import { describe, expect, it } from 'vitest';
import {
	isLocalAppUrl,
	isLocalRequestHost,
	isMisconfiguredLocalInstance
} from '$lib/domain/app-url';

/**
 * The "local instance" signal decides whether example secrets are tolerated and
 * whether SKIP_TOTP can be honored. `.dev.vars.example` ships a localhost
 * APP_URL and the Deploy-to-Cloudflare flow offers it as a pre-filled prompt,
 * so the signal must require a local *request* too — otherwise a public
 * deployment runs with the published example keys.
 */
describe('local instance detection', () => {
	it('recognises local APP_URLs', () => {
		for (const url of ['http://localhost:5173', 'http://127.0.0.1:8787', 'http://[::1]:3000']) {
			expect(isLocalAppUrl(url)).toBe(true);
		}
		for (const url of ['https://socialsent.example.com', '', null, 'not a url']) {
			expect(isLocalAppUrl(url)).toBe(false);
		}
	});

	it('recognises hosts that can only be reached locally', () => {
		for (const host of ['localhost', 'localhost:4173', 'dev.localhost', '127.0.0.1', '::1']) {
			expect(isLocalRequestHost(host)).toBe(true);
		}
		// A dev server opened from a phone on the same network is still local.
		expect(isLocalRequestHost('192.168.1.20:5173')).toBe(true);
		expect(isLocalRequestHost('10.0.0.5')).toBe(true);
		expect(isLocalRequestHost('172.20.3.4')).toBe(true);
		for (const host of ['socialsent.example.com', 'socialsent.acct.workers.dev', '172.32.0.1']) {
			expect(isLocalRequestHost(host)).toBe(false);
		}
	});

	it('flags only a local APP_URL served from a non-local host', () => {
		expect(isMisconfiguredLocalInstance('http://localhost:5173', 'localhost:4173')).toBe(false);
		expect(isMisconfiguredLocalInstance('http://localhost:5173', '192.168.1.20')).toBe(false);
		expect(isMisconfiguredLocalInstance('https://social.example', 'social.example')).toBe(false);
		expect(isMisconfiguredLocalInstance('http://localhost:5173', 'sent.acct.workers.dev')).toBe(
			true
		);
		expect(isMisconfiguredLocalInstance('http://127.0.0.1:8787', 'social.example')).toBe(true);
	});
});
