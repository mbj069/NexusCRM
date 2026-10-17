// Small shared helpers: error type, async route wrapper, date math.

import crypto from 'node:crypto';

export const uid = () => crypto.randomUUID();

/** Throw from a route to produce a JSON { error } response with a status. */
export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Wrap an async route handler so rejections reach the error middleware. */
export const ah = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** Today's date as YYYY-MM-DD (UTC). */
export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** Add n months to a YYYY-MM-DD date, keeping a valid calendar date. */
export function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, lastDay));
  return dt.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates (a - b). */
export function daysBetween(a, b) {
  const ms = Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}

/** Format a number as a PKR amount string. */
export function pkr(n) {
  return 'PKR ' + Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 });
}
