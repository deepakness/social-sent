import { isThreadsAuthFailure, isThreadsMediaFetchFailure } from './threads-error';

export function humanizeError(raw: string | null | undefined): string {
	if (!raw) return 'Something went wrong';
	const s = raw.toLowerCase();
	if (
		s.includes('401') ||
		s.includes('unauthorized') ||
		s.includes('invalid credentials') ||
		s.includes('createsession failed') ||
		s.includes('need reconnect')
	) {
		return 'Account needs reconnect — password or token expired';
	}
	if (s.includes('403') || s.includes('forbidden')) {
		return 'The platform refused this post (permissions or policy)';
	}
	// Meta permission failures are HTTP 400s, so the 401/403 branches never
	// match. Scoped to Threads wording (provider prefixes every message).
	if (isThreadsAuthFailure(s)) {
		return 'Threads refused with a permissions error — reconnect the account and retry';
	}
	// Meta could not download the image (its crawler is intermittent — the
	// same file has posted seconds later), so point at Retry, not at setup.
	if (isThreadsMediaFetchFailure(s)) {
		return 'Threads could not download the image — retry to publish it';
	}
	if (/threads (container|publish) failed \(4(?!29)\d/.test(s)) {
		return 'Threads could not create this post — check the post and the app setup, then retry';
	}
	if (s.includes('429') || s.includes('rate limit')) {
		return 'Rate limited — try again in a minute';
	}
	if (s.includes('already publishing')) {
		return 'Already publishing — wait for it to finish, then try again';
	}
	if (s.includes('already published')) {
		return 'Already published to this account';
	}
	if (s.includes('already scheduled')) {
		return 'Already scheduled — cancel or reschedule from Posts';
	}
	if (s.includes('scheduler') || s.includes('redis') || s.includes('queue')) {
		return 'Scheduler is delayed — scheduled posts will send on the next tick';
	}
	if (
		s.includes('timeout') ||
		s.includes('econnrefused') ||
		s.includes('fetch failed') ||
		s.includes('enotfound')
	) {
		return 'Could not reach the network — check connection and try again';
	}
	// Size/character messages are safe to echo but still length-capped: the
	// early `return raw` paths previously bypassed truncation and could leak
	// unbounded server text containing those substrings.
	if (
		s.includes('16mb') ||
		s.includes('95mb') ||
		s.includes('8mb') ||
		s.includes('5mb') ||
		s.includes('1mb') ||
		s.includes('too large') ||
		s.includes('max 4')
	)
		return truncate(raw);
	if (s.includes('grapheme') || s.includes('characters on this')) return truncate(raw);
	if (s.includes('instance host') || s.includes('host not allowed')) {
		return 'That instance URL isn’t allowed';
	}
	return truncate(raw);
}

function truncate(raw: string): string {
	return raw.length > 180 ? raw.slice(0, 177) + '…' : raw;
}
