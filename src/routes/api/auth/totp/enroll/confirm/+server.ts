import type { RequestHandler } from './$types';
import { clearMfaCookie, setSessionCookie } from '$lib/server/cookies';
import { fail, handleError, ok } from '$lib/server/http';
import { enrollConfirm, MFA_COOKIE } from '$lib/server/totp';

export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		const body = await request.json();
		const code = String(body.code || '');
		const raw = cookies.get(MFA_COOKIE);
		if (!raw) return fail('Setup expired — sign in again', 401);
		const result = await enrollConfirm(locals.db, locals.env, raw, code);
		clearMfaCookie(cookies);
		setSessionCookie(cookies, locals.env, url.host, result.raw, result.maxAge);
		return ok({ user: result.user });
	} catch (err) {
		return handleError(err);
	}
};
