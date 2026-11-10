const SUPPORTED_FREQUENCIES = new Set(['WEEK', 'MONTH', 'YEAR']);

function requireDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('A valid billing date is required.');
  }

  return date;
}

function requireFrequency(frequency) {
  if (!SUPPORTED_FREQUENCIES.has(frequency)) {
    throw new Error(`Unsupported billing frequency: ${frequency}`);
  }
}

function requireOccurrence(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Billing occurrence must be a non-negative integer.');
  }

  return value;
}

function daysInUtcMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function billingDateForOccurrence(anchor, frequency, occurrence) {
  requireFrequency(frequency);
  const sequence = requireOccurrence(occurrence);
  const source = requireDate(anchor);

  if (frequency === 'WEEK') {
    source.setUTCDate(source.getUTCDate() + (7 * sequence));
    return source;
  }

  const year = source.getUTCFullYear();
  const month = source.getUTCMonth();
  const day = source.getUTCDate();
  const hours = source.getUTCHours();
  const minutes = source.getUTCMinutes();
  const seconds = source.getUTCSeconds();
  const milliseconds = source.getUTCMilliseconds();

  if (frequency === 'MONTH') {
    const target = new Date(Date.UTC(
      year,
      month + sequence,
      1,
      hours,
      minutes,
      seconds,
      milliseconds,
    ));
    target.setUTCDate(Math.min(
      day,
      daysInUtcMonth(target.getUTCFullYear(), target.getUTCMonth()),
    ));
    return target;
  }

  const targetYear = year + sequence;
  return new Date(Date.UTC(
    targetYear,
    month,
    Math.min(day, daysInUtcMonth(targetYear, month)),
    hours,
    minutes,
    seconds,
    milliseconds,
  ));
}

function estimateOccurrence(anchor, frequency, after) {
  if (after <= anchor) {
    return 0;
  }

  if (frequency === 'WEEK') {
    return Math.floor((after.getTime() - anchor.getTime()) / (7 * 24 * 60 * 60 * 1000));
  }

  if (frequency === 'MONTH') {
    return ((after.getUTCFullYear() - anchor.getUTCFullYear()) * 12)
      + after.getUTCMonth() - anchor.getUTCMonth();
  }

  return after.getUTCFullYear() - anchor.getUTCFullYear();
}

function firstBillingOccurrenceAfter(anchor, frequency, after, startOccurrence = 0) {
  requireFrequency(frequency);
  const anchorDate = requireDate(anchor);
  const cutoff = requireDate(after);
  const firstAllowed = requireOccurrence(startOccurrence);
  let occurrence = Math.max(
    firstAllowed,
    estimateOccurrence(anchorDate, frequency, cutoff),
  );
  let date = billingDateForOccurrence(anchorDate, frequency, occurrence);

  while (date <= cutoff) {
    occurrence += 1;
    date = billingDateForOccurrence(anchorDate, frequency, occurrence);
  }

  return { occurrence, date };
}

function nextBillingDate(from, frequency) {
  return billingDateForOccurrence(from, frequency, 1);
}

module.exports = {
  billingDateForOccurrence,
  firstBillingOccurrenceAfter,
  nextBillingDate,
};
