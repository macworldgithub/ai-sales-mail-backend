const { fail } = require('./http');

function parseSchedule(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail(400, 'Send time must be an ISO date with a timezone');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) fail(400, 'Choose a send time in the future');
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23) fail(400, 'Choose a valid calendar date and time');
  return date;
}

// Missing dates on existing campaigns are treated as ready to send.
const dueSchedule = () => ({ $or: [{ scheduledAt: null }, { scheduledAt: { $lte: new Date() } }] });
module.exports = { parseSchedule, dueSchedule };
