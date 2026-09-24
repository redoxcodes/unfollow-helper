// ==UserScript==
// @name         X Unfollow Helper by Redox
// @namespace    https://x.com/amredox
// @version      1.0.2
// @description  Paced unfollowing on X with preview, skip mutuals, whitelist, inactive filter and hourly batches.
// @author       Redox
// @homepageURL  https://redoxcodes.github.io/unfollow-helper/
// @updateURL    https://redoxcodes.github.io/unfollow-helper/x-unfollow-helper.user.js
// @downloadURL  https://redoxcodes.github.io/unfollow-helper/x-unfollow-helper.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @grant        none
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  if (window.__redoxUnf) return;
  window.__redoxUnf = true;

  /* ================= EDIT THESE IF YOU WANT ================= */
  const DONATE = [
    { coin: 'SOL', addr: '7UekwDZb4Fv9x4M8bxAfQgzkwnzwvkgC3quYZAuBnsg7' },
    { coin: 'BTC', addr: 'bc1qwe3zmgv4uj4xlvnvp7djx0qjyuzxgxwu3kv88r' },
    { coin: 'ETH', addr: '0x247cb46cFE6b24e8b3ec3471e1974341C1ee7DB1' },
  ];
  const CREATOR = { name: 'Redox', url: 'https://x.com/amredox' };

  // Pacing (fixed). Daily + hourly limits are editable in the panel.
  const CFG = {
    minDelaySec: 30, maxDelaySec: 60,     // wait between unfollows
    breakEveryMin: 15, breakEveryMax: 25, // take a break after this many
    breakMinMin: 10, breakMaxMin: 20,     // break length in minutes
    dailyCheckCap: 250,                   // max activity checks per day
    checkMinSec: 10, checkMaxSec: 20,     // wait between activity checks
  };
  const DEFAULT_SETTINGS = {
    dailyCap: 140, hourlyCap: 35,
    skipMutuals: true, skipVerified: false,
    whitelist: '', keywords: '',
  };
  /* ========================================================== */

  const KEY = 'redoxUnf:v1';
  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const TPL_RE = /\/i\/api\/graphql\/[^/]+\/UserTweets\?/;

  const today = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }

  const S = Object.assign({
    queue: [], preview: [], log: [], stamps: [],
    running: false, pauseUntil: 0, nextAt: 0, waitLabel: '',
    sinceBreak: 0, breakAfter: 0,
    day: { d: today(), unf: 0, checks: 0 },
    meList: '', tpl: null, status: 'Ready',
    opts: { dir: 'newest', count: 50, months: 0 },
  }, load());
  S.settings = Object.assign({}, DEFAULT_SETTINGS, S.settings || {});

  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function rollDay() { if (!S.day || S.day.d !== today()) S.day = { d: today(), unf: 0, checks: 0 }; }

  /* ---------- helpers ---------- */
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let job = null; // { stop: bool, kind: 'scan'|'run' }

  // Uses the real clock, so time spent frozen in the background still counts.
  async function sleepUntil(t, token) {
    while (Date.now() < t) {
      if (token && token.stop) return false;
      await sleep(Math.max(50, Math.min(1000, t - Date.now())));
    }
    return true;
  }
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(250); }
    return null;
  }
  const fmt = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function ago(t) {
    if (!t) return 'No posts found';
    const days = Math.floor((Date.now() - t) / 864e5);
    if (days < 60) return 'Last post ' + days + ' days ago';
    return 'Last post ' + Math.floor(days / 30.44) + ' months ago';
  }
  function parseList(s, isKw) {
    return String(s || '')
      .split(isKw ? /[,\n]+/ : /[\s,]+/)
      .map(x => x.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);
  }
  function cookie(n) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function parseTw(s) {
    const m = String(s).match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \+0000 (\d{4})$/);
    if (!m) { const t = Date.parse(s); return isNaN(t) ? 0 : t; }
    const mon = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3;
    return Date.UTC(+m[6], mon, +m[2], +m[3], +m[4], +m[5]);
  }
  async function copy(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove(); return ok;
    }
  }

  /* ---------- keep screen awake while running ---------- */
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && job) keepAwake(true);
  });

  /* ---------- capture X's own activity request (for inactive check) ---------- */
  try { performance.setResourceTimingBufferSize && performance.setResourceTimingBufferSize(3000); } catch (e) {}
  function captureTpl() {
    try {
      const list = performance.getEntriesByType('resource').map(e => e.name).filter(n => TPL_RE.test(n));
      if (list.length) { S.tpl = list[list.length - 1]; save(); }
    } catch (e) {}
    return S.tpl;
  }
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) if (TPL_RE.test(e.name)) { S.tpl = e.name; save(); }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {}

  async function lastPost(uid) {
    let url;
    try {
      const u = new URL(S.tpl, location.origin);
      u.host = location.host;
      const v = JSON.parse(u.searchParams.get('variables') || '{}');
      v.userId = uid; v.count = 10;
      u.searchParams.set('variables', JSON.stringify(v));
      url = u.toString();
    } catch (e) { S.tpl = null; return { error: 'Activity check needs a refresh. Open any profile, then scan again.', fatal: true }; }

    let res;
    try {
      res = await fetch(url, {
        credentials: 'include',
        headers: {
          authorization: 'Bearer ' + BEARER,
          'x-csrf-token': cookie('ct0'),
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'content-type': 'application/json',
        },
      });
    } catch (e) { return { error: 'Network problem during activity check. Check your connection.', fatal: true }; }

    if (res.status === 429) return { error: 'X paused activity checks for now. Try again in a few hours.', fatal: true };
    if (!res.ok) { S.tpl = null; save(); return { error: 'Activity check failed (' + res.status + '). Open any profile, then scan again.', fatal: true }; }

    let data;
    try { data = await res.json(); } catch (e) { return { error: 'X sent an unreadable reply. Try again later.', fatal: true }; }
    if (!data || !data.data) return { error: 'X returned no data for activity checks. Try again later.', fatal: true };

    let last = 0;
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (o.type === 'TimelinePinEntry') return; // ignore pinned posts
      const lg = o.legacy;
      if (lg && lg.created_at && lg.user_id_str === uid && lg.full_text !== undefined) {
        const t = parseTw(lg.created_at);
        if (t > last) last = t;
      }
      for (const k in o) walk(o[k]);
    };
    walk(data.data);
    return { last };
  }

  /* ---------- reading the Following page ---------- */
  const isFollowingPage = () => /^\/[A-Za-z0-9_]{1,15}\/following\/?$/.test(location.pathname);
  function myHandle() {
    const a = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const m = a && (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})/);
    return m ? m[1] : null;
  }
  const cellsNow = () => Array.from(document.querySelectorAll('[data-testid="UserCell"]'));

  function cellInfo(cell) {
    const btn = cell.querySelector('[data-testid$="-unfollow"],[data-testid$="-follow"]');
    let id = null, following = false;
    if (btn) {
      const t = btn.getAttribute('data-testid');
      id = t.replace(/-(un)?follow$/, '');
      following = /-unfollow$/.test(t);
    }
    let handle = null, name = null;
    for (const a of cell.querySelectorAll('a[href^="/"]')) {
      const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m) { handle = m[1]; if (!name) name = (a.innerText || '').split('\n')[0].trim(); if (name) break; }
    }
    return {
      cell, id, handle, name: name || handle, following,
      mutual: !!cell.querySelector('[data-testid="userFollowIndicator"]'),
      verified: !!cell.querySelector('[data-testid="icon-verified"]'),
      text: (cell.innerText || '').toLowerCase(),
    };
  }
  function findCell(handle) {
    const h = handle.toLowerCase();
    for (const c of cellsNow()) {
      const i = cellInfo(c);
      if (i.handle && i.handle.toLowerCase() === h) return i;
    }
    return null;
  }
  async function scrollStep() {
    const el = document.scrollingElement || document.documentElement;
    const before = el.scrollTop;
    window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    await sleep(rnd(900, 1600));
    return el.scrollTop !== before;
  }
  function skipReason(i) {
    const st = S.settings;
    const h = i.handle.toLowerCase();
    if (parseList(st.whitelist).includes(h)) return 'whitelist';
    if (st.skipMutuals && i.mutual) return 'mutual';
    if (st.skipVerified && i.verified) return 'verified';
    if (parseList(st.keywords, true).some(k => i.text.includes(k))) return 'keyword';
    return null;
  }

  function checkOwnList() {
    const path = location.pathname.replace(/\/$/, '').toLowerCase();
    const me = myHandle();
    if (me) {
      if (path === '/' + me.toLowerCase() + '/following') { S.meList = path; return true; }
      alert('This is not your Following list. Open your own profile, then tap Following.');
      return false;
    }
    if (S.meList === path) return true;
    if (confirm('Is this YOUR Following list?\n' + path + '\n\nOnly continue if it is your own account.')) {
      S.meList = path; save(); return true;
    }
    return false;
  }

  /* ---------- scan and preview ---------- */
  async function scan() {
    if (job) return;
    if (!isFollowingPage()) { setStatus('Open your Following page first, then scan.'); render(); return; }
    if (!checkOwnList()) return;

    const o = S.opts;
    if (o.months && !captureTpl()) {
      setStatus('To check activity, open any profile once (tap a name), scroll a little, come back here and scan again.');
      render(); return;
    }
    rollDay();
    const my = job = { stop: false, kind: 'scan' };
    S.preview = []; save(); render();

    window.scrollTo(0, 0);
    await sleep(1800);
    const seen = new Set();
    const pool = [];
    const skipped = { whitelist: 0, mutual: 0, verified: 0, keyword: 0 };
    const checkRoom = Math.max(0, CFG.dailyCheckCap - S.day.checks);
    let stuck = 0;

    while (!my.stop) {
      if (!isFollowingPage()) { setStatus('Scan stopped because you left the Following page.'); break; }
      let added = 0;
      for (const c of cellsNow()) {
        const i = cellInfo(c);
        if (!i.handle || !i.id) continue;
        const k = i.handle.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); added++;
        if (!i.following) continue;
        const why = skipReason(i);
        if (why) { skipped[why]++; continue; }
        pool.push({ handle: i.handle, name: i.name, id: i.id, idx: pool.length });
      }
      setStatus('Scanning: ' + seen.size + ' accounts looked at, ' + pool.length + ' possible');
      if (o.dir === 'newest' && !o.months && pool.length >= o.count) break;
      if (o.dir === 'newest' && o.months && pool.length >= Math.min(checkRoom, 400)) break;
      if (seen.size > 6000) break;
      await scrollStep();
      if (added === 0) { if (++stuck >= 6) break; await sleep(1200); } else stuck = 0;
    }

    let list = o.dir === 'oldest' ? pool.slice().reverse() : pool;
    let picked = [];
    let note = '';

    if (!my.stop && !o.months) picked = list.slice(0, o.count);

    if (!my.stop && o.months) {
      const cutoff = Date.now() - o.months * 30.44 * 864e5;
      for (const u of list) {
        if (my.stop) break;
        rollDay();
        if (S.day.checks >= CFG.dailyCheckCap) { note = ' Daily activity-check limit reached, scan again tomorrow for more.'; break; }
        setStatus('Checking activity: found ' + picked.length + ' of ' + o.count + ' (checking @' + u.handle + ')');
        const r = await lastPost(u.id);
        S.day.checks++; save();
        if (r.error) { note = ' ' + r.error; if (r.fatal) break; continue; }
        if (!r.last || r.last < cutoff) { u.last = r.last || 0; picked.push(u); if (picked.length >= o.count) break; }
        await sleepUntil(Date.now() + rnd(CFG.checkMinSec, CFG.checkMaxSec) * 1000, my);
      }
    }

    if (job === my) job = null;
    S.preview = picked.map(u => Object.assign({}, u, { on: true }));
    save();
    window.scrollTo(0, 0);
    const skipText = 'Skipped: ' + skipped.mutual + ' follow you, ' + skipped.whitelist + ' whitelisted, ' +
      skipped.verified + ' verified, ' + skipped.keyword + ' keyword.';
    if (my.stop) setStatus('Scan stopped. ' + picked.length + ' in preview.');
    else setStatus('Preview ready: ' + picked.length + ' accounts. ' + skipText + note);
    render();
  }

  /* ---------- unfollowing ---------- */
  async function locate(handle, my) {
    let i = findCell(handle);
    if (i) { i.cell.scrollIntoView({ block: 'center' }); await sleep(700); return findCell(handle) || i; }
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) { window.scrollTo(0, 0); await sleep(2000); }
      let stuck = 0;
      for (let s = 0; s < 500 && !my.stop; s++) {
        if (!isFollowingPage()) return { away: true };
        const moved = await scrollStep();
        i = findCell(handle);
        if (i) { i.cell.scrollIntoView({ block: 'center' }); await sleep(700); return findCell(handle) || i; }
        if (!moved) { if (++stuck >= 5) break; await sleep(1500); } else stuck = 0;
      }
    }
    return null;
  }
  function limitHit() {
    if (/\/account\/access/.test(location.pathname)) return true;
    const t = document.querySelector('[data-testid="toast"]');
    const s = ((t && t.innerText) || '').toLowerCase();
    return /limit|try again later|temporar|restrict|locked|suspend/.test(s);
  }
  async function unfollowCell(info) {
    const btn = info.cell.querySelector('[data-testid$="-unfollow"]');
    if (!btn) return 'fail';
    btn.click();
    await sleep(rnd(700, 1200));
    const confirmBtn = await waitFor(() => document.querySelector('[data-testid="confirmationSheetConfirm"]'), 4000);
    if (confirmBtn) confirmBtn.click();
    const done = await waitFor(() => {
      if (limitHit()) return 'limit';
      const a = findCell(info.handle);
      return a && !a.following ? 'ok' : null;
    }, 7000);
    if (limitHit()) return 'limit';
    return done || 'fail';
  }

  async function run() {
    if (job) return;
    if (!S.queue.length) { setStatus('Queue is empty. Scan and approve a preview first.'); return; }
    if (!isFollowingPage()) { S.running = true; save(); setStatus('Open your Following page and it will continue.'); render(); return; }

    const my = job = { stop: false, kind: 'run' };
    S.running = true;
    if (!S.breakAfter) S.breakAfter = Math.round(rnd(CFG.breakEveryMin, CFG.breakEveryMax));
    save(); keepAwake(true); render();
    let fails = 0;

    while (!my.stop && S.queue.length) {
      rollDay();
      const st = S.settings;
      if (!isFollowingPage()) { setStatus('Paused: go back to your Following page to continue.'); await sleep(2000); continue; }
      if (S.pauseUntil > Date.now()) { setStatus('Paused after an X warning until ' + fmt(S.pauseUntil) + ' tomorrow.'); await sleepUntil(S.pauseUntil, my); continue; }
      if (S.day.unf >= st.dailyCap) {
        const t = new Date(); t.setHours(24, 0, 0, 0);
        setStatus('Daily limit reached (' + st.dailyCap + '). Continues after midnight.');
        await sleepUntil(t.getTime() + rnd(5, 30) * 60000, my); continue;
      }
      S.stamps = S.stamps.filter(t => t > Date.now() - 3600e3);
      if (S.stamps.length >= st.hourlyCap) {
        const t = S.stamps[0] + 3600e3 + rnd(30, 120) * 1000;
        setStatus('Batch done (' + st.hourlyCap + ' this hour). Next batch at ' + fmt(t) + '.');
        await sleepUntil(t, my); continue;
      }
      if (S.nextAt > Date.now()) {
        setStatus((S.waitLabel || 'Next unfollow') + ' at ' + fmt(S.nextAt) + '.');
        await sleepUntil(S.nextAt, my); continue;
      }

      const u = S.queue[0];
      setStatus('Finding @' + u.handle + '…');
      const info = await locate(u.handle, my);
      if (my.stop) break;
      if (info && info.away) continue;
      if (!info) { S.queue.shift(); save(); updateStats(); continue; }                 // not in list anymore
      if (!info.following) { S.queue.shift(); save(); updateStats(); continue; }       // already unfollowed
      if (skipReason(info)) { S.queue.shift(); save(); updateStats(); continue; }      // e.g. followed you back

      setStatus('Unfollowing @' + u.handle + '…');
      const r = await unfollowCell(info);
      if (r === 'limit') {
        S.pauseUntil = Date.now() + 24 * 3600e3;
        save();
        setStatus('X showed a warning. Stopped and paused for 24 hours to protect your account.');
        break;
      }
      if (r === 'ok') {
        fails = 0;
        S.queue.shift();
        S.day.unf++;
        S.stamps.push(Date.now());
        S.log.unshift({ h: u.handle, n: u.name, t: Date.now() });
        S.log = S.log.slice(0, 3000);
        S.sinceBreak++;
        let wait = rnd(CFG.minDelaySec, CFG.maxDelaySec) * 1000;
        S.waitLabel = 'Next unfollow';
        if (S.sinceBreak >= S.breakAfter) {
          wait = rnd(CFG.breakMinMin, CFG.breakMaxMin) * 60000;
          S.sinceBreak = 0;
          S.breakAfter = Math.round(rnd(CFG.breakEveryMin, CFG.breakEveryMax));
          S.waitLabel = 'Short break, back';
        }
        S.nextAt = Date.now() + wait;
        save(); updateStats();
      } else {
        fails++;
        if (fails >= 3) { setStatus('Unfollow did not work 3 times in a row. Stopped for safety.'); break; }
        S.nextAt = Date.now() + rnd(20, 40) * 1000;
        S.waitLabel = 'Retrying';
        save();
      }
    }

    if (job === my) job = null;
    S.running = false;
    save(); keepAwake(false);
    if (!S.queue.length) setStatus('All done. Queue finished.');
    else if (my.stop) setStatus('Stopped. Your queue is saved.');
    render();
  }

  function stopAll() {
    if (job) job.stop = true;
    S.running = false; save();
    setStatus('Stopping…');
  }

  /* ---------- UI ---------- */
  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
  .fab{position:fixed;left:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:2147483646;width:50px;height:50px;border-radius:25px;border:1px solid #3a3f45;background:#1b1e22;color:#fff;font-size:23px;box-shadow:0 6px 18px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
  .fab i{position:absolute;top:3px;right:3px;width:12px;height:12px;border-radius:6px;background:#f5b942;border:2px solid #1b1e22;display:none}
  .fab.on i{display:block}
  .sheet{position:fixed;left:0;right:0;bottom:0;max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch;background:#101215;color:#e8eaed;border-radius:20px 20px 0 0;border-top:1px solid #2c3036;z-index:2147483647;padding:16px 16px calc(22px + env(safe-area-inset-bottom));font-size:15px;line-height:1.4;box-shadow:0 -10px 40px rgba(0,0,0,.5)}
  .hidden{display:none!important}
  .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
  h2{font-size:19px;font-weight:800;margin:0;color:#fff}
  h3{font-size:15px;font-weight:700;margin:0 0 8px;color:#fff}
  .x{background:none;border:0;color:#9aa4ad;font-size:26px;line-height:1;padding:2px 6px}
  .status{background:#1b1e22;border-radius:14px;padding:12px;margin:10px 0 4px}
  .status .msg{font-weight:600;color:#fff}
  .stats{display:flex;gap:14px;margin-top:8px;color:#9aa4ad;font-size:13px}
  .stats b{color:#f5b942;font-size:15px}
  .block{padding:14px 0;border-bottom:1px solid #22262b}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .field{display:flex;flex-direction:column;gap:5px;flex:1 1 140px;margin-bottom:10px}
  .field span{font-size:13px;color:#9aa4ad}
  select,input[type=number],textarea{width:100%;background:#000;color:#e8eaed;border:1px solid #33383e;border-radius:10px;padding:10px;font-size:16px}
  textarea{min-height:64px;resize:vertical}
  .tog{display:flex;align-items:center;justify-content:space-between;padding:8px 0;gap:10px}
  .tog input{width:22px;height:22px;accent-color:#f5b942}
  button.b{border:0;border-radius:999px;padding:11px 16px;font-weight:700;font-size:15px;background:#e8eaed;color:#0f1419}
  button.main{background:#f5b942;color:#1a1400;width:100%;margin-top:4px}
  button.stop{background:#f4212e;color:#fff}
  button.ghost{background:transparent;color:#e8eaed;border:1px solid #454b52}
  button.small{padding:7px 12px;font-size:13px}
  .hint{color:#9aa4ad;font-size:13px;margin:6px 0 0}
  .list{max-height:42vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border:1px solid #2c3036;border-radius:12px;margin:10px 0}
  .item{display:flex;gap:12px;align-items:center;padding:10px 12px;border-bottom:1px solid #1f2328}
  .item:last-child{border-bottom:0}
  .item input{width:22px;height:22px;flex:none;accent-color:#f5b942}
  .who{min-width:0}
  .who a{color:#fff;font-weight:700;text-decoration:none}
  .who div{color:#9aa4ad;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  details summary{font-weight:700;color:#fff;padding:2px 0;list-style:none}
  details summary::-webkit-details-marker{display:none}
  details summary:after{content:"＋";float:right;color:#9aa4ad}
  details[open] summary:after{content:"－"}
  .support{width:100%;margin-top:14px;background:#1b1e22;color:#f5b942;border:1px solid #3a3322}
  .foot{text-align:center;margin-top:16px;color:#9aa4ad;font-size:13px}
  .foot a{color:#1d9bf0;text-decoration:none;font-weight:700;display:inline-block;margin-top:2px}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:2147483647;display:flex;align-items:flex-end}
  .modal .sheet{position:relative;max-height:80vh}
  .coin{background:#1b1e22;border-radius:14px;padding:12px;margin-top:10px}
  .coin .name{font-weight:800;color:#f5b942}
  .addr{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all;color:#e8eaed;margin:6px 0 10px}
  `;

  let host, root, sheet, bodyEl, fab, statusEl, statsEl;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'value' || k === 'open') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  function build() {
    host = document.createElement('div');
    host.id = 'redox-unfollow-helper';
    document.documentElement.append(host);
    // Stop X's keyboard shortcuts from swallowing what you type in the panel.
    ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy',
      'compositionstart', 'compositionupdate', 'compositionend', 'focusin', 'focusout']
      .forEach(ev => host.addEventListener(ev, e => e.stopPropagation()));
    root = host.attachShadow({ mode: 'open' });
    root.append(h('style', { text: CSS }));
    fab = h('button', { class: 'fab', 'aria-label': 'Open unfollow helper', onclick: () => { sheet.classList.remove('hidden'); render(); } }, '🧹', h('i'));
    sheet = h('div', { class: 'sheet hidden', role: 'dialog' });
    root.append(fab, sheet);
  }

  function updateStats() {
    rollDay();
    const hour = S.stamps.filter(t => t > Date.now() - 3600e3).length;
    if (statusEl) statusEl.textContent = S.status;
    if (statsEl) {
      statsEl.replaceChildren(
        h('span', null, 'Today ', h('b', { text: S.day.unf + '/' + S.settings.dailyCap })),
        h('span', null, 'This hour ', h('b', { text: hour + '/' + S.settings.hourlyCap })),
        h('span', null, 'Queue ', h('b', { text: String(S.queue.length) })),
      );
    }
    if (fab) fab.classList.toggle('on', !!(S.running || job));
  }
  function setStatus(t) { S.status = t; save(); updateStats(); }

  function setting(key, val) { S.settings[key] = val; save(); updateStats(); }
  function numField(label, key, min, max) {
    return h('label', { class: 'field' }, h('span', { text: label }),
      h('input', { type: 'number', min, max, inputmode: 'numeric', value: String(S.settings[key]),
        onchange: e => { const n = Math.max(min, Math.min(max, parseInt(e.target.value, 10) || min)); e.target.value = n; setting(key, n); } }));
  }
  function toggle(label, key) {
    return h('label', { class: 'tog' }, h('span', { text: label }),
      h('input', { type: 'checkbox', checked: !!S.settings[key], onchange: e => setting(key, e.target.checked) }));
  }
  function select(label, value, options, onchange) {
    const s = h('select', { onchange: e => onchange(e.target.value) },
      options.map(([v, t]) => h('option', { value: String(v), text: t })));
    s.value = String(value);
    return h('label', { class: 'field' }, h('span', { text: label }), s);
  }

  function goToFollowing() {
    if (S.meList) { location.href = S.meList; return; }
    const me = myHandle();
    if (me) { location.href = '/' + me + '/following'; return; }
    alert('Tap your profile picture, open your Profile, then tap "Following".');
  }

  function render() {
    updateStats();
    if (!sheet || sheet.classList.contains('hidden')) return;
    const busy = !!job;
    const onPage = isFollowingPage();

    statusEl = h('div', { class: 'msg', text: S.status });
    statsEl = h('div', { class: 'stats' });

    const controls = h('div', { class: 'row', style: 'margin-top:10px' },
      busy ? h('button', { class: 'b stop', onclick: stopAll }, job.kind === 'scan' ? 'Stop scan' : 'Stop') : null,
      !busy && S.queue.length ? h('button', { class: 'b', onclick: run }, S.running ? 'Resume' : 'Start queue') : null,
      !busy && S.queue.length ? h('button', { class: 'b ghost small', onclick: () => { if (confirm('Remove all ' + S.queue.length + ' accounts from the queue?')) { S.queue = []; S.running = false; save(); setStatus('Queue cleared.'); render(); } } }, 'Clear queue') : null,
      !onPage ? h('button', { class: 'b ghost small', onclick: goToFollowing }, 'Open my Following page') : null,
    );

    const o = S.opts;
    const scanBlock = h('div', { class: 'block' + (busy ? ' hidden' : '') },
      h('h3', { text: 'Choose who to unfollow' }),
      h('div', { class: 'row' },
        select('Start from', o.dir, [['newest', 'Newest follows'], ['oldest', 'Oldest follows']], v => { o.dir = v; save(); }),
        select('How many', o.count, [[25, '25'], [50, '50'], [100, '100'], [140, '140']], v => { o.count = +v; save(); }),
      ),
      select('Which accounts', o.months, [[0, 'Any account'], [3, 'Inactive for 3+ months'], [5, 'Inactive for 5+ months'], [6, 'Inactive for 6+ months']], v => { o.months = +v; save(); }),
      h('button', { class: 'b main', onclick: scan }, 'Scan and preview'),
      h('p', { class: 'hint', text: 'Nothing is unfollowed until you approve the preview.' }),
    );

    let previewBlock = null;
    if (S.preview.length && !busy) {
      const selected = () => S.preview.filter(u => u.on).length;
      const startBtn = h('button', { class: 'b main' });
      const setStart = () => { startBtn.textContent = 'Unfollow ' + selected() + ' selected'; };
      setStart();
      startBtn.addEventListener('click', () => {
        const add = S.preview.filter(u => u.on).sort((a, b) => a.idx - b.idx);
        const have = new Set(S.queue.map(u => u.handle.toLowerCase()));
        for (const u of add) if (!have.has(u.handle.toLowerCase())) S.queue.push({ handle: u.handle, name: u.name, id: u.id });
        S.preview = []; save();
        setStatus(add.length + ' accounts added to the queue.');
        render(); run();
      });
      const boxes = S.preview.map(u => h('label', { class: 'item' },
        h('input', { type: 'checkbox', checked: u.on, onchange: e => { u.on = e.target.checked; save(); setStart(); } }),
        h('div', { class: 'who' },
          h('a', { href: '/' + u.handle, target: '_blank', rel: 'noopener', text: '@' + u.handle }),
          h('div', { text: u.last !== undefined ? u.name + ', ' + ago(u.last) : u.name }))));
      const setAll = v => { S.preview.forEach(u => { u.on = v; }); save(); render(); };
      previewBlock = h('div', { class: 'block' },
        h('h3', { text: 'Preview: untick anyone you want to keep' }),
        h('div', { class: 'row' },
          h('button', { class: 'b ghost small', onclick: () => setAll(true) }, 'Select all'),
          h('button', { class: 'b ghost small', onclick: () => setAll(false) }, 'Select none'),
          h('button', { class: 'b ghost small', onclick: () => { S.preview = []; save(); render(); } }, 'Discard')),
        h('div', { class: 'list' }, boxes),
        startBtn);
    }

    const settingsBlock = h('details', { class: 'block' },
      h('summary', { text: 'Settings' }),
      h('div', { style: 'margin-top:10px' },
        h('div', { class: 'row' },
          numField('Unfollows per day', 'dailyCap', 1, 400),
          numField('Unfollows per hour', 'hourlyCap', 1, 60)),
        toggle('Skip accounts that follow you', 'skipMutuals'),
        toggle('Skip verified accounts', 'skipVerified'),
        h('label', { class: 'field' }, h('span', { text: 'Never unfollow (usernames, one per line)' }),
          h('textarea', { placeholder: 'elonmusk\n@friend', value: S.settings.whitelist, oninput: e => setting('whitelist', e.target.value) })),
        h('label', { class: 'field' }, h('span', { text: 'Keep accounts whose name or bio contains (comma separated)' }),
          h('textarea', { placeholder: 'crypto, nft, football', value: S.settings.keywords, oninput: e => setting('keywords', e.target.value) })),
        h('p', { class: 'hint', text: 'Safe range: up to 150 a day, around 35 an hour. Start lower on new accounts.' })));

    const logList = h('div');
    const fillLog = () => {
      logList.replaceChildren(
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'b ghost small', onclick: async e => { const ok = await copy(S.log.map(x => '@' + x.h).join('\n')); e.target.textContent = ok ? 'Copied' : 'Copy failed'; } }, 'Copy usernames'),
          h('button', { class: 'b ghost small', onclick: () => { if (confirm('Clear the unfollow history?')) { S.log = []; save(); render(); } } }, 'Clear history')),
        S.log.length
          ? h('div', { class: 'list' }, S.log.slice(0, 150).map(x => h('div', { class: 'item' },
              h('div', { class: 'who' },
                h('a', { href: '/' + x.h, target: '_blank', rel: 'noopener', text: '@' + x.h }),
                h('div', { text: new Date(x.t).toLocaleString() })))))
          : h('p', { class: 'hint', text: 'No unfollows yet.' }));
    };
    const logBlock = h('details', { class: 'block', ontoggle: e => { if (e.target.open) fillLog(); } },
      h('summary', { text: 'Unfollow history (' + S.log.length + ')' }),
      logList,
      h('p', { class: 'hint', text: 'Tap a name to open their profile and follow again.' }));

    bodyEl = h('div', null,
      h('div', { class: 'top' },
        h('h2', { text: '🧹 X Unfollow Helper' }),
        h('button', { class: 'x', 'aria-label': 'Close', onclick: () => sheet.classList.add('hidden') }, '×')),
      h('div', { class: 'status' }, statusEl, statsEl, controls),
      !onPage && !busy ? h('p', { class: 'hint', text: 'Works on your own Following page: Profile, then Following.' }) : null,
      previewBlock, scanBlock, settingsBlock, logBlock,
      h('button', { class: 'b support', onclick: openDonate }, '💛 Support the dev'),
      h('div', { class: 'foot' },
        h('div', { text: 'Made by ' + CREATOR.name }),
        h('a', { href: CREATOR.url, target: '_blank', rel: 'noopener' }, 'Connect on X')));

    sheet.replaceChildren(bodyEl);
    updateStats();
  }

  function openDonate() {
    const close = () => m.remove();
    const m = h('div', { class: 'modal', onclick: e => { if (e.target === m) close(); } },
      h('div', { class: 'sheet' },
        h('div', { class: 'top' },
          h('h2', { text: '💛 Support the dev' }),
          h('button', { class: 'x', 'aria-label': 'Close', onclick: close }, '×')),
        h('p', { class: 'hint', text: 'Thanks for using the tool. Send only on the matching network.' }),
        DONATE.map(d => h('div', { class: 'coin' },
          h('div', { class: 'name', text: d.coin }),
          h('div', { class: 'addr', text: d.addr }),
          h('button', { class: 'b small', onclick: async e => { const ok = await copy(d.addr); e.target.textContent = ok ? 'Copied ✓' : 'Copy failed'; setTimeout(() => { e.target.textContent = 'Copy ' + d.coin; }, 1800); } }, 'Copy ' + d.coin))),
        h('div', { class: 'foot' },
          h('div', { text: 'Made by ' + CREATOR.name }),
          h('a', { href: CREATOR.url, target: '_blank', rel: 'noopener' }, 'Connect on X'))));
    root.append(m);
  }

  /* ---------- start ---------- */
  function tick() {
    if (S.running && !job && S.queue.length && isFollowingPage() && document.visibilityState === 'visible') run();
    else if (S.running && !job && S.queue.length && !isFollowingPage()) {
      if (!/Following page/.test(S.status)) setStatus('Paused: open your Following page and it will continue.');
    }
    updateStats();
  }
  function init() {
    if (!document.body) { setTimeout(init, 400); return; }
    build();
    rollDay();
    if (S.running && S.queue.length) S.status = 'Resuming your queue…';
    save();
    updateStats();
    setInterval(tick, 3000);
  }
  init();
})();
