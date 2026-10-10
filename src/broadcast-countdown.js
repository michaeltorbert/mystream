// Next-broadcast countdown for the selected school (issue #32). It owns one quiet text line and nothing
// else: no Player, catalog, game status, timing or Listen session dependency. Only schools with a verified
// broadcaster schedule contract make requests; every other school stays hidden and silent.
export const SCHEDULE_PATHS = Object.freeze({ duke: 'broadcast/schedule/duke' });
// The schedule describes the school's network, not an affiliate that may be selected in Source.
const NETWORK = Object.freeze({ duke: 'Duke network' });
// Local policy, not provider guarantees: poll once a minute while visible, and treat data older than
// five minutes (source age + request + elapsed) as unknown.
export const POLL_MS = 60000, MAX_AGE_MS = 300000, CLOCK_JUMP_MS = 2000;
const STATES = new Set(['upcoming', 'none-listed', 'unknown']);
const UNKNOWN = Object.freeze({ state: 'unknown', ageMs: null });

export function validateSchedule(data, school) {
  if (!data || typeof data !== 'object' || data.schemaVersion !== 1 || data.school !== school || !STATES.has(data.state) || !Number.isSafeInteger(data.checkedAt)) return null;
  if (data.ageMs !== null && !(Number.isSafeInteger(data.ageMs) && data.ageMs >= 0)) return null;
  if (data.state !== 'upcoming') return { state: data.state, reason: data.reason === 'uncertain' ? 'uncertain' : null, ageMs: data.ageMs };
  const event = data.event;
  if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(event.id) || typeof event.label !== 'string' || !event.label.trim() || event.label.length > 1100
    || !['game', 'show'].includes(event.kind) || !Number.isSafeInteger(event.broadcastStart) || event.broadcastStart <= 0) return null;
  return { state: 'upcoming', event: { id: event.id, label: event.label, kind: event.kind, broadcastStart: event.broadcastStart }, ageMs: data.ageMs };
}
export function formatRemaining(ms) {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const days = Math.floor(total / 86400), hours = Math.floor(total % 86400 / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}
const localTime = ms => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
// Reaching the scheduled start is stated neutrally: it confirms neither audio nor a live game.
export function scheduleText(school, snapshot, nowMs, formatTime = localTime) {
  const network = NETWORK[school];
  if (!network) return '';
  if (!snapshot) return `${network} · Checking the broadcast schedule…`;
  if (snapshot.state === 'none-listed') return `${network} · No upcoming broadcast listed.`;
  if (snapshot.state !== 'upcoming') return snapshot.reason === 'uncertain' ? `${network} · Next broadcast time not confirmed.` : `${network} · Next broadcast time unknown.`;
  const { event } = snapshot, remaining = event.broadcastStart - nowMs;
  if (remaining <= 0) return `${network} · Scheduled broadcast start time reached for ${event.label}. This does not confirm audio or game status.`;
  return `${network} · Next broadcast starts in ${formatRemaining(remaining)} (${formatTime(event.broadcastStart)}) · ${event.label}`;
}

export function createBroadcastCountdown({ read, el, now = Date.now, mono = () => performance.now(), enabled = () => true,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer), formatTime = localTime } = {}) {
  let school = null, snapshot = null, request = null, generation = 0, timer = null, suspended = false, zeroRefreshed = null, lastWall = null, lastMono = null;
  const path = () => school && SCHEDULE_PATHS[school];
  const fresh = () => snapshot?.ageMs != null && snapshot.ageMs + (mono() - snapshot.requestedAt) < MAX_AGE_MS;
  function show(text) {
    if (!el) return;
    if (el.hidden !== !text) el.hidden = !text;
    if (el.textContent !== text) el.textContent = text;
  }
  function view() {
    if (!path()) return show('');
    show(scheduleText(school, snapshot && snapshot.state !== 'unknown' && !fresh() ? UNKNOWN : snapshot, now(), formatTime));
  }
  function poll() {
    clearTimer(timer);
    timer = path() && !suspended ? setTimer(() => { timer = null; refresh(); }, POLL_MS) : null;
  }
  // One request at a time; a school change or suspension discards any late answer.
  function refresh() {
    if (!path() || suspended || request || !enabled()) return;
    clearTimer(timer); timer = null;
    const mine = generation, controller = new AbortController(), requestedAt = mono(), requested = school;
    request = controller;
    let reading;
    try { reading = Promise.resolve(read(path(), { signal: controller.signal })); } catch (error) { reading = Promise.reject(error); }
    reading.then(data => {
      if (mine !== generation) return;
      const valid = validateSchedule(data, requested);
      snapshot = valid ? { ...valid, requestedAt } : UNKNOWN;
    }, () => { if (mine === generation) snapshot = UNKNOWN; }).finally(() => {
      if (mine !== generation) return;
      request = null; view(); poll();
    });
  }
  function cancel() { generation++; request?.abort(); request = null; clearTimer(timer); timer = null; }
  // Called once a second while visible. Counts against the absolute start time; a wall-clock jump that
  // the monotonic clock does not share makes the countdown unknown until fresh data arrives.
  function tick() {
    if (!path() || suspended) return;
    const wall = now(), elapsed = mono();
    const jumped = lastWall !== null && Math.abs((wall - lastWall) - (elapsed - lastMono)) > CLOCK_JUMP_MS;
    lastWall = wall; lastMono = elapsed;
    if (jumped) { snapshot = UNKNOWN; view(); refresh(); return; }
    view();
    // One extra check when the start is reached, never a loop: the row stays "reached" until a provider
    // snapshot moves or withdraws it.
    const event = snapshot?.state === 'upcoming' && fresh() ? snapshot.event : null;
    const key = event && event.broadcastStart <= wall ? `${event.id}:${event.broadcastStart}` : null;
    if (key && key !== zeroRefreshed) { zeroRefreshed = key; refresh(); }
  }
  return {
    setSchool(key) {
      cancel();
      school = Object.hasOwn(SCHEDULE_PATHS, key) ? key : null;
      snapshot = null; zeroRefreshed = null;
      view(); refresh();
    },
    tick,
    suspend() { suspended = true; cancel(); },
    resume() { suspended = false; tick(); refresh(); },
    stop() { suspended = true; cancel(); school = null; snapshot = null; show(''); },
    get state() { return snapshot && snapshot.state !== 'unknown' && !fresh() ? UNKNOWN : snapshot; }
  };
}
