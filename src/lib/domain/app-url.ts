/**
 * Is this instance running on a local address?
 *
 * Used as the single "local instance" signal for local-only affordances:
 * tolerating example secrets, skipping 2FA when SKIP_TOTP is set, and allowing
 * OAuth/SSRF targets on localhost or private hosts.
 *
 * A build flag is deliberately NOT used for this: `wrangler dev` serves a
 * production build locally, so `import.meta.env.PROD` is true on a developer's
 * machine. APP_URL is what actually distinguishes a local instance from a
 * deployed one.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export function isLocalAppUrl(url: string | undefined | null): boolean {
	try {
		return LOCAL_HOSTS.has(new URL(String(url)).hostname);
	} catch {
		return false;
	}
}

/** Hosts that can only be reached from the machine running the server. */
const PRIVATE_HOST =
	/^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

export function isLocalRequestHost(host: string | undefined | null): boolean {
	let h = String(host ?? '')
		.toLowerCase()
		.trim();
	if (!h) return false;
	// Accept a `host:port` form. Bracketed IPv6 keeps its brackets; a bare IPv6
	// literal has several colons and must not be sliced.
	if (h.startsWith('[')) {
		const end = h.indexOf(']');
		if (end !== -1) h = h.slice(0, end + 1);
	} else {
		const parts = h.split(':');
		if (parts.length === 2) h = parts[0];
	}
	if (LOCAL_HOSTS.has(h) || h.endsWith('.localhost')) return true;
	// A dev server reached from a phone or another machine on the same network.
	return PRIVATE_HOST.test(h);
}

/**
 * A deployed Worker that still thinks it is a local instance.
 *
 * `isLocalAppUrl` alone is not enough: `.dev.vars.example` ships
 * `APP_URL=http://localhost:5173`, and the "Deploy to Cloudflare" button offers
 * that value as a pre-filled prompt. Accepting it on a real deployment would
 * turn off the example-secret guard (and the SKIP_TOTP gate) on the public
 * internet, so an APP_URL that is local while the request is not is treated as
 * a misconfiguration rather than a local instance.
 */
export function isMisconfiguredLocalInstance(
	appUrl: string | undefined | null,
	requestHost: string | undefined | null
): boolean {
	return isLocalAppUrl(appUrl) && !isLocalRequestHost(requestHost);
}
