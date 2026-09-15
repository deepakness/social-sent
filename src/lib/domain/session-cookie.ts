export const SESSION_MAX_AGE_REMEMBER = 30 * 24 * 60 * 60;
export const SESSION_MAX_AGE_SESSION = 7 * 24 * 60 * 60;

export function shouldUseSecureCookie(opts: {
	/** Production build? Pass `import.meta.env.PROD` — never NODE_ENV, which
	 *  nothing sets in a Worker. */
	isProduction: boolean;
	appUrl?: string;
	requestHost?: string;
}): boolean {
	const appUrl = (opts.appUrl || '').trim();
	try {
		if (appUrl) {
			const u = new URL(appUrl);
			// URL.hostname keeps IPv6 brackets ("[::1]") — strip for comparison.
			const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
			if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
			if (u.protocol !== 'https:') return false;
			return true;
		}
	} catch {
		/* fall through */
	}
	// Strip IPv6 brackets and any :port before comparing: "[::1]:5173" and
	// "[::1]" must both match, and bare "::1" too. (URL.hostname keeps the
	// brackets, so compare the stripped form in both branches.)
	const rawHost = (opts.requestHost || '').toLowerCase();
	const noPort = rawHost.startsWith('[')
		? (rawHost.split(']')[0] ?? '').replace('[', '')
		: (rawHost.split(':')[0] ?? '');
	const host = noPort.replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
	return opts.isProduction;
}

export function sessionMaxAgeSeconds(remember: boolean): number {
	return remember ? SESSION_MAX_AGE_REMEMBER : SESSION_MAX_AGE_SESSION;
}

export function shouldSlideSession(expiresAt: Date, now: Date, maxAgeSeconds: number): boolean {
	const remaining = expiresAt.getTime() - now.getTime();
	return remaining < (maxAgeSeconds * 1000) / 2;
}

export function nextSessionExpiry(now: Date, maxAgeSeconds: number): Date {
	return new Date(now.getTime() + maxAgeSeconds * 1000);
}

// Idle timeout: absolute sliding expiry is not enough — an active attacker
// with a stolen cookie stays signed in for 30 days. Sessions idle longer
// than this are destroyed on next use, regardless of expiresAt.
export const SESSION_IDLE_MS = 24 * 60 * 60_000;
// lastSeenAt writes are throttled: at most one extra D1 write per window
// of active use instead of one per request.
export const SESSION_SEEN_WRITE_MS = 15 * 60_000;

export function isSessionIdle(lastSeen: Date | null | undefined, now: Date): boolean {
	if (!lastSeen) return false;
	return now.getTime() - lastSeen.getTime() > SESSION_IDLE_MS;
}

export function shouldTouchSeen(lastSeen: Date | null | undefined, now: Date): boolean {
	if (!lastSeen) return true;
	return now.getTime() - lastSeen.getTime() > SESSION_SEEN_WRITE_MS;
}
