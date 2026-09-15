import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '$lib/server/db/schema';
import { ensureAdminUser } from '$lib/server/auth';
import { newId, type AppDb } from '$lib/server/db/client';
import { TEST_ENV, createTestDb } from '$lib/server/db/test';

async function orphan(db: AppDb) {
	const now = new Date();
	await db.insert(users).values({
		id: newId(),
		email: `orphan-${newId()}@localhost`,
		passwordHash: 'x',
		timezone: 'UTC',
		createdAt: now,
		updatedAt: now
	});
}

async function emails(db: AppDb) {
	return (await db.select({ email: users.email }).from(users)).map((r) => r.email).sort();
}

describe('ensureAdminUser sweep memoization', () => {
	let db: AppDb;
	let close: () => void;
	let reset: () => void;
	let count: () => number;

	beforeAll(async () => {
		const ctx = await createTestDb();
		db = ctx.db;
		close = ctx.close;
		reset = ctx.reset;
		count = ctx.count;
	});
	afterAll(() => close());

	it('sweeps once per binding, then serves SELECT-only calls', async () => {
		const binding = {};
		reset();
		await ensureAdminUser(db, TEST_ENV, binding);
		const first = count();
		expect(first).toBeGreaterThanOrEqual(2); // SELECT (+INSERT on fresh DB) + DELETE sweep

		await orphan(db);
		reset();
		await ensureAdminUser(db, TEST_ENV, binding);
		expect(count()).toBe(1); // SELECT only: no DELETE write
		expect(await emails(db)).toContain(TEST_ENV.ADMIN_EMAIL);

		// Without a binding the sweep always runs (fresh contexts, tests).
		reset();
		await ensureAdminUser(db, TEST_ENV);
		expect(count()).toBeGreaterThanOrEqual(2);
		const remaining = await emails(db);
		expect(remaining).toEqual([TEST_ENV.ADMIN_EMAIL]);
	});
});
