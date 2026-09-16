import { and, eq, lt, ne } from 'drizzle-orm';
import {
	isSessionIdle,
	nextSessionExpiry,
	sessionMaxAgeSeconds,
	shouldSlideSession,
	shouldTouchSeen,
	shouldUseSecureCookie
} from '$lib/domain/session-cookie';
import { randomHex } from '$lib/domain/bytes';
import { envCredentialsMatch } from '$lib/domain/env-credentials';
import { hashPassword, hmacHex, verifyPassword } from './crypto';
import { first, newId, type AppDb } from './db/client';
import { sessions, users } from './db/schema';
import type { AppEnv } from './env';

export const SESSION_COOKIE = 'sent_session';

export type SessionUser = {
	id: string;
	email: string;
	timezone: string;
	totpEnabled: boolean;
	mfaVerified: boolean;
};

export function isFullyVerified(user: SessionUser | null): boolean {
	return Boolean(user && user.totpEnabled && user.mfaVerified);
}

/** Session-shaped admin for Bearer API_TOKEN requests. Does not change the D1 user row. */
export function asMachineUser(admin: { id: string; email: string; timezone: string }): SessionUser {
	return {
		id: admin.id,
		email: admin.email,
		timezone: admin.timezone,
		totpEnabled: true,
		mfaVerified: true
	};
}

export function needsTotpEnroll(user: SessionUser | null): boolean {
	return Boolean(user && !user.totpEnabled);
}

// Domain-separated HMAC: session tokens live in the `session:` domain so a
// token hash can never collide with MFA (`mfa:`), backup (`backup:`), gate
// (`gate:`) or OAuth-state (`oauth-state:`) hashes even if raw values repeat.
// NOTE: this invalidates sessions minted before the prefix was added — users
// sign in again once after deploy.
export async function hashToken(raw: string, secret: string): Promise<string> {
	return hmacHex(secret, `session:${raw}`);
}

/**
 * Where the login comes from. Both secrets set means the operator manages it
 * from Worker secrets (`npm run secrets:put`); neither means the single account
 * lives in D1 — claimed in the browser on first run, changed in Settings after
 * that. envFromPlatform rejects a half-configured pair.
 */
export function hasEnvCredentials(env: AppEnv): boolean {
	return Boolean(env.ADMIN_EMAIL && env.ADMIN_PASSWORD);
}

// Binds a session to the password that minted it: changing the password
// invalidates every outstanding session on next use (previously they lived on
// until expiry). A D1-managed account is bound to the stored hash; the prefix
// keeps the two derivations from ever colliding. Never logged.
export async function passwordFingerprint(
	env: AppEnv,
	passwordHash?: string | null
): Promise<string> {
	if (hasEnvCredentials(env)) return hmacHex(env.AUTH_SECRET, `pwd-fp:${env.ADMIN_PASSWORD}`);
	return hmacHex(env.AUTH_SECRET, `pwd-fp:hash:${passwordHash ?? ''}`);
}

/** True while the instance has no account at all: first run, before the claim. */
export async function needsSetup(db: AppDb, env: AppEnv): Promise<boolean> {
	if (hasEnvCredentials(env)) return false;
	const row = await first(db.select({ id: users.id }).from(users).limit(1));
	return !row;
}

/** The single account: bootstrapped from env credentials when those are set,
 *  otherwise whatever the claim created. Null before the claim. */
export async function getAdminUser(
	db: AppDb,
	env: AppEnv,
	d1?: object
): Promise<Awaited<ReturnType<typeof ensureAdminUser>> | null> {
	if (hasEnvCredentials(env)) return ensureAdminUser(db, env, d1);
	return (await first(db.select().from(users).limit(1))) ?? null;
}

// Tracks (binding, admin email) pairs already swept for stray users. A changed
// ADMIN_EMAIL always ships with a redeploy (new isolate), so the flag cannot
// go stale: the sweep re-runs exactly once per deployment. Callers without a
// stable binding (tests) omit it and always sweep.
const sweptAdminBindings = new WeakMap<object, Set<string>>();

export async function ensureAdminUser(db: AppDb, env: AppEnv, d1?: object) {
	if (!hasEnvCredentials(env)) {
		throw new Error('ensureAdminUser needs ADMIN_EMAIL and ADMIN_PASSWORD');
	}
	// Both are present past the guard; the schema rejects a half-configured pair.
	const email = env.ADMIN_EMAIL ?? '';
	const password = env.ADMIN_PASSWORD ?? '';
	let existing = await first(db.select().from(users).where(eq(users.email, email)));
	if (!existing) {
		const now = new Date();
		const row = {
			id: newId(),
			email,
			passwordHash: await hashPassword(password),
			displayName: null,
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now,
			totpEnabled: false,
			totpSecretEnc: null,
			totpEnrolledAt: null,
			totpLastStep: null,
			settingsJson: null
		};
		try {
			await db.insert(users).values(row);
			existing = row;
		} catch {
			existing = await first(db.select().from(users).where(eq(users.email, email)));
		}
	}
	if (!existing) throw new Error('Failed to bootstrap admin user');
	const swept = d1 ? (sweptAdminBindings.get(d1) ?? new Set<string>()) : null;
	if (!swept?.has(email)) {
		await db.delete(users).where(ne(users.email, email));
		if (d1 && swept) {
			swept.add(email);
			sweptAdminBindings.set(d1, swept);
		}
	}
	return existing;
}

export async function createSession(
	db: AppDb,
	env: AppEnv,
	userId: string,
	remember = true,
	mfaVerified = false,
	passwordHash?: string | null
): Promise<{ raw: string; maxAge: number }> {
	const raw = randomHex(32);
	const token = await hashToken(raw, env.AUTH_SECRET);
	const maxAge = sessionMaxAgeSeconds(remember);
	const now = new Date();
	await db.insert(sessions).values({
		id: newId(),
		token,
		userId,
		expiresAt: nextSessionExpiry(now, maxAge),
		remember,
		mfaVerified,
		createdAt: now,
		pwdFp: await passwordFingerprint(env, passwordHash),
		lastSeenAt: now
	});
	return { raw, maxAge };
}

export async function revokeOtherSessions(db: AppDb, userId: string, keepSessionId?: string) {
	if (keepSessionId) {
		await db
			.delete(sessions)
			.where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
		return;
	}
	await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function destroySession(db: AppDb, env: AppEnv, rawToken: string | undefined) {
	if (!rawToken) return;
	const token = await hashToken(rawToken, env.AUTH_SECRET);
	await db.delete(sessions).where(eq(sessions.token, token));
}

export function cookieSecureFlag(env: AppEnv, requestHost?: string): boolean {
	return shouldUseSecureCookie({
		isProduction: import.meta.env.PROD,
		appUrl: env.APP_URL,
		requestHost
	});
}

export async function getSessionUser(
	db: AppDb,
	env: AppEnv,
	rawToken: string | undefined
): Promise<{ user: SessionUser; slideMaxAge?: number } | null> {
	if (!rawToken) return null;
	const token = await hashToken(rawToken, env.AUTH_SECRET);
	const row = await first(
		db
			.select({
				sessionId: sessions.id,
				expiresAt: sessions.expiresAt,
				remember: sessions.remember,
				pwdFp: sessions.pwdFp,
				lastSeenAt: sessions.lastSeenAt,
				userId: users.id,
				email: users.email,
				timezone: users.timezone,
				totpEnabled: users.totpEnabled,
				mfaVerified: sessions.mfaVerified,
				passwordHash: users.passwordHash
			})
			.from(sessions)
			.innerJoin(users, eq(sessions.userId, users.id))
			.where(eq(sessions.token, token))
	);

	if (!row) return null;
	const now = new Date();
	if (row.expiresAt < now) {
		await db.delete(sessions).where(eq(sessions.id, row.sessionId));
		return null;
	}
	// Password rotation kills outstanding sessions. Rows minted before the
	// fingerprint column existed (NULL) are backfilled once instead.
	const fp = await passwordFingerprint(env, row.passwordHash);
	if (row.pwdFp && row.pwdFp !== fp) {
		await db.delete(sessions).where(eq(sessions.id, row.sessionId));
		return null;
	}
	if (isSessionIdle(row.lastSeenAt, now)) {
		await db.delete(sessions).where(eq(sessions.id, row.sessionId));
		return null;
	}

	const user: SessionUser = {
		id: row.userId,
		email: row.email,
		timezone: row.timezone,
		totpEnabled: Boolean(row.totpEnabled),
		mfaVerified: Boolean(row.mfaVerified)
	};
	const maxAge = sessionMaxAgeSeconds(row.remember);
	// Backfill pre-fingerprint rows and throttle lastSeenAt writes.
	const touch = !row.pwdFp || shouldTouchSeen(row.lastSeenAt, now);
	if (shouldSlideSession(row.expiresAt, now, maxAge)) {
		await db
			.update(sessions)
			.set({
				expiresAt: nextSessionExpiry(now, maxAge),
				...(touch ? { pwdFp: fp, lastSeenAt: now } : {})
			})
			.where(eq(sessions.id, row.sessionId));
		return { user, slideMaxAge: maxAge };
	}
	if (touch) {
		await db
			.update(sessions)
			.set({ pwdFp: fp, lastSeenAt: now })
			.where(eq(sessions.id, row.sessionId));
	}
	return { user };
}

export async function authenticatePassword(
	db: AppDb,
	env: AppEnv,
	email: string,
	password: string
) {
	if (hasEnvCredentials(env)) {
		if (!envCredentialsMatch(email, password, env.ADMIN_EMAIL ?? '', env.ADMIN_PASSWORD ?? '')) {
			return null;
		}
		await ensureAdminUser(db, env);
		const row = await first(
			db
				.select()
				.from(users)
				.where(eq(users.email, env.ADMIN_EMAIL ?? ''))
		);
		return row ?? null;
	}
	// D1-managed: the row is the account, and the email is stored lowercased.
	const user = await first(
		db.select().from(users).where(eq(users.email, email.trim().toLowerCase()))
	);
	if (!user) return null;
	return (await verifyPassword(password, user.passwordHash)) ? user : null;
}

export async function purgeExpiredSessions(db: AppDb) {
	await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
