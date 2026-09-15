import { defineConfig } from '@playwright/test';
import { E2E_PERSIST_TO } from './tests/e2e/e2e-env';

export default defineConfig({
	// Fresh local D1 on every run, in its own state directory so a test run never
	// deletes the data a developer uses for `npm run dev`.
	webServer: {
		command: `rm -rf ${E2E_PERSIST_TO} && npm run build && node scripts/wrangler.mjs dev .svelte-kit/cloudflare/_worker.js --port 4173 --persist-to ${E2E_PERSIST_TO}`,
		port: 4173
	},
	workers: 1,
	testMatch: 'tests/e2e/**/*.e2e.{ts,js}'
});
