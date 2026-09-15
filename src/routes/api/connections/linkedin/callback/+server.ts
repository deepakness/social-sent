import { isRedirect, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { decryptSecret, encryptJson } from '$lib/server/crypto';
import { SESSION_COOKIE } from '$lib/server/auth';
import { splitOAuthState, verifyOAuthState } from '$lib/server/oauth-state';
import { first, newId } from '$lib/server/db/client';
import { connections, oauthPending } from '$lib/server/db/schema';
import { linkedinExchangeCode } from '$lib/server/providers';

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
		pending.instanceUrl !== 'linkedin'
	) {
		if (pending) await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
		redirect(302, `${appUrl}/accounts?error=oauth_expired`);
	}

	try {
		const clientSecret = await decryptSecret(
			pending.clientSecretEnc,
			locals.env.APP_ENCRYPTION_KEY
		);
		const exchanged = await linkedinExchangeCode({
			clientId: pending.clientId,
			clientSecret,
			code,
			appUrl: locals.env.APP_URL
		});
		const encrypted = await encryptJson(
			{
				accessToken: exchanged.accessToken,
				refreshToken: exchanged.refreshToken,
				expiresAt: exchanged.expiresAt,
				tokenType: exchanged.tokenType,
				scopes: exchanged.scopes,
				clientId: pending.clientId,
				clientSecret,
				personUrn: exchanged.personUrn,
				openIdSub: exchanged.openIdSub
			},
			locals.env.APP_ENCRYPTION_KEY
		);
		const now = new Date();
		const data = {
			displayName: exchanged.displayName || exchanged.handle || null,
			handle: exchanged.handle || null,
			avatarUrl: exchanged.avatarUrl || null,
			credentialsEncrypted: encrypted,
			metaJson: JSON.stringify({ personUrn: exchanged.personUrn, maxCharacters: 3000 }),
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
						eq(connections.platform, 'linkedin'),
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
				platform: 'linkedin',
				...data,
				createdAt: now
			});
		}
		await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
		redirect(302, `${appUrl}/accounts?connected=linkedin`);
	} catch (e) {
		if (isRedirect(e)) throw e;
		const message = e instanceof Error ? e.message : 'oauth_failed';
		redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(message)}`);
	}
};
