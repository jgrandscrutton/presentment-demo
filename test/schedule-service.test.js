const test = require('node:test');
const assert = require('node:assert/strict');

const {
  billingDateForOccurrence,
  firstBillingOccurrenceAfter,
} = require('../services/schedule-service');

test('keeps weekly billing on the approved UTC time', () => {
  const result = billingDateForOccurrence(
    '2026-01-05T14:30:00.000Z',
    'WEEK',
    3,
  );

  assert.equal(result.toISOString(), '2026-01-26T14:30:00.000Z');
});

test('keeps a month-end anchor instead of drifting after February', () => {
  const anchor = '2024-01-31T10:15:00.000Z';

  assert.equal(
    billingDateForOccurrence(anchor, 'MONTH', 1).toISOString(),
    '2024-02-29T10:15:00.000Z',
  );
  assert.equal(
    billingDateForOccurrence(anchor, 'MONTH', 2).toISOString(),
    '2024-03-31T10:15:00.000Z',
  );
});

test('restores a leap-day anchor in the next leap year', () => {
  const anchor = '2024-02-29T09:00:00.000Z';

  assert.equal(
    billingDateForOccurrence(anchor, 'YEAR', 1).toISOString(),
    '2025-02-28T09:00:00.000Z',
  );
  assert.equal(
    billingDateForOccurrence(anchor, 'YEAR', 4).toISOString(),
    '2028-02-29T09:00:00.000Z',
  );
});

test('skips missed dates after a late run without changing the anchor', () => {
  const upcoming = firstBillingOccurrenceAfter(
    '2024-01-31T10:15:00.000Z',
    'MONTH',
    '2024-04-15T00:00:00.000Z',
    1,
  );

  assert.equal(upcoming.occurrence, 3);
  assert.equal(upcoming.date.toISOString(), '2024-04-30T10:15:00.000Z');
});
