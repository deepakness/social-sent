import { describe, expect, it } from 'vitest';
import {
	anySecretMatches,
	applyApiCors,
	extractBearerToken,
	hasAllowedMutationOrigin,
	isInternalApiPath,
	secretMatches
} from '$lib/domain/bearer';

describe('extractBearerToken', () => {
	it('reads Authorization Bearer and alternate headers', () => {
		expect(extractBearerToken(new Headers({ authorization: 'Bearer abc.def' }))).toBe('abc.def');
		expect(extractBearerToken(new Headers({ 'x-socialsent-token': ' tok ' }))).toBe('tok');
		expect(extractBearerToken(new Headers({ 'x-socialsent-scheduler': 'sched' }))).toBe('sched');
		expect(extractBearerToken(new Headers())).toBeNull();
	});
});

describe('secretMatches', () => {
	it('accepts an exact match and rejects mismatches', () => {
		expect(secretMatches('same-token-value', 'same-token-value')).toBe(true);
		expect(secretMatches('same-token-value', 'other-token-value')).toBe(false);
		expect(secretMatches('short', 'much-longer-secret')).toBe(false);
		expect(secretMatches(null, 'secret')).toBe(false);
		expect(secretMatches('secret', undefined)).toBe(false);
	});

	it('matches any configured secret', () => {
		expect(anySecretMatches('beta', ['alpha', 'beta', 'gamma'])).toBe(true);
		expect(anySecretMatches('nope', ['alpha', 'beta'])).toBe(false);
		expect(anySecretMatches('token', [undefined, 'token'])).toBe(true);
	});
});

describe('internal paths and CORS', () => {
	it('allows only the two scheduler endpoints', () => {
		expect(isInternalApiPath('/api/internal/tick')).toBe(true);
		expect(isInternalApiPath('/api/internal/publish')).toBe(true);
		expect(isInternalApiPath('/api/drafts')).toBe(false);
		expect(isInternalApiPath('/api/internal/tick/extra')).toBe(false);
	});

	it('sends no wildcard CORS headers (same-origin app)', () => {
		const api = applyApiCors('/api/drafts', new Response('ok'));
		expect(api.headers.get('Access-Control-Allow-Origin')).toBeNull();
		const page = applyApiCors('/queue', new Response('ok'));
		expect(page.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});

	describe('hasAllowedMutationOrigin', () => {
		const req = (origin?: string, referer?: string) =>
			({
				headers: {
					get: (name: string) => {
						if (name === 'origin') return origin ?? null;
						if (name === 'referer') return referer ?? null;
						return null;
					}
				}
			}) as unknown as Request;
		const url = new URL('https://app.example.com/api/drafts');
		it('allows clients that assert no origin (curl, GH Actions)', () => {
			expect(hasAllowedMutationOrigin(req(), url)).toBe(true);
		});
		it('allows matching origin and referer', () => {
			expect(hasAllowedMutationOrigin(req('https://app.example.com'), url)).toBe(true);
			expect(hasAllowedMutationOrigin(req(undefined, 'https://app.example.com/compose'), url)).toBe(
				true
			);
		});
		it('rejects cross-origin mutations', () => {
			expect(hasAllowedMutationOrigin(req('https://evil.example.com'), url)).toBe(false);
			expect(hasAllowedMutationOrigin(req(undefined, 'https://evil.example.com/x'), url)).toBe(
				false
			);
			expect(hasAllowedMutationOrigin(req('not-a-url'), url)).toBe(false);
		});
	});
});
