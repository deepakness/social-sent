import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { hashPassword, verifyPassword } from '$lib/server/crypto';
import { users } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { getAdminUser, hasEnvCredentials, revokeOtherSessions } from '$lib/server/auth';
import { requireSession } from '$lib/server/require';

const EMAIL_MAX = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

/**
 * The login itself: email and password.
 *
 * Session-only and re-authenticated with the current password — a leaked API
 * key must never be able to take over the account. Only available while the
 * account lives in D1: when ADMIN_EMAIL/ADMIN_PASSWORD are set as Worker
 * secrets those stay authoritative, and this reports that instead of silently
 * diverging from them.
 */
export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireSession(locals.user, locals.authMethod);
		return ok({
			managedByEnv: hasEnvCredentials(locals.env),
			email: locals.user?.email ?? null
		});
	} catch (err) {
		return handleError(err);
	}
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		if (hasEnvCredentials(locals.env)) {
			return fail('The login is managed by Worker secrets (ADMIN_EMAIL / ADMIN_PASSWORD)', 409);
		}
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const payload = body as Record<string, unknown>;
		const currentPassword = String(payload.currentPassword ?? '');
		if (!currentPassword) return fail('Enter your current password', 400);

		const row = await getAdminUser(locals.db, locals.env);
		if (!row) return fail('This instance has no account yet', 409);
		if (!(await verifyPassword(currentPassword, row.passwordHash))) {
			return fail('Current password is incorrect', 401);
		}

		const wantEmail = Object.hasOwn(payload, 'email');
		const wantPassword = Object.hasOwn(payload, 'newPassword');
		const email = String(payload.email ?? '')
			.trim()
			.toLowerCase();
		const newPassword = String(payload.newPassword ?? '');
		if (wantEmail && (!EMAIL_SHAPE.test(email) || email.length > EMAIL_MAX)) {
			return fail('Enter a valid email address', 400);
		}
		if (wantPassword) {
			if (newPassword.length < PASSWORD_MIN) {
				return fail(`Password must be at least ${PASSWORD_MIN} characters`, 400);
			}
			if (newPassword.length > PASSWORD_MAX) return fail('Password is too long', 400);
			if (await verifyPassword(newPassword, row.passwordHash)) {
				return fail('That is already your password', 400);
			}
		}
		if (!wantEmail && !wantPassword) return fail('Nothing to change', 400);

		await locals.db
			.update(users)
			.set({
				...(wantEmail ? { email } : {}),
				...(wantPassword ? { passwordHash: await hashPassword(newPassword) } : {}),
				updatedAt: new Date()
			})
			.where(eq(users.id, row.id));

		// A password change invalidates every session, including this one: the
		// client signs in again with the new password.
		if (wantPassword) await revokeOtherSessions(locals.db, row.id, undefined);
		return ok({ email: wantEmail ? email : user.email, reauth: wantPassword });
	} catch (err) {
		return handleError(err);
	}
};
