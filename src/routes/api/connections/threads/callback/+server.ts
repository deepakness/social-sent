import { isRedirect, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { decryptSecret, encryptJson } from '$lib/server/crypto';
import { SESSION_COOKIE } from '$lib/server/auth';
import { splitOAuthState, verifyOAuthState } from '$lib/server/oauth-state';
import { first, newId } from '$lib/server/db/client';
import { connections, oauthPending } from '$lib/server/db/schema';
import { threadsExchangeCode } from '$lib/server/providers';

export const GET: RequestHandler = async ({ url, locals, cookies }) => {
	const appUrl = locals.env.APP_URL.replace(/\/$/, '');
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const err = url.searchParams.get('error');
	if (err) redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(err)}`);
	if (!code || !state) redirect(302, `${appUrl}/accounts?error=missing_code`);

	const candidate = splitOAuthState(state);
	const pending = candidate
		? await first(locals.db.select().from(oauthPending).where(eq(oauthPending.id, candidate)))
		: null;
	const sessionId = cookies.get(SESSION_COOKIE) ?? (pending ? `machine:${pending.userId}` : null);
	const pendingId = await verifyOAuthState({ secret: locals.env.AUTH_SECRET, state, sessionId });
	if (
		!pending ||
		!pendingId ||
		pending.id !== pendingId ||
		pending.expiresAt < new Date() ||
		pending.instanceUrl !== 'threads'
	) {
		if (pending) await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
		redirect(302, `${appUrl}/accounts?error=oauth_expired`);
	}

	try {
		const appSecret = await decryptSecret(pending.clientSecretEnc, locals.env.APP_ENCRYPTION_KEY);
		const exchanged = await threadsExchangeCode({
			appId: pending.clientId,
			appSecret,
			code,
			appUrl: locals.env.APP_URL
		});
		// NOTE: the global appSecret is deliberately NOT persisted per row.
		// Threads refresh/verify need only the access token; the secret stays
		// in env (and short-lived in oauth_pending) to shrink blast radius.
		const encrypted = await encryptJson(
			{
				accessToken: exchanged.accessToken,
				expiresAt: exchanged.expiresAt,
				tokenType: exchanged.tokenType,
				scopes: exchanged.scopes,
				clientId: pending.clientId,
				threadsUserId: exchanged.threadsUserId,
				threadsUsername: exchanged.threadsUsername
			},
			locals.env.APP_ENCRYPTION_KEY
		);
		const now = new Date();
		const data = {
			displayName: exchanged.displayName || exchanged.handle || null,
			handle: exchanged.handle || null,
			avatarUrl: exchanged.avatarUrl || null,
			credentialsEncrypted: encrypted,
			metaJson: JSON.stringify({ threadsUserId: exchanged.threadsUserId, maxCharacters: 500 }),
			status: 'active',
			updatedAt: now
		};
		const existing = await first(
			locals.db
				.select()
				.from(connections)
				.where(
					and(
						eq(connections.userId, pending.userId),
						eq(connections.platform, 'threads'),
						eq(connections.handle, exchanged.handle || '')
					)
				)
		);
		if (existing) {
			await locals.db.update(connections).set(data).where(eq(connections.id, existing.id));
		} else {
			await locals.db.insert(connections).values({
				id: newId(),
				userId: pending.userId,
				platform: 'threads',
				...data,
				createdAt: now
			});
		}
		await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
		redirect(302, `${appUrl}/accounts?connected=threads`);
	} catch (e) {
		if (isRedirect(e)) throw e;
		const message = e instanceof Error ? e.message : 'oauth_failed';
		redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(message)}`);
	}
};
