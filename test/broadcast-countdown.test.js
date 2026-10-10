// Next-broadcast countdown controller with fake clocks, timers and metadata reads. Silent: no audio,
// player or network. Rendering here is component proof only, not browser or device validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBroadcastCountdown, validateSchedule, formatRemaining, scheduleText, POLL_MS, MAX_AGE_MS } from '../src/broadcast-countdown.js';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const START = 1_800_000_000_000;
const upcoming = (over = {}) => ({ schemaVersion: 1, school: 'duke', state: 'upcoming', event: { id: 'e1', label: 'Football: Visitor', kind: 'game', broadcastStart: START + 1_061_000 }, checkedAt: START, ageMs: 1000, ...over });
function rig({ answers = [], visible = true } = {}) {
  const clock = { wall: START, mono: 0 }, timers = new Map(), reads = [], el = { hidden: true, textContent: '' };
  let id = 0;
  const read = (path, { signal }) => {
    const entry = { path, signal };
    reads.push(entry);
    const answer = answers.shift();
    if (answer === 'defer') return new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  const countdown = createBroadcastCountdown({ read, el, now: () => clock.wall, mono: () => clock.mono, enabled: () => visible,
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer: timer => timers.delete(timer), formatTime: () => 'Sat 2:00 PM' });
  const advance = ms => { clock.wall += ms; clock.mono += ms; };
  const fire = () => { const entries = [...timers]; timers.clear(); for (const [, timer] of entries) timer.fn(); };
  return { clock, timers, reads, el, countdown, advance, fire, answers, setVisible: value => { visible = value; } };
}

test('only Duke has a schedule path; every other school stays hidden and makes no request', async () => {
  const r = rig();
  for (const key of ['miami', 'vt', 'gt', 'auburn', 'uva', 'catalog-school', '__proto__', 'toString', undefined]) {
    r.countdown.setSchool(key); r.countdown.tick(); await settle();
    assert.equal(r.el.hidden, true, String(key)); assert.equal(r.el.textContent, '');
  }
  assert.equal(r.reads.length, 0); assert.equal(r.timers.size, 0);
});
test('a known Duke broadcast shows a labeled countdown that ticks from absolute time and polls once a minute', async () => {
  const r = rig({ answers: [upcoming()] });
  r.countdown.setSchool('duke');
  assert.equal(r.el.textContent, 'Duke network · Checking the broadcast schedule…'); assert.equal(r.el.hidden, false);
  await settle();
  assert.deepEqual(r.reads.map(read => read.path), ['broadcast/schedule/duke']);
  assert.equal(r.el.textContent, 'Duke network · Next broadcast starts in 17 min 41 s (Sat 2:00 PM) · Football: Visitor');
  r.advance(1000); r.countdown.tick();
  assert.equal(r.el.textContent, 'Duke network · Next broadcast starts in 17 min 40 s (Sat 2:00 PM) · Football: Visitor');
  assert.deepEqual([...r.timers.values()].map(timer => timer.ms), [POLL_MS]);
  r.answers.push(upcoming({ event: { id: 'e1', label: 'Football: Visitor', kind: 'game', broadcastStart: START + 3_600_000 }, checkedAt: START + 1000 }));
  r.fire(); await settle();
  assert.equal(r.reads.length, 2);
  assert.match(r.el.textContent, /starts in 59 min 59 s/, 'a provider delay is reflected on the next poll');
});
test('reaching the start is neutral, refreshes once, stays reached on an identical snapshot and advances only when the provider moves the row', async () => {
  const soon = upcoming({ event: { id: 'e1', label: 'Football Radio Show', kind: 'show', broadcastStart: START + 2000 } });
  const r = rig({ answers: [soon, soon] });
  r.countdown.setSchool('duke'); await settle();
  r.advance(1000); r.countdown.tick(); r.advance(1000); r.countdown.tick();
  assert.equal(r.el.textContent, 'Duke network · Scheduled broadcast start time reached for Football Radio Show. This does not confirm audio or game status.');
  assert.doesNotMatch(r.el.textContent, /live|playing|on air/i);
  await settle();
  assert.equal(r.reads.length, 2, 'one refresh at zero');
  for (let i = 0; i < 30; i++) { r.advance(1000); r.countdown.tick(); }
  await settle();
  assert.equal(r.reads.length, 2, 'no zero-refresh loop');
  assert.match(r.el.textContent, /start time reached/);
  r.answers.push(upcoming({ event: { id: 'e2', label: 'Football: Visitor', kind: 'game', broadcastStart: START + 7_200_000 } }));
  r.fire(); await settle();
  assert.match(r.el.textContent, /Next broadcast starts in 1 h 59 min/);
});
test('missing, ambiguous, stale, invalid and failed data are unknown, never an estimate or a kept countdown', async () => {
  const r = rig({ answers: [upcoming({ ageMs: 290_000 })] });
  r.countdown.setSchool('duke'); await settle();
  assert.match(r.el.textContent, /starts in/);
  r.advance(10_000); r.countdown.tick();
  assert.equal(r.el.textContent, 'Duke network · Next broadcast time unknown.', 'source age plus elapsed time beyond five minutes');
  for (const [answer, text] of [[upcoming({ ageMs: null }), 'unknown'], [Error('502'), 'unknown'], [upcoming({ school: 'vt' }), 'unknown'],
    [{ schemaVersion: 1, school: 'duke', state: 'unknown', reason: 'uncertain', checkedAt: START, ageMs: 0 }, 'not confirmed'],
    [{ schemaVersion: 1, school: 'duke', state: 'unknown', reason: 'ambiguous', checkedAt: START, ageMs: 0 }, 'unknown'],
    [{ schemaVersion: 1, school: 'duke', state: 'none-listed', checkedAt: START, ageMs: 0 }, 'No upcoming broadcast listed.']]) {
    const s = rig({ answers: [upcoming(), answer] });
    s.countdown.setSchool('duke'); await settle();
    assert.match(s.el.textContent, /starts in/);
    s.fire(); await settle();
    assert.ok(s.el.textContent.includes(text), `${JSON.stringify(answer)} -> ${s.el.textContent}`);
    assert.doesNotMatch(s.el.textContent, /starts in/);
  }
  for (const bad of [null, {}, upcoming({ schemaVersion: 2 }), upcoming({ checkedAt: '2026' }), upcoming({ ageMs: -1 }), upcoming({ ageMs: 1.5 }), upcoming({ state: 'live' }),
    upcoming({ event: null }), upcoming({ event: { id: 'e1', label: ' ', kind: 'game', broadcastStart: START } }), upcoming({ event: { id: 'e1', label: 'x', kind: 'kickoff', broadcastStart: START } }),
    upcoming({ event: { id: 'e1', label: 'x', kind: 'game', broadcastStart: '2026-10-10T18:00Z' } }), upcoming({ event: { id: 'bad id', label: 'x', kind: 'game', broadcastStart: START } })])
    assert.equal(validateSchedule(bad, 'duke'), null, JSON.stringify(bad));
});
test('a wall-clock jump the monotonic clock does not share makes the countdown unknown and refreshes', async () => {
  const r = rig({ answers: [upcoming(), 'defer'] });
  r.countdown.setSchool('duke'); await settle();
  r.countdown.tick(); r.clock.wall += 3_600_000; r.clock.mono += 1000; r.countdown.tick();
  assert.equal(r.el.textContent, 'Duke network · Next broadcast time unknown.');
  assert.equal(r.reads.length, 2);
});
test('school changes and suspension discard late answers, abort requests and never overlap polls', async () => {
  const r = rig({ answers: ['defer'] });
  r.countdown.setSchool('duke');
  const first = r.reads[0];
  r.countdown.tick(); r.countdown.tick();
  assert.equal(r.reads.length, 1, 'no overlapping request');
  r.countdown.setSchool('miami');
  assert.equal(first.signal.aborted, true);
  first.resolve(upcoming()); await settle();
  assert.equal(r.el.hidden, true); assert.equal(r.el.textContent, '');
  r.answers.push('defer');
  r.countdown.setSchool('duke');
  const second = r.reads[1];
  r.countdown.suspend();
  assert.equal(second.signal.aborted, true); assert.equal(r.timers.size, 0);
  second.resolve(upcoming()); await settle();
  assert.equal(r.el.textContent, 'Duke network · Checking the broadcast schedule…');
  r.countdown.tick(); assert.equal(r.reads.length, 2, 'suspended ticks request nothing');
  r.answers.push(upcoming());
  r.countdown.resume(); await settle();
  assert.equal(r.reads.length, 3); assert.match(r.el.textContent, /starts in/);
  const hidden = rig({ answers: [upcoming()], visible: false });
  hidden.countdown.setSchool('duke'); await settle();
  assert.equal(hidden.reads.length, 0, 'a hidden page makes no schedule request');
  hidden.setVisible(true); hidden.countdown.resume(); await settle();
  assert.equal(hidden.reads.length, 1);
  hidden.countdown.stop(); assert.equal(hidden.el.hidden, true); assert.equal(hidden.timers.size, 0);
});
test('remaining time formats compactly and the countdown line is not a live region', () => {
  assert.deepEqual([formatRemaining(41_000), formatRemaining(1_061_000), formatRemaining(3_660_000), formatRemaining(90_000_000), formatRemaining(1)], ['41 s', '17 min 41 s', '1 h 01 min', '1 d 1 h', '1 s']);
  assert.equal(scheduleText('miami', null, START), '');
  assert.ok(MAX_AGE_MS === 300000 && POLL_MS === 60000);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8'), line = html.match(/<p id="broadcast-next"[^>]*>/)?.[0];
  assert.ok(line && line.includes(' hidden'));
  assert.doesNotMatch(line, /aria-live|role=/);
});
