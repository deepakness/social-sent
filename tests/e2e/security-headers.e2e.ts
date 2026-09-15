import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { e2eVars } from './e2e-env';

const vars = e2eVars();

/**
 * The Content-Security-Policy is only worth having if the app actually runs
 * under it. SvelteKit nonces its own inline hydration scripts, so `script-src`
 * needs no 'unsafe-inline' — and the moment a dependency injects a script or a
 * stylesheet from somewhere else, this spec fails instead of the browser
 * silently blocking it in production.
 */
function watchForViolations(page: Page): string[] {
	const violations: string[] = [];
	const note = (text: string) => {
		if (/content security policy|refused to (load|execute|apply)/i.test(text)) {
			violations.push(text);
		}
	};
	page.on('console', (msg: ConsoleMessage) => note(msg.text()));
	page.on('pageerror', (err: Error) => note(err.message));
	return violations;
}

async function signIn(page: Page) {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(vars.ADMIN_EMAIL);
		await page.getByLabel('Password').fill(vars.ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
}

test('page responses carry the security headers, and HSTS only over https', async ({ page }) => {
	const res = await page.goto('/login');
	expect(res).toBeTruthy();
	const headers = res!.headers();

	// The policy itself comes from SvelteKit (mode: 'auto' adds the nonce).
	expect(headers['content-security-policy']).toContain("default-src 'self'");
	expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(headers['content-security-policy']).toContain("object-src 'none'");
	expect(headers['content-security-policy']).toContain("connect-src 'self'");
	expect(headers['x-frame-options']).toBe('DENY');
	expect(headers['x-content-type-options']).toBe('nosniff');
	expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
	expect(headers['permissions-policy']).toContain('camera=()');
	// This server is plain http on purpose: pinning it to https would break
	// local development for good.
	expect(headers['strict-transport-security']).toBeUndefined();
});

test('every page runs without a CSP violation', async ({ page }) => {
	test.setTimeout(120_000);
	await signIn(page);
	const violations = watchForViolations(page);

	for (const path of ['/compose', '/posts', '/accounts', '/settings', '/insights', '/']) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		// Give hydration and the data fetches a moment to finish.
		await page.waitForTimeout(500);
	}

	expect(violations).toEqual([]);
});
