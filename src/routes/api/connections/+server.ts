import { and, desc, eq, ne } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { connections } from '$lib/server/db/schema';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { serializeConnection } from '$lib/server/serialize';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		// Slim select: never ship credentialsEncrypted/userId/updatedAt to the
		// client (serializeConnection drops them anyway). Saves D1 bytes on
		// every Accounts/Composer load.
		const rows = await locals.db
			.select({
				id: connections.id,
				platform: connections.platform,
				displayName: connections.displayName,
				handle: connections.handle,
				avatarUrl: connections.avatarUrl,
				instanceUrl: connections.instanceUrl,
				status: connections.status,
				metaJson: connections.metaJson,
				createdAt: connections.createdAt
			})
			.from(connections)
			// Disconnected rows are archive tombstones (published posts keep
			// referencing them); they are not connectable accounts and must
			// not render as expired accounts waiting for a reconnect.
			.where(and(eq(connections.userId, user.id), ne(connections.status, 'disconnected')))
			.orderBy(desc(connections.createdAt));
		// OAuth platforms needing server-side app credentials: the connect
		// button can render its "not configured" state without a failed POST.
		const configured = {
			linkedin: Boolean(locals.env.LINKEDIN_CLIENT_ID && locals.env.LINKEDIN_CLIENT_SECRET),
			threads: Boolean(locals.env.THREADS_APP_ID && locals.env.THREADS_APP_SECRET),
			x: Boolean(locals.env.X_CLIENT_ID)
		};
		return ok({ connections: rows.map(serializeConnection), configured });
	} catch (err) {
		return handleError(err);
	}
};
