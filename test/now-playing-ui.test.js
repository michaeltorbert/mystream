// Real consumers (app.js Listen, Archive) wired to the real Now Playing publisher and scoreboard poller.
// Only I/O, timers, players, the catalog and the platform MediaSession object are fakes. Browser API
// readback here is not OS, phone or car proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createNowPlaying, nowPlayingArtwork } from '../src/now-playing.js';
import { createScoreboard } from '../src/scoreboard.js';
import { PlaybackMemory } from '../src/playback-memory.js';
import { SessionLog } from '../src/session-log.js';
import { teams, getSources } from '../src/teams.js';
import { metadataURL, configuredGatewayOrigin, gatewayOptions } from '../src/gateway.js';
import { listenTeams, resolveSources, officialLink } from '../src/listen-sources.js';
import { createListenSession, failureKind } from '../src/listen-session.js';
import { TIMELINE_NOTICE, FALLBACK_NOTICE } from '../src/hls-timeline.js';
import { setupArchive } from '../src/archive.js';
import * as shell from '../src/ui-shell.js';
globalThis.__GATEWAY_ORIGIN__ = 'https://gateway.example';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const strip = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ART = 'https://example.test/homecall/now-playing/homecall-512.png';
// Team images resolved by the real app wiring: the claim's frozen school, exact app team names.
const TEAM_ART = key => `https://example.test/homecall/now-playing/${key}-512.png 512x512 image/png`;
const appArtwork = w => identity => nowPlayingArtwork(w.document.baseURI, identity, teams);
const GT = '410422f0-663f-4e3d-82e2-787d954ae29d', DUKE = '2903e5f6-960e-4954-a3ec-f7754e78660f';
const providerTeams = [{ id: '150', name: 'Duke', homestreamId: DUKE }, { id: '59', name: 'Georgia Tech', homestreamId: GT }];
function fakeMediaSession() {
  const ms = { writes: [], actions: [], positions: [], states: [], current: null };
  Object.defineProperty(ms, 'metadata', { get: () => ms.current, set: value => { ms.writes.push(value); ms.current = value; } });
  Object.defineProperty(ms, 'playbackState', { get: () => 'none', set: value => { ms.states.push(value); } });
  ms.setActionHandler = (...args) => { ms.actions.push(args); };
  ms.setPositionState = (...args) => { ms.positions.push(args); };
  return ms;
}
class FakeMetadata { constructor(init) { Object.assign(this, structuredClone(init)); } }
const noControls = ms => assert.deepEqual([ms.actions, ms.positions, ms.states], [[], [], []], 'no action handlers, position state or playback state writes');
// Synthetic live envelopes of the supported contract (not captured provider samples).
const statusEnvelope = (teamId, season, events, ageMs = 0) => ({ schemaVersion: 1, teamId, season, checkedAt: 1, ageMs, events });

// ---------- Listen (src/app.js) ----------
const GT_GAME = { id: 'g2', opponent: 'Duke', start: Date.parse('2026-10-10T19:30:00Z'), url: 'https://gateway.example/media/game/gt/g2' };
const GT_GAMES = [{ id: 'g1', opponent: 'Clemson', start: Date.parse('2026-09-05T19:30:00Z') }, { id: 'g2', opponent: 'Duke', start: GT_GAME.start }];
const DUKE_GAME = { id: 'd1', opponent: 'Tulane', start: GT_GAME.start, url: `https://gateway.example/media/game/${DUKE}/d1` };
const PLAYING = { delay: 0, available: 5, paused: false, holding: false, ingesting: true, restoring: null };
// games: catalog ID -> the ready game feed the fake catalog publishes for that team before Play.
function live(t, { mediaSession = true, games = { [GT]: { game: GT_GAME, list: GT_GAMES } } } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/homecall/', runScripts: 'outside-only' }), w = dom.window;
  t.after(() => w.close());
  const h = { w, ms: fakeMediaSession(), reads: [], timers: [], tickers: [], held: [], statusFail: false, holdStatus: false,
    status: () => statusEnvelope('59', 2026, [{ id: '401858255', start: GT_GAME.start, teams: ['Georgia Tech', 'Duke'], teamIds: ['59', '150'], season: 2026, status: 'live',
      scoreboard: { phase: 'in-progress', period: 2, clock: '7:29', scores: { 150: 14, 59: 17 } } }]) };
  class FakePlayer {
    constructor(update, event) { this.update = update; this.event = event; this.sequence = 0; this.epoch = 0; this.starts = []; h.player = this; }
    get sourceConnected() { return !!this.audio; }
    get sourcePaused() { return !!this.audio?.paused; }
    start(url, delay) { this.starts.push({ url, delay }); this.context = { state: 'running' }; this.audio = { paused: false }; if (this.failNext) { this.failNext = false; return Promise.reject(Error('source-error')); } return Promise.resolve(); }
    stop() { this.context = null; this.audio = null; }
    command() { return Promise.resolve({ result: 'applied', before: { delay: 0 }, after: { delay: 0 }, contextSeconds: 1 }); }
    resumeContext() { return Promise.resolve(); }
    timestampState() { return 'none'; } liveTarget() { return null; }
  }
  const readJSON = async (url, { signal } = {}) => {
    const path = url.pathname.replace(/^\/api\//, ''); h.reads.push(path);
    if (path === 'sync/teams') return structuredClone(providerTeams);
    if (/^sync\/status\//.test(path)) {
      if (h.statusFail) throw Error('status unavailable');
      if (!h.holdStatus) return h.status();
      const gate = deferred(); h.held.push(() => gate.resolve(h.status())); return gate.promise;
    }
    throw Error('unexpected ' + path);
  };
  const catalogFactory = callbacks => ({ ready: null, status: 'idle', stop() {}, relabel() {},
    setEnabled(value) {
      callbacks.onCatalogInvalidated(); this.ready = null; this.status = 'idle';
      const entry = value ? games[callbacks.teamId()] : null;
      if (entry) callbacks.onGames(entry.list ?? [entry.game], { teamId: callbacks.teamId() });
      if (value) { this.ready = entry?.game ?? null; this.status = entry ? 'ready' : 'unavailable'; }
    },
    async refresh() { callbacks.onChange('refresh'); callbacks.onReady(); } });
  w.setTimeout = (fn, ms) => { const timer = { fn, ms, cancelled: false }; h.timers.push(timer); return timer; };
  w.clearTimeout = timer => { if (timer) timer.cancelled = true; };
  w.setInterval = (fn, ms) => { const ticker = { fn, ms, cancelled: false }; h.tickers.push(ticker); return ticker; };
  w.clearInterval = ticker => { if (ticker) ticker.cancelled = true; };
  if (mediaSession) { Object.defineProperty(w.navigator, 'mediaSession', { value: h.ms, configurable: true }); w.MediaMetadata = FakeMetadata; }
  w.URL.revokeObjectURL = () => {};
  Object.assign(w, { setupGameTiming: () => ({ start() {}, stop() {}, reset() {}, invalidate() {}, render() {} }), setupArchive: options => { h.archiveOptions = options; }, setupHomestream: catalogFactory,
    createBroadcastCountdown: () => ({ setSchool() {}, tick() {}, suspend() {}, resume() {}, stop() {} }), createGameStatus: () => ({ setGames() {}, clear() {}, suspend() {}, resume() {}, tick() {}, stop() {} }), listenTeams, resolveSources, officialLink, createListenSession, failureKind, TIMELINE_NOTICE, FALLBACK_NOTICE,
    PlaybackMemory, SessionLog, teams, getSources, Player: FakePlayer, demoURL: () => 'blob:demo', createNowPlaying, nowPlayingArtwork, createScoreboard, readJSON, metadataURL, configuredGatewayOrigin, gatewayOptions, ...shell });
  w.eval(strip('../src/app.js'));
  h.$ = id => w.document.getElementById(id);
  // Changing an active session's team or source now asks first; Continue applies the original change.
  h.proceed = () => h.$('confirm-continue').click();
  h.selectGT = () => { h.$('team').value = 'gt'; h.$('team').onchange(); };
  h.statusReads = () => h.reads.filter(p => p.startsWith('sync/status/')).length;
  h.gameReads = () => h.reads.filter(p => p.startsWith('sync/'));
  h.tick = () => { for (const ticker of h.tickers.filter(x => !x.cancelled && x.ms === 1000)) ticker.fn(); };
  h.firePoll = async () => { const timer = h.timers.filter(x => !x.cancelled && !x.fired && x.ms >= 15000).at(-1); timer.fired = true; timer.fn(); await flush(); };
  h.meta = () => h.ms.metadata && { title: h.ms.metadata.title, artist: h.ms.metadata.artist, album: h.ms.metadata.album, art: h.ms.metadata.artwork.map(a => `${a.src} ${a.sizes} ${a.type}`) };
  return h;
}
const SCORE = /^Live · ESPN data received .+ · Georgia Tech 17, Duke 14 · Q2 7:29$/;

test('Listen GT: browsing never claims; Play freezes identity; score appears only while PCM output plays and strips on every non-playing state', async t => {
  const h = live(t);
  h.selectGT();
  assert.equal(h.ms.writes.length, 0, 'team browsing and catalog readiness never claim');
  h.$('connect').click();
  const STATIC = { title: 'Georgia Tech vs Duke', artist: 'Homecall · Game broadcasts', album: 'Georgia Tech · Homestream', art: [TEAM_ART('gt')] };
  assert.deepEqual(h.meta(), STATIC);
  await flush();
  assert.equal(h.statusReads(), 0, 'connected but no PCM output state yet');
  h.player.update(PLAYING); await flush();
  assert.match(h.ms.metadata.title, SCORE);
  assert.equal(h.ms.metadata.artist, 'Georgia Tech vs Duke · Homecall · Game broadcasts');
  assert.deepEqual(h.meta().art, [TEAM_ART('gt')], 'the score never changes the selected school\'s image');
  assert.deepEqual(h.gameReads().slice(0, 2), ['sync/teams', 'sync/status/59/2026']);
  for (const [name, change, restore] of [
    ['pause', () => h.player.update({ ...PLAYING, paused: true }), () => h.player.update(PLAYING)],
    ['hold', () => h.player.update({ ...PLAYING, holding: true }), () => h.player.update(PLAYING)],
    ['restoring', () => h.player.update({ ...PLAYING, restoring: 35 }), () => h.player.update(PLAYING)],
    ['context interruption', () => { h.player.context.state = 'suspended'; h.player.event('context-interrupted'); }, () => { h.player.context.state = 'running'; h.player.event('context-restored'); }],
    ['element pause', () => { h.player.audio.paused = true; h.player.event('source-paused'); }, () => { h.player.audio.paused = false; h.player.event('source-playing'); h.player.update(PLAYING); }],
    ['internal reconnect', () => h.player.event('source-reconnecting'), () => { h.player.event('source-reconnected'); h.player.update(PLAYING); }]
  ]) {
    const reads = h.statusReads();
    change();
    assert.deepEqual(h.meta(), STATIC, name);
    for (let i = 0; i < 20; i++) h.tick();
    await flush();
    assert.equal(h.statusReads(), reads, `${name}: no polling while output is not playing`);
    restore(); await flush();
    assert.equal(h.statusReads(), reads + 1, `${name}: returning to playback polls immediately`);
    assert.match(h.ms.metadata.title, SCORE, name);
  }
  h.$('stop').click();
  assert.equal(h.ms.metadata, null);
  noControls(h.ms);
});
test('Listen input buffering alone keeps the score while delayed PCM output continues', async t => {
  const h = live(t);
  h.selectGT(); h.$('connect').click(); await flush();
  h.player.update(PLAYING); await flush();
  h.player.event('source-waiting'); h.player.update({ ...PLAYING, ingesting: false });
  assert.match(h.ms.metadata.title, SCORE);
});
test('Listen late results and every terminal path release; a superseded session cannot republish', async t => {
  const h = live(t);
  h.selectGT(); h.$('connect').click(); await flush();
  h.holdStatus = true; h.player.update(PLAYING); await flush();
  h.$('stop').click();
  assert.equal(h.ms.metadata, null);
  for (const release of h.held.splice(0)) release();
  await flush();
  assert.equal(h.ms.metadata, null, 'a late result after Stop cannot republish');
  h.holdStatus = false;
  h.$('connect').click(); await flush(); h.player.update(PLAYING); await flush();
  assert.match(h.ms.metadata.title, SCORE);
  h.player.event('source-reconnect-required'); h.player.update(null);
  assert.equal(h.ms.metadata, null, 'player-reported terminal state releases');
  h.$('stop').click();
  h.player.failNext = true; h.$('connect').click();
  assert.equal(h.ms.metadata.title, 'Georgia Tech vs Duke', 'claimed on the playback intent');
  await flush();
  assert.equal(h.ms.metadata, null, 'a failed start releases');
  h.$('connect').click(); await flush(); h.player.update(PLAYING); await flush();
  h.holdStatus = true; await h.firePoll();
  h.$('team').value = 'duke'; h.$('team').onchange();
  assert.notEqual(h.ms.metadata, null, 'a pending team prompt changes nothing');
  h.proceed();
  assert.equal(h.ms.metadata, null, 'changing team releases');
  for (const release of h.held.splice(0)) release();
  await flush();
  assert.equal(h.ms.metadata, null);
  noControls(h.ms);
});
test('Listen status failure only removes volatile data; audio keeps playing', async t => {
  const h = live(t);
  h.selectGT(); h.$('connect').click(); await flush();
  h.player.update(PLAYING); await flush();
  assert.match(h.ms.metadata.title, SCORE);
  h.statusFail = true; await h.firePoll();
  assert.equal(h.ms.metadata.title, 'Georgia Tech vs Duke');
  assert.equal(h.player.starts.length, 1); assert.equal(h.$('stop').disabled, false); assert.notEqual(h.$('status').textContent, 'Disconnected');
  assert.equal(h.timers.filter(x => !x.cancelled && !x.fired).at(-1).ms, 30000);
  h.statusFail = false; await h.firePoll();
  assert.match(h.ms.metadata.title, SCORE);
});
test('Listen radio, affiliates and the demo publish station or test-tone identity only, even while a live event exists', async t => {
  const h = live(t);
  assert.equal(h.ms.writes.length, 0);
  h.$('connect').click(); await flush();
  h.player.update(PLAYING);
  for (let i = 0; i < 30; i++) h.tick();
  await flush();
  assert.deepEqual(h.meta(), { title: 'Duke Sports Network', artist: 'Homecall · Radio stations', album: 'Duke', art: [TEAM_ART('duke')] });
  assert.deepEqual(h.gameReads(), [], 'no game is guessed for radio, so no status is read');
  h.$('feed').value = 'duke-wsjs'; h.$('feed').onchange(); h.proceed();
  assert.equal(h.ms.metadata, null, 'changing feed stops and releases');
  h.$('connect').click(); await flush();
  assert.equal(h.ms.metadata.title, 'WSJS · Duke affiliate');
  assert.deepEqual(h.meta().art, [TEAM_ART('duke')], 'an affiliate keeps the selected school\'s image');
  for (const [key, title] of [['miami', '104.3 WQAM'], ['vt', 'Virginia Tech Sports Network']]) {
    h.$('team').value = key; h.$('team').onchange(); h.proceed(); h.$('connect').click(); await flush(); h.player.update(PLAYING); await flush();
    assert.equal(h.ms.metadata.title, title); assert.equal(h.ms.metadata.artist, 'Homecall · Radio stations');
    assert.deepEqual(h.meta().art, [TEAM_ART(key)], key);
  }
  h.$('demo').click(); await flush();
  assert.deepEqual(h.meta(), { title: 'Timing demo · repeating tones', artist: 'Homecall · Test tone', album: 'Homecall', art: [`${ART} 512x512 image/png`] }, 'the test tone keeps the generic image');
  assert.deepEqual(h.gameReads(), []);
  noControls(h.ms);
});
// Superseded: the separate Sync route is gone; Listen and Recordings share the one publisher.
test('one application publisher is shared with Recordings; a superseded Listen owner never clears the newer claim', async t => {
  const h = live(t);
  h.$('connect').click(); await flush();
  const other = h.archiveOptions.nowPlaying.claim({ mode: 'archive', school: 'Duke', opponent: 'Tulane' });
  assert.equal(h.ms.metadata.title, 'Duke vs Tulane');
  assert.deepEqual(h.meta().art, [TEAM_ART('duke')], 'the shared publisher resolves team art for every caller');
  h.player.update(null); h.$('stop').click();
  assert.equal(h.ms.metadata.title, 'Duke vs Tulane');
  assert.equal(other.release(), true); assert.equal(h.ms.metadata, null);
});
test('a superseded Listen session stops polling even while its old audio state still looks eligible', async t => {
  const h = live(t);
  h.selectGT(); h.$('connect').click(); await flush();
  h.player.update(PLAYING); await flush();
  assert.match(h.ms.metadata.title, SCORE);
  const other = h.archiveOptions.nowPlaying.claim({ mode: 'archive', school: 'Duke', opponent: 'Tulane' });
  h.tick();
  assert.equal(h.timers.filter(x => !x.cancelled && !x.fired).length, 0, 'the old poller halts on the next watchdog tick');
  const reads = h.statusReads();
  h.player.update(PLAYING);
  for (let i = 0; i < 60; i++) h.tick();
  await flush();
  assert.equal(h.statusReads(), reads, 'Listen audio still reports PCM output, but it no longer owns Now Playing');
  assert.equal(h.ms.metadata.title, 'Duke vs Tulane');
  assert.equal(other.current, true);
});
test('without a Media Session API no scoreboard requests are made and audio is unchanged', async t => {
  const h = live(t, { mediaSession: false });
  h.selectGT(); h.$('connect').click(); await flush();
  h.player.update(PLAYING);
  for (let i = 0; i < 30; i++) h.tick();
  await flush();
  assert.deepEqual(h.gameReads(), []); assert.equal(h.ms.writes.length, 0);
  assert.equal(h.player.starts.length, 1); assert.equal(h.$('stop').disabled, false);
});
test('AC16 a game-feed fallback publishes the actual network identity without a score; Source and the log name it too', async t => {
  const h = live(t, { games: { [DUKE]: { game: DUKE_GAME } } });
  h.player.failNext = true; h.$('connect').click();
  assert.equal(h.ms.metadata.title, 'Duke vs Tulane', 'the game feed was claimed when it started');
  await flush();
  assert.deepEqual(h.meta(), { title: 'Duke Sports Network', artist: 'Homecall · Radio stations', album: 'Duke', art: [TEAM_ART('duke')] });
  h.player.update(PLAYING);
  for (let i = 0; i < 20; i++) h.tick();
  await flush();
  assert.equal(h.statusReads(), 0, 'no scoreboard follows a radio replacement');
  h.player.event('output-ready');
  assert.match(h.$('switch-notice').textContent, /^Switched to Duke Sports Network/);
  const fade = h.timers.filter(x => !x.cancelled && x.ms === 6000).at(-1); fade.fn(); h.timers.filter(x => !x.cancelled && x.ms === 700).at(-1).fn();
  assert.equal(h.$('switch-notice').hidden, true, 'the notice fades');
  assert.equal(h.$('source-current').textContent, 'Playing · Network · manual alignment', 'Source stays accurate after the notice fades');
  assert.equal(h.$('station').textContent, 'Duke Sports Network');
  h.$('preview').click(); assert.equal(JSON.parse(h.$('export').value).sourceId, 'duke-leanstream');
});

// ---------- Archive (src/archive.js) ----------
test('Archive publishes a score-free recording identity, keeps it through pause, end and error, and releases on stop or replacement', async t => {
  const item = { id: 'one', opponent: 'Tulane', sport: 'Football', start: '2026-09-05T18:00:00Z', kind: 'Game recording', url: 'https://gateway.example/media/archive/duke/one' };
  const dom = new JSDOM(html, { url: 'https://example.test/homecall/' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(String(url)); return { ok: true, json: async () => ({ checkedAt: '2026-09-11T00:00:00Z', schools: { duke: { status: 'ready', source: 'https://duke.leanplayer.com/', items: [item] }, miami: { status: 'external', source: 'https://miamihurricanes.com/', items: [] }, vt: { status: 'ready', source: 'https://hokiesports.com/', items: [] } } }) }; });
  const oldDocument = globalThis.document, oldOption = globalThis.Option;
  globalThis.document = dom.window.document; globalThis.Option = dom.window.Option;
  t.after(() => { globalThis.document = oldDocument; globalThis.Option = oldOption; dom.window.close(); });
  const $ = id => document.getElementById(id), audio = $('replay-audio'), saved = [];
  audio.pause = () => {}; audio.load = () => {}; audio.play = async () => {};
  const ms = fakeMediaSession(), np = createNowPlaying({ mediaSession: ms, MediaMetadata: FakeMetadata, artwork: appArtwork(dom.window) });
  let stops = 0;
  setupArchive({ stopLive: () => { stops++; }, selectedTeam: () => 'duke', memory: { read: () => null, save: (...args) => saved.push(args) }, nowPlaying: np, origin: 'https://gateway.example' });
  await new Promise(r => setImmediate(r));
  $('archive-tab').click();
  assert.equal(ms.writes.length, 0, 'opening the tab and listing recordings never claim');
  $('archive-list').querySelector('button').click();
  assert.equal(stops, 1);
  const identity = { title: 'Duke vs Tulane', artist: 'Homecall · Recordings', album: 'Duke', artwork: [{ src: 'https://example.test/homecall/now-playing/duke-512.png', sizes: '512x512', type: 'image/png' }] };
  assert.deepEqual({ ...ms.metadata }, identity);
  const writes = ms.writes.length;
  for (const type of ['playing', 'pause', 'ended', 'error']) audio.dispatchEvent(new dom.window.Event(type));
  assert.deepEqual({ ...ms.metadata }, identity); assert.equal(ms.writes.length, writes, 'end and error keep the static identity for native replay');
  Object.defineProperty(audio, 'readyState', { value: 1 }); audio.currentTime = 7; audio.dispatchEvent(new dom.window.Event('timeupdate'));
  assert.deepEqual(saved.at(-1), ['replay', 'duke:one', 7], 'bookmarks are unchanged');
  $('archive-list').querySelector('button').click();
  assert.equal(ms.writes.length, writes, 'a pending replacement prompt changes nothing');
  $('confirm-continue').click();
  assert.deepEqual(ms.writes.slice(writes).map(x => x?.title ?? null), [null, 'Duke vs Tulane'], 'replacement releases before the new claim');
  assert.ok(requests.every(url => url.endsWith('/api/catalog/archive')), 'Archive never reads game status or scores');
  assert.ok(!/\d+, |ESPN|Q\d/.test(ms.metadata.title + ms.metadata.artist));
  $('archive-team').value = 'miami'; $('archive-team').onchange(); $('confirm-continue').click();
  assert.equal(ms.metadata, null);
  noControls(ms);
});
