import { timingSafeEqual, utf8Bytes } from './bytes';

/**
 * The app is same-origin: the browser UI calls its own /api/*, and API
 * consumers are non-browser scripts (curl, GH Actions) that ignore CORS.
 * So we send NO Access-Control-Allow-Origin on API responses. A wildcard
 * here would let any site read responses with fetch() (no credentials
 * needed for bearer-in-header flows once a token leaks into a page).
 * Kept as an empty map so call sites and the OPTIONS handler compile
 * unchanged; applyApiCors below is now a pass-through.
 */
export const API_CORS_HEADERS: Record<string, string> = {};

export function extractBearerToken(headers: { get(name: string): string | null }): string | null {
	const auth = headers.get('authorization');
	if (auth) {
		const match = /^Bearer\s+(\S+)/i.exec(auth.trim());
		if (match?.[1]) return match[1];
	}
	const alt = headers.get('x-socialsent-token') || headers.get('x-socialsent-scheduler');
	const token = alt?.trim();
	return token ? token : null;
}

export function secretMatches(
	provided: string | null | undefined,
	expected: string | null | undefined
): boolean {
	if (!provided || !expected) return false;
	const a = utf8Bytes(provided);
	const b = utf8Bytes(expected);
	if (a.length !== b.length) {
		timingSafeEqual(b, b);
		return false;
	}
	return timingSafeEqual(a, b);
}

export function anySecretMatches(
	provided: string | null | undefined,
	secrets: Array<string | null | undefined>
): boolean {
	let matched = false;
	for (const secret of secrets) {
		if (secretMatches(provided, secret)) matched = true;
	}
	return matched;
}

export function isInternalApiPath(path: string): boolean {
	return path === '/api/internal/tick' || path === '/api/internal/publish';
}

export function applyApiCors(_path: string, response: Response): Response {
	return response;
}

/**
 * CSRF guard for cookie-session mutations. Same-origin fetch sends Origin
 * (and usually Referer); non-browser API clients send neither. Rule: if the
 * client asserts an origin, it must match this request's origin. Absent
 * origin headers (curl, GH Actions) are allowed through to auth.
 */
export function hasAllowedMutationOrigin(
	request: { headers: { get(name: string): string | null } },
	url: URL
): boolean {
	const origin = request.headers.get('origin')?.trim();
	const referer = request.headers.get('referer')?.trim();
	if (!origin && !referer) return true;
	try {
		if (origin && new URL(origin).origin === url.origin) return true;
	} catch {
		return false;
	}
	try {
		if (referer && new URL(referer).origin === url.origin) return true;
	} catch {
		return false;
	}
	return false;
}
