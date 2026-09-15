import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '$lib/server/db/schema';
import { users } from '$lib/server/db/schema';
import { ensureAdminUser } from '$lib/server/auth';
import { newId, type AppDb } from '$lib/server/db/client';
import { TEST_ENV } from '$lib/server/db/test';

const here = dirname(fileURLToPath(import.meta.url));

async function countedDb() {
	const client = createClient({ url: ':memory:' });
	const dir = join(here, '../drizzle');
	for (const name of readdirSync(dir)
		.filter((n) => n.endsWith('.sql'))
		.sort()) {
		await client.executeMultiple(readFileSync(join(dir, name), 'utf8'));
	}
	await client.execute('PRAGMA foreign_keys = ON');
	let queries = 0;
	const orig = client.execute.bind(client);
	client.execute = (async (...args: Parameters<typeof orig>) => {
		queries += 1;
		return orig(...args);
	}) as typeof orig;
	const db = drizzle(client, { schema }) as unknown as AppDb;
	return { db, close: () => client.close(), count: () => queries, reset: () => (queries = 0) };
}

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
		const ctx = await countedDb();
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
