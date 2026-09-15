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
