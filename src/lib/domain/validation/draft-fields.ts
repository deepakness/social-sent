/**
 * Bounds for the free-text fields a client writes into a draft.
 *
 * Without them any JSON value was bound straight into D1: an object produced a
 * driver error (500 instead of 400) and a multi-megabyte string was stored
 * happily. Generous caps: far above every platform limit, low enough that a
 * runaway client cannot push megabytes into the database.
 */
export const DRAFT_TITLE_MAX_LENGTH = 200;
export const DRAFT_BODY_MAX_LENGTH = 100_000;
export const MAX_THREAD_SEGMENTS = 100;

export type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** `null` clears the title; a non-string is rejected. */
export function parseDraftTitle(value: unknown): FieldResult<string | null> {
	if (value === null) return { ok: true, value: null };
	if (typeof value !== 'string') return { ok: false, error: 'title must be a string' };
	const title = value.trim();
	if (title.length > DRAFT_TITLE_MAX_LENGTH) {
		return { ok: false, error: `title must be ${DRAFT_TITLE_MAX_LENGTH} characters or fewer` };
	}
	return { ok: true, value: title || null };
}

export function parseDraftBody(value: unknown): FieldResult<string> {
	if (typeof value !== 'string') return { ok: false, error: 'baseBody must be a string' };
	if (value.length > DRAFT_BODY_MAX_LENGTH) {
		return { ok: false, error: `baseBody must be ${DRAFT_BODY_MAX_LENGTH} characters or fewer` };
	}
	return { ok: true, value };
}

/**
 * Per-platform body override for a thread segment. `null` is meaningful — the
 * editor sends it to clear an override while keeping the platform's options —
 * so it is accepted, unlike an object or a number.
 */
export function parseSegmentBody(value: unknown): FieldResult<string | null> {
	if (value === null) return { ok: true, value: null };
	if (typeof value !== 'string') return { ok: false, error: 'body must be a string' };
	if (value.length > DRAFT_BODY_MAX_LENGTH) {
		return { ok: false, error: `body must be ${DRAFT_BODY_MAX_LENGTH} characters or fewer` };
	}
	return { ok: true, value };
}

export function parseThreadSegments(value: unknown): FieldResult<string[]> {
	if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
		return { ok: false, error: 'threadSegments must be an array of strings' };
	}
	if (value.length > MAX_THREAD_SEGMENTS) {
		return {
			ok: false,
			error: `threadSegments must have ${MAX_THREAD_SEGMENTS} segments or fewer`
		};
	}
	if (value.some((s) => (s as string).length > DRAFT_BODY_MAX_LENGTH)) {
		return {
			ok: false,
			error: `Each thread segment must be ${DRAFT_BODY_MAX_LENGTH} characters or fewer`
		};
	}
	return { ok: true, value: value as string[] };
}
