'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { automationDue, nextRunAt, describeSchedule, LATE_LIMIT_MS } = require('../src/renderer/schedule.js');

const at = (h, m = 0) => new Date(2026, 9, 22, h, m).getTime(); // local, Oct 22 2026

test('interval: due when never run, then again after N hours', () => {
  const a = { enabled: true, schedule: { kind: 'interval', hours: 2 } };
  assert.equal(automationDue(a, at(10)), true);
  a.lastRun = at(10);
  assert.equal(automationDue(a, at(11)), false);
  assert.equal(automationDue(a, at(12)), true);
  assert.equal(nextRunAt(a, at(11)), at(12));
});

test('daily: fires once after the scheduled time, not again the same day', () => {
  const a = { enabled: true, schedule: { kind: 'daily', time: '09:00' } };
  assert.equal(automationDue(a, at(8, 59)), true, 'never ran: the most recent 09:00 was yesterday');
  a.lastRun = at(9, 1); // ran right after today's 09:00
  assert.equal(automationDue(a, at(15)), false);
  assert.equal(automationDue(a, at(9) + 24 * 3600e3), true, 'due again the next day');
});

test('daily with catch-up (default): runs however late the app opens', () => {
  const a = { enabled: true, lastRun: at(9) - 24 * 3600e3 + 60e3, schedule: { kind: 'daily', time: '09:00' } };
  assert.equal(automationDue(a, at(20)), true);
});

test('daily without catch-up: skipped once more than 45 minutes late', () => {
  const a = { enabled: true, lastRun: at(9) - 24 * 3600e3 + 60e3, schedule: { kind: 'daily', time: '09:00', catchUp: false } };
  assert.equal(automationDue(a, at(9, 30)), true);
  assert.equal(automationDue(a, at(9) + LATE_LIMIT_MS + 60e3), false);
});

test('disabled automations never fire', () => {
  assert.equal(automationDue({ enabled: false, schedule: { kind: 'interval', hours: 1 } }, at(10)), false);
});

test('describeSchedule reads naturally', () => {
  assert.equal(describeSchedule({ kind: 'interval', hours: 1 }), 'every hour');
  assert.equal(describeSchedule({ kind: 'interval', hours: 48 }), 'every 2 days');
  assert.equal(describeSchedule({ kind: 'daily', time: '07:30', catchUp: false }), 'daily at 07:30');
  assert.match(describeSchedule({ kind: 'daily', time: '9:05' }), /daily at 09:05/);
});
