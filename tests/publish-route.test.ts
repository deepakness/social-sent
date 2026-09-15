import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encryptJson } from '$lib/server/crypto';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, drafts, publishTargets, users } from '$lib/server/db/schema';
import { createTestDb, createTestMedia, TEST_ENV } from '$lib/server/db/test';
import { POST as publishPOST } from '../src/routes/api/drafts/[id]/publish/+server';

describe('POST /api/drafts/[id]/publish guard', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;
	let connDone: string;
	let connStale: string;
	const media = createTestMedia();

	const localsFor = () => ({
		db,
		env: TEST_ENV,
		media,
		user: {
			id: userId,
			email: 'guard@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	function post(connectionIds: string[]) {
		return publishPOST({
			params: { id: draftId },
			request: new Request('http://localhost/api/drafts/x/publish', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionIds })
			}),
			locals: localsFor()
		} as never) as Promise<Response>;
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'guard@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'guard probe',
			status: 'partial',
			createdAt: now,
			updatedAt: now
		});
		connDone = newId();
		await db.insert(connections).values({
			id: connDone,
			userId,
			platform: 'mastodon',
			handle: 'done@mastodon.test',
			instanceUrl: 'https://mastodon.test',
			credentialsEncrypted: await encryptJson(
				{ accessToken: 'token', instanceUrl: 'https://mastodon.test' },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ maxCharacters: 500 }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		connStale = newId();
		await db.insert(connections).values({
			id: connStale,
			userId,
			platform: 'x',
			handle: '@stale',
			credentialsEncrypted: await encryptJson(
				{ accessToken: 'dead', expiresAt: Date.now() - 60_000 },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ maxCharacters: 280 }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values([
			{
				id: newId(),
				draftId,
				connectionId: connDone,
				status: 'published',
				remotePostId: 'posted-1',
				remoteUrl: 'https://mastodon.test/@u/1',
				attemptCount: 1,
				createdAt: now,
				updatedAt: now
			},
			{
				id: newId(),
				draftId,
				connectionId: connStale,
				status: 'failed',
				errorMessage: 'boom',
				attemptCount: 1,
				createdAt: now,
				updatedAt: now
			}
		]);
	});

	afterAll(() => close());

	it('lets a partial re-draft through: published skips, failed retries', async () => {
		const res = await post([connDone, connStale]);
		expect(res.status).toBe(200);
		const body = await res.json();
		const rows = body.results as Array<{ connectionId: string; status: string; error?: string }>;
		const byConn = new Map(rows.map((r) => [r.connectionId, r]));
		expect(byConn.get(connDone)).toMatchObject({ status: 'published', skipped: true });
		const staleResult = byConn.get(connStale);
		expect(staleResult).toMatchObject({ status: 'failed' });
		expect(String(staleResult?.error)).toMatch(/reconnect/);
		const [stale] = await db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.connectionId, connStale));
		expect(stale?.attemptCount).toBe(1);
	});

	it('returns 409 while a requested connection is publishing', async () => {
		const now = new Date();
		const liveDraft = newId();
		await db.insert(drafts).values({
			id: liveDraft,
			userId,
			baseBody: 'live probe',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId: liveDraft,
			connectionId: connDone,
			status: 'publishing',
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		const res = (await publishPOST({
			params: { id: liveDraft },
			request: new Request('http://localhost/api/drafts/x/publish', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionIds: [connDone] })
			}),
			locals: localsFor()
		} as never)) as Response;
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: 'Already publishing' });
	});
});
