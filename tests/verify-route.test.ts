import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, users } from '$lib/server/db/schema';
import { newId, type AppDb } from '$lib/server/db/client';
import { TEST_ENV, createTestDb } from '$lib/server/db/test';
import { encryptJson } from '$lib/server/crypto';
import { POST as verifyPOST } from '../src/routes/api/connections/[id]/verify/+server';

/**
 * The verify handler used to run `requireScope('write')` inside the same try
 * as the provider call, so the 403 it throws landed in the catch that treats
 * 401/403 as "the stored token is dead" and expired the row — by id, with no
 * ownership filter. A read-scoped key could therefore expire every connection
 * it could list.
 */
describe('POST /api/connections/[id]/verify — scope gate never writes', () => {
	let db: AppDb;
	let close: () => void;
	let ownerId: string;
	let strangerId: string;

	async function addConnection(
		owner: string,
		overrides: Partial<typeof connections.$inferInsert> = {}
	) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId: owner,
			platform: 'mastodon',
			handle: `acct-${id.slice(0, 8)}@example.social`,
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now,
			...overrides
		});
		return id;
	}

	const locals = (scopes: string[] | null, user = ownerId) => ({
		db,
		user: {
			id: user,
			email: `${user}@localhost`,
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		authMethod: 'bearer' as const,
		apiKeyScopes: scopes,
		env: TEST_ENV
	});
	const verify = (id: string, scopes: string[] | null, user = ownerId) =>
		verifyPOST({ params: { id }, locals: locals(scopes, user) } as never) as Promise<Response>;
	const statusOf = async (id: string) =>
		(await db.select().from(connections).where(eq(connections.id, id)))[0];

	beforeAll(async () => {
		const ctx = await createTestDb();
		db = ctx.db;
		close = ctx.close;
		ownerId = newId();
		strangerId = newId();
		const now = new Date();
		for (const id of [ownerId, strangerId]) {
			await db.insert(users).values({
				id,
				email: `${id}@localhost`,
				passwordHash: 'x',
				timezone: 'UTC',
				createdAt: now,
				updatedAt: now
			});
		}
	});
	afterAll(() => {
		vi.unstubAllGlobals();
		close();
	});

	it('refuses a read-scoped key and leaves the row untouched', async () => {
		const conn = await addConnection(ownerId);
		const before = await statusOf(conn);

		const res = await verify(conn, ['read']);

		expect(res.status).toBe(403);
		const after = await statusOf(conn);
		expect(after.status).toBe('active');
		// Not even the timestamp moved: a rejected gate must not reach the DB.
		expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
	});

	it('cannot expire a connection belonging to someone else', async () => {
		const victim = await addConnection(strangerId);
		const before = await statusOf(victim);

		const res = await verify(victim, ['read']);

		expect(res.status).toBe(403);
		const after = await statusOf(victim);
		expect(after.status).toBe('active');
		expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
	});

	it('404s an unknown id and another user’s row for a write key', async () => {
		expect((await verify(newId(), ['write'])).status).toBe(404);
		const stranger = await addConnection(strangerId);
		expect((await verify(stranger, ['write'])).status).toBe(404);
		expect((await statusOf(stranger)).status).toBe('active');
	});

	it('still expires the row on a real provider auth failure', async () => {
		const conn = await addConnection(ownerId, {
			credentialsEncrypted: await encryptJson(
				{ instanceUrl: 'https://mastodon.example', accessToken: 'dead-token' },
				TEST_ENV.APP_ENCRYPTION_KEY
			)
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('revoked', { status: 401 }))
		);

		const res = await verify(conn, ['write']);

		expect(res.status).toBe(401);
		expect((await statusOf(conn)).status).toBe('expired');
		vi.unstubAllGlobals();
	});

	it('marks the row active again when the provider accepts the token', async () => {
		const conn = await addConnection(ownerId, {
			credentialsEncrypted: await encryptJson(
				{ instanceUrl: 'https://mastodon.example', accessToken: 'good-token' },
				TEST_ENV.APP_ENCRYPTION_KEY
			)
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ id: '1', username: 'me', display_name: 'Me' }))
		);

		const res = await verify(conn, ['write']);

		expect(res.status).toBe(200);
		expect((await statusOf(conn)).status).toBe('active');
		vi.unstubAllGlobals();
	});
});
