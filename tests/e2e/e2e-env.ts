import { existsSync, readFileSync } from 'node:fs';

/**
 * Shared harness values for the e2e suite.
 *
 * The preview server (wrangler dev) reads `.dev.vars`, so the specs read the
 * same file to learn the login credentials. On a fresh clone there is no
 * `.dev.vars`: `npm run test:e2e` seeds one from `tests/e2e/fixtures/dev.vars`
 * (scripts/e2e-prepare.mjs) and this helper falls back to that fixture, so the
 * suite never depends on a particular developer's machine.
 */
const FIXTURE = 'tests/e2e/fixtures/dev.vars';

function parse(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of raw.split('\n')) {
		const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

export function e2eVars(): Record<string, string> {
	return parse(readFileSync(existsSync('.dev.vars') ? '.dev.vars' : FIXTURE, 'utf8'));
}

/**
 * Dedicated local D1/R2 state for tests. Using its own directory means a test
 * run never deletes the state a developer uses for `npm run dev`.
 * Keep in sync with playwright.config.ts, which passes the same value to
 * `wrangler dev --persist-to`.
 */
export const E2E_PERSIST_TO = '.wrangler/e2e-state';

/** Extra flags for every `wrangler d1 …` call inside a spec. */
export const E2E_D1_FLAGS = `--persist-to ${E2E_PERSIST_TO}`;
