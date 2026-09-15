import { z } from 'zod';
import { isLocalAppUrl } from '$lib/domain/app-url';

const envSchema = z.object({
	// Required, with no localhost default: a deploy that forgets APP_URL should
	// fail loudly rather than silently behave like a local instance (which would
	// also drop the Secure cookie flag and switch off the guards below).
	APP_URL: z.string().min(1),
	// Instance display name: the UI title, header and login screen. Self-hosters
	// can rename their instance from config without touching code.
	APP_NAME: z.string().min(1).default('SocialSent'),
	// 32+ chars (≈256-bit when random). TEST/dev use 64-hex; weak keys make the
	// DB-stored OAuth/TOTP ciphertexts trivially brute-forceable on DB leak.
	APP_ENCRYPTION_KEY: z.string().min(32),
	AUTH_SECRET: z.string().min(16),
	ADMIN_EMAIL: z.string().min(3),
	ADMIN_PASSWORD: z.string().min(8),
	SCHEDULER_SECRET: z.string().min(32).optional(),
	API_TOKEN: z.string().min(16).optional(),
	// Local-dev convenience: skip the 2FA enrollment/verify dance. Honored only
	// when APP_URL is localhost (see readAppEnv) so it can never leak to prod.
	SKIP_TOTP: z.string().optional(),
	LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
	LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
	THREADS_APP_ID: z.string().min(1).optional(),
	THREADS_APP_SECRET: z.string().min(1).optional(),
	X_CLIENT_ID: z.string().min(1).optional(),
	X_CLIENT_SECRET: z.string().min(1).optional(),
	// Failure-digest email (Resend). All optional: when unset, the digest is
	// a no-op and failures only surface on the dashboard/posts tabs.
	RESEND_API_KEY: z.string().min(1).optional(),
	NOTIFY_EMAIL: z.string().min(3).optional(),
	NOTIFY_FROM: z.string().min(3).optional(),
	// Optional public media origin (for example an R2 custom domain with
	// Cloudflare cache). When set, Threads is handed direct URLs here instead
	// of the signed Worker route, which removes the Worker/R2 hop from Meta's
	// crawler fetch. Deliberately not schema-validated: a bad value degrades
	// to the signed route (publicMediaUrlFor) instead of 500ing every
	// request over an optional optimization.
	MEDIA_PUBLIC_BASE_URL: z.string().optional()
});

export type AppEnv = z.infer<typeof envSchema> & {
	skipTotp: boolean;
};

const PLACEHOLDER_SECRETS = new Set([
	'change-me',
	// Current .dev.vars.example values.
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	// Earlier example values: still listed so a stale .dev.vars, or a deploy
	// that copied one, keeps being rejected after the rename.
	'dev-auth-secret-change-me',
	'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
]);

export function readAppEnv(source: Record<string, string | undefined>): AppEnv {
	const parsed = envSchema.safeParse(source);
	if (!parsed.success) {
		const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new Error(`Invalid environment: ${msg}`);
	}
	// Fail closed anywhere that is not a local instance: example values from
	// .dev.vars.example must never reach a public deployment, where a
	// publicly-known encryption key would mean total credential decryption.
	// APP_URL — not a build flag — decides what counts as local, because
	// `wrangler dev` serves a production build on a developer's machine.
	const localInstance = isLocalAppUrl(parsed.data.APP_URL);
	if (!localInstance) {
		for (const key of ['APP_ENCRYPTION_KEY', 'AUTH_SECRET', 'ADMIN_PASSWORD'] as const) {
			if (PLACEHOLDER_SECRETS.has(source[key] ?? '')) {
				throw new Error(`Invalid environment: ${key} must not be an example value`);
			}
		}
	}
	// SKIP_TOTP is a local-dev convenience: without this guard a stray secret
	// (or a pasted .dev.vars into prod) would silently disable 2FA. Honored for
	// a local instance only.
	const skipTotp =
		Boolean(source.SKIP_TOTP) &&
		!['0', 'false', 'no', 'off'].includes((source.SKIP_TOTP ?? '').toLowerCase()) &&
		localInstance;
	return { ...parsed.data, skipTotp };
}

function procEnv(): Record<string, string | undefined> {
	try {
		return (
			(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
		);
	} catch {
		return {};
	}
}

export function envFromPlatform(platformEnv: Record<string, unknown> | undefined): AppEnv {
	const fallback = procEnv();
	const src: Record<string, string | undefined> = {
		APP_URL: asString(platformEnv?.APP_URL) ?? fallback.APP_URL,
		APP_NAME: asString(platformEnv?.APP_NAME) ?? fallback.APP_NAME,
		APP_ENCRYPTION_KEY: asString(platformEnv?.APP_ENCRYPTION_KEY) ?? fallback.APP_ENCRYPTION_KEY,
		AUTH_SECRET: asString(platformEnv?.AUTH_SECRET) ?? fallback.AUTH_SECRET,
		ADMIN_EMAIL: asString(platformEnv?.ADMIN_EMAIL) ?? fallback.ADMIN_EMAIL,
		ADMIN_PASSWORD: asString(platformEnv?.ADMIN_PASSWORD) ?? fallback.ADMIN_PASSWORD,
		SCHEDULER_SECRET: asString(platformEnv?.SCHEDULER_SECRET) ?? fallback.SCHEDULER_SECRET,
		API_TOKEN: asString(platformEnv?.API_TOKEN) ?? fallback.API_TOKEN,
		LINKEDIN_CLIENT_ID: asString(platformEnv?.LINKEDIN_CLIENT_ID) ?? fallback.LINKEDIN_CLIENT_ID,
		LINKEDIN_CLIENT_SECRET:
			asString(platformEnv?.LINKEDIN_CLIENT_SECRET) ?? fallback.LINKEDIN_CLIENT_SECRET,
		THREADS_APP_ID: asString(platformEnv?.THREADS_APP_ID) ?? fallback.THREADS_APP_ID,
		THREADS_APP_SECRET: asString(platformEnv?.THREADS_APP_SECRET) ?? fallback.THREADS_APP_SECRET,
		X_CLIENT_ID: asString(platformEnv?.X_CLIENT_ID) ?? fallback.X_CLIENT_ID,
		X_CLIENT_SECRET: asString(platformEnv?.X_CLIENT_SECRET) ?? fallback.X_CLIENT_SECRET,
		RESEND_API_KEY: asString(platformEnv?.RESEND_API_KEY) ?? fallback.RESEND_API_KEY,
		NOTIFY_EMAIL: asString(platformEnv?.NOTIFY_EMAIL) ?? fallback.NOTIFY_EMAIL,
		NOTIFY_FROM: asString(platformEnv?.NOTIFY_FROM) ?? fallback.NOTIFY_FROM,
		MEDIA_PUBLIC_BASE_URL:
			asString(platformEnv?.MEDIA_PUBLIC_BASE_URL) ?? fallback.MEDIA_PUBLIC_BASE_URL,
		SKIP_TOTP: asString(platformEnv?.SKIP_TOTP) ?? fallback.SKIP_TOTP
	};
	return readAppEnv(src);
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}
