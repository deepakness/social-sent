import type { RequestHandler } from './$types';
import { parseApiScopes } from '$lib/domain/api-scopes';
import { getActiveApiKey, revokeApiKeys, rotateApiKey } from '$lib/server/api-keys';
import { fail, handleError, ok } from '$lib/server/http';
import { requireSession } from '$lib/server/require';

function metadataOf(
	active: {
		prefix: string;
		createdAt: Date;
		lastUsedAt: Date | null;
		scopes?: string | string[] | null;
	} | null
) {
	if (!active) return null;
	return {
		prefix: active.prefix,
		createdAt: active.createdAt,
		lastUsedAt: active.lastUsedAt,
		scopes: parseApiScopes(
			Array.isArray(active.scopes) ? JSON.stringify(active.scopes) : active.scopes
		)
	};
}

// Session-only key management: a leaked API key authenticates as the user but
// must never mint its own replacement or lock the owner out, so these
// endpoints reject bearer auth outright (see requireSession).
export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const active = await getActiveApiKey(locals.db, user.id);
		return ok({ active: metadataOf(active) });
	} catch (err) {
		return handleError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request?.json().catch(() => ({}))) ?? {};
		const { raw, prefix, createdAt, scopes } = await rotateApiKey(locals.db, user.id, body.scopes);
		// The raw key is returned exactly once; only its hash is stored.
		return ok({ key: raw, prefix, createdAt, scopes, rotated: true }, 201);
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const revoked = await revokeApiKeys(locals.db, user.id);
		if (revoked === 0) return fail('No active API key', 404);
		return ok({ ok: true, revoked });
	} catch (err) {
		return handleError(err);
	}
};
