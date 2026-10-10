// Real Homestream catalog + Listen owner wiring + status controller in one page; only I/O, timers, the
// player and the timing tools are fakes. Status labels are label-only: they never decide readiness.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { metadataURL, mediaURL, configuredGatewayOrigin, gatewayOptions } from '../src/gateway.js';
import * as mapping from '../src/sync-mapping.js';
import { createGameStatus } from '../src/game-status.js';
import { PlaybackMemory } from '../src/playback-memory.js';
import { SessionLog } from '../src/session-log.js';
import { teams } from '../src/teams.js';
import { createNowPlaying, nowPlayingArtwork } from '../src/now-playing.js';
import { createScoreboard } from '../src/scoreboard.js';
import { listenTeams, resolveSources, officialLink } from '../src/listen-sources.js';
import { createListenSession, failureKind } from '../src/listen-session.js';
import { TIMELINE_NOTICE, FALLBACK_NOTICE } from '../src/hls-timeline.js';
import * as shell from '../src/ui-shell.js';
globalThis.__GATEWAY_ORIGIN__ = 'https://gateway.example';
const strip = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
const homestreamSource = strip('../src/homestream-ui.js'), appSource = strip('../src/app.js');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const DUKE = '2903e5f6-960e-4954-a3ec-f7754e78660f', GT = '410422f0-663f-4e3d-82e2-787d954ae29d', HOUR = 3600000, DAY = 24 * HOUR;
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness(t) {
  const dom = new JSDOM(html, { url: 'https://example.test/homecall/', runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window; t.after(() => w.close());
  const now = Date.now();
  const catalogs = {
    [DUKE]: [{ id: 'g1', opponent: 'Illinois', start: now - 30 * DAY }, { id: 'g2', opponent: 'Tulane', start: now + HOUR }, { id: 'g3', opponent: 'Clemson', start: now + 7 * DAY, url: null }],
    [GT]: [{ id: 'g1', opponent: 'Clemson', start: now - 30 * DAY }, { id: 'g2', opponent: 'Duke', start: now + HOUR }]
  };
  const h = { w, clock: { wall: 1_000_000, mono: 1_000_000 }, requests: [], probes: [], statusTimers: [], intervals: [], statusSignals: [], held: [], ageMs: 0,
    statusFail: false, holdStatus: false, holdProbe: false, provider: { 150: { g1: 'completed', g2: 'upcoming', g3: 'upcoming' }, 59: { g1: 'completed', g2: 'live' } } };
  const events = teamId => (teamId === '150' ? catalogs[DUKE] : catalogs[GT]).map((g, i) => ({ id: `${teamId}${i}`, start: g.start, teams: [teamId === '150' ? 'Duke' : 'Georgia Tech', g.opponent], teamIds: [teamId, String(900 + i)], season: mapping.footballSeason(g.start), status: h.provider[teamId][g.id] }));
  const readJSON = async (url, { signal } = {}) => {
    const path = url.pathname.replace(/^\/api\//, ''); h.requests.push(path);
    if (path === 'homestream/teams') return [{ id: DUKE, name: 'Duke' }, { id: GT, name: 'Georgia Tech' }];
    const games = /^homestream\/games\/(.+)$/.exec(path);
    if (games) return catalogs[games[1]].map(g => ({ ...g, url: g.url === null ? null : `https://gateway.example/media/game/${games[1]}/${g.id}` }));
    if (path === 'sync/teams') return [{ id: '150', name: 'Duke', homestreamId: DUKE }, { id: '59', name: 'Georgia Tech', homestreamId: GT }];
    const status = /^sync\/status\/(\d+)\/(\d+)$/.exec(path);
    if (status) {
      h.statusSignals.push(signal);
      const build = () => { if (h.statusFail) throw Error('status'); return { schemaVersion: 1, teamId: status[1], season: Number(status[2]), checkedAt: 1, ageMs: h.ageMs, events: events(status[1]).filter(e => e.season === Number(status[2])) }; };
      if (!h.holdStatus) return build();
      const gate = deferred(); h.held.push(() => gate.resolve(build())); return gate.promise;
    }
    throw Error('unexpected ' + path);
  };
  class FakePlayer {
    constructor(update, event) { h.player = this; this.update = update; this.event = event; this.sequence = 0; this.epoch = 0; this.starts = 0; this.stops = 0; }
    start() { this.starts++; this.context = { state: 'running' }; this.audio = { paused: false }; return Promise.resolve(); }
    stop() { this.stops++; this.context = null; this.audio = null; }
    command() { return Promise.resolve({ result: 'applied', before: {}, after: {}, contextSeconds: 1 }); }
    resumeContext() { return Promise.resolve(); } timestampState() { return 'none'; } liveTarget() { return null; }
  }
  const clock = () => ({ ...h.clock });
  w.setTimeout = () => ({ cancelled: false }); w.clearTimeout = () => {};
  w.setInterval = (fn, ms) => { h.intervals.push({ fn, ms }); return h.intervals.length; };
  w.__GATEWAY_ORIGIN__ = 'https://gateway.example';
  Object.assign(w, { AbortController, metadataURL, mediaURL, configuredGatewayOrigin, gatewayOptions, readJSON, PlaybackMemory, SessionLog, teams, Player: FakePlayer, demoURL: () => 'blob:demo', setupArchive: () => {},
    createNowPlaying, nowPlayingArtwork, createScoreboard, listenTeams, resolveSources, officialLink, createListenSession, failureKind, TIMELINE_NOTICE, FALLBACK_NOTICE, ...shell,
    setupGameTiming: () => ({ start() {}, stop() {}, reset() {}, invalidate() {}, render() {} }),
    checkPlaylist: url => { h.probes.push({ url, labels: h.labels() }); if (!h.holdProbe) return Promise.resolve('ready'); const gate = deferred(); h.releaseProbe = () => gate.resolve('ready'); return gate.promise; },
    createBroadcastCountdown: () => ({ setSchool() {}, tick() {}, suspend() {}, resume() {}, stop() {} }), createGameStatus: options => createGameStatus({ ...options, clock, timeout: () => new AbortController().signal,
      setTimer: (fn, ms) => { const timer = { fn, ms, cancelled: false, fired: false }; h.statusTimers.push(timer); return timer; },
      clearTimer: timer => { if (timer) timer.cancelled = true; } }) });
  h.$ = id => w.document.getElementById(id);
  h.texts = () => [...h.$('game').options].map(o => o.textContent);
  h.labels = () => h.texts().map(text => text.split(' · ')[0]);
  w.eval(homestreamSource + ';window.setupHomestream=setupHomestream;');
  h.boot = () => w.eval(appSource);
  h.fireStatus = async () => { for (const timer of h.statusTimers.filter(x => !x.cancelled && !x.fired)) { timer.fired = true; timer.fn(); } await flush(); };
  h.tick = () => { for (const { fn, ms } of h.intervals) if (ms === 1000) fn(); };
  h.setVisibility = state => { Object.defineProperty(w.document, 'visibilityState', { value: state, configurable: true }); w.document.dispatchEvent(new w.Event('visibilitychange')); };
  // Everything a status update must leave untouched.
  h.state = () => ({ starts: h.player.starts, stops: h.player.stops, value: h.$('game').value, selected: h.$('game').selectedIndex, values: [...h.$('game').options].map(o => o.value),
    disabled: h.$('game').disabled, focus: w.document.activeElement?.id, play: h.$('connect').disabled, status: h.$('status').textContent, station: h.$('station').textContent,
    source: h.$('source-current').textContent, note: h.$('game-note').textContent, catalogReads: h.requests.filter(p => p.startsWith('homestream/games')).length, probes: h.probes.length });
  return h;
}
const U = 'Status unavailable';

test('every Listen game option is labeled before the selected feed probe; a status label is never feed readiness', async t => {
  const h = harness(t); h.holdProbe = true;
  assert.equal(h.$('game').getAttribute('aria-describedby'), 'game-status-help');
  assert.match(h.$('game-status-help').textContent, /reported by the sports-data source/); assert.match(h.$('game-status-help').textContent, /do not mean a feed is published or playable/);
  assert.equal(h.$('game-status-help').getAttribute('role'), null, 'no live-region announcements for polls');
  h.boot(); await flush();
  assert.deepEqual(h.probes[0].labels, [U, U, U], 'labels exist before the probe starts');
  assert.deepEqual(h.labels(), ['Completed', 'Upcoming', 'Upcoming']);
  assert.match(h.texts()[2], /^Upcoming · .+ · vs Clemson · feed not published$/);
  assert.match(h.texts()[1], /^Upcoming · .+ · vs Tulane$/);
  assert.equal(h.$('connect').disabled, true, 'a status label is not feed readiness: Play waits for the check');
  assert.equal(h.player.starts, 0);
  h.releaseProbe(); await flush();
  assert.equal(h.$('connect').disabled, false); assert.equal(h.$('source-current').textContent, 'Will play · Game feed · timestamps checked once it loads');
});
test('status updates and failures change labels only; audio, source, selection, focus and readiness are untouched', async t => {
  const h = harness(t); h.boot(); await flush();
  h.$('connect').click(); await flush();
  h.$('game').focus();
  const before = h.state();
  assert.deepEqual([before.starts, before.focus], [1, 'game']);
  h.provider[150].g2 = 'live'; await h.fireStatus();
  assert.deepEqual(h.labels(), ['Completed', 'LIVE', 'Upcoming']); assert.deepEqual(h.state(), before);
  h.statusFail = true; await h.fireStatus();
  assert.deepEqual(h.labels(), [U, U, U]); assert.deepEqual(h.state(), before);
  assert.ok(h.statusTimers.filter(x => !x.cancelled && !x.fired).every(x => x.ms === 30000));
  h.statusFail = false; await h.fireStatus();
  assert.deepEqual(h.labels(), ['Completed', 'LIVE', 'Upcoming']); assert.equal(h.player.starts, 1);
});
test('labels expire on the one-second Listen tick without any network completion', async t => {
  const h = harness(t); h.ageMs = 40000; h.boot(); await flush();
  assert.equal(h.labels()[1], 'Upcoming');
  const reads = h.requests.length;
  h.clock.wall += 4000; h.clock.mono += 4000; h.tick();
  assert.equal(h.labels()[1], 'Upcoming');
  h.clock.wall += 1000; h.clock.mono += 1000; h.tick();
  assert.deepEqual(h.labels(), [U, U, U]); assert.equal(h.requests.length, reads);
});
test('hidden tab aborts status and relabels unavailable; visible return reacquires immediately without restarting audio', async t => {
  const h = harness(t); h.boot(); await flush();
  h.$('connect').click(); await flush();
  h.holdStatus = true; await h.fireStatus();
  const inFlight = h.statusSignals.at(-1), starts = h.player.starts, stops = h.player.stops;
  h.setVisibility('hidden');
  assert.equal(inFlight.aborted, true); assert.deepEqual(h.labels(), [U, U, U]);
  assert.equal(h.statusTimers.filter(x => !x.cancelled && !x.fired).length, 0);
  for (const release of h.held.splice(0)) release();
  await flush(); assert.deepEqual(h.labels(), [U, U, U], 'late hidden-tab data cannot relabel');
  h.holdStatus = false; const reads = h.statusSignals.length;
  h.setVisibility('visible'); await flush();
  assert.ok(h.statusSignals.length > reads); assert.deepEqual(h.labels(), ['Completed', 'Upcoming', 'Upcoming']);
  assert.equal(h.player.starts, starts); assert.equal(h.player.stops, stops);
});
test('team change invalidates status; late data never labels the replacement catalog with the same game IDs', async t => {
  const h = harness(t); h.boot(); await flush();
  assert.deepEqual(h.labels(), ['Completed', 'Upcoming', 'Upcoming']);
  h.holdStatus = true; await h.fireStatus();
  const lateDuke = h.held.splice(0);
  h.$('team').value = 'gt'; h.$('team').onchange(); await flush();
  assert.deepEqual([...h.$('game').options].map(o => o.value), ['g1', 'g2']);
  assert.deepEqual(h.labels(), [U, U]);
  for (const release of lateDuke) release();
  await flush(); assert.deepEqual(h.labels(), [U, U], 'Duke results cannot label Georgia Tech options');
  assert.ok(h.requests.some(p => /^sync\/status\/59\//.test(p)));
  for (const release of h.held.splice(0)) release();
  await flush(); assert.deepEqual(h.labels(), ['Completed', 'LIVE']);
  h.$('team').value = 'miami'; h.$('team').onchange();
  assert.equal(h.statusTimers.filter(x => !x.cancelled && !x.fired).length, 0, 'a team without a catalog stops status work');
  assert.equal(h.$('game-panel').hidden, true);
});
