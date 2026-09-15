import { eq, inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { isFullyVerified, needsTotpEnroll } from '$lib/server/auth';
import { clearMfaCookie, clearSessionCookie } from '$lib/server/cookies';
import { chunkIds } from '$lib/server/db/client';
import { draftMedia, drafts, users } from '$lib/server/db/schema';
import { handleError, ok } from '$lib/server/http';
import { requireSession } from '$lib/server/require';

export const GET: RequestHandler = async ({ locals }) => {
	const user = locals.user;
	return ok({
		user: isFullyVerified(user)
			? { id: user!.id, email: user!.email, timezone: user!.timezone }
			: null,
		needsEnroll: needsTotpEnroll(user),
		totpEnabled: Boolean(user?.totpEnabled)
	});
};

// Permanently delete the account and all associated data (drafts,
// connections, targets, keys — everything cascades off users). Session-only:
// bearer credentials must never reach it.
export const DELETE: RequestHandler = async ({ locals, cookies, url }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		// Cascade wipes all rows but not R2 bytes: remove media objects
		// first so a crash leaves retryable rows instead of orphaned bytes.
		const userDrafts = await locals.db
			.select({ id: drafts.id })
			.from(drafts)
			.where(eq(drafts.userId, user.id));
		for (const chunk of chunkIds(userDrafts.map((d) => d.id))) {
			if (!chunk.length) break;
			const files = await locals.db
				.select({ storageKey: draftMedia.storageKey })
				.from(draftMedia)
				.where(inArray(draftMedia.draftId, chunk));
			for (const f of files) await locals.media.delete(f.storageKey);
		}
		await locals.db.delete(users).where(eq(users.id, user.id));
		clearSessionCookie(cookies, locals.env, url.host);
		clearMfaCookie(cookies, locals.env, url.host);
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};
