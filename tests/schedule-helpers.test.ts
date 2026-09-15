import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SCHEDULE_OFFSET,
	defaultScheduleDatetime,
	isFutureScheduleValue,
	listSchedulePresets,
	minScheduleDatetime,
	parseDatetimeLocal,
	parseOffsetField,
	scheduleFromDHM,
	scheduleFromOffset,
	scheduleValueToIso,
	toDatetimeLocalValue
} from '$lib/domain/schedule-helpers';

describe('toDatetimeLocalValue / parseDatetimeLocal', () => {
	it('round-trips local components', () => {
		const d = new Date(2026, 5, 15, 14, 30, 0, 0);
		const s = toDatetimeLocalValue(d);
		expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		const back = parseDatetimeLocal(s)!;
		expect(back.getFullYear()).toBe(2026);
		expect(back.getMonth()).toBe(5);
		expect(back.getDate()).toBe(15);
		expect(back.getHours()).toBe(14);
		expect(back.getMinutes()).toBe(30);
	});
});

describe('defaultScheduleDatetime', () => {
	it('is always after now', () => {
		const now = new Date('2026-08-10T12:00:00');
		const val = defaultScheduleDatetime(now, 15);
		expect(isFutureScheduleValue(val, now)).toBe(true);
		const d = parseDatetimeLocal(val)!;
		expect(d.getTime() - now.getTime()).toBeGreaterThanOrEqual(14 * 60_000);
	});
});

describe('minScheduleDatetime', () => {
	it('is at least 1 minute ahead', () => {
		const now = new Date('2026-08-10T12:00:00');
		expect(isFutureScheduleValue(minScheduleDatetime(now), now)).toBe(true);
	});
});

describe('isFutureScheduleValue', () => {
	it('rejects empty and past', () => {
		const now = new Date('2026-08-10T12:00:00');
		expect(isFutureScheduleValue('', now)).toBe(false);
		expect(isFutureScheduleValue('2026-08-10T11:00', now)).toBe(false);
	});
	it('accepts future', () => {
		expect(isFutureScheduleValue('2026-08-10T12:30', new Date('2026-08-10T12:00:00'))).toBe(true);
	});
});

describe('scheduleFromOffset', () => {
	it('adds 15 minutes', () => {
		const now = new Date('2026-08-10T12:00:00');
		expect(parseDatetimeLocal(scheduleFromOffset(15, now))!.getTime() - now.getTime()).toBe(
			15 * 60_000
		);
	});
	it('adds 2 hours', () => {
		const now = new Date('2026-08-10T12:00:00');
		expect(parseDatetimeLocal(scheduleFromOffset(120, now))!.getTime() - now.getTime()).toBe(
			120 * 60_000
		);
	});
	it('tomorrow 9am special case', () => {
		const now = new Date('2026-08-10T15:30:00');
		const d = parseDatetimeLocal(scheduleFromOffset(-1, now))!;
		expect(d.getDate()).toBe(11);
		expect(d.getHours()).toBe(9);
	});
});

describe('scheduleValueToIso', () => {
	it('returns ISO for future values', () => {
		const now = new Date('2026-08-10T12:00:00');
		const iso = scheduleValueToIso('2026-08-10T14:00', now);
		expect(iso).toBeTruthy();
		expect(new Date(iso!).getTime()).toBeGreaterThan(now.getTime());
	});
	it('returns null for past', () => {
		expect(scheduleValueToIso('2026-08-10T10:00', new Date('2026-08-10T12:00:00'))).toBeNull();
	});
});

describe('listSchedulePresets', () => {
	it('includes 15 min and 2 hours', () => {
		const labels = listSchedulePresets().map((p) => p.label);
		expect(labels).toContain('15 min');
		expect(labels).toContain('2 hours');
	});
});

describe('parseOffsetField', () => {
	it('treats empty and garbage as 0 and clamps negatives', () => {
		expect(parseOffsetField('')).toBe(0);
		expect(parseOffsetField(null)).toBe(0);
		expect(parseOffsetField(undefined)).toBe(0);
		expect(parseOffsetField('abc')).toBe(0);
		expect(parseOffsetField('-3')).toBe(0);
		expect(parseOffsetField(-3)).toBe(0);
	});
	it('floors fractional input', () => {
		expect(parseOffsetField('2.9')).toBe(2);
		expect(parseOffsetField(1.7)).toBe(1);
	});
});

describe('scheduleFromDHM', () => {
	it('adds days / hours / mins to now', () => {
		const now = new Date('2026-08-10T12:00:00');
		const d = parseDatetimeLocal(scheduleFromDHM(1, 2, 30, now))!;
		expect(d.getTime() - now.getTime()).toBe((24 * 60 + 2 * 60 + 30) * 60_000);
	});
	it('treats blank fields as zero but still returns a future value', () => {
		const now = new Date('2026-08-10T12:00:30');
		const val = scheduleFromDHM('', '', '', now);
		expect(isFutureScheduleValue(val, now)).toBe(true);
	});
	it('matches the prefilled default offset', () => {
		const now = new Date('2026-08-10T12:00:00');
		const { days, hours, mins } = DEFAULT_SCHEDULE_OFFSET;
		const d = parseDatetimeLocal(scheduleFromDHM(days, hours, mins, now))!;
		expect(d.getTime() - now.getTime()).toBe((hours * 60 + mins) * 60_000);
	});
});
