import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { secretFromBase32, totpAt } from '$lib/domain/totp';
import { authenticatePassword } from '$lib/server/auth';
import { first } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { mfaChallenges, totpBackupCodes } from '$lib/server/db/schema';
import {
	enrollConfirm,
	enrollStart,
	rotateStart,
	startEnrollChallenge,
	startLoginChallenge,
	verifyMfa
} from '$lib/server/totp';
import type { AppDb } from '$lib/server/db/client';

describe('totp auth flow', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('password success does not enable totp by itself', async () => {
		const user = await authenticatePassword(db, TEST_ENV, 'admin@localhost', 'admin123');
		expect(user).toBeTruthy();
		expect(user!.totpEnabled).toBe(false);
	});

	it('enroll without a valid code does not enable totp', async () => {
		const user = await authenticatePassword(db, TEST_ENV, 'admin@localhost', 'admin123');
		const token = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		await enrollStart(db, TEST_ENV, token);
		await expect(enrollConfirm(db, TEST_ENV, token, '000000')).rejects.toThrow(/Invalid code/);
		const row = await first(db.select().from(users).where(eq(users.id, user!.id)));
		expect(row?.totpEnabled).toBe(false);
	});

	it('enroll + login with totp and one-time backup code', async () => {
		const user = await authenticatePassword(db, TEST_ENV, 'admin@localhost', 'admin123');
		const enrollToken = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		const started = await enrollStart(db, TEST_ENV, enrollToken);
		expect(started.otpauthUrl).toContain('otpauth://totp/');
		expect(started.backupCodes).toHaveLength(10);

		const secret = started.secret.replace(/\s+/g, '');
		const code = await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000));
		const enrolled = await enrollConfirm(db, TEST_ENV, enrollToken, code);
		expect(enrolled.raw).toBeTruthy();
		const after = await first(db.select().from(users).where(eq(users.id, user!.id)));
		expect(after?.totpEnabled).toBe(true);

		const loginToken = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		const again = await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000) + 30);
		const verified = await verifyMfa(db, TEST_ENV, loginToken, again);
		expect(verified.usedBackup).toBe(false);

		const loginToken2 = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		const backup = started.backupCodes[0];
		const withBackup = await verifyMfa(db, TEST_ENV, loginToken2, backup);
		expect(withBackup.usedBackup).toBe(true);
		const loginToken3 = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		await expect(verifyMfa(db, TEST_ENV, loginToken3, backup)).rejects.toThrow(/Invalid code/);
	});
});

describe('rotate start', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('does not mark a backup used until confirm', async () => {
		const user = await authenticatePassword(db, TEST_ENV, 'admin@localhost', 'admin123');
		const enrollToken = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		const started = await enrollStart(db, TEST_ENV, enrollToken);
		const secret = started.secret.replace(/\s+/g, '');
		const code = await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000));
		await enrollConfirm(db, TEST_ENV, enrollToken, code);

		const backup = started.backupCodes[1];
		await rotateStart(
			db,
			TEST_ENV,
			{ id: user!.id, email: user!.email, timezone: 'UTC', totpEnabled: true, mfaVerified: true },
			backup
		);
		const rows = await db
			.select()
			.from(totpBackupCodes)
			.where(eq(totpBackupCodes.userId, user!.id));
		expect(rows.every((row) => row.usedAt == null)).toBe(true);
	});
});

describe('rotate confirm cycle', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('confirming rotation replaces backup codes and keeps other challenges', async () => {
		const user = await authenticatePassword(db, TEST_ENV, 'admin@localhost', 'admin123');
		const enrollToken = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		const started = await enrollStart(db, TEST_ENV, enrollToken);
		const secret = started.secret.replace(/\s+/g, '');
		await enrollConfirm(
			db,
			TEST_ENV,
			enrollToken,
			await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000))
		);
		const oldBackup = started.backupCodes[2];

		// An unrelated login challenge must survive the rotate confirm below.
		await startLoginChallenge(db, TEST_ENV, user!.id, true);

		const rotated = await rotateStart(
			db,
			TEST_ENV,
			{ id: user!.id, email: user!.email, timezone: 'UTC', totpEnabled: true, mfaVerified: true },
			oldBackup
		);
		const newSecret = rotated.secret.replace(/\s+/g, '');
		await enrollConfirm(
			db,
			TEST_ENV,
			rotated.mfaToken,
			await totpAt(secretFromBase32(newSecret), Math.floor(Date.now() / 1000))
		);

		// Old backups are dead after rotation.
		const loginToken = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		await expect(verifyMfa(db, TEST_ENV, loginToken, oldBackup)).rejects.toThrow();
		const remaining = await db
			.select()
			.from(totpBackupCodes)
			.where(and(eq(totpBackupCodes.userId, user!.id), isNull(totpBackupCodes.usedAt)));
		expect(remaining).toHaveLength(10);

		// The unrelated login challenge survived the confirm.
		const logins = await db
			.select()
			.from(mfaChallenges)
			.where(and(eq(mfaChallenges.userId, user!.id), eq(mfaChallenges.kind, 'login')));
		expect(logins.length).toBeGreaterThanOrEqual(1);
	});
});

describe('totp brute-force gate', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('fresh login challenges do not reset the global TOTP guess budget', async () => {
		const user = await authenticatePassword(db, TEST_ENV, 'admin@localhost', 'admin123');
		const enrollToken = await startEnrollChallenge(db, TEST_ENV, user!.id, true);
		const started = await enrollStart(db, TEST_ENV, enrollToken);
		const secret = started.secret.replace(/\s+/g, '');
		await enrollConfirm(
			db,
			TEST_ENV,
			enrollToken,
			await totpAt(secretFromBase32(secret), Math.floor(Date.now() / 1000))
		);

		// Attacker with the password mints a fresh challenge per guess batch.
		// Per-challenge counters reset, but the cross-challenge totp-gate must
		// still lock after 8 total guesses.
		for (let i = 0; i < 8; i++) {
			const token = await startLoginChallenge(db, TEST_ENV, user!.id, true);
			await expect(verifyMfa(db, TEST_ENV, token, '000000')).rejects.toThrow();
		}
		const fresh = await startLoginChallenge(db, TEST_ENV, user!.id, true);
		await expect(verifyMfa(db, TEST_ENV, fresh, '000000')).rejects.toThrow(/Too many attempts/);
	});
});
