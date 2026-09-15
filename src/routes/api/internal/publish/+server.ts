import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '$lib/server/http';
import { assertScheduler } from '$lib/server/require';
import { consumePublishJob } from '$lib/server/scheduler';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		assertScheduler(request, locals.env);
		const body = await request.json();
		const targetId = String(body.targetId || '');
		if (!targetId) return fail('targetId required');
		const result = await consumePublishJob(locals.db, locals.env, locals.media, targetId);
		return ok(result);
	} catch (err) {
		return handleError(err);
	}
};
