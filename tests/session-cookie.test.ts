import { describe, expect, it } from 'vitest';
import {
	nextSessionExpiry,
	sessionMaxAgeSeconds,
	shouldSlideSession,
	shouldUseSecureCookie,
	SESSION_MAX_AGE_REMEMBER
} from '$lib/domain/session-cookie';

describe('shouldUseSecureCookie', () => {
	it('is false for http localhost even in production', () => {
		expect(shouldUseSecureCookie({ isProduction: true, appUrl: 'http://localhost:3000' })).toBe(
			false
		);
	});
	it('is false for 127.0.0.1', () => {
		expect(shouldUseSecureCookie({ isProduction: true, appUrl: 'http://127.0.0.1:3000' })).toBe(
			false
		);
	});
	it('is true for https production host', () => {
		expect(
			shouldUseSecureCookie({ isProduction: true, appUrl: 'https://social.example.com' })
		).toBe(true);
	});
	it('is false for https localhost', () => {
		expect(shouldUseSecureCookie({ isProduction: true, appUrl: 'https://localhost:3000' })).toBe(
			false
		);
	});
	it('is false when request host is localhost without APP_URL', () => {
		expect(shouldUseSecureCookie({ isProduction: true, requestHost: 'localhost:3000' })).toBe(
			false
		);
	});
	it('is true for a real host in a production build', () => {
		expect(shouldUseSecureCookie({ isProduction: true, requestHost: 'social.example.com' })).toBe(
			true
		);
	});
	it('is false in a development build', () => {
		expect(shouldUseSecureCookie({ isProduction: false, requestHost: 'social.example.com' })).toBe(
			false
		);
	});
});

describe('session sliding', () => {
	it('remember lasts 30 days', () => {
		expect(sessionMaxAgeSeconds(true)).toBe(SESSION_MAX_AGE_REMEMBER);
	});
	it('slides when less than half window remains', () => {
		const now = new Date('2026-08-17T12:00:00Z');
		const soon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
		expect(shouldSlideSession(soon, now, SESSION_MAX_AGE_REMEMBER)).toBe(true);
		const far = new Date(now.getTime() + 25 * 24 * 60 * 60 * 1000);
		expect(shouldSlideSession(far, now, SESSION_MAX_AGE_REMEMBER)).toBe(false);
	});
	it('next expiry is now + maxAge', () => {
		const now = new Date('2026-08-17T12:00:00Z');
		expect(nextSessionExpiry(now, 3600).getTime() - now.getTime()).toBe(3600_000);
	});
});
