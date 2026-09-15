import { and, eq } from 'drizzle-orm';
import { first, newId, type AppDb } from './db/client';
import { mfaChallenges } from './db/schema';
import { hashToken } from './auth';
import type { AppEnv } from './env';

export const AUTH_GATE_MAX_FAILURES = 8;
export const AUTH_GATE_WINDOW_MS = 15 * 60_000;

export type AuthGateKind = 'password' | 'rotate-gate' | 'totp-gate';

function gateExpires(now = new Date()) {
	return new Date(now.getTime() + AUTH_GATE_WINDOW_MS);
}

async function gateTokenHash(env: AppEnv, kind: AuthGateKind, userId: string) {
	return hashToken(`gate:${kind}:${userId}`, env.AUTH_SECRET);
}

export async function assertAuthGateOpen(
	db: AppDb,
	env: AppEnv,
	userId: string,
	kind: AuthGateKind
) {
	const tokenHash = await gateTokenHash(env, kind, userId);
	const row = await first(
		db.select().from(mfaChallenges).where(eq(mfaChallenges.tokenHash, tokenHash))
	);
	if (!row) return;
	const now = new Date();
	if (row.expiresAt < now) {
		await db.delete(mfaChallenges).where(eq(mfaChallenges.id, row.id));
		return;
	}
	if (row.failedAttempts >= AUTH_GATE_MAX_FAILURES) {
		throw Object.assign(new Error('Too many attempts — try again in 15 minutes'), { status: 401 });
	}
}

export async function recordAuthGateFailure(
	db: AppDb,
	env: AppEnv,
	userId: string,
	kind: AuthGateKind
) {
	const tokenHash = await gateTokenHash(env, kind, userId);
	const now = new Date();
	const row = await first(
		db.select().from(mfaChallenges).where(eq(mfaChallenges.tokenHash, tokenHash))
	);
	if (!row || row.expiresAt < now) {
		if (row) await db.delete(mfaChallenges).where(eq(mfaChallenges.id, row.id));
		await db.insert(mfaChallenges).values({
			id: newId(),
			userId,
			tokenHash,
			kind,
			remember: false,
			failedAttempts: 1,
			expiresAt: gateExpires(now),
			createdAt: now
		});
		return { locked: false as const };
	}
	const next = row.failedAttempts + 1;
	const locked = next >= AUTH_GATE_MAX_FAILURES;
	await db
		.update(mfaChallenges)
		.set({
			failedAttempts: next,
			expiresAt: locked ? gateExpires(now) : row.expiresAt
		})
		.where(eq(mfaChallenges.id, row.id));
	return { locked };
}

export async function clearAuthGate(db: AppDb, env: AppEnv, userId: string, kind: AuthGateKind) {
	const tokenHash = await gateTokenHash(env, kind, userId);
	await db.delete(mfaChallenges).where(and(eq(mfaChallenges.tokenHash, tokenHash)));
}
