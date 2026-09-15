import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { validatePollConfig } from '$lib/domain/poll';
import { first, newId } from '$lib/server/db/client';
import { drafts, draftVariants, publishTargets } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { draftHasInFlightPublish } from '$lib/server/publish-plan';
import { requireScope, requireUser } from '$lib/server/require';

const VISIBILITIES = new Set(['public', 'unlisted', 'private', 'direct']);

// Fail fast at write time: invalid options previously sat in the DB until
// publish, when the tick failed opaquely. Mirrors provider.validate rules.
function validateVariantOptions(options: unknown): string | null {
	if (options === undefined) return null;
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		return 'options must be an object';
	}
	const o = options as Record<string, unknown>;
	if (o.visibility !== undefined && !VISIBILITIES.has(String(o.visibility))) {
		return 'Invalid visibility';
	}
	if (o.poll !== undefined && o.poll !== null) {
		const poll = validatePollConfig(o.poll);
		if (!poll.ok) return poll.error;
	}
	if (o.threadSegments !== undefined) {
		if (!Array.isArray(o.threadSegments) || o.threadSegments.some((s) => typeof s !== 'string')) {
			return 'threadSegments must be an array of strings';
		}
	}
	return null;
}

async function rejectIfPublishing(db: App.Locals['db'], draftId: string) {
	const targets = await db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId));
	if (draftHasInFlightPublish(targets)) {
		return fail('Publishing in progress — try again shortly', 409);
	}
	return null;
}
import { serializeVariant } from '$lib/server/serialize';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const draft = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, params.id), eq(drafts.userId, user.id)))
		);
		if (!draft) return fail('Not found', 404);
		const busy = await rejectIfPublishing(locals.db, params.id);
		if (busy) return busy;
		const body = await request.json();
		const optionsError = validateVariantOptions(body.options);
		if (optionsError) return fail(optionsError);
		const platform = String(body.platform || '');
		if (
			platform !== 'mastodon' &&
			platform !== 'bluesky' &&
			platform !== 'linkedin' &&
			platform !== 'threads' &&
			platform !== 'x'
		) {
			return fail('platform must be mastodon, bluesky, linkedin, threads, or x');
		}
		const existing = await first(
			locals.db
				.select()
				.from(draftVariants)
				.where(and(eq(draftVariants.draftId, params.id), eq(draftVariants.platform, platform)))
		);
		const now = new Date();
		const optionsJson =
			body.options !== undefined
				? JSON.stringify(body.options ?? {})
				: (existing?.optionsJson ?? '{}');
		const variant = existing
			? (
					await locals.db
						.update(draftVariants)
						.set({
							body: body.body !== undefined ? body.body : existing.body,
							optionsJson,
							updatedAt: now
						})
						.where(eq(draftVariants.id, existing.id))
						.returning()
				)[0]
			: (
					await locals.db
						.insert(draftVariants)
						.values({
							id: newId(),
							draftId: params.id,
							platform,
							body: body.body ?? null,
							optionsJson,
							createdAt: now,
							updatedAt: now
						})
						.returning()
				)[0];
		return ok({ variant: serializeVariant(variant) });
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const draft = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, params.id), eq(drafts.userId, user.id)))
		);
		if (!draft) return fail('Not found', 404);
		const busy = await rejectIfPublishing(locals.db, params.id);
		if (busy) return busy;
		const platform = url.searchParams.get('platform');
		if (!platform) return fail('platform required');
		await locals.db
			.delete(draftVariants)
			.where(and(eq(draftVariants.draftId, params.id), eq(draftVariants.platform, platform)));
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};
