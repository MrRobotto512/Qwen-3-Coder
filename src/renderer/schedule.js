'use strict';

// Scheduling rules for Automations, kept free of DOM/state so they can be unit-tested in Node.
// An automation's schedule is one of:
//   { kind: 'interval', hours }           — run every N hours while the app is open
//   { kind: 'daily', time: 'HH:MM', catchUp } — run once a day at a local time; when the app
//     was closed at that moment, catchUp=true (default) runs it on launch, catchUp=false only
//     runs it when the app was open within 45 minutes of the scheduled time.

const LATE_LIMIT_MS = 45 * 60e3;

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  const h = m ? Number(m[1]) : 9;
  const min = m ? Number(m[2]) : 0;
  return [Math.min(23, h), Math.min(59, min)];
}

// The most recent scheduled instant at or before `now` (daily schedules only).
function prevDailyAt(s, now) {
  const [h, m] = parseTime(s.time);
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  return today <= now ? today : today - 24 * 3600e3;
}

// Should this automation run now?
function automationDue(a, now) {
  if (!a || a.enabled === false) return false;
  const s = a.schedule || {};
  if (s.kind === 'interval') {
    const ms = Math.max(1, Number(s.hours) || 24) * 3600e3;
    return !a.lastRun || now - a.lastRun >= ms;
  }
  if (s.kind === 'daily') {
    const sched = prevDailyAt(s, now);
    if ((a.lastRun || 0) >= sched) return false;
    return s.catchUp === false ? now - sched <= LATE_LIMIT_MS : true;
  }
  return false;
}

// When the next run would start, for display. Infinity when the schedule is unknown.
function nextRunAt(a, now) {
  const s = a?.schedule || {};
  if (s.kind === 'interval') {
    const ms = Math.max(1, Number(s.hours) || 24) * 3600e3;
    return a.lastRun ? a.lastRun + ms : now;
  }
  if (s.kind === 'daily') {
    if (automationDue(a, now)) return now;
    return prevDailyAt(s, now) + 24 * 3600e3;
  }
  return Infinity;
}

function describeSchedule(s) {
  if (!s) return '';
  if (s.kind === 'interval') {
    const h = Math.max(1, Number(s.hours) || 24);
    return h === 1 ? 'every hour' : h % 24 === 0 ? `every ${h / 24} day${h === 24 ? '' : 's'}` : `every ${h} hours`;
  }
  if (s.kind === 'daily') {
    const [h, m] = parseTime(s.time);
    return `daily at ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${s.catchUp === false ? '' : ' (catch-up on launch)'}`;
  }
  return '';
}

const ScheduleExports = { automationDue, nextRunAt, describeSchedule, prevDailyAt, parseTime, LATE_LIMIT_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = ScheduleExports;
if (typeof window !== 'undefined') window.Schedule = ScheduleExports;
