import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '$lib/server/db/client';
import { oauthPending, users } from '$lib/server/db/schema';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { POST as linkedinPOST } from '../src/routes/api/connections/linkedin/+server';
import { POST as mastodonPOST } from '../src/routes/api/connections/mastodon/+server';
import { POST as threadsPOST } from '../src/routes/api/connections/threads/+server';
import { POST as xPOST } from '../src/routes/api/connections/x/+server';

/**
 * The four connect entry points. They were untested: a regression here (a
 * dropped state binding, a wrong pending marker, a leaked authorize URL shape)
 * only surfaced when someone tried to connect a real account.
 */
describe('connect routes', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	/** Every provider configured, so the happy paths can run. */
	const env = {
		...TEST_ENV,
		THREADS_APP_ID: 'threads-app',
		THREADS_APP_SECRET: 'threads-secret',
		X_CLIENT_ID: 'x-client',
		X_CLIENT_SECRET: 'x-secret',
		LINKEDIN_CLIENT_ID: 'li-client',
		LINKEDIN_CLIENT_SECRET: 'li-secret'
	};

	const locals = (overrides: Record<string, unknown> = {}) => ({
		db,
		env,
		user: {
			id: userId,
			email: 'connect@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		authMethod: 'session' as const,
		...overrides
	});

	const call = (handler: unknown, body?: unknown, overrides: Record<string, unknown> = {}) =>
		(handler as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			}),
			locals: locals(overrides),
			cookies: { get: () => 'session-token' },
			url: new URL('http://localhost/api/connections')
		} as never) as Promise<Response>;

	const pendingFor = async (marker: string) =>
		(await db.select().from(oauthPending).where(eq(oauthPending.instanceUrl, marker)))[0];

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'connect@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());
	afterEach(() => vi.unstubAllGlobals());

	it('refuses bearer credentials — connecting is session-only', async () => {
		for (const handler of [mastodonPOST, threadsPOST, xPOST, linkedinPOST]) {
			const res = await call(
				handler,
				{ instanceUrl: 'https://mastodon.example' },
				{
					authMethod: 'bearer'
				}
			);
			expect(res.status).toBe(401);
		}
	});

	it('reports a provider that is not configured instead of throwing', async () => {
		// Mastodon is not in this list on purpose: it registers an app on the
		// instance itself and needs no client credentials of its own.
		const bare = { ...TEST_ENV };
		for (const handler of [threadsPOST, xPOST, linkedinPOST]) {
			const res = await call(handler, undefined, { env: bare });
			expect(res.status).toBe(500);
			expect(((await res.json()) as { error: string }).error).toMatch(/not configured/i);
		}
	});

	it('binds X state, stores a PKCE verifier and returns an authorize URL', async () => {
		const res = await call(xPOST);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { authorizeUrl: string };
		const url = new URL(body.authorizeUrl);
		expect(url.searchParams.get('code_challenge')).toBeTruthy();
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBeTruthy();

		const row = await pendingFor('x');
		expect(row.clientId).toBe('x-client');
		// The verifier travels encrypted, packed with the client secret.
		expect(row.clientSecretEnc).not.toContain('x-secret');
	});

	it('returns Threads and LinkedIn authorize URLs with a bound state', async () => {
		for (const [handler, marker, client] of [
			[threadsPOST, 'threads', 'threads-app'],
			[linkedinPOST, 'linkedin', 'li-client']
		] as const) {
			const res = await call(handler);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { authorizeUrl: string };
			const url = new URL(body.authorizeUrl);
			expect(url.searchParams.get('state')).toBeTruthy();
			expect(url.searchParams.get('client_id')).toBe(client);

			const row = await pendingFor(marker);
			expect(row.userId).toBe(userId);
			expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
		}
	});

	it('rejects a Mastodon instance the SSRF guard blocks', async () => {
		const fetched = vi.fn();
		vi.stubGlobal('fetch', fetched);
		// A real APP_URL keeps the local-host allowance off. The test env points
		// at localhost, which deliberately relaxes it so a local instance can be
		// connected.
		const production = { ...env, APP_URL: 'https://socialsent.example' };
		for (const instanceUrl of [
			'http://127.0.0.1:3000',
			'http://169.254.169.254',
			'metadata.google.internal',
			'https://db.internal'
		]) {
			const res = await call(mastodonPOST, { instanceUrl }, { env: production });
			expect(res.status).toBe(400);
		}
		expect(fetched).not.toHaveBeenCalled();
	});

	it('registers a Mastodon app and stores the pending row under the instance URL', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = String(input);
				if (url.endsWith('/api/v1/apps')) {
					return Response.json({ client_id: 'cid', client_secret: 'csecret' });
				}
				return new Response('unmocked', { status: 404 });
			})
		);
		const res = await call(mastodonPOST, { instanceUrl: 'https://mastodon.example' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { authorizeUrl: string };
		const url = new URL(body.authorizeUrl);
		expect(url.host).toBe('mastodon.example');
		expect(url.pathname).toBe('/oauth/authorize');

		// Mastodon stores the real instance URL (not a marker) so the callback
		// can match one row per account per instance.
		const row = await pendingFor('https://mastodon.example');
		expect(row.clientId).toBe('cid');
		expect(row.clientSecretEnc).not.toContain('csecret');
	});
});
