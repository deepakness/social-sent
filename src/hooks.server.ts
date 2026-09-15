import type { Handle } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import {
	anySecretMatches,
	applyApiCors,
	extractBearerToken,
	hasAllowedMutationOrigin,
	isInternalApiPath,
	secretMatches
} from '$lib/domain/bearer';
import { isApiKeyFormat, touchApiKey, verifyApiKey } from '$lib/server/api-keys';
import {
	SESSION_COOKIE,
	asMachineUser,
	cookieSecureFlag,
	ensureAdminUser,
	getSessionUser,
	isFullyVerified,
	needsTotpEnroll
} from '$lib/server/auth';
import { createD1Db, first } from '$lib/server/db/client';
import { ensureSchemaOnce } from '$lib/server/db/init-sql';
import { users } from '$lib/server/db/schema';
import { envFromPlatform } from '$lib/server/env';
import { memoryMediaStore, r2MediaStore } from '$lib/server/media';
import { runSchedulerTick } from '$lib/server/scheduler';

export function isPublicPath(path: string): boolean {
	if (path === '/login' || path === '/login/setup-2fa' || path === '/login/verify') return true;
	if (
		path === '/api/health' ||
		path.startsWith('/api/media/public/') ||
		path.startsWith('/api/connections/mastodon/callback') ||
		path.startsWith('/api/connections/linkedin/callback') ||
		path.startsWith('/api/connections/threads/callback') ||
		path.startsWith('/api/connections/x/callback')
	)
		return true;
	if (path === '/api/auth/login' || path === '/api/auth/logout' || path === '/api/auth/me')
		return true;
	if (path.startsWith('/api/auth/totp/enroll') || path.startsWith('/api/auth/totp/verify'))
		return true;
	return false;
}

function withPageSecurity(path: string, response: Response, secure: boolean): Response {
	const next = applyApiCors(path, response);
	if (secure) {
		// Only over https: pinning a plain-http local dev server to https would
		// break it in the browser for good.
		next.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}
	next.headers.set('X-Content-Type-Options', 'nosniff');
	next.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	// The app uses none of these; saying so stops a future dependency from
	// asking the browser for them. Clipboard access is left at its 'self'
	// default because the API-key copy button needs it.
	next.headers.set(
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), midi=()'
	);
	if (!path.startsWith('/api/')) {
		next.headers.set('X-Frame-Options', 'DENY');
	}
	return next;
}

function deny(path: string, status: number, body: unknown, secure: boolean, location?: string) {
	if (location && !path.startsWith('/api/')) {
		return withPageSecurity(path, new Response(null, { status, headers: { location } }), secure);
	}
	return withPageSecurity(path, json(body, { status }), secure);
}

let lastLocalTickAt = 0;

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const secureRequest = event.url.protocol === 'https:';
	if (event.request.method === 'OPTIONS' && path.startsWith('/api/')) {
		// Same-origin app: no CORS preflight needed. Bare 204 (no
		// Access-Control-* headers) so browsers default-deny cross-origin reads.
		return new Response(null, { status: 204 });
	}

	const platformEnv = event.platform?.env as Env | undefined;
	if (!platformEnv?.DB) {
		throw new Error('D1 binding DB is missing. Run via vite (adapter-cloudflare) or wrangler.');
	}

	await ensureSchemaOnce(platformEnv.DB);
	const appEnv = envFromPlatform(platformEnv as unknown as Record<string, unknown>);
	const db = createD1Db(platformEnv.DB);
	event.locals.db = db;
	event.locals.env = appEnv;
	// Fail closed in prod when the R2 binding is missing: persisting draft_media
	// rows against a per-request in-memory Map silently loses bytes on next
	// request. DEV keeps the memory fallback for local runs without R2.
	if (platformEnv.MEDIA) {
		event.locals.media = r2MediaStore(platformEnv.MEDIA);
	} else if (import.meta.env.DEV) {
		console.warn('[media] R2 MEDIA binding missing; using ephemeral memory store (DEV only)');
		event.locals.media = memoryMediaStore();
	} else {
		throw new Error('R2 binding MEDIA is missing. Configure an R2 bucket for media storage.');
	}
	const queue = platformEnv.PUBLISH_QUEUE;
	event.locals.queue = queue ? { send: (body) => queue.send(body) } : null;

	event.locals.authMethod = null;
	event.locals.apiKeyScopes = null;
	const raw = event.cookies.get(SESSION_COOKIE);
	const bearer = extractBearerToken(event.request.headers);
	// The admin row is only needed to mint the machine user for the env
	// API_TOKEN and to save a lookup when a personal key belongs to the admin
	// (the API-key path below falls back to a lookup by id). A fully anonymous
	// request needs neither, and skipping it here keeps unauthenticated traffic
	// — health probes, bots probing /login — from doing D1 work on every hit.
	// Login bootstraps the row itself when a fresh database has none.
	const hasCredential =
		bearer !== null || (event.request.headers.get('x-api-key')?.trim() ?? '') !== '';
	const admin = hasCredential ? await ensureAdminUser(db, appEnv, platformEnv.DB) : null;

	const session = await getSessionUser(db, appEnv, raw);
	event.locals.user = session?.user ?? null;
	if (session?.user) event.locals.authMethod = 'session';
	if (session?.slideMaxAge && raw) {
		event.cookies.set(SESSION_COOKIE, raw, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: cookieSecureFlag(appEnv, event.url.host),
			maxAge: session.slideMaxAge
		});
	}

	if (secretMatches(bearer, appEnv.API_TOKEN)) {
		const row =
			admin ?? (await first(db.select().from(users).where(eq(users.email, appEnv.ADMIN_EMAIL))));
		if (row) {
			event.locals.user = asMachineUser(row);
			event.locals.authMethod = 'bearer';
		}
	} else if (!event.locals.user) {
		// Personal API key: `Authorization: Bearer sent_…` or the `X-API-Key`
		// header (never query strings — they leak into logs). Cookie sessions
		// win when both are present. Format-gated before any hashing or D1
		// query; only active (non-revoked) hashes verify.
		const apiKeyHeader = event.request.headers.get('x-api-key')?.trim() || null;
		const candidate =
			apiKeyHeader && apiKeyHeader.length > 0
				? apiKeyHeader
				: isApiKeyFormat(bearer)
					? bearer
					: null;
		if (isApiKeyFormat(candidate)) {
			const verified = await verifyApiKey(db, candidate);
			const userRow =
				verified && admin && admin.id === verified.userId
					? admin
					: verified
						? await first(db.select().from(users).where(eq(users.id, verified.userId)))
						: null;
			if (verified && userRow) {
				event.locals.user = asMachineUser(userRow);
				event.locals.authMethod = 'bearer';
				event.locals.apiKeyScopes = verified.scopes;
				const touch = touchApiKey(db, verified.keyId);
				try {
					event.platform?.ctx?.waitUntil(touch);
				} catch {
					// waitUntil unavailable (tests, preview): the touch still
					// runs; last_used_at is best-effort metadata either way.
				}
			}
		}
	}

	if (import.meta.env.DEV) {
		const nowMs = Date.now();
		if (nowMs - lastLocalTickAt > 30_000) {
			lastLocalTickAt = nowMs;
			void runSchedulerTick(db, appEnv, {
				store: event.locals.media,
				queue: event.locals.queue
			}).catch((err) => console.error('[scheduler] local tick failed', err));
		}
	}

	// CSRF: cookie-session mutations must come from this origin. Bearer/API-key
	// clients (curl, GH Actions) send no Origin/Referer and skip this check.
	if (
		event.locals.authMethod === 'session' &&
		path.startsWith('/api/') &&
		!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) &&
		!hasAllowedMutationOrigin(event.request, event.url)
	) {
		return deny(path, 403, { error: 'Origin mismatch' }, secureRequest);
	}

	// Scheduler bypass: SCHEDULER_SECRET (preferred) or API_TOKEN. AUTH_SECRET
	// signs sessions/challenges and must never be accepted on the wire here.
	if (
		isInternalApiPath(path) &&
		anySecretMatches(bearer, [appEnv.SCHEDULER_SECRET, appEnv.API_TOKEN])
	) {
		return withPageSecurity(path, await resolve(event), secureRequest);
	}

	// Dev convenience: SKIP_TOTP (honored for localhost APP_URLs only) treats
	// 2FA as satisfied so local runs skip the enroll/verify dance entirely.
	if (appEnv.skipTotp && event.locals.user) {
		event.locals.user = { ...event.locals.user, totpEnabled: true, mfaVerified: true };
	}

	if (event.locals.user?.totpEnabled && !event.locals.user.mfaVerified) {
		event.locals.user = null;
	}

	const user = event.locals.user;
	if (needsTotpEnroll(user)) {
		const allowed =
			path === '/login/setup-2fa' ||
			path === '/login' ||
			path.startsWith('/api/auth/totp/enroll') ||
			path === '/api/auth/logout' ||
			path === '/api/auth/me';
		if (!allowed) {
			if (path.startsWith('/api/'))
				return deny(path, 401, { error: 'Unauthorized' }, secureRequest);
			return deny(path, 303, { error: 'Unauthorized' }, secureRequest, '/login/setup-2fa');
		}
		return withPageSecurity(path, await resolve(event), secureRequest);
	}

	if (!isFullyVerified(user) && !isPublicPath(path)) {
		if (path.startsWith('/api/')) return deny(path, 401, { error: 'Unauthorized' }, secureRequest);
		return deny(path, 303, { error: 'Unauthorized' }, secureRequest, '/login');
	}

	return withPageSecurity(path, await resolve(event), secureRequest);
};
