import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { encryptJson } from '$lib/server/crypto';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, drafts, publishTargets, users } from '$lib/server/db/schema';
import { createTestDb, createTestMedia, TEST_ENV } from '$lib/server/db/test';
import {
	claimDueTargets,
	consumePublishJob,
	runSchedulerTick,
	schedulerHealth,
	writeHeartbeat
} from '$lib/server/scheduler';

describe('claimDueTargets stale publishing', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;
	let connId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'sched@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'tick',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'bluesky',
			handle: 'test.bsky.social',
			credentialsEncrypted: await encryptJson(
				{
					handle: 'test.bsky.social',
					appPassword: 'xxxx',
					did: 'did:plc:test',
					pdsHost: 'https://bsky.social'
				},
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ did: 'did:plc:test' }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	it('selects a due stale publishing row and tick publishes it once', async () => {
		const now = new Date();
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId: connId,
			status: 'publishing',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 1,
			createdAt: now,
			updatedAt: new Date(now.getTime() - 16 * 60_000)
		});
		const due = await claimDueTargets(db, now);
		expect(due.map((t) => t.id)).toContain(targetId);

		const store = createTestMedia();
		const result = await runSchedulerTick(db, TEST_ENV, {
			store,
			fetchImpl: async (input) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url.includes('createSession')) {
					return Response.json({
						accessJwt: 'a',
						refreshJwt: 'r',
						did: 'did:plc:test',
						handle: 'test.bsky.social'
					});
				}
				if (url.includes('createRecord')) {
					return Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/tick', cid: 'cid' });
				}
				return new Response(`unmocked ${url}`, { status: 404 });
			}
		});
		expect(result.results.some((r) => r.id === targetId && r.status === 'published')).toBe(true);
	});

	it('bounds the batch oldest-due-first', async () => {
		const now = new Date();
		const ids: string[] = [];
		for (let i = 0; i < 60; i++) {
			// Unique (draft, connection) pairs: reuse one draft per target is
			// blocked by the unique index, so mint a draft each.
			const d = newId();
			await db.insert(drafts).values({
				id: d,
				userId,
				baseBody: `batch ${i}`,
				status: 'scheduled',
				createdAt: now,
				updatedAt: now
			});
			const id = newId();
			ids.push(id);
			await db.insert(publishTargets).values({
				id,
				draftId: d,
				connectionId: connId,
				status: 'scheduled',
				scheduledFor: new Date(now.getTime() - (60 - i) * 60_000),
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			});
		}
		const due = await claimDueTargets(db, now);
		expect(due.length).toBeLessThanOrEqual(50);
		// Oldest-due first: the earliest scheduledFor in the batch leads.
		const times = due.map((t) => new Date(t.scheduledFor as Date).getTime());
		expect(times).toEqual([...times].sort((a, b) => a - b));
		// Cleanup so later tests see a quiet queue.
		await db.delete(publishTargets).where(inArray(publishTargets.id, ids.slice(0, 100)));
	});

	it('queue handoff does not trap the consumer claim', async () => {
		const now = new Date();
		const qDraft = newId();
		await db.insert(drafts).values({
			id: qDraft,
			userId,
			baseBody: 'queued tick',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: qDraft,
			connectionId: connId,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		const sent: Array<{ targetId: string }> = [];
		const store = createTestMedia();
		const tick = await runSchedulerTick(db, TEST_ENV, {
			store,
			queue: {
				send: async (body) => {
					sent.push(body);
				}
			}
		});
		expect(tick.results.some((r) => r.id === targetId && r.status === 'queued')).toBe(true);
		expect(sent).toEqual([{ targetId }]);
		const consumed = await consumePublishJob(db, TEST_ENV, store, targetId, async (input) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes('createSession')) {
				return Response.json({
					accessJwt: 'a',
					refreshJwt: 'r',
					did: 'did:plc:test',
					handle: 'test.bsky.social'
				});
			}
			if (url.includes('createRecord')) {
				return Response.json({ uri: 'at://did:plc:test/app.bsky.feed.post/queued', cid: 'cid' });
			}
			return new Response(`unmocked ${url}`, { status: 404 });
		});
		expect(consumed.status).toBe('published');
	});

	it('a failed queue send releases the tag and propagates', async () => {
		const now = new Date();
		const qDraft = newId();
		await db.insert(drafts).values({
			id: qDraft,
			userId,
			baseBody: 'wedged tick',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId: qDraft,
			connectionId: connId,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		const store = createTestMedia();
		await expect(
			runSchedulerTick(db, TEST_ENV, {
				store,
				queue: {
					send: async () => {
						throw new Error('queue down');
					}
				}
			})
		).rejects.toThrow('queue down');
		const [row] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
		expect(row?.jobId).toBeNull();
		expect(row?.status).toBe('scheduled');
		// The next tick can reclaim it immediately (no 15m wedge).
		expect(await claimDueTargets(db, new Date())).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: targetId })])
		);
		await db.delete(publishTargets).where(eq(publishTargets.id, targetId));
	});

	it('health reports stuck publishing and overdue targets', async () => {
		const now = new Date();
		const hDraft = newId();
		await db.insert(drafts).values({
			id: hDraft,
			userId,
			baseBody: 'health probe',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: hDraft,
			connectionId: connId,
			status: 'publishing',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 1,
			createdAt: now,
			updatedAt: new Date(now.getTime() - 31 * 60_000)
		});
		const oDraft = newId();
		await db.insert(drafts).values({
			id: oDraft,
			userId,
			baseBody: 'overdue probe',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const otherConn = newId();
		await db.insert(connections).values({
			id: otherConn,
			userId,
			platform: 'mastodon',
			handle: 'health@example.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: oDraft,
			connectionId: otherConn,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		await writeHeartbeat(db, now);
		const health = await schedulerHealth(db, now);
		expect(health.ok).toBe(true);
		expect(health.stuckPublishing).toBe(1);
		expect(health.overdue).toBeGreaterThanOrEqual(1);
	});
});

describe('queue single-flight', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		const userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'singleflight@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'single flight',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		const connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'bluesky',
			handle: 'test.bsky.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: 'singleflight-target',
			draftId,
			connectionId: connId,
			status: 'scheduled',
			scheduledFor: new Date(now.getTime() - 60_000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('two overlapping ticks enqueue a target only once', async () => {
		const sent: Array<{ targetId: string }> = [];
		const queue = {
			send: async (body: { targetId: string }) => {
				sent.push(body);
			}
		};
		const store = createTestMedia();
		await runSchedulerTick(db, TEST_ENV, { store, queue });
		await runSchedulerTick(db, TEST_ENV, { store, queue });
		expect(sent.filter((s) => s.targetId === 'singleflight-target')).toHaveLength(1);
	});
});
