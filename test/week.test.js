import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  babyDay, babyDayText, babyWeekText, isoWeek, monthWeek, weekFileLabel, weekLabel, weekRange,
} from '../public/week.js';

test('isoWeek basic', () => {
  assert.equal(isoWeek(new Date(2026, 10, 23, 10, 0)), '2026-W48');
  assert.equal(isoWeek(new Date('2026-11-23T10:00')), '2026-W48');
});
test('isoWeek year boundaries', () => {
  assert.equal(isoWeek(new Date(2027, 0, 1)), '2026-W53');
  assert.equal(isoWeek(new Date(2024, 11, 30)), '2025-W01');
  assert.equal(isoWeek(new Date(2026, 0, 1)), '2026-W01');
});
test('isoWeek uses local calendar day', () => {
  assert.equal(isoWeek(new Date(2026, 10, 22, 23, 59)), '2026-W47'); // Sunday
  assert.equal(isoWeek(new Date(2026, 10, 23, 0, 0)), '2026-W48'); // Monday
});
test('isoWeek format', () => {
  assert.match(isoWeek(new Date(2026, 1, 3)), /^\d{4}-W\d{2}$/);
});

test('month and ordinal come from Thursday, including year boundaries', () => {
  assert.deepEqual(weekRange('2026-W49'), { start: '2026-11-30', end: '2026-12-06' });
  assert.deepEqual(monthWeek('2026-W49'), { year: 2026, month: 12, nth: 1 });
  assert.deepEqual(monthWeek('2026-W01'), { year: 2026, month: 1, nth: 1 });
  assert.deepEqual(monthWeek('2026-W53'), { year: 2026, month: 12, nth: 5 });
  assert.deepEqual(weekRange('2026-W01'), { start: '2025-12-29', end: '2026-01-04' });
  assert.equal(weekLabel('2026-W48'), '2026년 11월 4주차');
  assert.equal(weekFileLabel('2026-W10'), '2026-03월1주차');
});

test('babyDay counts Seoul calendar days including the birth day', () => {
  const birth = '2026-01-01';
  assert.equal(babyDay(birth, new Date('2025-12-31T14:59:59Z')), null);
  assert.equal(babyDay(birth, new Date('2025-12-31T15:00:00Z')), 1);
  assert.equal(babyDay(birth, new Date('2026-04-09T15:00:00Z')), 100);
  assert.equal(babyDay('2026-02-30', new Date('2026-04-10T00:00:00Z')), null);
});

test('babyWeekText clamps the first week and hides all earlier weeks', () => {
  assert.equal(babyWeekText('2025-03-02', '2026-W49'), '생후 639~645일 · 92주차');
  assert.equal(babyWeekText('2026-12-03', '2026-W49'), '생후 1~4일 · 1주차');
  assert.equal(babyWeekText('2026-12-07', '2026-W49'), null);
  assert.equal(babyWeekText(null, '2026-W49'), null);
});

test('babyDayText formats a millisecond timestamp or returns null', () => {
  assert.equal(babyDayText('2025-03-02', Date.parse('2026-12-03T01:00:00Z')), '생후 642일');
  assert.equal(babyDayText('2025-03-02', null), null);
  assert.equal(babyDayText('2025-03-02', Date.parse('2025-03-01T14:00:00Z')), null);
});
