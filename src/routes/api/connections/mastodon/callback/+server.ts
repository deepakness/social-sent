import { isRedirect, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { isLocalAppUrl } from '$lib/domain/app-url';
import { decryptSecret, encryptJson } from '$lib/server/crypto';
import { SESSION_COOKIE } from '$lib/server/auth';
import { splitOAuthState, verifyOAuthState } from '$lib/server/oauth-state';
import { first, newId } from '$lib/server/db/client';
import { connections, oauthPending } from '$lib/server/db/schema';
import { mastodonExchangeCode, providerFetch } from '$lib/server/providers';

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
	if (!pending || !pendingId || pending.id !== pendingId || pending.expiresAt < new Date()) {
		if (pending) await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
		redirect(302, `${appUrl}/accounts?error=oauth_expired`);
	}

	try {
		const allowLocal = isLocalAppUrl(locals.env.APP_URL);
		const clientSecret = await decryptSecret(
			pending.clientSecretEnc,
			locals.env.APP_ENCRYPTION_KEY
		);
		const exchanged = await mastodonExchangeCode(
			pending.instanceUrl,
			pending.clientId,
			clientSecret,
			code,
			locals.env.APP_URL,
			providerFetch,
			allowLocal
		);
		const encrypted = await encryptJson(
			{
				accessToken: exchanged.accessToken,
				clientId: exchanged.clientId,
				clientSecret: exchanged.clientSecret,
				instanceUrl: exchanged.instanceUrl
			},
			locals.env.APP_ENCRYPTION_KEY
		);
		const existing = await first(
			locals.db
				.select()
				.from(connections)
				.where(
					and(
						eq(connections.userId, pending.userId),
						eq(connections.platform, 'mastodon'),
						eq(connections.handle, exchanged.handle || ''),
						eq(connections.instanceUrl, exchanged.instanceUrl || '')
					)
				)
		);
		const now = new Date();
		const data = {
			displayName: exchanged.displayName || exchanged.handle || null,
			handle: exchanged.handle || null,
			avatarUrl: exchanged.avatarUrl || null,
			instanceUrl: exchanged.instanceUrl,
			credentialsEncrypted: encrypted,
			metaJson: JSON.stringify({ maxCharacters: exchanged.maxCharacters ?? 500 }),
			status: 'active',
			updatedAt: now
		};
		if (existing) {
			await locals.db.update(connections).set(data).where(eq(connections.id, existing.id));
		} else {
			await locals.db.insert(connections).values({
				id: newId(),
				userId: pending.userId,
				platform: 'mastodon',
				...data,
				createdAt: now
			});
		}
		await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
		redirect(302, `${appUrl}/accounts?connected=mastodon`);
	} catch (e) {
		if (isRedirect(e)) throw e;
		const message = e instanceof Error ? e.message : 'oauth_failed';
		redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(message)}`);
	}
};
