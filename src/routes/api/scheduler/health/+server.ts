import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { schedulerHealth } from '$lib/server/scheduler';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireUser(locals.user);
		requireScope(locals, 'read');
		const ping = await schedulerHealth(locals.db);
		return ok({
			ok: ping.ok,
			error: ping.error,
			stuckPublishing: ping.stuckPublishing,
			overdue: ping.overdue,
			message: ping.stuckPublishing
				? `${ping.stuckPublishing} post${ping.stuckPublishing === 1 ? '' : 's'} stuck publishing — retry from Posts`
				: ping.ok
					? 'Scheduler reachable'
					: 'Scheduler delayed — GitHub Actions will catch up (often 15–75 minutes)'
		});
	} catch (err) {
		return handleError(err);
	}
};
