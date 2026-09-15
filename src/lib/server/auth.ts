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
import { hashPassword, hmacHex } from './crypto';
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

// Binds a session to the password that minted it: rotating ADMIN_PASSWORD
// invalidates every outstanding session on next use (previously they lived
// on until expiry). Compared in constant structure, never logged.
export async function sessionPasswordFp(env: AppEnv): Promise<string> {
	return hmacHex(env.AUTH_SECRET, `pwd-fp:${env.ADMIN_PASSWORD}`);
}

// Tracks (binding, admin email) pairs already swept for stray users. A changed
// ADMIN_EMAIL always ships with a redeploy (new isolate), so the flag cannot
// go stale: the sweep re-runs exactly once per deployment. Callers without a
// stable binding (tests) omit it and always sweep.
const sweptAdminBindings = new WeakMap<object, Set<string>>();

export async function ensureAdminUser(db: AppDb, env: AppEnv, d1?: object) {
	let existing = await first(db.select().from(users).where(eq(users.email, env.ADMIN_EMAIL)));
	if (!existing) {
		const now = new Date();
		const row = {
			id: newId(),
			email: env.ADMIN_EMAIL,
			passwordHash: await hashPassword(env.ADMIN_PASSWORD),
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
			existing = await first(db.select().from(users).where(eq(users.email, env.ADMIN_EMAIL)));
		}
	}
	if (!existing) throw new Error('Failed to bootstrap admin user');
	const swept = d1 ? (sweptAdminBindings.get(d1) ?? new Set<string>()) : null;
	if (!swept?.has(env.ADMIN_EMAIL)) {
		await db.delete(users).where(ne(users.email, env.ADMIN_EMAIL));
		if (d1 && swept) {
			swept.add(env.ADMIN_EMAIL);
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
	mfaVerified = false
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
		pwdFp: await sessionPasswordFp(env),
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
				mfaVerified: sessions.mfaVerified
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
	const fp = await sessionPasswordFp(env);
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
	if (!envCredentialsMatch(email, password, env.ADMIN_EMAIL, env.ADMIN_PASSWORD)) return null;
	await ensureAdminUser(db, env);
	const user = await first(db.select().from(users).where(eq(users.email, env.ADMIN_EMAIL)));
	if (!user) return null;
	return user;
}

export async function purgeExpiredSessions(db: AppDb) {
	await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
