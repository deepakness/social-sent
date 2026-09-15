import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { totpStatus } from '$lib/server/totp';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		return ok(await totpStatus(locals.db, user.id));
	} catch (err) {
		return handleError(err);
	}
};
