#!/usr/bin/env node
/**
 * Wrangler wrapper used by every npm script, so a checkout can keep its own
 * deployment details out of version control.
 *
 * 1. Config: if `wrangler.personal.jsonc` exists it is passed via `--config`.
 *    That file is gitignored and holds instance-specific values — your Worker
 *    name, your D1 `database_id`, your R2 bucket — so `wrangler.jsonc` in the
 *    repo can stay generic and upstream-friendly.
 * 2. Profile: when WRANGLER_PROFILE is set, `--profile` is added. Multi-account
 *    users pick an account with `WRANGLER_PROFILE=my-account npm run deploy`
 *    instead of the repo hardcoding a profile name.
 *
 * Explicit flags always win: passing `--config` or `--profile` yourself
 * disables the corresponding inference.
 *
 * Usage: node scripts/wrangler.mjs <wrangler args...>
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const PERSONAL_CONFIG = 'wrangler.personal.jsonc';
const args = process.argv.slice(2);

const hasFlag = (...names) =>
	args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));

const configArgs =
	!existsSync(PERSONAL_CONFIG) || hasFlag('-c', '--config') ? [] : ['--config', PERSONAL_CONFIG];

const profile = process.env.WRANGLER_PROFILE?.trim();
const profileArgs = !profile || hasFlag('--profile') ? [] : ['--profile', profile];

const overrides = [...profileArgs, ...configArgs];
console.error(`\n$ npx wrangler ${[...args, ...overrides].join(' ')}`);
if (overrides.length) {
	console.error(`  (${overrides.join(' ')} applied by scripts/wrangler.mjs)`);
}

const result = spawnSync('npx', ['wrangler', ...args, ...overrides], { stdio: 'inherit' });
process.exit(result.status ?? 1);
