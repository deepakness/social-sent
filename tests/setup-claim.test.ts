import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sessions, users } from '$lib/server/db/schema';
import { newId, type AppDb } from '$lib/server/db/client';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { hashPassword, verifyPassword } from '$lib/server/crypto';
import { authenticatePassword, hasEnvCredentials, needsSetup } from '$lib/server/auth';
import { POST as setupPOST } from '../src/routes/api/setup/+server';
import { GET as accountGET, PATCH as accountPATCH } from '../src/routes/api/account/+server';

/** The D1-managed login: claimed once, then changed from Settings. */
const SETUP_ENV = { ...TEST_ENV, ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined };

const sessionLocals = (db: AppDb, id: string) => ({
	db,
	env: SETUP_ENV,
	authMethod: 'session' as const,
	user: { id, email: 'owner@localhost', timezone: 'UTC', totpEnabled: true, mfaVerified: true }
});

function post(payload: unknown, db: AppDb, env: Record<string, unknown> = SETUP_ENV) {
	return setupPOST({
		locals: { db, env },
		request: new Request('http://localhost/api/setup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		})
	} as never) as Promise<Response>;
}

describe('first-run claim', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('is needed only while no account exists and no env credentials are set', async () => {
		expect(await needsSetup(db, SETUP_ENV)).toBe(true);
		expect(await needsSetup(db, TEST_ENV)).toBe(false);
		expect(hasEnvCredentials(TEST_ENV)).toBe(true);
		expect(hasEnvCredentials(SETUP_ENV)).toBe(false);
	});

	it('serves the page while unclaimed and redirects once claimed', async () => {
		const load = (await import('../src/routes/setup/+page.server')).load;
		await expect(load({ locals: { db, env: SETUP_ENV } } as never)).resolves.toEqual({});
	});

	it('rejects a bad email or a short password', async () => {
		expect((await post({ email: 'nope', password: 'long-enough' }, db)).status).toBe(400);
		expect((await post({ email: 'owner@localhost', password: 'short' }, db)).status).toBe(400);
		// Nothing was created by the rejected attempts.
		expect(await needsSetup(db, SETUP_ENV)).toBe(true);
	});

	it('creates the account, lowercases the email, and closes itself', async () => {
		const created = await post({ email: 'Owner@LocalHost', password: 'correct horse' }, db);
		expect(created.status).toBe(200);
		const rows = await db.select().from(users);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.email).toBe('owner@localhost');
		expect(await verifyPassword('correct horse', rows[0]!.passwordHash)).toBe(true);

		expect(await needsSetup(db, SETUP_ENV)).toBe(false);
		expect((await post({ email: 'second@localhost', password: 'another one' }, db)).status).toBe(
			409
		);
		expect(await db.select().from(users)).toHaveLength(1);
	});

	it('authenticates against the stored hash, not an env password', async () => {
		expect(
			await authenticatePassword(db, SETUP_ENV, 'owner@localhost', 'correct horse')
		).not.toBeNull();
		expect(await authenticatePassword(db, SETUP_ENV, 'owner@localhost', 'wrong')).toBeNull();
		expect(
			await authenticatePassword(db, SETUP_ENV, 'other@localhost', 'correct horse')
		).toBeNull();
		// Env credentials, when present, stay authoritative.
		expect(
			await authenticatePassword(db, TEST_ENV, TEST_ENV.ADMIN_EMAIL, TEST_ENV.ADMIN_PASSWORD)
		).not.toBeNull();
		expect(
			await authenticatePassword(db, TEST_ENV, TEST_ENV.ADMIN_EMAIL, 'not-the-env-password')
		).toBeNull();
	});

	it('exposes the claim through GET /setup while the table is empty', async () => {
		// A fresh database: the page load allows the claim.
		const fresh = await createTestDb();
		try {
			const load = (await import('../src/routes/setup/+page.server')).load;
			await expect(load({ locals: { db: fresh.db, env: SETUP_ENV } } as never)).resolves.toEqual(
				{}
			);
			await expect(
				load({ locals: { db: fresh.db, env: TEST_ENV } } as never)
			).rejects.toMatchObject({ status: 303 });
		} finally {
			fresh.close();
		}
	});
});

describe('account settings', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'owner@localhost',
			passwordHash: await hashPassword('correct horse'),
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		await db.insert(sessions).values({
			id: newId(),
			token: 'token',
			userId,
			expiresAt: new Date(Date.now() + 3600_000),
			remember: true,
			mfaVerified: true,
			createdAt: now,
			pwdFp: 'x',
			lastSeenAt: now
		});
	});
	afterAll(() => close());

	const patch = (payload: unknown, locals: unknown = sessionLocals(db, userId)) =>
		accountPATCH({
			locals,
			request: new Request('http://localhost/api/account', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			})
		} as never) as Promise<Response>;

	it('requires a session', async () => {
		const bearer = { ...sessionLocals(db, userId), authMethod: 'bearer' as const };
		expect((await accountGET({ locals: bearer } as never)).status).toBe(401);
		expect((await patch({ currentPassword: 'correct horse' }, bearer)).status).toBe(401);
	});

	it('reports that env-managed logins cannot be changed here', async () => {
		const get = (await accountGET({
			locals: { ...sessionLocals(db, userId), env: TEST_ENV }
		} as never)) as Response;
		expect(await get.json()).toMatchObject({ managedByEnv: true });
		const res = await patch(
			{ currentPassword: 'whatever' },
			{ ...sessionLocals(db, userId), env: TEST_ENV }
		);
		expect(res.status).toBe(409);
	});

	it('re-authenticates with the current password', async () => {
		// Missing (400) and wrong (401) are different answers on purpose.
		expect((await patch({ email: 'new@localhost' })).status).toBe(400);
		expect((await patch({ currentPassword: 'wrong', email: 'new@localhost' })).status).toBe(401);
		expect((await patch({ currentPassword: 'correct horse' })).status).toBe(400);
	});

	it('changes the email without touching the password', async () => {
		const res = await patch({ currentPassword: 'correct horse', email: 'New@LocalHost' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ email: 'new@localhost', reauth: false });
		const row = (await db.select().from(users).where(eq(users.id, userId)))[0]!;
		expect(row.email).toBe('new@localhost');
		expect(await verifyPassword('correct horse', row.passwordHash)).toBe(true);
	});

	it('changes the password, refuses a repeat, and revokes every session', async () => {
		expect((await patch({ currentPassword: 'correct horse', newPassword: 'short' })).status).toBe(
			400
		);
		expect(
			(await patch({ currentPassword: 'correct horse', newPassword: 'correct horse' })).status
		).toBe(400);

		const res = await patch({ currentPassword: 'correct horse', newPassword: 'a longer one' });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ reauth: true });
		const row = (await db.select().from(users).where(eq(users.id, userId)))[0]!;
		expect(await verifyPassword('a longer one', row.passwordHash)).toBe(true);
		expect(await db.select().from(sessions)).toHaveLength(0);
	});
});
