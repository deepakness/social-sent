import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { needsSetup } from '$lib/server/auth';

/** The claim page exists only while the instance has no account. */
export const load: PageServerLoad = async ({ locals }) => {
	if (!(await needsSetup(locals.db, locals.env))) redirect(303, '/login');
	return {};
};
