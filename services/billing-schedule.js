function nextDate(value, frequency = 'monthly', anchorDay = new Date(value).getUTCDate()) {
  const date = new Date(value);
  if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
  else {
    const month = date.getUTCMonth() + (frequency === 'yearly' ? 12 : 1);
    date.setUTCDate(1);
    date.setUTCMonth(month);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(anchorDay, last));
  }
  return date.toISOString();
}

function money(value, { allowZero = false } = {}) {
  const string = String(value ?? '');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(string)) throw Object.assign(new Error('Enter an amount with up to two decimal places.'), { status: 400 });
  const pence = Math.round(Number(string) * 100);
  if (pence < (allowZero ? 0 : 1) || pence > 1000000) throw Object.assign(new Error('Amounts must be between £0.01 and £10,000.'), { status: 400 });
  return pence;
}

module.exports = { nextDate, money };
