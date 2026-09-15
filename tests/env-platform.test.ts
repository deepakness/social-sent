import { afterEach, describe, expect, it, vi } from 'vitest';
import { envFromPlatform } from '$lib/server/env';
import { TEST_ENV } from '$lib/server/db/test';

/**
 * `envFromPlatform` is the only path a real Worker takes to its configuration
 * (bindings + `[vars]`), and the test suite exercised `readAppEnv` alone.
 */
describe('envFromPlatform', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('reads the Worker bindings, ignoring non-string entries', () => {
		const env = envFromPlatform({
			APP_URL: 'https://socialsent.example',
			APP_NAME: 'My Scheduler',
			APP_ENCRYPTION_KEY: TEST_ENV.APP_ENCRYPTION_KEY,
			AUTH_SECRET: TEST_ENV.AUTH_SECRET,
			ADMIN_EMAIL: TEST_ENV.ADMIN_EMAIL,
			ADMIN_PASSWORD: TEST_ENV.ADMIN_PASSWORD,
			// Real bindings ride along in the same object and must not be coerced.
			DB: { prepare: () => {} },
			MEDIA: { get: () => {} }
		});

		expect(env.APP_URL).toBe('https://socialsent.example');
		expect(env.APP_NAME).toBe('My Scheduler');
		expect(env.ADMIN_EMAIL).toBe(TEST_ENV.ADMIN_EMAIL);
		expect(env.skipTotp).toBe(false);
	});

	it('falls back to the process environment for anything the binding omits', () => {
		vi.stubEnv('SCHEDULER_SECRET', 'from-process-env-at-least-32-chars');
		const env = envFromPlatform({
			APP_URL: 'https://socialsent.example',
			APP_ENCRYPTION_KEY: TEST_ENV.APP_ENCRYPTION_KEY,
			AUTH_SECRET: TEST_ENV.AUTH_SECRET,
			ADMIN_EMAIL: TEST_ENV.ADMIN_EMAIL,
			ADMIN_PASSWORD: TEST_ENV.ADMIN_PASSWORD
		});

		expect(env.SCHEDULER_SECRET).toBe('from-process-env-at-least-32-chars');
	});

	it('treats an empty binding value as absent so the fallback applies', () => {
		vi.stubEnv('APP_NAME', 'from-process-env');
		const env = envFromPlatform({
			APP_URL: 'https://socialsent.example',
			APP_NAME: '',
			APP_ENCRYPTION_KEY: TEST_ENV.APP_ENCRYPTION_KEY,
			AUTH_SECRET: TEST_ENV.AUTH_SECRET,
			ADMIN_EMAIL: TEST_ENV.ADMIN_EMAIL,
			ADMIN_PASSWORD: TEST_ENV.ADMIN_PASSWORD
		});

		expect(env.APP_NAME).toBe('from-process-env');
	});

	it('still fails closed on an example secret for a real deployment', () => {
		expect(() =>
			envFromPlatform({
				APP_URL: 'https://socialsent.example',
				APP_ENCRYPTION_KEY: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
				AUTH_SECRET: 'dev-auth-secret-change-me',
				ADMIN_EMAIL: TEST_ENV.ADMIN_EMAIL,
				ADMIN_PASSWORD: TEST_ENV.ADMIN_PASSWORD
			})
		).toThrow();
	});

	it('allows the local-development defaults on a localhost APP_URL', () => {
		const env = envFromPlatform({
			APP_URL: 'http://localhost:5173',
			APP_ENCRYPTION_KEY: 'local-dev-encryption-key-32-chars!!',
			AUTH_SECRET: 'local-dev-auth-secret-16',
			ADMIN_EMAIL: 'admin@localhost',
			ADMIN_PASSWORD: 'local-dev-password'
		});

		expect(env.APP_URL).toBe('http://localhost:5173');
	});
});
