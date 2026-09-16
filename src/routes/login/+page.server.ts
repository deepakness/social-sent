import { redirect } from '@sveltejs/kit';
import { isFullyVerified, needsSetup, needsTotpEnroll } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// No account yet: the claim comes first, and it doubles as the login page.
	if (await needsSetup(locals.db, locals.env)) redirect(303, '/setup');
	if (isFullyVerified(locals.user)) redirect(303, '/');
	if (needsTotpEnroll(locals.user)) redirect(303, '/login/setup-2fa');
	return {};
};
