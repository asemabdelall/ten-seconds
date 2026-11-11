import { TARGET_MS, MAX_RUN_MS, evaluate, timeParts, formatTime, formatDelta } from './timing.js';
import { RESULTS_ENDPOINT, fetchLeaderboard, serverReachable } from './api.js';
import { sfx, unlockAudio, isMuted, setMuted } from './sound.js';

const $ = (id) => document.getElementById(id);
const el = {
  splash: $('splash'), stage: $('stage'), clock: $('clock'), clockHit: $('clockHit'),
  trackFill: $('trackFill'), hint: $('hint'), mainBtn: $('mainBtn'), mainBtnLabel: $('mainBtnLabel'),
  result: $('result'), verdict: $('verdict'), resTime: $('resTime'), resExact: $('resExact'), resDelta: $('resDelta'),
  submitStatus: $('submitStatus'), submitText: $('submitText'), againBtn: $('againBtn'), resBoardBtn: $('resBoardBtn'),
  netPill: $('netPill'), netLabel: $('netLabel'), pendingBadge: $('pendingBadge'),
  installBtn: $('installBtn'), soundBtn: $('soundBtn'), boardBtn: $('boardBtn'),
  boardDlg: $('boardDlg'), boardList: $('boardList'), boardNote: $('boardNote'),
  pendingBox: $('pendingBox'), pendingCount: $('pendingCount'), syncNowBtn: $('syncNowBtn'),
  nameDlg: $('nameDlg'), nameForm: $('nameForm'), nameInput: $('nameInput'), iosDlg: $('iosDlg'),
  toasts: $('toasts'), burst: $('burst'),
};
const digits = Array.from(el.clock.querySelectorAll('i'));

/* ------------------------------------------------------------------ storage */
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    }));

let playerId = store.get('ten.player');
if (!playerId) { playerId = uuid(); store.set('ten.player', playerId); }
let playerName = store.get('ten.name', '');

/* ------------------------------------------------------------------ clock rendering */
let shown = '';
function renderClock(ms) {
  const { ss, cc, xx } = timeParts(ms);
  const s = String(ss).padStart(2, '0') + String(cc).padStart(2, '0') + String(xx).padStart(2, '0');
  if (s !== shown) {
    for (let i = 0; i < 6; i++) if (s[i] !== shown[i]) digits[i].textContent = s[i];
    shown = s;
  }
  el.trackFill.style.width = Math.min(ms / 15_000, 1) * 100 + '%';
}

/* ------------------------------------------------------------------ game loop */
let state = 'ready';            // ready | running | result
let startT = 0;                 // performance.now() timebase
let rafId = 0;
let resultShownAt = 0;
let current = null;             // the result object of the last run

/**
 * Best timestamp for an input event, in the performance.now() timebase.
 * event.timeStamp is when the input actually happened, which is more accurate
 * than when our handler got to run (the main thread may have been busy).
 */
function eventTime(e) {
  const now = performance.now();
  const ts = e && e.timeStamp;
  if (typeof ts === 'number' && ts > 0 && ts <= now + 1 && now - ts < 1000) return ts;
  return now;
}

function setState(s, tier = '') {
  state = s;
  el.stage.dataset.state = s;
  if (tier) el.stage.dataset.tier = tier; else delete el.stage.dataset.tier;
}

function tick() {
  const elapsed = performance.now() - startT;
  if (elapsed >= MAX_RUN_MS) { stop(startT + MAX_RUN_MS); return; }
  renderClock(elapsed);
  rafId = requestAnimationFrame(tick);
}

function start(t) {
  if (!playerName) { openNameDialog(); return; }
  unlockAudio();
  startT = t;
  setState('running');
  el.result.hidden = true;
  el.mainBtnLabel.textContent = 'STOP';
  el.hint.innerHTML = 'Stop at exactly <b>10:00:00</b>';
  el.clock.setAttribute('aria-label', 'Running');
  sfx.start();
  vibrate(12);
  rafId = requestAnimationFrame(tick);
}

function stop(t) {
  cancelAnimationFrame(rafId);
  // The verdict comes from the raw measured duration, never from the display.
  const elapsedMs = Math.max(0, t - startT);
  const ev = evaluate(elapsedMs);
  renderClock(elapsedMs);
  el.clock.setAttribute('aria-label', ev.display);
  showResult(ev);
  record(ev);
}

function abortRun(reason) {
  cancelAnimationFrame(rafId);
  resetToReady();
  toast(reason, 'warn');
}

function resetToReady() {
  setState('ready');
  el.result.hidden = true;
  el.mainBtnLabel.textContent = 'START';
  el.hint.innerHTML = 'Tap to start. Stop the clock at exactly <b>10:00:00</b>.';
  renderClock(0);
  el.clock.setAttribute('aria-label', formatTime(0));
}

function showResult(ev) {
  setState('result', ev.tier);
  resultShownAt = performance.now();
  el.verdict.textContent = ev.label;
  el.resTime.textContent = ev.display;
  el.resExact.textContent = ev.elapsedMs.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).replace(/,/g, ' ') + ' ms';
  el.resDelta.textContent = ev.perfect ? 'under 0.5 ms' : formatDelta(ev.deltaMs);
  el.result.hidden = false;
  if (ev.perfect) { sfx.perfect(); vibrate([40, 40, 40, 40, 120]); celebrate(); }
  else if (ev.absDeltaMs <= 250) { sfx.good(); vibrate(30); }
  else { sfx.miss(); vibrate([20, 30, 20]); }
  setTimeout(() => el.againBtn.focus({ preventScroll: true }), 50);
}

function onPress(e) {
  if (e.type === 'pointerdown' && (e.button !== 0 || !e.isPrimary)) return;
  if (document.querySelector('dialog[open]')) return;
  const t = eventTime(e);
  if (e.cancelable) e.preventDefault();
  if (state === 'ready') start(t);
  else if (state === 'running') stop(t);
}

el.mainBtn.addEventListener('pointerdown', onPress);
el.clockHit.addEventListener('pointerdown', onPress);
// Keyboard / assistive-tech activation of the button (click with detail 0 = not a pointer).
el.mainBtn.addEventListener('click', (e) => { if (e.detail === 0) onPress(e); });
window.addEventListener('keydown', (e) => {
  if (e.repeat || (e.code !== 'Space' && e.code !== 'Enter')) return;
  if (document.querySelector('dialog[open]') || e.target.closest?.('input, textarea')) return;
  if (state === 'result') {
    if (e.target.closest?.('button') && e.target !== el.mainBtn) return; // let focused buttons work
    if (performance.now() - resultShownAt < 500) { e.preventDefault(); return; }
    e.preventDefault(); resetToReady(); return;
  }
  e.preventDefault();
  onPress(e);
});
el.againBtn.addEventListener('click', () => { if (performance.now() - resultShownAt > 400) resetToReady(); });
el.resBoardBtn.addEventListener('click', openBoard);
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, dialog')) e.preventDefault(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'running') abortRun('Run cancelled: the app was hidden mid-run.');
  if (!document.hidden) checkConnectivity();
});

/* ------------------------------------------------------------------ results: queue first, then submit */
let syncing = false;
const Q = () => window.TenQueue;

async function record(ev) {
  const result = {
    clientId: uuid(),
    playerId,
    name: playerName,
    elapsedMs: ev.elapsedMs,
    playedAt: Date.now(),
  };
  current = result;
  // 1) Persist locally BEFORE any network call: nothing is lost if we are offline or the app closes.
  try {
    await Q().add(result);
  } catch (err) {
    setSubmitStatus('rejected', 'Could not save this result on the device (storage unavailable). It was not submitted.');
    return;
  }
  // 2) Try to submit.
  if (!navigator.onLine) {
    setSubmitStatus('pending', pendingMessage());
    requestBackgroundSync();
    refreshPending();
    return;
  }
  setSubmitStatus('submitting', 'Submitting to the leaderboard…');
  await syncPending();
  // If the flush could not deliver it, say so plainly.
  if (current === result && el.submitStatus.dataset.status === 'submitting') {
    setSubmitStatus('pending', pendingMessage());
    requestBackgroundSync();
  }
}

function pendingMessage() {
  return 'OFFLINE · Saved on this device. NOT submitted yet. It will be sent automatically when you are back online.';
}

function setSubmitStatus(status, text) {
  el.submitStatus.dataset.status = status;
  el.submitText.textContent = text;
}

async function syncPending() {
  if (syncing || !Q()) return;
  if (!navigator.onLine) { await refreshPending(); setNet('offline'); return; }
  const count = await Q().count().catch(() => 0);
  if (!count) { setNet('online'); await refreshPending(); return; }
  syncing = true;
  setNet('syncing');
  try {
    const report = await Q().flush(RESULTS_ENDPOINT);
    handleReport(report, true);
    setNet(report.networkError ? 'offline' : 'online');
  } catch {
    setNet('offline');
  } finally {
    syncing = false;
    refreshPending();
  }
}

/** Applies a flush report (from this page or from the service worker). */
function handleReport(report, fromPage) {
  let others = 0;
  for (const { result, response } of report.sent || []) {
    if (current && result.clientId === current.clientId) {
      const rank = response && response.rank;
      const best = response && response.personalBest;
      setSubmitStatus('submitted',
        `Submitted ✓${rank ? ` · Your best ranks #${rank}` : ''}${best ? ' · NEW PERSONAL BEST' : ''}`);
    } else {
      others++;
    }
  }
  if (others) toast(`${others} result${others > 1 ? 's' : ''} saved offline ${others > 1 ? 'were' : 'was'} submitted ✓`, 'ok');
  for (const { result, error } of report.rejected || []) {
    if (current && result.clientId === current.clientId) setSubmitStatus('rejected', `Not accepted by the server: ${error}`);
    else toast(`An offline result was rejected by the server: ${error}`, 'warn');
  }
  if (!fromPage) refreshPending();
  if (el.boardDlg.open && (report.sent || []).length) loadBoard();
}

async function refreshPending() {
  const n = Q() ? await Q().count().catch(() => 0) : 0;
  el.pendingBadge.hidden = n === 0;
  el.pendingBadge.textContent = n;
  el.pendingBox.hidden = n === 0;
  el.pendingCount.textContent = n;
  el.netPill.title = n ? `${n} result(s) waiting to be submitted` : 'Connection status';
  return n;
}

let netMode = 'online';
function setNet(mode) {
  if (!navigator.onLine) mode = 'offline';
  netMode = mode;
  el.netPill.dataset.net = mode;
  el.netLabel.textContent = mode === 'offline' ? 'OFFLINE' : mode === 'syncing' ? 'SYNCING' : 'ONLINE';
}

async function requestBackgroundSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && 'sync' in reg) await reg.sync.register('submit-results');
  } catch { /* Not supported (Safari/Firefox): the page retries on 'online' and on resume. */ }
}

/**
 * navigator.onLine is only a hint (it stays true on captive portals, dead Wi-Fi or a
 * server outage), so the indicator is driven by a real round-trip to /api/health.
 */
let checking = false;
async function checkConnectivity() {
  if (checking) return;
  checking = true;
  try {
    const wasOffline = netMode === 'offline';
    const ok = await serverReachable();
    if (!ok) { setNet('offline'); return; }
    if (netMode !== 'syncing') setNet('online');
    const pending = await refreshPending();
    if (wasOffline && pending) toast('Back online. Submitting saved results…');
    if (pending) await syncPending();
  } finally {
    checking = false;
  }
}
// Poll every 5 s while offline (to notice reconnection quickly), every 30 s otherwise.
let lastCheck = 0;
setInterval(() => {
  if (document.hidden || state === 'running') return;
  const due = netMode === 'offline' || Date.now() - lastCheck > 30_000;
  if (due) { lastCheck = Date.now(); checkConnectivity(); }
}, 5_000);

window.addEventListener('online', () => checkConnectivity());
window.addEventListener('offline', () => { setNet('offline'); toast('You are offline. Keep playing: results are saved on this device.', 'warn'); });
el.netPill.addEventListener('click', openBoard);
el.syncNowBtn.addEventListener('click', () => {
  checkConnectivity().then(() => {
    if (netMode === 'offline') toast('Still offline. Results will be sent when the connection returns.', 'warn');
  });
});

/* ------------------------------------------------------------------ leaderboard */
function openBoard() {
  if (!el.boardDlg.open) el.boardDlg.showModal();
  loadBoard();
}

async function loadBoard() {
  refreshPending();
  const cached = store.get('ten.board');
  if (!el.boardList.children.length && cached) {
    try { renderBoard(JSON.parse(cached)); } catch { /* ignore */ }
  }
  if (!navigator.onLine) {
    setNet('offline');
    showBoardNote(cached);
    if (!cached) el.boardList.innerHTML = '<li class="empty">The online leaderboard needs an internet connection.</li>';
    return;
  }
  try {
    const data = await fetchLeaderboard(50, playerId);
    data.fetchedAt = Date.now();
    store.set('ten.board', JSON.stringify(data));
    el.boardNote.hidden = true;
    renderBoard(data);
    setNet('online');
  } catch {
    setNet('offline');
    showBoardNote(store.get('ten.board'));
    if (!store.get('ten.board')) el.boardList.innerHTML = '<li class="empty">Leaderboard unavailable. Check your connection.</li>';
  }
}

function showBoardNote(cached) {
  let when = '';
  try { when = cached ? new Date(JSON.parse(cached).fetchedAt).toLocaleString() : ''; } catch { /* ignore */ }
  el.boardNote.hidden = false;
  el.boardNote.textContent = when
    ? `OFFLINE · Showing a saved copy from ${when}. Live rankings need an internet connection.`
    : 'OFFLINE · The live leaderboard needs an internet connection.';
}

function renderBoard(data) {
  const rows = data.entries || [];
  if (!rows.length) { el.boardList.innerHTML = '<li class="empty">No results yet. Be the first!</li>'; return; }
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const li = document.createElement('li');
    if (r.me) li.className = 'me';
    const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = r.rank;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.name;
    const tm = document.createElement('span'); tm.className = 'tm' + (r.perfect ? ' perfect' : '');
    tm.textContent = formatTime(r.elapsedMs);
    const sm = document.createElement('small'); sm.textContent = r.perfect ? 'PERFECT' : formatDelta(r.elapsedMs - TARGET_MS);
    tm.append(sm);
    li.append(rk, nm, tm);
    frag.append(li);
  }
  if (data.you && !rows.some((r) => r.me)) {
    const li = document.createElement('li'); li.className = 'me';
    li.innerHTML = '<span class="rk"></span><span class="nm"></span><span class="tm"><small></small></span>';
    li.querySelector('.rk').textContent = data.you.rank;
    li.querySelector('.nm').textContent = data.you.name + ' (you)';
    li.querySelector('.tm').prepend(formatTime(data.you.elapsedMs));
    li.querySelector('small').textContent = formatDelta(data.you.elapsedMs - TARGET_MS);
    frag.append(li);
  }
  el.boardList.replaceChildren(frag);
}

el.boardBtn.addEventListener('click', openBoard);
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

/* ------------------------------------------------------------------ player name */
function openNameDialog() {
  el.nameInput.value = playerName;
  el.nameDlg.showModal();
  setTimeout(() => el.nameInput.focus(), 50);
}
el.nameForm.addEventListener('submit', (e) => {
  const v = el.nameInput.value.trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N} _.\-]{2,16}$/u.test(v)) { e.preventDefault(); el.nameInput.reportValidity(); return; }
  playerName = v.toUpperCase();
  store.set('ten.name', playerName);
  toast(`Welcome, ${playerName}. Tap START when ready.`, 'ok');
});
el.nameDlg.addEventListener('click', (e) => { if (e.target === el.nameDlg && !playerName) e.stopImmediatePropagation(); }, true);

/* ------------------------------------------------------------------ sound, haptics, fx */
function syncSoundBtn() { el.soundBtn.setAttribute('aria-pressed', String(isMuted())); el.soundBtn.setAttribute('aria-label', isMuted() ? 'Unmute sound' : 'Mute sound'); }
el.soundBtn.addEventListener('click', () => { setMuted(!isMuted()); syncSoundBtn(); if (!isMuted()) { unlockAudio(); sfx.stop(); } });
syncSoundBtn();

function vibrate(p) { try { navigator.vibrate?.(p); } catch { /* ignore */ } }

function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#ffd23f', '#00f0ff', '#ff2bd6', '#3dff9a', '#ffffff'];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('i');
    const a = Math.random() * Math.PI * 2, d = 140 + Math.random() * 360;
    p.style.cssText = `--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d + 120}px;--r:${Math.random() * 720}deg;background:${colors[i % colors.length]};animation-delay:${Math.random() * 120}ms`;
    frag.append(p);
  }
  el.burst.replaceChildren(frag);
  document.body.classList.remove('flash'); void document.body.offsetWidth; document.body.classList.add('flash');
  setTimeout(() => el.burst.replaceChildren(), 1700);
}

function toast(msg, kind = '', action) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  const span = document.createElement('span'); span.textContent = msg; t.append(span);
  if (action) {
    const b = document.createElement('button'); b.className = 'btn small primary'; b.textContent = action.label;
    b.addEventListener('click', () => { action.run(); t.remove(); });
    t.append(b);
  }
  el.toasts.append(t);
  if (!action) setTimeout(() => t.remove(), 4200);
  while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
}

/* ------------------------------------------------------------------ install (Add to Home Screen) */
let deferredPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!isStandalone()) el.installBtn.hidden = false;
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  el.installBtn.hidden = true;
  toast('Installed! Launch Ten Seconds from your home screen.', 'ok');
});
if (isIOS && !isStandalone()) el.installBtn.hidden = false;
el.installBtn.addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => null);
    deferredPrompt = null;
    el.installBtn.hidden = true;
  } else if (isIOS) {
    el.iosDlg.showModal();
  }
});

/* ------------------------------------------------------------------ service worker + updates */
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const offerUpdate = (w) => toast('A new version is ready.', 'ok', {
      label: 'UPDATE',
      run: () => w.postMessage('SKIP_WAITING'),
    });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true;
      if (state === 'running') { addEventListener('pointerup', () => location.reload(), { once: true }); return; }
      location.reload();
    });
    // Check for a new version when the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  } catch (err) {
    console.warn('Service worker registration failed', err);
  }
}
const hadController = !!navigator.serviceWorker?.controller;
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'SYNC_REPORT') handleReport(e.data.report, false);
});

/* ------------------------------------------------------------------ boot */
async function boot() {
  resetToReady();
  setNet(navigator.onLine ? 'online' : 'offline');
  const minSplash = new Promise((r) => setTimeout(r, 650));
  const fontsReady = document.fonts ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]) : Promise.resolve();
  await Promise.all([minSplash, fontsReady]);
  el.splash.classList.add('done');
  setTimeout(() => el.splash.remove(), 600);
  registerSW();
  await refreshPending();
  checkConnectivity();
  const params = new URLSearchParams(location.search);
  if (params.has('board')) openBoard();
  else if (!playerName) setTimeout(openNameDialog, 450);
  // Keep the URL clean in the standalone window.
  if (location.search) history.replaceState(null, '', '/');
}

if (window.TenQueue) boot();
else window.addEventListener('DOMContentLoaded', boot, { once: true });
