import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { hashPassword } from '$lib/server/crypto';
import { newId, first } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { needsSetup } from '$lib/server/auth';

const EMAIL_MAX = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

/**
 * First-run claim: creates the single account when the instance has none.
 *
 * The claim is a conditional insert — it only lands while the users table is
 * empty — so two people opening the page at the same time cannot both create an
 * account. Whoever claims first owns the instance; setting ADMIN_EMAIL and
 * ADMIN_PASSWORD as Worker secrets takes it back (env credentials are
 * authoritative, and the sweep removes other rows).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (!(await needsSetup(locals.db, locals.env))) {
			return fail('This instance is already set up', 409);
		}
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const email = String((body as Record<string, unknown>).email ?? '')
			.trim()
			.toLowerCase();
		const password = String((body as Record<string, unknown>).password ?? '');
		if (!EMAIL_SHAPE.test(email) || email.length > EMAIL_MAX) {
			return fail('Enter a valid email address', 400);
		}
		if (password.length < PASSWORD_MIN) {
			return fail(`Password must be at least ${PASSWORD_MIN} characters`, 400);
		}
		if (password.length > PASSWORD_MAX) return fail('Password is too long', 400);

		const id = newId();
		const now = Date.now();
		const passwordHash = await hashPassword(password);
		await locals.db.run(sql`
			INSERT INTO users (
				id, email, password_hash, display_name, timezone,
				created_at, updated_at, totp_enabled, totp_secret_enc,
				totp_enrolled_at, totp_last_step, settings_json
			)
			SELECT ${id}, ${email}, ${passwordHash}, NULL, 'UTC', ${now}, ${now}, 0, NULL, NULL, NULL, NULL
			WHERE NOT EXISTS (SELECT 1 FROM users)
		`);
		const created = await first(
			locals.db.select({ id: users.id }).from(users).where(eq(users.id, id))
		);
		if (!created) return fail('This instance was already claimed', 409);
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};
