import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SECRETS } from '$lib/server/env';

/**
 * `scripts/setup.mjs` refuses to upload a value the app would reject at boot
 * (or worse, boot with), using its own copy of the placeholder list because a
 * plain .mjs script cannot import from src. This keeps the two from drifting:
 * a stale copy would happily upload an example key to a real deployment.
 */
function scriptPlaceholders(): string[] {
	const source = readFileSync('scripts/setup.mjs', 'utf8');
	const match = source.match(/const PLACEHOLDERS = new Set\(\[([\s\S]*?)\]\);/);
	if (!match) throw new Error('could not find the PLACEHOLDERS list in scripts/setup.mjs');
	return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('scripts/setup.mjs placeholders', () => {
	it('covers every value the app itself rejects', () => {
		const fromScript = scriptPlaceholders();
		for (const placeholder of PLACEHOLDER_SECRETS) {
			expect(fromScript).toContain(placeholder);
		}
	});

	it('also refuses the example admin email setups are tempted to keep', () => {
		expect(scriptPlaceholders()).toContain('admin@example.com');
	});
});
