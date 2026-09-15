import { json } from '@sveltejs/kit';
import { humanizeError } from '$lib/domain/human-error';

export function ok(data: unknown, status = 200) {
	return json(data, { status });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
	return json({ error: message, ...extra }, { status });
}

export function handleError(err: unknown) {
	const status = (err as { status?: number })?.status ?? 500;
	const message = err instanceof Error ? err.message : 'Server error';
	if (status === 401)
		return fail(message && message !== 'Server error' ? message : 'Unauthorized', 401);
	if (status < 500) return fail(message, status >= 400 && status < 600 ? status : 400);
	console.error(err);
	return fail(humanizeError(message), status >= 400 && status < 600 ? status : 500);
}

export function unauthorized(): never {
	throw Object.assign(new Error('Unauthorized'), { status: 401 });
}
