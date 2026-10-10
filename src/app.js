import { setupGameTiming } from './sync.js';
import { PlaybackMemory } from './playback-memory.js';
import { setupArchive } from './archive.js';
import { teams } from './teams.js';
import { setupHomestream } from './homestream-ui.js';
import { Player } from './player.js';
import { SessionLog } from './session-log.js';
import { demoURL } from './demo.js';
import { createNowPlaying, nowPlayingArtwork } from './now-playing.js';
import { createScoreboard } from './scoreboard.js';
import { readJSON } from './homestream.js';
import { metadataURL, configuredGatewayOrigin, gatewayOptions } from './gateway.js';
import { setupShell, createConfirm, setDisclosure, closeDialog } from './ui-shell.js';
import { listenTeams, resolveSources, officialLink } from './listen-sources.js';
import { createListenSession, failureKind } from './listen-session.js';
import { createGameStatus } from './game-status.js';
import { createBroadcastCountdown } from './broadcast-countdown.js';
import { TIMELINE_NOTICE, FALLBACK_NOTICE } from './hls-timeline.js';
const $ = id => document.getElementById(id);
let storage;
try { storage = localStorage; } catch { /* Private browsing may deny access. */ }
const memory = new PlaybackMemory(storage, text => { $('storage-warning').textContent = text; });
let liveKey = null, savedDelay = null, sourcePaused = false;
// Every configured team plus every school the catalog lists (added once the catalog answers).
let teamList = listenTeams(), teamsLoaded = false;
let selected = 'duke';
try { if (teams[storage?.getItem('mystream.team')]) selected = storage.getItem('mystream.team'); } catch {}
let resetSourceDelay = false;
let state = null, connecting = false, active = false, scrubbing = false, generation = 0, demo = null, pending = 0, specialPending = false;
let previewText = '', previewId = '', needsCheck = true, sourceStatus = 'Stopped', attention = false;
let nav = null;
// One Listen owner: the Source mode and listening intent, the candidate physically started, its attempt
// token, and the terminal Player event that explains an ended physical session.
const session = createListenSession();
let current = null, attempt = null, terminal = null, freshPending = null, timestampsNoticed = false, switchTimer = null, exhaustion = null;
// Transport progress text (buffering, stalled, trying a replacement) that later eligible output makes
// obsolete; any other notice (warnings, timestamps, restoration, alignment) is never retired by output.
let progressText = null, outputSeen = false, switchedFrom = null;
const build = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'development';
$('build').textContent = build;
const log = new SessionLog({ storage, build, onWarning: text => { $('storage-warning').textContent = text; } });
const notice = text => { $('notice').textContent = text; };
const progress = text => { notice(text); progressText = text; };
const progressShown = () => progressText !== null && $('notice').textContent === progressText;
// One prompt for every takeover, departure and destructive refresh across Listen and Recordings.
const ask = createConfirm(document);
// One application-wide Now Playing publisher; Listen and Recordings each claim it on playback start.
// Artwork follows the claim's frozen school by exact app team name; anything else is generic.
const nowPlaying = createNowPlaying({ mediaSession: navigator.mediaSession, MediaMetadata: window.MediaMetadata, artwork: identity => nowPlayingArtwork(document.baseURI, identity, teams) });
const metadata = (path, options) => readJSON(metadataURL(path, document.baseURI, configuredGatewayOrigin(), gatewayOptions()), options);
const scoreboard = () => createScoreboard({ read: metadata, window, document,
  setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: timer => clearTimeout(timer), setTicker: (fn, ms) => setInterval(fn, ms), clearTicker: timer => clearInterval(timer) });
const liveBoard = scoreboard();
let liveOwner = null, liveCatalog = null;
// Volatile game data follows actual PCM output, not input ingestion or the selected view, and
// stops as soon as another session owns Now Playing.
const livePlaying = () => !!liveOwner?.current && active && !connecting && !!state && player.context?.state === 'running' && player.sourceConnected && !player.sourcePaused &&
  !sourcePaused && !state.paused && !state.holding && state.restoring == null;
function releaseLive() { liveBoard.stop(); liveOwner?.release(); liveOwner = null; }
// Events that need the listener's attention; they stay visible while browsing other views.
const ATTENTION = new Set(['source-stalled', 'source-paused', 'source-reconnecting', 'source-reconnect-required', 'source-reconnect-exhausted', 'source-ended', 'source-error',
  'context-interrupted', 'engine-error', 'control-overflow', 'command-timeout', 'resume-failed', 'buffer-overrun']);
// Recovery replacement and terminal failures make any pending prompt about this session stale.
const TERMINAL = new Set(['source-reconnecting', 'source-reconnect-required', 'source-reconnect-exhausted', 'source-error', 'engine-error', 'control-overflow', 'command-timeout', 'resume-failed']);
// Player events that are followed by the end of the physical session (update(null)).
const ENDING = new Set(['source-reconnect-required', 'source-reconnect-exhausted', 'control-overflow', 'command-timeout', 'resume-failed']);
const player = new Player(update, (event, detail) => {
  if (!active) return;
  if (event === 'output-ready') { outputReady(); return; }
  if (event.startsWith('timeline-')) { timelineEvent(event, detail); return; }
  if (event === 'source-reconnecting') { connecting = true; timing.invalidate(); }
  if (['source-reconnected', 'source-reconnect-required', 'source-reconnect-exhausted'].includes(event)) connecting = false;
  if (event === 'source-paused') sourcePaused = true;
  if (TERMINAL.has(event)) ask.cancel();
  if (ENDING.has(event)) terminal = { event, reason: detail?.reason };
  if (ATTENTION.has(event)) attention = true;
  else if (['source-playing', 'source-reconnected', 'context-restored'].includes(event)) attention = false;
  if (event === 'source-playing') {
    sourceStatus = 'Receiving audio'; log.add(event, {}, state);
    // Once this attempt has produced output, a resumed source replaces its buffering text with an alignment check.
    if (outputSeen && progressShown()) { progressText = null; notice('The source returned after buffering. Check alignment with your TV.'); }
  } else {
    needsCheck = true; log.boundary(event, state);
    const messages = {
      'source-waiting': 'The source is buffering. Check alignment when it returns.',
      'source-stalled': 'The source stopped delivering data. Check alignment when it returns.',
      'source-paused': 'Your phone paused the source. Resume restores your saved delay; use Resume at paused position only if the TV paused too.',
      'source-reconnecting': 'Connection lost. Reconnecting to the same source and refilling your saved delay…',
      'source-reconnected': 'Reconnected. Your saved delay is refilling; check alignment when audio returns.',
      'source-reconnect-required': detail?.reason === 'seek' ? 'The timestamp move could not be confirmed and audio did not resume. Press Play to reconnect to the same source, then check alignment.'
        : detail?.reason === 'local' ? 'The audio engine could not restart. Press Play to reconnect to the same source.' : 'Playback needs your permission to resume. Press Play to reconnect with your saved delay.',
      'source-reconnect-exhausted': 'The source could not reconnect after three attempts.',
      'source-ended': 'The source ended. Reconnect to start a fresh audio buffer.',
      'source-error': 'The source reported an error. Check playback.',
      'context-restored': 'Phone audio returned. Restoring playback; check alignment.',
      'context-interrupted': 'Phone audio was interrupted. Press Resume, then check alignment.',
      'engine-error': 'The audio engine stopped. Reconnect to start a fresh buffer.',
      'control-overflow': 'Audio disconnected after too many pending source events. Press Play to reconnect.',
      'command-timeout': 'Audio disconnected because a timing change could not be confirmed. Reconnect to begin with a fresh buffer.',
      'resume-failed': 'Audio could not resume. Reconnect when your phone is ready for playback.',
      'buffer-overrun': 'The held audio reached the 3-minute limit. Playback is paused; choose a new sync point.'
    };
    sourceStatus = event === 'buffer-overrun' ? 'Buffer limit reached' : 'Check playback';
    (['source-waiting', 'source-stalled'].includes(event) ? progress : notice)(messages[event] || 'Playback changed. Check alignment.');
  }
  render();
});
// Label-only game status for the Game choice; it never affects readiness, audio or timing.
const gameStatus = createGameStatus({ read: metadata, enabled: () => document.visibilityState !== 'hidden', onUpdate: labels => catalog.relabel(labels) });
// The committed school's next network broadcast. It writes only its own line; never audio, catalog or status.
const countdown = createBroadcastCountdown({ read: metadata, el: $('broadcast-next'), enabled: () => document.visibilityState !== 'hidden' });
const catalog = setupHomestream({ guard: liveGuard, school: () => currentTeam().name, teamId: () => currentTeam().catalogId,
  // A game change ends the intent and returns Source to Automatic; a reload ends the intent only.
  onChange: kind => { disconnect(); if (kind === 'game') session.setMode('auto'); resetAlignment(); render(); },
  onReady: () => { showSource(); render(); },
  onGames: (games, { teamId }) => { liveCatalog = { games, teamId }; gameStatus.setGames({ games, teamId, school: currentTeam().name }); },
  onCatalogInvalidated: () => { liveCatalog = null; gameStatus.clear(); } });
// Match my TV game-timing tools for catalog game feeds; they move audio only through seekTo.
const timing = setupGameTiming({ player, seek: position => seekTo(position), schoolName: () => currentTeam().name, teamId: () => currentTeam().catalogId });
// Changing or refreshing the selected game stops an active session; confirm before that happens.
function liveGuard(kind, proceed, revert) {
  if (!active && !connecting) return proceed();
  revert?.();
  ask.ask(kind === 'game' ? { title: 'Change game?', text: 'Audio stops. Your delay and TV alignment do not transfer to another game.', action: 'Change game' }
    : { title: 'Refresh games?', text: 'Refreshing the game list stops this broadcast. Press Play again when the feed is ready.', action: 'Refresh' }, proceed);
}
const currentTeam = () => teamList.get(selected) ?? teamList.get('duke');
// What the selected team and game can play now. A fake or older catalog without status reads as ready/unavailable.
function resolution() {
  return resolveSources(currentTeam(), { status: catalog.status ?? (catalog.ready ? 'ready' : 'unavailable'), game: catalog.ready });
}
// The candidate the next Play would start: a pending one, the chosen source, or the top of the order.
function nextCandidate(r = resolution()) {
  if (session.pending) return session.candidate;
  if (r.state !== 'resolved') return null;
  return session.mode === 'auto' ? r.candidates[0] ?? null : r.candidates.find(c => c.sourceId === session.mode) ?? null;
}
const shown = () => (active || session.pending ? current : nextCandidate());
function update(value) {
  if (value === null && active) {
    ask.cancel();
    releaseLive(); timing.stop(); log.end(state); active = false; sourceStatus = 'Disconnected';
    if (demo) URL.revokeObjectURL(demo); demo = null;
    const ended = terminal; terminal = null; attempt = null; state = null;
    refreshSessions();
    if (!current?.demo && session.intent) {
      // Exhausted same-source recovery advances once; everything else keeps this candidate for Play.
      if (ended?.event === 'source-reconnect-exhausted') { advance(current, 'exhausted'); return; }
      session.hold(ended?.event === 'source-reconnect-required' ? ended.reason === 'paused' ? 'paused' : ['local', 'seek'].includes(ended.reason) ? 'local' : 'denied' : 'local');
    }
  }
  const wasRestoring = state?.restoring != null;
  state = value;
  if (state && active && state.ingesting && !state.paused && !state.holding && state.restoring == null) {
    if (!player.sourcePaused) sourcePaused = false;
    if (savedDelay === null || Math.abs(savedDelay - (state.resumeDelay ?? state.delay)) > 0.02) {
      savedDelay = state.resumeDelay ?? state.delay; if (liveKey) memory.save('live', liveKey, savedDelay);
    }
    if (wasRestoring) notice(`Restored your ${state.delay.toFixed(1)}-second delay. Check alignment with your TV.`);
  }
  render();
}
// Restoring wins, then connecting, interruption, hold and pause. Playing requires actual
// output (running context, unpaused element and engine); input receipt alone never says Playing.
function primaryStatus() {
  if (state?.restoring != null) return `Restoring ${state.restoring.toFixed(1)}-second delay · ${Math.max(0, state.restoring - state.available).toFixed(0)} s of audio still needed`;
  if (connecting) return 'Connecting…';
  if (!active) return sourceStatus;
  if (!state) return 'Connecting…';
  // Without both a source and an audio context there is no output to call Playing.
  if (!player.sourceConnected || !player.context) return 'Check playback';
  if (player.context.state !== 'running') return 'Interrupted';
  if (state.holding) return 'Paused for TV';
  if (state.paused || sourcePaused || player.sourcePaused) return sourceStatus === 'Buffer limit reached' ? 'Paused · buffer limit reached' : 'Paused';
  return sourceStatus === 'Check playback' ? 'Playing · check playback' : 'Playing';
}
// The persistent Source line: which source plays or will play, and how alignment works for it.
function sourceLine(r, status) {
  const c = shown();
  if (!c) return r.state === 'checking' ? 'Checking the game feed before Play…' : r.state === 'unavailable' ? 'No feed is available for this game right now.' : session.mode !== 'auto' ? 'The chosen source is not available. Choose Automatic or another source.' : '';
  if (c.demo) return '';
  const prefix = connecting ? 'Connecting' : active ? (status.startsWith('Playing') ? 'Playing' : 'Source') : session.pending === 'paused' ? 'Paused on' : session.pending ? 'Waiting for Play' : 'Will play';
  const ts = active && c.kind === 'game' ? player.timestampState?.() : null;
  const alignment = c.kind !== 'game' ? 'manual alignment' : ts === 'available' ? 'broadcast timestamps' : ts === 'missing' ? 'manual alignment · no broadcast timestamps' : 'timestamps checked once it loads';
  return [prefix, c.label, c.kind === 'affiliate' ? 'affiliate · check coverage' : null, alignment, session.mode !== 'auto' ? 'chosen in Source' : null].filter(Boolean).join(' · ');
}
function render() {
  const r = resolution(), team = currentTeam();
  const ready = active && !!state && !connecting;
  const restoring = state?.restoring != null;
  const holding = !!state?.holding;
  const positionReady = ready && !restoring && player.context?.state === 'running';
  // Hold exits stay usable while a restore is in progress so a hold can never be stranded.
  const holdExitReady = ready && player.context?.state === 'running' && !specialPending;
  const status = primaryStatus();
  $('status').textContent = status;
  const playable = !!session.pending || (r.state === 'resolved' && !!nextCandidate(r));
  $('connect').textContent = active ? 'Reconnect' : 'Play';
  $('connect').hidden = active;
  // Play waits for the pre-Play check; it never starts a placeholder for a feed still being checked.
  $('connect').disabled = connecting || (!active && !playable);
  // Stop also cancels a source that is waiting for Play after a denial, pause or engine stop.
  $('stop').disabled = !active && !connecting && !session.pending;
  $('pause').hidden = !active;
  // While connecting or reconnecting, Pause cancels the pending attempt and keeps this source for Play.
  $('pause').disabled = connecting ? !!current?.demo : !ready || (restoring && player.context?.state === 'running' && !player.sourcePaused) || holding || specialPending;
  $('pause').textContent = holding ? 'Paused' : !connecting && (state?.paused || player.sourcePaused || player.context?.state !== 'running') ? 'Resume' : 'Pause';
  $('hold').disabled = holding ? !holdExitReady : !positionReady || specialPending || state.paused || !state.ingesting;
  $('hold').textContent = holding ? 'Resume with this delay' : 'Pause to match TV';
  $('resume-position').hidden = !ready || state?.canResumePosition === false || !state?.paused || restoring || holding || state.delay >= state.available - 0.01;
  $('resume-position').disabled = specialPending;
  $('resume-position-row').hidden = $('resume-position').hidden;
  $('cancel').hidden = !holding;
  $('cancel').disabled = !holdExitReady;
  // Matching stays open for the whole hold; Close returns once the hold ends.
  if (holding) setDisclosure(document, 'matching', true);
  $('match-close').hidden = holding;
  $('adjust-area').hidden = holding;
  $('sync-help').textContent = holding ? 'When the TV reaches what you just heard, resume. The buffer keeps filling while audio is held.' : 'Call ahead of the picture? Pause at a distinct play, then resume when the TV shows it.';
  $('confirm').disabled = !ready || restoring || holding || state.paused || !state.ingesting || pending > 0 || player.context?.state !== 'running';
  $('confirm').textContent = log.confirmed && !needsCheck ? '✓ Marked aligned' : 'Sounds aligned';
  $('alignment').textContent = log.confirmed && !needsCheck ? 'You marked it aligned' : 'Check alignment';
  $('scrub').disabled = !positionReady || holding || specialPending;
  $('live').disabled = !ready || player.context?.state !== 'running' || holding || specialPending;
  document.querySelectorAll('[data-nudge]').forEach(button => { button.disabled = !positionReady || holding || specialPending; });
  $('delay').textContent = (state?.delay || 0).toFixed(2);
  $('buffer').textContent = state ? `${state.available.toFixed(0)} s available${state.paused ? ' · audio paused' : ''}` : 'History fills as you listen';
  if (!scrubbing) {
    $('scrub').max = state?.available || 0; $('scrub').value = state?.delay || 0;
    $('scrub-label').textContent = `${(state?.delay || 0).toFixed(2)} s`;
  }
  $('provider').disabled = $('output').disabled = active;
  $('context-lock').hidden = !active;
  for (const id of ['share', 'copy', 'download']) $(id).disabled = !previewText || pending > 0;
  // Source picker: Automatic plus every configured source; the game feed only when published and playable.
  const gameOption = r.gameSourceId ? $('feed').querySelector(`option[value="${r.gameSourceId}"]`) : null;
  if (gameOption) {
    const label = r.game === 'ready' ? 'Game feed' : r.game === 'checking' ? 'Game feed · checking' : 'Game feed · unavailable';
    if (gameOption.textContent !== label) gameOption.textContent = label;
    gameOption.disabled = r.game !== 'ready' && session.mode !== r.gameSourceId;
  }
  if ($('feed').value !== session.mode) $('feed').value = session.mode;
  const line = sourceLine(r, status);
  if ($('source-current').textContent !== line) $('source-current').textContent = line;
  // Missing timestamps change only the tools offered: same audio, same source, manual alignment.
  const ts = active && !connecting && current?.kind === 'game' ? player.timestampState?.() : null;
  if (ts === 'missing' && !timestampsNoticed) { timestampsNoticed = true; notice(TIMELINE_NOTICE.timestamps); }
  $('timing-tools').hidden = !(active && current?.kind === 'game' && ts !== 'missing');
  const link = officialLink(team, shown());
  $('official').hidden = $('recover-official').hidden = !link;
  if (link) $('official').href = $('recover-official').href = link;
  $('recover-note').hidden = !!link || !attention;
  $('recover-note').textContent = link ? '' : `No official player link is configured for ${team.name}.`;
  // Attention messages are flagged for the browsing strip and modal mirrors; the notice stays the only writer.
  $('notice').classList.toggle('attention', attention);
  if ($('notice').dataset.alert !== (attention ? 'on' : '')) $('notice').dataset.alert = attention ? 'on' : '';
  $('recovery-actions').hidden = !attention || connecting;
  $('recover-reconnect').textContent = active ? 'Reconnect' : session.pending ? 'Play' : 'Retry';
  $('recover-reconnect').disabled = $('connect').disabled;
  // The Listen owner stays reachable from Recordings, including its last error.
  $('owner-strip').hidden = !(active || connecting || attention);
  $('owner-name').textContent = $('station').textContent;
  $('owner-state').textContent = $('status').textContent;
  $('owner-stop').disabled = !active && !connecting;
  liveBoard.check();
}
function showSource() {
  const team = currentTeam(), r = resolution(), source = shown();
  if (!active && !connecting) $('station').textContent = source?.title ?? team.name;
  $('source-note').textContent = source?.kind === 'game' ? 'Published game feed. Availability is checked before Play. When the feed carries broadcast timestamps, Match my TV can find a recorded play; delay controls work either way.'
    : source?.kind === 'affiliate' ? `${team.name} affiliate station. Game and postgame coverage can change; check that you hear the broadcast you want.`
    : source?.note ? source.note
    : selected === 'miami' ? 'WQAM’s live station stream. Scheduled games may be subject to streaming rights and location restrictions; station audio does not prove the game is on air.'
    : source ? 'Live network channel. Game coverage depends on the broadcaster; an empty or expired schedule does not disable this channel.'
    : r.state === 'checking' ? 'Checking the published game feed before Play.' : 'No feed is available for this game right now. Refresh games later.';
}
// Automatic first, then the game feed (when the team has a catalog identity) and every existing source.
function rebuildSources() {
  const r = resolution(), team = currentTeam();
  const options = [['auto', 'Automatic', 'Plays the best available feed and switches to a backup if it fails']];
  if (r.gameSourceId) options.push([r.gameSourceId, 'Game feed', 'The selected game’s published broadcast feed']);
  for (const c of team.radio ? resolveSources({ ...team, catalogId: null }).candidates : []) options.push([c.sourceId, c.label, c.description]);
  $('feed').replaceChildren(...options.map(([value, text, title]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; option.title = title; return option; }));
  $('feed').value = session.mode; $('feed-picker').hidden = options.length < 3;
}
function teamChanged() {
  disconnect(); selected = $('team').value;
  session.setMode('auto'); resetSourceDelay = false; resetAlignment();
  if (teams[selected]) try { storage?.setItem('mystream.team', selected); } catch {}
  catalog.setEnabled(!!currentTeam().catalogId);
  rebuildSources(); showSource(); notice(''); render();
  countdown.setSchool(selected);
}
function sourceChanged() {
  const id = $('feed').value;
  if (id === session.mode || ![...$('feed').options].some(option => option.value === id)) return;
  disconnect(); session.setMode(id); resetSourceDelay = true; resetAlignment();
  showSource();
  const next = nextCandidate();
  notice(id === 'auto' ? 'Automatic source. Press Play to start the best available feed at 0 seconds.' : `Ready for ${next?.station ?? 'the chosen source'}. Press Play to start at 0 seconds.`);
  render();
}
// A cross-source boundary: no timestamp offset, calibration, play choice or anchor carries over.
// PCM history ends with the old context and the new source starts at 0 seconds.
function resetAlignment() { timing.reset(); needsCheck = true; }
// Ends the physical session only; the listening intent is decided by the caller.
function stopPhysical() {
  ask.cancel();
  releaseLive(); ++generation; sourcePaused = false; liveKey = null; savedDelay = null; log.end(state); player.stop(); timing.stop();
  if (demo) URL.revokeObjectURL(demo); demo = null;
  state = null; active = connecting = false; pending = 0; specialPending = false; attention = false; attempt = null; terminal = null;
  progressText = null; outputSeen = false; switchedFrom = null;
  needsCheck = true; sourceStatus = 'Stopped';
}
function disconnect() {
  stopPhysical(); session.cancel(); current = null; freshPending = null; exhaustion = null; hideSwitch();
  refreshSessions(); showSource(); render();
}
// The only physical start for Listen. It runs synchronously inside the caller's click or callback.
function startCandidate(candidate, { trigger = 'play', replacement = false, previous = null } = {}) {
  stopPhysical();
  const mine = generation, team = currentTeam();
  attempt = candidate.demo ? null : session.attempt();
  const token = attempt;
  current = candidate; active = connecting = true; timestampsNoticed = false; exhaustion = null;
  liveKey = candidate.demo ? null : candidate.game ? `${candidate.sourceId}:${candidate.game.id}` : candidate.sourceId;
  // A replacement or an explicitly chosen source starts at incoming audio; a stored delay never transfers.
  const fresh = !candidate.demo && (replacement || resetSourceDelay || freshPending === candidate.sourceId);
  if (fresh) freshPending = candidate.sourceId;
  savedDelay = liveKey ? fresh ? 0 : memory.read('live', liveKey)?.value ?? null : null;
  const restoreDelay = savedDelay ?? 0;
  log.start(selected, candidate.sourceId, candidate.demo ? 'demo' : 'live', $('provider').value, $('output').value, { trigger, previousSourceId: previous?.sourceId });
  sourceStatus = 'Connecting';
  if (replacement && previous) { switchedFrom = previous.station; progress(`${previous.station} could not play. Trying ${candidate.station}…`); } else notice('');
  $('station').textContent = candidate.title;
  // Identity is frozen at this candidate. Radio is never guessed into a game, so only a catalog game
  // feed can add a scoreboard.
  const owner = liveOwner = nowPlaying.claim(candidate.demo ? { mode: 'demo', title: candidate.title }
    : candidate.game ? { mode: 'game', school: team.name, opponent: candidate.game.opponent, album: candidate.station } : { mode: 'live', school: team.name, title: candidate.station });
  if (candidate.game && liveCatalog && nowPlaying.supported) liveBoard.start({ teamId: liveCatalog.teamId, school: team.name, game: candidate.game, games: liveCatalog.games, eligible: livePlaying, onUpdate: snapshot => owner.update(snapshot) });
  if (candidate.game) timing.start(candidate.game);
  showSource(); refreshSessions(log.session.id); render();
  let started;
  try {
    const url = candidate.demo ? (demo = demoURL()) : candidate.url;
    if (!url) throw Object.assign(new Error('gateway-unavailable'), { kind: 'transport' });
    // Only the verified Duke primary MP3 enters the decoded PCM transport.
    started = player.start(url, restoreDelay, { hls: !!candidate.hls, mp3: !candidate.demo && !candidate.hls && candidate.sourceId === 'duke-leanstream' });
    if (candidate.demo && player.audio) player.audio.loop = true;
  } catch (error) { started = Promise.reject(error); }
  started.then(() => {
    if (mine !== generation) return;
    if (fresh && liveKey) memory.save('live', liveKey, 0);
    if (!candidate.demo) { resetSourceDelay = false; if (freshPending === candidate.sourceId) freshPending = null; }
    connecting = false;
    if (candidate.demo) notice('Test tone: a beep each second, higher every fifth.');
    else if (restoreDelay > 0) notice(`Restoring your saved ${restoreDelay.toFixed(1)}-second delay. Use Incoming audio in Match my TV to skip the wait.`);
    else if (!replacement) notice('');
    render();
  }, error => {
    if (mine !== generation || (!candidate.demo && !session.current(token))) return;
    startFailed(candidate, error);
  });
}
// Startup failure classification: transport or availability advance at once; permission and local
// engine failures keep this candidate pending for Play; an unsupported browser ends the intent.
function startFailed(candidate, error) {
  const kind = candidate.demo ? 'demo' : failureKind(error);
  releaseLive(); timing.stop(); log.boundary('source-error', state); log.end(state);
  active = connecting = false; state = null; attempt = null; attention = true; sourceStatus = 'Could not connect';
  refreshSessions();
  if (kind === 'transport' || kind === 'availability') { advance(candidate, 'startup'); return; }
  if (kind === 'permission') { session.hold('denied'); sourceStatus = 'Waiting for Play'; notice(`This browser needs a tap to start audio. Press Play to start ${candidate.station}.`); }
  else if (kind === 'local') { session.hold('local'); notice(error?.message === 'mp3-unsupported' ? 'This browser could not load the radio audio decoder. Press Play to try the same source again, or open the official player.' : 'The audio engine could not start. Press Play to try the same source again, or open the official player.'); }
  else if (kind === 'environment') { session.cancel(); notice('This browser cannot run Homecall’s delayed audio. Open the official player instead.'); }
  else notice('The test tone could not play. Try again.');
  render();
}
// Enters the next lower-ranked candidate once, or ends the intent honestly when none remain.
function advance(previous, reason) {
  const tried = session.intent?.trace.length ?? 1, mode = session.intent?.mode ?? session.mode;
  const next = session.advance();
  if (next) { resetAlignment(); startCandidate(next, { trigger: 'fallback', replacement: true, previous }); return; }
  current = null; freshPending = null; exhaustion = { tried, reason, mode };
  active = connecting = false; state = null; sourceStatus = 'Could not connect'; attention = true;
  const link = officialLink(currentTeam(), previous);
  notice(`${reason === 'exhausted' ? 'The source could not reconnect after three attempts. ' : ''}${tried > 1 ? 'None of the available feeds could play. ' : reason === 'exhausted' ? '' : 'Audio could not play. '}` +
    `Press Retry to start again${tried > 1 ? mode === 'auto' ? ' from the top' : ' from your chosen source' : ''}${link ? ', or open the official player' : ''}.`);
  showSource(); render();
}
// One Play entry for Play, Retry, a resumed pause and a denied or local-pending source.
function play(trigger = 'play') {
  if (connecting) return;
  if (active) { reconnect(); return; }
  if (session.pending) { startCandidate(session.candidate, { trigger: 'resume', replacement: freshPending === session.candidate.sourceId }); return; }
  const r = resolution();
  if (r.state !== 'resolved' || !session.begin(r.candidates)) { render(); return; }
  startCandidate(session.candidate, { trigger: exhaustion ? 'retry' : trigger });
}
// Reconnect keeps the same candidate and its saved delay. A game feed refreshes its catalog first.
function reconnect() {
  if (current?.game) {
    ask.ask({ title: 'Reconnect this broadcast?', text: 'The game list refreshes and audio stops. Press Play again when the feed is ready.', action: 'Reconnect' }, () => { catalog.refresh(); });
    return;
  }
  restartCurrent();
}
function restartCurrent() {
  if (current?.demo) startDemo();
  else if (current) startCandidate(current, { trigger: 'resume' });
}
function startDemo() { session.cancel(); startCandidate({ demo: true, sourceId: 'test-tone', title: 'Timing demo · repeating tones', station: 'Test tone', label: 'Test tone' }, { trigger: 'play' }); }
// Pause while connecting or reconnecting cancels the pending attempt but keeps this candidate.
function pauseIntent() {
  const held = current;
  stopPhysical(); session.hold('paused'); current = held;
  sourceStatus = 'Paused'; notice(`Paused. Press Play to continue with ${held.station}.`);
  refreshSessions(); render();
}
function outputReady() {
  if (!attempt) return;
  outputSeen = true;
  log.add('output-ready', {}, state);
  const replaced = session.outputReady(attempt);
  // Eligible output makes buffering or "trying" text obsolete. A replacement keeps a quiet alignment
  // reminder after its brief notice fades; other warnings stay as they are.
  if (progressShown()) { progressText = null; notice(replaced && switchedFrom ? `Switched from ${switchedFrom}. Check alignment with your TV.` : ''); }
  if (replaced) showSwitch(current);
  else render();
}
// Brief, visual and nonblocking: shown only after a replacement's first eligible output.
function showSwitch(candidate) {
  const el = $('switch-notice');
  el.textContent = `Switched to ${candidate.station} because the previous feed stopped. It started at 0 seconds; check alignment with your TV.` +
    (candidate.kind === 'affiliate' ? ' Affiliate coverage can change; check that you hear the broadcast you want.' : '');
  el.classList.remove('fading'); el.hidden = false; needsCheck = true;
  clearTimeout(switchTimer);
  switchTimer = setTimeout(() => { el.classList.add('fading'); switchTimer = setTimeout(hideSwitch, 700); }, 6000);
  render();
}
function hideSwitch() { clearTimeout(switchTimer); switchTimer = null; $('switch-notice').hidden = true; $('switch-notice').classList.remove('fading'); }
function timelineEvent(event, detail) {
  timing.invalidate(); needsCheck = true;
  if (event === 'timeline-restoring') notice(TIMELINE_NOTICE.restoring);
  else if (event === 'timeline-restored') { log.add(event, {}, state); notice(TIMELINE_NOTICE.restored); }
  else if (event === 'timeline-canceled') { log.add(event, {}, state); notice(TIMELINE_NOTICE.canceled); }
  else { log.add(event, {}, state); attention = true; notice(detail?.issued ? TIMELINE_NOTICE.unconfirmed : FALLBACK_NOTICE[detail?.reason] ?? TIMELINE_NOTICE.fallback); }
  render();
}
// A catalog timestamp move: in-history moves are atomic; media moves flush PCM first. Never a source failure.
async function seekTo(position, kind = 'play') {
  const mine = generation;
  if (!active || !state || connecting || specialPending || pending) return 'unavailable';
  pending++; specialPending = true; needsCheck = true; render();
  log.request('seek', position, player.sequence + 1, player.epoch, $('reason').value, state);
  try {
    const { result } = await player.seek(position);
    if (mine !== generation) return 'stale';
    log.add('ack', { action: 'seek', result: result === 'applied' || result === 'history' ? result : ['unavailable', 'canceled'].includes(result) ? result : 'failed' });
    if (kind === 'live') notice(result === 'applied' || result === 'history' ? 'Moved to incoming audio. Check against your TV.' : 'Incoming audio could not be confirmed. Check playback against your TV.');
    return result;
  } catch {
    return mine === generation ? 'failed' : 'stale';
  } finally {
    if (mine === generation) { pending--; specialPending = false; render(); }
  }
}
async function command(action, value) {
  const mine = generation;
  if (!active || !state) return;
  const special = ['pause', 'hold', 'complete', 'cancel', 'confirm', 'restore'].includes(action);
  if (specialPending || (special && pending)) return;
  pending++; if (special) specialPending = true;
  if (action !== 'confirm') needsCheck = true;
  render();
  try {
    if (action === 'pause' && !value) await player.resumeContext();
    if (mine !== generation) return;
    log.request(action, value, player.sequence + 1, player.epoch, $('reason').value, state);
    const ack = await player.command(action === 'confirm' ? 'snapshot' : action, value);
    if (mine !== generation) return;
    log.acknowledge(action, ack);
    if (ack.result !== 'applied') { notice('That control is not available in the current playback state.'); return; }
    if (['nudge', 'delay', 'live', 'complete', 'cancel'].includes(action) && Number.isFinite(ack.after.delay)) {
      savedDelay = ack.after.resumeDelay ?? ack.after.delay;
      if (liveKey) memory.save('live', liveKey, savedDelay);
    }
    if (action === 'confirm') {
      needsCheck = !log.confirm({ ...ack.after, contextSeconds: ack.contextSeconds }, $('reason').value);
      // The button itself shows "✓ Marked aligned"; no duplicate caption.
      if (!needsCheck) notice('');
    } else if (action === 'hold') notice('');
    else if (action === 'complete') notice('Resumed with this delay. Fine-tune if needed.');
    else if (action === 'cancel') notice('Match canceled. Previous delay restored.');
    else if ((action === 'nudge' && value < 0 || action === 'live' || action === 'delay') && ack.after.delay < 0.01)
      notice('At incoming audio. If the call still trails the picture, pause your TV until it catches up.');
    else if ((action === 'nudge' && Math.abs(ack.after.delay - ack.before.delay - value) > 0.02) || (action === 'delay' && Math.abs(ack.after.delay - value) > 0.02))
      notice('Reached the available history limit; a smaller change was applied.');
  } catch {
    if (mine === generation) { log.boundary('command-failed', state); notice(player.context ? 'That change could not be confirmed. Check playback or reconnect.' : 'Audio disconnected because the change could not be confirmed. Press Play to reconnect.'); }
  } finally {
    if (mine === generation) { pending--; if (special) specialPending = false; render(); }
  }
}
function refreshSessions(preferred) {
  const selectedId = preferred || $('sessions').value;
  $('sessions').replaceChildren();
  const records = log.list();
  for (const s of records) {
    const option = document.createElement('option'); option.value = s.id;
    option.textContent = `${teamList.get(s.team)?.name || (s.team === 'catalog' ? 'Catalog school' : 'Unknown')} · ${s.mode === 'demo' ? 'demo · ' : ''}${new Date(s.startedAt).toLocaleString()}`;
    $('sessions').append(option);
  }
  if (records.some(s => s.id === selectedId)) $('sessions').value = selectedId;
  if ($('sessions').value !== previewId) {
    previewText = ''; $('export').value = ''; $('log-summary').textContent = '';
  }
  if (!records.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'No sessions yet'; $('sessions').append(option); }
}
function preview() {
  if (pending) { $('share-status').textContent = 'Wait for the timing change to finish, then refresh the log.'; return; }
  refreshSessions(); previewId = $('sessions').value;
  previewText = log.export(previewId) || '';
  $('export').value = previewText;
  if (previewText) {
    const s = JSON.parse(previewText);
    $('log-summary').textContent = `${s.events.length} recorded events · ${s.confirmedEpisodes} confirmed adjustment episodes · ${Math.round(s.userConfirmedObservedSeconds)} s observed after your alignment marks. ${s.truncatedEvents ? `${s.truncatedEvents} older events omitted. ` : ''}${s.status === 'last-saved-unclosed' ? 'Last saved snapshot; session did not close cleanly. ' : ''}This is not a measurement of true TV delay.`;
    $('share-status').textContent = 'This exact preview will be shared. Refresh it to include later adjustments.';
  } else $('log-summary').textContent = 'Start a listening session to create a log.';
  render();
}
// Schools listed only by the catalog join the Team choice by explicit ID once the catalog answers.
async function loadTeams() {
  try {
    const list = await metadata('homestream/teams');
    teamList = listenTeams(list); teamsLoaded = true;
    const known = new Set([...$('team').options].map(option => option.value));
    for (const team of teamList.values()) if (!known.has(team.key)) { const option = document.createElement('option'); option.value = team.key; option.textContent = team.name; $('team').append(option); }
    render();
  } catch { /* Configured teams keep working; catalog-only schools appear once the list loads. */ }
}
// A team or source change stops an active session. The select keeps the committed choice until
// Continue, so Cancel leaves audio, buffer, log and stored delay untouched.
$('feed').onchange = () => {
  const next = $('feed').value;
  if (!active && !connecting) return sourceChanged();
  $('feed').value = session.mode;
  ask.ask({ title: 'Change source?', text: 'Audio stops. The new source starts at 0 seconds; check alignment again.', action: 'Change source' }, () => { $('feed').value = next; sourceChanged(); });
};
$('team').value = selected;
$('team').onchange = () => {
  const next = $('team').value;
  if (!active && !connecting) return teamChanged();
  $('team').value = selected;
  ask.ask({ title: 'Change team?', text: 'Audio stops. Your current delay and TV alignment do not transfer.', action: 'Change team' }, () => { $('team').value = next; teamChanged(); });
};
$('connect').onclick = () => play();
$('recover-reconnect').onclick = () => play();
// The tone dialog is the takeover prompt: leave any recording, then start the real demo.
$('demo').onclick = () => { closeDialog($('tone-dialog')); nav?.select('live', { force: true }); startDemo(); };
$('stop').onclick = $('owner-stop').onclick = () => { disconnect(); notice(''); };
$('menu-reconnect').onclick = () => {
  if (active && !connecting) reconnect();
  else if (session.pending) play();
};
$('pause').onclick = () => {
  if (connecting) return pauseIntent();
  if ((sourcePaused && state?.paused) || player.context?.state !== 'running' || player.sourcePaused) return restartCurrent();
  if (state?.paused) return command('restore', savedDelay ?? 0);
  command('pause', true);
};
$('resume-position').onclick = () => { sourcePaused = false; command('pause', false); };
$('hold').onclick = () => command(state?.holding ? 'complete' : 'hold');
$('cancel').onclick = () => command('cancel'); $('confirm').onclick = () => command('confirm');
// Incoming audio: a catalog input far behind the live edge moves the media; otherwise PCM delay drops to 0.
$('live').onclick = () => {
  const target = current?.hls ? player.liveTarget?.() : null;
  if (target != null) seekTo(target, 'live'); else command('live');
};
document.querySelectorAll('[data-nudge]').forEach(button => { button.onclick = () => command('nudge', Number(button.dataset.nudge)); });
$('scrub').onpointerdown = () => { scrubbing = true; };
$('scrub').oninput = () => { scrubbing = true; $('scrub-label').textContent = `${Number($('scrub').value).toFixed(2)} s`; };
$('scrub').onchange = () => { const value = Number($('scrub').value); scrubbing = false; command('delay', value); };
$('scrub').onpointerup = () => { setTimeout(() => { scrubbing = false; render(); }, 0); };
$('scrub').onblur = $('scrub').onpointercancel = () => { scrubbing = false; render(); };
$('volume').oninput = () => { player.setVolume(Number($('volume').value)); $('volume-value').textContent = `${Math.round(Number($('volume').value) * 100)}%`; };
$('preview').onclick = preview; $('sessions').onchange = preview;
$('menu-logs').onclick = () => refreshSessions();
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(previewText); $('share-status').textContent = 'Copied the complete log. Paste it into your email or message.'; }
  catch { $('export').focus(); $('export').select(); $('share-status').textContent = 'Select and copy the log text above; clipboard access was unavailable.'; }
};
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([previewText], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `homecall-${previewId}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  $('share-status').textContent = 'Download requested. Check your browser’s downloads or save menu.';
};
$('share').onclick = async () => {
  const file = new File([previewText], `homecall-${previewId}.json`, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: 'Homecall test log', files: [file] });
    else if (navigator.share) await navigator.share({ title: 'Homecall test log', text: previewText });
    else { $('share-status').textContent = 'This browser has no share menu. Use Copy or Download instead.'; return; }
    $('share-status').textContent = 'Handed the log to your share app. Your saved copy remains here.';
  } catch (error) { $('share-status').textContent = error.name === 'AbortError' ? 'Sharing canceled. Your log is still saved.' : 'Sharing was unavailable. Use Copy or Download instead.'; }
};
$('clear').onclick = () => {
  if (active) { $('share-status').textContent = 'Stop playback before removing saved logs.'; return; }
  $('clear-confirm').hidden = false;
};
$('clear-confirm').onclick = () => {
  if (log.clear()) { previewText = ''; $('export').value = ''; $('log-summary').textContent = ''; refreshSessions(); $('share-status').textContent = 'Saved logs removed.'; }
  else $('share-status').textContent = active ? 'Stop playback before removing saved logs.' : 'Saved logs could not be removed. They remain in this browser; see the storage warning.';
  $('clear-confirm').hidden = true; render();
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { gameStatus.suspend(); countdown.suspend(); } else { gameStatus.resume(); countdown.resume(); if (!teamsLoaded) loadTeams(); }
  if (!active) return;
  needsCheck = true; log.boundary(document.hidden ? 'hidden' : 'visible', state);
  if (document.hidden && state?.holding) player.command('invalidate').catch(() => {});
  if (!document.hidden) notice('Back from another app. Check alignment.');
  render();
});
window.addEventListener('pagehide', () => { log.boundary('hidden', state); });
setInterval(() => { if (active && state) log.heartbeat(state, !document.hidden && player.context?.state === 'running'); }, 30000);
setInterval(() => { if (document.visibilityState !== 'hidden') { gameStatus.tick(); countdown.tick(); } }, 1000);
setupShell({ doc: document, onMenuOpen: () => { $('menu-reconnect').disabled = !((active && !connecting) || session.pending); } });
teamChanged(); refreshSessions(); render();

const liveActive = () => active || connecting;
nav = setupArchive({ stopLive: disconnect, liveActive, confirm: ask, selectedTeam: () => selected, memory, nowPlaying }) ?? null;
loadTeams();
