import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWeek } from '../public/week.js';

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
