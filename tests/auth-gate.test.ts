import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	AUTH_GATE_MAX_FAILURES,
	assertAuthGateOpen,
	recordAuthGateFailure
} from '$lib/server/auth-gate';
import { ensureAdminUser } from '$lib/server/auth';
import { newId } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import type { AppDb } from '$lib/server/db/client';

describe('auth gate', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('locks after too many failures', async () => {
		const admin = await ensureAdminUser(db, TEST_ENV);
		for (let i = 0; i < AUTH_GATE_MAX_FAILURES; i++) {
			await recordAuthGateFailure(db, TEST_ENV, admin.id, 'password');
		}
		await expect(assertAuthGateOpen(db, TEST_ENV, admin.id, 'password')).rejects.toThrow(
			/Too many attempts/
		);
	});

	it('ensureAdminUser removes leftover non-admin users', async () => {
		const now = new Date();
		await db.insert(users).values({
			id: newId(),
			email: 'orphan@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		await ensureAdminUser(db, TEST_ENV);
		const emails = (await db.select({ email: users.email }).from(users)).map((row) => row.email);
		expect(emails).toEqual([TEST_ENV.ADMIN_EMAIL]);
	});
});
