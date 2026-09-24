// ==UserScript==
// @name         X Unfollow Helper by Redox
// @namespace    https://x.com/amredox
// @version      1.1.3
// @description  Paced unfollowing on X with preview, skip mutuals, whitelist, inactive filter and hourly batches.
// @author       Redox
// @homepageURL  https://unfollow-helper.vercel.app/
// @updateURL    https://unfollow-helper.vercel.app/x-unfollow-helper.user.js
// @downloadURL  https://unfollow-helper.vercel.app/x-unfollow-helper.user.js
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
    dailyCheckCap: 1500,                  // max activity checks per day
    checkMinSec: 10, checkMaxSec: 20,     // fallback wait if X doesn't report its limit
    checkFloorSec: 1.5,                   // fastest allowed gap between checks
  };
  const DEFAULT_SETTINGS = {
    dailyCap: 140, hourlyCap: 35, speed: 'safe',
    skipMutuals: true, skipVerified: false,
    whitelist: '', keywords: '',
  };
  /* ========================================================== */

  const SPEEDS = { safe: [30, 60], medium: [15, 30], fast: [10, 20] }; // seconds between unfollows
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
    meList: '', tpl: null, status: 'Ready', act: {},
    opts: { dir: 'newest', count: 50, months: 0 },
  }, load());
  S.settings = Object.assign({}, DEFAULT_SETTINGS, S.settings || {});

  const ACT_DAYS = 7; // reuse an account's activity result for this many days
  function pruneAct() {
    const keys = Object.keys(S.act || {});
    if (keys.length <= 6000) return;
    keys.sort((a, b) => S.act[a].t - S.act[b].t).slice(0, keys.length - 5000).forEach(k => { delete S.act[k]; });
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function rollDay() { if (!S.day || S.day.d !== today()) S.day = { d: today(), unf: 0, checks: 0 }; }

  /* ---------- helpers ---------- */
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let job = null; // { stop: bool, kind: 'scan'|'run' }

  // Uses the real clock, so time spent frozen in the background still counts.
  async function sleepUntil(t, token) {
    while (Date.now() < t) {
      if (token && (token.stop || token.review)) return false;
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

  // Finds X's own "UserTweets" request details in X's script files,
  // so activity checks work without opening a profile first.
  async function discoverTpl() {
    const srcs = new Set();
    document.querySelectorAll('script[src]').forEach(s => srcs.add(s.src));
    try { performance.getEntriesByType('resource').forEach(e => { if (/\.js(\?|$)/.test(e.name)) srcs.add(e.name); }); } catch (e) {}
    const list = Array.from(srcs)
      .filter(u => /twimg\.com|\/responsive-web\//.test(u))
      .sort((a, b) => (/\/main\./.test(b) ? 1 : 0) - (/\/main\./.test(a) ? 1 : 0))
      .slice(0, 40);
    const re = /queryId:"([^"]+)",operationName:"UserTweets",operationType:"query",metadata:\{featureSwitches:\[([^\]]*)\]/;
    for (const src of list) {
      let text;
      try { const r = await fetch(src); if (!r.ok) continue; text = await r.text(); } catch (e) { continue; }
      const m = text.match(re);
      if (!m) continue;
      const features = {};
      (m[2].match(/"([^"]+)"/g) || []).forEach(q => { features[q.slice(1, -1)] = false; });
      const variables = { userId: '0', count: 10, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: true };
      S.tpl = location.origin + '/i/api/graphql/' + m[1] + '/UserTweets?variables=' +
        encodeURIComponent(JSON.stringify(variables)) + '&features=' + encodeURIComponent(JSON.stringify(features));
      save();
      return S.tpl;
    }
    return null;
  }
  async function getTpl() {
    if (S.tpl) return S.tpl;
    if (captureTpl()) return S.tpl;
    return discoverTpl();
  }

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

    const doFetch = u => fetch(u, {
      credentials: 'include',
      headers: {
        authorization: 'Bearer ' + BEARER,
        'x-csrf-token': cookie('ct0'),
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'content-type': 'application/json',
      },
    });
    let res;
    try {
      res = await doFetch(url);
      if (res.status === 400) {
        // X lists any missing settings in the error; add them and try once more.
        let txt = '';
        try { txt = await res.clone().text(); } catch (e) {}
        const m = txt.match(/cannot be null:\s*([^"]+)/i);
        if (m) {
          const u = new URL(url);
          const f = JSON.parse(u.searchParams.get('features') || '{}');
          m[1].split(',').map(x => x.trim()).filter(Boolean).forEach(k => { f[k] = false; });
          u.searchParams.set('features', JSON.stringify(f));
          url = u.toString();
          res = await doFetch(url);
          if (res.ok) {
            const t = new URL(url); const v = JSON.parse(t.searchParams.get('variables') || '{}');
            v.userId = '0'; t.searchParams.set('variables', JSON.stringify(v));
            S.tpl = t.toString(); save();
          }
        }
      }
    } catch (e) { return { error: 'Network problem during activity check. Check your connection.', fatal: true }; }

    const rem = parseInt(res.headers.get('x-rate-limit-remaining'), 10);
    const reset = parseInt(res.headers.get('x-rate-limit-reset'), 10);
    if (!isNaN(rem) && !isNaN(reset)) { S.rl = { rem, reset: reset * 1000 }; }
    if (res.status === 429) {
      if (S.rl && S.rl.reset > Date.now()) return { error: 'X asked to slow down.', waitUntil: S.rl.reset + 5000 };
      return { error: 'X paused activity checks for now. Try again in a few hours.', fatal: true };
    }
    if (!res.ok) { S.tpl = null; save(); return { error: 'Activity check failed (' + res.status + '). Open any profile once, then scan again. If it keeps failing, use "Any account" for now.', fatal: true }; }

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
  // Batch activity check: one request returns up to 100 accounts with their latest post.
  // If X doesn't support it, the script quietly goes back to one-by-one checks.
  let lookupBroken = false;
  async function lookupBatch(ids) {
    if (lookupBroken || !ids.length) return null;
    let res;
    try {
      res = await fetch(location.origin + '/i/api/1.1/users/lookup.json?include_entities=false&tweet_mode=extended&user_id=' + ids.join(','), {
        credentials: 'include',
        headers: {
          authorization: 'Bearer ' + BEARER,
          'x-csrf-token': cookie('ct0'),
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
        },
      });
    } catch (e) { return null; }
    if (res.status === 429) return null;
    if (!res.ok) { lookupBroken = true; return null; }
    let data;
    try { data = await res.json(); } catch (e) { lookupBroken = true; return null; }
    if (!Array.isArray(data)) { lookupBroken = true; return null; }
    const out = {};
    let withStatus = 0;
    for (const u of data) {
      const id = u && u.id_str;
      if (!id) continue;
      if (u.status && u.status.created_at) { out[id] = parseTw(u.status.created_at); withStatus++; }
      else if (u.statuses_count === 0) out[id] = 0;       // never posted
      else out[id] = undefined;                            // unclear, check one by one
    }
    if (data.length >= 5 && withStatus === 0) { lookupBroken = true; return null; } // X hides latest posts here
    return out;
  }

  // Spreads the checks X still allows evenly until its limit resets.
  function checkGap() {
    const rl = S.rl;
    if (rl && rl.reset > Date.now()) {
      const left = rl.rem - 2; // keep a small safety margin
      if (left <= 0) return rl.reset - Date.now() + 5000;
      const even = (rl.reset - Date.now()) / left;
      return Math.max(CFG.checkFloorSec * 1000, even) * rnd(1, 1.35);
    }
    return rnd(CFG.checkMinSec, CFG.checkMaxSec) * 1000;
  }
  const prog = { phase: '', sub: '', looked: 0, possible: 0, checked: 0, found: 0, target: 0, pct: -1 };
  function setProg(p) { Object.assign(prog, p); updateLoader(); }
  async function scan() {
    if (job) return;
    if (!isFollowingPage()) { setStatus('Open your Following page first, then scan.'); render(); return; }
    if (!checkOwnList()) return;

    const o = S.opts;
    rollDay();
    const my = job = { stop: false, kind: 'scan' };
    S.preview = []; save();
    Object.assign(prog, { phase: 'Getting ready', sub: 'Going to the top of your list', looked: 0, possible: 0, checked: 0, found: 0, target: o.count, pct: -1 });
    sheet.classList.remove('hidden');
    render();

    if (o.months) {
      setProg({ phase: 'Getting ready', sub: 'Setting up activity checks' });
      setStatus('Setting up activity checks…');
      if (!(await getTpl())) {
        if (job === my) job = null;
        setStatus('Could not set up activity checks. Open any profile once (tap a name), scroll a little, come back here and scan again.');
        render(); return;
      }
    }

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
      setProg({ phase: 'Scanning your list', sub: o.dir === 'oldest' ? 'Scrolling to your oldest follows' : 'Reading your newest follows',
        looked: seen.size, possible: pool.length,
        pct: (o.dir === 'newest' && !o.months) ? Math.min(100, pool.length / o.count * 100) : -1 });
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
      const known = id => { const c = S.act[id]; return !!(c && Date.now() - c.t < ACT_DAYS * 864e5); };
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (my.stop || my.review) break;
        rollDay();
        // Fast path: ask X about up to 100 accounts in one request.
        if (!known(u.id) && !lookupBroken) {
          const ids = [];
          for (let j = i; j < list.length && ids.length < 100; j++) if (!known(list[j].id)) ids.push(list[j].id);
          setProg({ phase: 'Checking who is inactive', sub: 'Checking ' + ids.length + ' accounts at once' });
          const m = await lookupBatch(ids);
          if (m) {
            const now = Date.now();
            for (const id in m) if (m[id] !== undefined) S.act[id] = { last: m[id], t: now };
            pruneAct(); S.day.checks++; save();
            await sleepUntil(Date.now() + rnd(800, 1600), my);
          }
        }
        let r, fresh = false;
        const c = S.act[u.id];
        if (known(u.id)) {
          r = { last: c.last };
          setProg({ phase: 'Checking who is inactive', sub: 'Checked @' + u.handle, checked: prog.checked + 1 });
        } else {
          if (S.day.checks >= CFG.dailyCheckCap) { note = ' Daily activity-check limit reached, scan again tomorrow for more.'; break; }
          setStatus('Checking activity: found ' + picked.length + ' of ' + o.count + ' (checking @' + u.handle + ')');
          setProg({ phase: 'Checking who is inactive', sub: 'Looking at @' + u.handle, checked: prog.checked + 1,
            found: picked.length, pct: Math.min(100, picked.length / o.count * 100) });
          r = await lastPost(u.id);
          S.day.checks++;
          if (!r.error) { S.act[u.id] = { last: r.last || 0, t: Date.now() }; pruneAct(); }
          save();
          if (r.waitUntil) {
            setProg({ sub: 'X asked for a short pause. Continuing at ' + fmt(r.waitUntil) });
            await sleepUntil(r.waitUntil, my);
            continue;
          }
          if (r.error) { note = ' ' + r.error; if (r.fatal) break; continue; }
          fresh = true;
        }
        if (!r.last || r.last < cutoff) {
          u.last = r.last || 0; picked.push(u);
          setProg({ found: picked.length, pct: Math.min(100, picked.length / o.count * 100) });
          if (picked.length >= o.count) break;
        }
        if (fresh) await sleepUntil(Date.now() + checkGap(), my);
      }
    }

    if (job === my) job = null;
    S.preview = picked.map(u => Object.assign({}, u, { on: true }));
    save();
    window.scrollTo(0, 0);
    const skipText = 'Skipped: ' + skipped.mutual + ' follow you, ' + skipped.whitelist + ' whitelisted, ' +
      skipped.verified + ' verified, ' + skipped.keyword + ' keyword.';
    if (my.stop) setStatus('Scan stopped. ' + picked.length + ' in preview.');
    else if (my.review) setStatus('Showing the ' + picked.length + ' found so far. Scan again anytime for more; checked accounts are remembered.');
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

  // Unfollows by account ID, the same request X's Unfollow button sends,
  // so it doesn't need to scroll the list to find each account.
  let apiBroken = false;
  async function unfollowApi(id) {
    if (apiBroken || !id) return 'fallback';
    let res;
    try {
      res = await fetch(location.origin + '/i/api/1.1/friendships/destroy.json', {
        method: 'POST',
        credentials: 'include',
        headers: {
          authorization: 'Bearer ' + BEARER,
          'x-csrf-token': cookie('ct0'),
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'include_profile_interstitial_type=1&skip_status=true&user_id=' + encodeURIComponent(id),
      });
    } catch (e) { return 'fallback'; }
    if (res.status === 429) return 'limit';
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.ok && data && (data.id_str || data.screen_name)) return 'ok';
    const codes = ((data && data.errors) || []).map(e => e.code);
    if (codes.some(c => [88, 161, 283, 326].includes(c))) return 'limit';
    if (codes.some(c => [34, 50, 63].includes(c))) return 'gone';
    apiBroken = true; // use the old click method for the rest of this session
    return 'fallback';
  }

  async function run() {
    if (job) return;
    if (!S.queue.length) { setStatus('Queue is empty. Scan and approve a preview first.'); return; }

    const my = job = { stop: false, kind: 'run' };
    S.running = true;
    if (!S.breakAfter) S.breakAfter = Math.round(rnd(CFG.breakEveryMin, CFG.breakEveryMax));
    save(); keepAwake(true); render();
    let fails = 0;

    while (!my.stop && S.queue.length) {
      rollDay();
      const st = S.settings;
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
      if (parseList(st.whitelist).includes(u.handle.toLowerCase())) { S.queue.shift(); save(); updateStats(); continue; }

      setStatus('Unfollowing @' + u.handle + '…');
      let r = await unfollowApi(u.id);
      if (r === 'fallback') {
        // Old method: find the account on the Following page and tap its button.
        if (!isFollowingPage()) { setStatus('Paused: open your Following page to continue.'); await sleep(3000); continue; }
        setStatus('Finding @' + u.handle + '…');
        const info = await locate(u.handle, my);
        if (my.stop) break;
        if (info && info.away) continue;
        if (!info || !info.following || skipReason(info)) { S.queue.shift(); save(); updateStats(); continue; }
        setStatus('Unfollowing @' + u.handle + '…');
        r = await unfollowCell(info);
      }
      if (r === 'gone') { S.queue.shift(); save(); updateStats(); continue; }       // account deleted or suspended
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
        const sp = SPEEDS[S.settings.speed] || SPEEDS.safe;
        let wait = rnd(sp[0], sp[1]) * 1000;
        S.waitLabel = 'Next unfollow';
        if (S.sinceBreak >= S.breakAfter) {
          wait = rnd(CFG.breakMinMin, CFG.breakMaxMin) * 60000;
          S.sinceBreak = 0;
          S.breakAfter = Math.round(rnd(CFG.breakEveryMin, CFG.breakEveryMax));
          S.waitLabel = 'Short break, back';
        }
        S.nextAt = Date.now() + wait;
        save(); updateStats();
        sweptAway(u.handle);
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
  .sweep.still{animation:none;opacity:.6}
  .sweep.swish{animation:swish .65s ease-in-out}
  @keyframes swish{0%{transform:rotate(0)}30%{transform:rotate(-38deg) translateX(-8px)}70%{transform:rotate(32deg) translateX(12px)}100%{transform:rotate(0)}}
  .swept{position:absolute;left:50%;top:70px;display:flex;flex-direction:column;align-items:center;gap:5px;pointer-events:none;z-index:2;animation:swept 2.2s cubic-bezier(.5,0,.3,1) forwards}
  .swept .chip{position:relative;background:#e8eaed;color:#0f1419;font-weight:800;border-radius:999px;padding:7px 14px;font-size:14px;white-space:nowrap;box-shadow:0 8px 20px rgba(0,0,0,.4)}
  .swept .chip:after{content:"";position:absolute;left:10px;right:10px;top:50%;height:2.5px;border-radius:2px;background:#f4212e;transform:scaleX(0);transform-origin:left;animation:strike .35s .3s ease-out forwards}
  .swept .ok{color:#f5b942;font-size:12.5px;font-weight:800;opacity:0;animation:okin .25s .45s forwards}
  @keyframes strike{to{transform:scaleX(1)}}
  @keyframes okin{to{opacity:1}}
  @keyframes swept{0%{opacity:0;transform:translate(-50%,14px) scale(.85)}12%{opacity:1;transform:translate(-50%,0) scale(1)}58%{opacity:1;transform:translate(-50%,0) rotate(0)}100%{opacity:0;transform:translate(70%,-46px) rotate(16deg) scale(.75)}}
  .burst{position:absolute;left:50%;top:84px;width:0;height:0;pointer-events:none;z-index:1}
  .burst i{position:absolute;width:6px;height:6px;border-radius:3px;background:#f5b942;opacity:0;animation:burst .8s .35s ease-out forwards}
  .burst i:nth-child(even){background:#e8eaed;width:4px;height:4px}
  @keyframes burst{0%{opacity:1;transform:rotate(var(--a)) translateX(0)}100%{opacity:0;transform:rotate(var(--a)) translateX(46px)}}
  .counts b.bump{animation:bump .55s ease}
  @keyframes bump{40%{transform:scale(1.35);color:#fff}}
  @media (prefers-reduced-motion:reduce){.sweep.swish,.burst i,.counts b.bump{animation:none}.swept{animation:fadeout 2.2s forwards}.swept .chip:after{animation:none;transform:scaleX(1)}.swept .ok{animation:none;opacity:1}}
  @keyframes fadeout{0%,70%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;transform:translate(-50%,0)}}
  .speedbox{background:#1b1e22;border-radius:14px;padding:12px;margin:10px 0}
  .saved{color:#f5b942;font-size:13px;font-weight:700}
  .support{width:100%;margin-top:14px;background:#1b1e22;color:#f5b942;border:1px solid #3a3322}
  .loader{background:#1b1e22;border-radius:18px;padding:22px 16px 18px;margin:12px 0;text-align:center;position:relative;overflow:hidden}
  .sweep{font-size:46px;display:inline-block;transform-origin:50% 85%;animation:sweep .9s ease-in-out infinite alternate}
  @keyframes sweep{from{transform:rotate(-20deg) translateX(-6px)}to{transform:rotate(20deg) translateX(6px)}}
  .dust{height:10px;position:relative;margin:-4px auto 6px;width:90px}
  .dust i{position:absolute;bottom:0;width:6px;height:6px;border-radius:3px;background:#f5b942;opacity:0;animation:dust 1.8s ease-out infinite}
  .dust i:nth-child(1){left:20px}.dust i:nth-child(2){left:44px;animation-delay:.6s}.dust i:nth-child(3){left:66px;animation-delay:1.2s}
  @keyframes dust{0%{opacity:.8;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(14px,-18px) scale(.3)}}
  .phase{display:inline;font-weight:800;font-size:18px;color:#fff}
  .dots{display:inline-block;width:0;overflow:hidden;vertical-align:bottom;font-weight:800;font-size:18px;color:#fff;animation:dots 1.2s steps(4,end) infinite}
  @keyframes dots{to{width:1.1em}}
  .lsub{color:#9aa4ad;font-size:14px;margin-top:4px;min-height:1.4em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar{height:8px;background:#2a2f35;border-radius:99px;overflow:hidden;margin:16px 0 14px}
  .bar i{display:block;height:100%;width:4%;background:#f5b942;border-radius:99px;transition:width .5s ease}
  .bar.ind i{width:35%;animation:ind 1.3s ease-in-out infinite}
  @keyframes ind{0%{transform:translateX(-110%)}100%{transform:translateX(300%)}}
  .counts{display:flex;justify-content:center;gap:22px;color:#9aa4ad;font-size:12.5px}
  .counts span{display:flex;flex-direction:column;align-items:center}
  .counts b{color:#f5b942;font-size:22px;font-weight:800;line-height:1.2}
  @media (prefers-reduced-motion:reduce){.sweep,.dust i,.dots,.bar.ind i{animation:none}.dots{width:auto}.dust{display:none}}
  .foot{text-align:center;margin-top:16px;color:#9aa4ad;font-size:13px}
  .foot a{color:#1d9bf0;text-decoration:none;font-weight:700;display:inline-block;margin-top:2px}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:2147483647;display:flex;align-items:flex-end}
  .modal .sheet{position:relative;max-height:80vh}
  .coin{background:#1b1e22;border-radius:14px;padding:12px;margin-top:10px}
  .coin .name{font-weight:800;color:#f5b942}
  .addr{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all;color:#e8eaed;margin:6px 0 10px}
  `;

  let host, root, sheet, bodyEl, fab, statusEl, statsEl, ld = null, rv = null;

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
    updateRunView();
  }
  function setStatus(t) { S.status = t; save(); updateStats(); }

  const withCurrent = (opts, cur) => opts.some(o => o[0] === cur) ? opts : opts.concat([[cur, String(cur)]]).sort((a, b) => a[0] - b[0]);
  function speedBox(countFn, onChange) {
    const est = h('p', { class: 'hint' });
    const saved = h('span', { class: 'saved' });
    const refresh = () => {
      const n = countFn();
      const sp = SPEEDS[S.settings.speed] || SPEEDS.safe;
      const perHour = Math.min(S.settings.hourlyCap, Math.floor(3600 / ((sp[0] + sp[1]) / 2)));
      const today = Math.max(0, S.settings.dailyCap - S.day.unf);
      const nowPart = Math.min(n, today);
      const mins = Math.ceil(nowPart / Math.max(1, perHour) * 60);
      const time = mins >= 60 ? Math.floor(mins / 60) + ' hr ' + (mins % 60) + ' min' : mins + ' min';
      est.textContent = n === 0 ? 'Nothing to unfollow yet.' :
        (nowPart === 0 ? 'Daily limit reached. The ' + n + ' left continue tomorrow.' :
        'About ' + perHour + ' an hour, so roughly ' + time + ' for ' + nowPart + ' account' + (nowPart === 1 ? '' : 's') + ' today' +
        (n > nowPart ? '. The other ' + (n - nowPart) + ' continue tomorrow (daily limit ' + S.settings.dailyCap + ').' : '.'));
      if (onChange) onChange();
    };
    const done = () => { refresh(); updateRunView(); saved.textContent = 'Saved ✓'; clearTimeout(done.t); done.t = setTimeout(() => { saved.textContent = ''; }, 1500); };
    const box = h('div', { class: 'speedbox' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', { text: 'How fast to unfollow', style: 'margin:0' }), saved),
      select('Speed', S.settings.speed, [['safe', 'Safe: every 30–60 sec'], ['medium', 'Faster: every 15–30 sec'], ['fast', 'Fastest: every 10–20 sec (riskier)']],
        v => { setting('speed', v); S.nextAt = Math.min(S.nextAt, Date.now() + 5000); save(); done(); }),
      h('div', { class: 'row' },
        select('Per hour', S.settings.hourlyCap, withCurrent([[20, '20'], [35, '35 (safe)'], [50, '50'], [75, '75'], [100, '100']], S.settings.hourlyCap),
          v => { setting('hourlyCap', +v); done(); }),
        select('Per day', S.settings.dailyCap, withCurrent([[50, '50'], [100, '100'], [140, '140 (safe)'], [200, '200'], [300, '300']], S.settings.dailyCap),
          v => { setting('dailyCap', +v); done(); })),
      est,
      h('p', { class: 'hint', text: 'Saved automatically and used every time until you change them. Changes apply straight away, even mid-queue.' }));
    box.refresh = refresh;
    refresh();
    return box;
  }

  function clearQueue() {
    if (!confirm('Remove all ' + S.queue.length + ' accounts from the queue?')) return;
    if (job && job.kind === 'run') job.stop = true;
    S.queue = []; S.running = false; save();
    setStatus('Queue cleared.'); render();
  }

  function runBlock() {
    const running = !!(job && job.kind === 'run');
    rv = { count: h('div', { class: 'lsub' }), bar: h('div', { class: 'bar' }), fill: h('i'), counts: h('div', { class: 'counts' }), next: h('div', { class: 'list' }) };
    rv.bar.append(rv.fill);
    const broom = h('div', { class: 'sweep' + (running ? '' : ' still'), 'aria-hidden': 'true' }, '🧹');
    const box = h('div', { class: 'loader' },
      broom,
      running ? h('div', { class: 'dust', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : h('div', { class: 'dust' }),
      h('div', null, h('div', { class: 'phase', text: running ? 'Unfollowing' : 'Queue paused' }),
        running ? h('span', { class: 'dots', 'aria-hidden': 'true' }, '...') : null),
      rv.count, rv.bar, rv.counts,
      running
        ? h('button', { class: 'b stop', style: 'margin-top:14px', onclick: stopAll }, 'Pause')
        : h('button', { class: 'b main', style: 'margin-top:14px', onclick: run }, 'Continue unfollowing (' + S.queue.length + ' left)'),
      h('div', null, h('button', { class: 'b ghost small', style: 'margin-top:10px', onclick: clearQueue }, 'Clear queue')));
    rv.box = box; rv.broom = broom; rv.lastDone = S.day.unf;
    const wrap = h('div', null,
      box,
      speedBox(() => S.queue.length),
      h('div', { class: 'block' }, h('h3', { text: 'Up next' }), rv.next,
        h('p', { class: 'hint', text: 'Keep Safari open on this tab. If you leave, it continues when you come back.' })));
    updateRunView();
    return wrap;
  }

  // Little celebration each time an account is unfollowed:
  // the broom swishes, the @name gets crossed out and swept off the card.
  function sweptAway(handle) {
    if (!rv || !rv.box) return;
    const chip = h('div', { class: 'swept', 'aria-hidden': 'true' },
      h('span', { class: 'chip', text: '@' + handle }),
      h('span', { class: 'ok', text: 'Unfollowed ✓' }));
    const bits = h('div', { class: 'burst', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4, 5, 6, 7].map(i => h('i', { style: '--a:' + (i * 45) + 'deg' })));
    rv.box.append(chip, bits);
    rv.broom.classList.remove('swish'); void rv.broom.offsetWidth; rv.broom.classList.add('swish');
    setTimeout(() => { rv && rv.broom && rv.broom.classList.remove('swish'); }, 700);
    setTimeout(() => { chip.remove(); bits.remove(); }, 2300);
  }

  function updateRunView() {
    if (!rv) return;
    const running = !!(job && job.kind === 'run');
    let t;
    if (!running) t = S.queue.length + ' accounts waiting. Tap Continue to carry on.';
    else if (S.pauseUntil > Date.now()) t = 'Paused after an X warning until ' + fmt(S.pauseUntil);
    else if (S.nextAt > Date.now()) {
      const sec = Math.ceil((S.nextAt - Date.now()) / 1000);
      t = (S.waitLabel || 'Next unfollow') + ' in ' + (sec >= 60 ? Math.floor(sec / 60) + 'm ' + (sec % 60) + 's' : sec + 's');
    } else t = S.status;
    rv.count.textContent = t;
    const target = Math.min(S.settings.dailyCap, S.day.unf + S.queue.length);
    rv.fill.style.width = (target ? Math.max(4, Math.min(100, S.day.unf / target * 100)) : 4) + '%';
    const hour = S.stamps.filter(x => x > Date.now() - 3600e3).length;
    const doneB = h('b', { text: String(S.day.unf) });
    if (S.day.unf > rv.lastDone) { doneB.classList.add('bump'); rv.lastDone = S.day.unf; }
    rv.counts.replaceChildren(
      h('span', null, doneB, 'done today'),
      h('span', null, h('b', { text: String(S.queue.length) }), 'left'),
      h('span', null, h('b', { text: hour + '/' + S.settings.hourlyCap }), 'this hour'));
    rv.next.replaceChildren(...(S.queue.length
      ? S.queue.slice(0, 5).map(u => h('div', { class: 'item' }, h('div', { class: 'who' },
          h('a', { href: '/' + u.handle, target: '_blank', rel: 'noopener', text: '@' + u.handle }),
          h('div', { text: u.name || '' }))))
      : [h('div', { class: 'item' }, h('div', { class: 'who' }, h('div', { text: 'Queue finished.' })))]));
  }
  setInterval(updateRunView, 1000);

  function updateLoader() {
    if (!ld) return;
    ld.phase.textContent = prog.phase;
    ld.sub.textContent = prog.sub;
    const checking = prog.phase === 'Checking who is inactive';
    ld.counts.replaceChildren(
      h('span', null, h('b', { text: String(prog.looked) }), 'looked at'),
      h('span', null, h('b', { text: String(prog.possible) }), 'possible'),
      checking ? h('span', null, h('b', { text: prog.found + '/' + prog.target }), 'inactive found') : null);
    const det = prog.pct >= 0;
    ld.bar.classList.toggle('ind', !det);
    ld.fill.style.width = det ? Math.max(4, prog.pct) + '%' : '';
    ld.hint.textContent = checking ? 'Speed adjusts to what X allows, so it goes as fast as is safe. Accounts checked in the last 7 days are instant. Keep this screen open.' : 'Keep this screen open. The page scrolls by itself.';
    ld.review.classList.toggle('hidden', !(checking && prog.found > 0));
    ld.review.textContent = 'Review ' + prog.found + ' found now';
  }
  function loaderBlock() {
    ld = {
      phase: h('div', { class: 'phase' }),
      sub: h('div', { class: 'lsub' }),
      bar: h('div', { class: 'bar' }),
      fill: h('i'),
      counts: h('div', { class: 'counts' }),
      hint: h('p', { class: 'hint' }),
      review: h('button', { class: 'b main', style: 'margin-top:12px', onclick: () => { if (job && job.kind === 'scan') job.review = true; } }),
    };
    ld.bar.append(ld.fill);
    const box = h('div', { class: 'loader' },
      h('div', { class: 'sweep', 'aria-hidden': 'true' }, '🧹'),
      h('div', { class: 'dust', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('div', null, ld.phase, h('span', { class: 'dots', 'aria-hidden': 'true' }, '...')),
      ld.sub, ld.bar, ld.counts, ld.hint, ld.review,
      h('button', { class: 'b stop', style: 'margin-top:10px', onclick: stopAll }, 'Stop scan'));
    updateLoader();
    return box;
  }

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
    ld = null;
    rv = null;
    const onPage = isFollowingPage();

    statusEl = h('div', { class: 'msg', text: S.status });
    statsEl = h('div', { class: 'stats' });

    const controls = h('div', { class: 'row', style: 'margin-top:10px' },
      !onPage && !S.queue.length ? h('button', { class: 'b ghost small', onclick: goToFollowing }, 'Open my Following page') : null,
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
      const sb = speedBox(selected, () => { startBtn.textContent = 'Unfollow ' + selected() + ' selected'; });
      startBtn.addEventListener('click', () => {
        const add = S.preview.filter(u => u.on).sort((a, b) => a.idx - b.idx);
        const have = new Set(S.queue.map(u => u.handle.toLowerCase()));
        for (const u of add) if (!have.has(u.handle.toLowerCase())) S.queue.push({ handle: u.handle, name: u.name, id: u.id });
        S.preview = []; save();
        setStatus(add.length + ' accounts added to the queue.');
        render(); run();
      });
      const boxes = S.preview.map(u => h('label', { class: 'item' },
        h('input', { type: 'checkbox', checked: u.on, onchange: e => { u.on = e.target.checked; save(); sb.refresh(); } }),
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
        sb,
        startBtn);
    }

    const showRun = S.queue.length > 0 && !(busy && job.kind === 'scan');

    const settingsBlock = h('details', { class: 'block' },
      h('summary', { text: 'Settings' }),
      h('div', { style: 'margin-top:10px' },
        h('div', { class: 'row' },
          numField('Unfollows per day', 'dailyCap', 1, 400),
          numField('Unfollows per hour', 'hourlyCap', 1, 100)),
        select('Speed between unfollows', S.settings.speed, [['safe', 'Safe: every 30–60 sec'], ['medium', 'Faster: every 15–30 sec'], ['fast', 'Fastest: every 10–20 sec (riskier)']], v => { setting('speed', v); S.nextAt = Math.min(S.nextAt, Date.now() + 5000); save(); }),
        toggle('Skip accounts that follow you', 'skipMutuals'),
        toggle('Skip verified accounts', 'skipVerified'),
        h('label', { class: 'field' }, h('span', { text: 'Never unfollow (usernames, one per line)' }),
          h('textarea', { placeholder: 'elonmusk\n@friend', value: S.settings.whitelist, oninput: e => setting('whitelist', e.target.value) })),
        h('label', { class: 'field' }, h('span', { text: 'Keep accounts whose name or bio contains (comma separated)' }),
          h('textarea', { placeholder: 'crypto, nft, football', value: S.settings.keywords, oninput: e => setting('keywords', e.target.value) })),
        h('p', { class: 'hint', text: 'Safe range: up to 150 a day, around 35 an hour. Faster speeds only finish your daily amount sooner; the daily limit still decides the total. Start lower on new accounts.' }),
        h('button', { class: 'b ghost small', style: 'margin-top:10px', onclick: () => { if (confirm('Forget saved activity checks? Next inactive scan will check everyone again.')) { S.act = {}; save(); setStatus('Saved activity checks cleared.'); } } }, 'Forget saved activity checks')));

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
      busy && job.kind === 'scan' ? loaderBlock() : null,
      showRun ? runBlock() : null,
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
    if (S.running && !job && S.queue.length && document.visibilityState === 'visible') run();
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
