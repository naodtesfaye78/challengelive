'use strict';

/**
 * app.js - the web server logic: login check, rules, dares, voting, goal, Q&A.
 * Who someone is (channel, streamer or viewer) comes ONLY from the verified Twitch token.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ApiError } = require('./errors');
const { CATALOG, GOAL_PRODUCTS, findById, findDareBySku, findGoalProduct, publicView } = require('./catalog');
const { signHs256 } = require('./jwt');
const { makeZip } = require('./zip');

const EXT_DIR = path.join(__dirname, '..', 'extension');
const DEV_DIR = path.join(__dirname, '..', 'dev');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const PER_VIEWER_ACTIVE = 3;
const MAX_QUEUE = 50;
const DEDUPE_MS = 10 * 60 * 1000;
const POLL_MIN = 20;
const POLL_MAX = 600;

// dare statuses: pending -> approved|rejected ; approved -> accepted|declined|skipped ; accepted -> completed|declined|skipped
const TRANSITIONS = {
  accept: { from: ['approved'], to: 'accepted' },
  decline: { from: ['approved', 'accepted'], to: 'declined' },
  skip: { from: ['approved', 'accepted'], to: 'skipped' },
  complete: { from: ['accepted'], to: 'completed' },
};

function createApp(deps) {
  const { config, store, moderate, twitch } = deps;
  const now = deps.now || (() => Date.now());
  const hits = new Map();

  function limit(key, max, windowMs) {
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) {
      throw new ApiError(429, 'rate_limited', 'Slow down a little and try again.', { 'retry-after': String(Math.ceil((windowMs - (t - arr[0])) / 1000)) });
    }
    arr.push(t);
    hits.set(key, arr);
    if (hits.size > 20000) hits.delete(hits.keys().next().value);
  }

  // ---------- helpers ----------
  const id = () => crypto.randomUUID();
  const channelOf = (auth) => store.channel(auth.channelId);
  const isStreamer = (auth) => auth.role === 'broadcaster';

  function requireStreamer(auth) {
    if (!isStreamer(auth)) throw new ApiError(403, 'forbidden', 'Only the channel owner can do that.');
  }

  function bodyString(body, key, max) {
    const v = body && body[key];
    if (typeof v !== 'string' || v.length > max) throw new ApiError(400, 'bad_request', 'Invalid ' + key + '.');
    return v;
  }

  function dareView(d, auth) {
    const mine = d.viewerId === auth.opaqueId;
    return {
      id: d.id, kind: d.kind, title: d.title, text: d.text, bits: d.bits, status: d.status,
      viewerName: d.viewerName, mine, chatPick: !!d.chatPick, createdAt: d.createdAt,
      message: mine || isStreamer(auth) ? d.message || '' : '',
    };
  }

  function questionView(q, auth) {
    return {
      id: q.id, text: q.text, status: q.status, viewerName: q.viewerName, mine: q.viewerId === auth.opaqueId,
      votes: q.voters.length, voted: q.voters.includes(auth.opaqueId), message: q.viewerId === auth.opaqueId ? q.message || '' : '',
      createdAt: q.createdAt,
    };
  }

  function pollView(p, auth) {
    if (!p) return null;
    const mineChoice = p.voters[auth.opaqueId] || null;
    return {
      id: p.id, status: p.status, closesAt: p.closesAt, myChoice: mineChoice,
      totalVotes: p.options.reduce((n, o) => n + o.votes, 0),
      winnerId: p.winnerId || null,
      options: p.options.map((o) => ({ id: o.id, title: o.title, text: o.text, votes: o.votes })),
    };
  }

  function goalView(g) {
    if (!g) return null;
    return { dareId: g.dareId, title: g.title, objective: g.objective, target: g.target, current: g.current, timesReached: g.timesReached };
  }

  function settingsView(ch) {
    return { customDaresOpen: ch.settings.customDaresOpen, qaOpen: ch.settings.qaOpen, freeMenuMode: ch.settings.freeMenuMode };
  }

  function menuFor(ch) {
    return CATALOG.filter((d) => !ch.settings.disabled.includes(d.id)).map(publicView);
  }

  function closePoll(ch, reason) {
    const p = ch.poll;
    if (!p || p.status !== 'open') return;
    p.status = 'closed';
    p.closedReason = reason;
    const top = [...p.options].sort((a, b) => b.votes - a.votes)[0];
    if (top && top.votes > 0) {
      p.winnerId = top.id;
      if (top.source === 'catalog') {
        const cat = findById(top.catalogId);
        if (cat) {
          ch.dares.push({
            id: id(), kind: 'vote', title: cat.title, text: cat.objective, bits: 0, viewerId: null, viewerName: 'Chat vote',
            status: 'approved', createdAt: now(), decidedAt: null, message: '',
          });
        }
      } else if (top.source === 'dare') {
        const d = ch.dares.find((x) => x.id === top.dareId);
        if (d) d.chatPick = true;
      }
    }
    ch.lastPoll = p;
    ch.poll = null;
    store.touch();
  }

  function sweep() {
    const t = now();
    for (const ch of Object.values(store.channels())) {
      if (ch.poll && ch.poll.status === 'open' && ch.poll.closesAt <= t) closePoll(ch, 'time');
    }
  }
  const sweeper = setInterval(sweep, 1000);
  sweeper.unref();
  const pruner = setInterval(() => store.prune(), 6 * 3600 * 1000);
  pruner.unref();

  function activeCount(ch, viewerId) {
    return ch.dares.filter((d) => d.viewerId === viewerId && ['pending', 'approved', 'accepted'].includes(d.status)).length;
  }

  // ---------- viewer routes ----------
  async function viewerState(auth) {
    sweep();
    const ch = channelOf(auth);
    const visible = ch.dares
      .filter((d) => d.status === 'approved' || d.status === 'accepted')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 30)
      .map((d) => dareView(d, auth));
    const mine = ch.dares.filter((d) => d.viewerId === auth.opaqueId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 15).map((d) => dareView(d, auth));
    const questions = ch.questions
      .filter((q) => ['approved', 'shown', 'answered'].includes(q.status) || (q.viewerId === auth.opaqueId && q.status === 'rejected'))
      .sort((a, b) => (b.status === 'shown') - (a.status === 'shown') || b.voters.length - a.voters.length || a.createdAt - b.createdAt)
      .slice(0, 30)
      .map((q) => questionView(q, auth));
    return {
      role: auth.role,
      loggedIn: auth.loggedIn,
      linked: !!auth.userId,
      settings: settingsView(ch),
      menu: menuFor(ch),
      goalProducts: GOAL_PRODUCTS,
      board: visible,
      mine,
      poll: pollView(ch.poll, auth),
      lastPoll: !ch.poll ? pollView(ch.lastPoll, auth) : null,
      goal: goalView(ch.goal),
      questions,
      serverTime: now(),
    };
  }

  async function submitCustom(auth, body) {
    if (!auth.loggedIn || !auth.userId) throw new ApiError(403, 'identity_required', 'Please share your Twitch identity to send a dare.');
    const ch = channelOf(auth);
    if (!ch.settings.customDaresOpen) throw new ApiError(403, 'closed', 'The streamer is not taking custom dares right now.');
    limit('custom:' + auth.channelId + ':' + auth.opaqueId, 5, 10 * 60 * 1000);
    limit('customch:' + auth.channelId, 30, 60 * 1000);
    const text = bodyString(body, 'text', 1000);
    const verdict = await moderate(text, 'dare');
    const clean = verdict.text;
    if (verdict.status === 'approved') {
      const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const dup = ch.dares.some((d) => d.kind === 'custom' && ['approved', 'accepted'].includes(d.status) && now() - d.createdAt < DEDUPE_MS && d.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === key);
      if (dup) throw new ApiError(409, 'duplicate', 'Someone already sent that dare. Try your own idea!');
      if (activeCount(ch, auth.opaqueId) >= PER_VIEWER_ACTIVE) throw new ApiError(429, 'viewer_limit', 'You already have ' + PER_VIEWER_ACTIVE + ' dares waiting. Wait for the streamer.');
      if (ch.dares.filter((d) => d.status === 'approved' || d.status === 'accepted').length >= MAX_QUEUE) throw new ApiError(429, 'queue_full', 'The dare queue is full right now.');
    }
    const name = await twitch.getDisplayName(auth.userId);
    const dare = {
      id: id(), kind: 'custom', title: 'Viewer dare', text: clean, bits: 0, viewerId: auth.opaqueId, viewerName: name,
      status: verdict.status === 'approved' ? 'approved' : 'rejected', createdAt: now(), decidedAt: verdict.status === 'approved' ? null : now(),
      message: verdict.message,
    };
    ch.dares.push(dare);
    store.touch();
    return { dare: dareView(dare, auth), message: verdict.status === 'approved' ? 'Sent! The streamer decides whether to do it.' : verdict.message };
  }

  async function submitMenuFree(auth, body) {
    const ch = channelOf(auth);
    if (!ch.settings.freeMenuMode) throw new ApiError(403, 'closed', 'Test mode is off.');
    if (!auth.loggedIn) throw new ApiError(403, 'identity_required', 'Please log in to Twitch to send a dare.');
    limit('menu:' + auth.channelId + ':' + auth.opaqueId, 20, 10 * 60 * 1000);
    const cat = findById(bodyString(body, 'dareId', 60));
    if (!cat || ch.settings.disabled.includes(cat.id)) throw new ApiError(404, 'not_found', 'That dare is not on the menu.');
    if (activeCount(ch, auth.opaqueId) >= PER_VIEWER_ACTIVE) throw new ApiError(429, 'viewer_limit', 'You already have ' + PER_VIEWER_ACTIVE + ' dares waiting.');
    const name = await twitch.getDisplayName(auth.userId);
    const dare = { id: id(), kind: 'menu', title: cat.title, text: cat.objective, bits: 0, viewerId: auth.opaqueId, viewerName: name, status: 'approved', createdAt: now(), decidedAt: null, message: '' };
    ch.dares.push(dare);
    store.touch();
    return { dare: dareView(dare, auth), message: 'Sent! The streamer decides whether to do it.' };
  }

  async function receipt(auth, body) {
    limit('receipt:' + auth.channelId + ':' + auth.opaqueId, 20, 10 * 60 * 1000);
    const token = bodyString(body, 'receipt', 4096);
    const r = twitch.verifyBitsReceipt(token);
    if (auth.userId && r.userId !== auth.userId) throw new ApiError(400, 'invalid_receipt', 'That Bits receipt belongs to someone else.');
    const txs = store.tx();
    if (txs[r.transactionId]) {
      const prev = txs[r.transactionId];
      if (prev.channelId !== auth.channelId || prev.userId !== r.userId) throw new ApiError(409, 'receipt_used', 'That receipt was already used.');
      return { alreadyProcessed: true, message: 'Already received.' };
    }
    const ch = channelOf(auth);
    const dareProduct = findDareBySku(r.sku);
    const goalProduct = findGoalProduct(r.sku);
    if (!dareProduct && !goalProduct) throw new ApiError(400, 'unknown_product', 'That product is not part of ChallengeLive.');
    const expected = dareProduct ? dareProduct.bits : goalProduct.bits;
    if (r.bitsAmount !== null && r.bitsAmount !== expected) throw new ApiError(400, 'amount_mismatch', 'The Bits amount did not match.');
    const name = await twitch.getDisplayName(r.userId);

    if (dareProduct) {
      const dare = { id: id(), kind: 'paid', title: dareProduct.title, text: dareProduct.objective, bits: dareProduct.bits, sku: dareProduct.sku, viewerId: auth.opaqueId, viewerName: name, status: 'approved', createdAt: now(), decidedAt: null, message: '' };
      ch.dares.push(dare);
      txs[r.transactionId] = { at: now(), channelId: auth.channelId, userId: r.userId, ref: dare.id };
      store.touch();
      return { message: 'Sent! The streamer decides whether to do it.', dare: dareView(dare, auth) };
    }
    // community goal
    if (!ch.goal) {
      // Receipt is genuine but no goal is running (it ended). Record it so it is not lost; nothing to add to.
      txs[r.transactionId] = { at: now(), channelId: auth.channelId, userId: r.userId, ref: 'no-goal' };
      store.touch();
      return { message: 'Thanks! There is no goal running right now.' };
    }
    const g = ch.goal;
    g.current += goalProduct.bits;
    let reachedNow = false;
    while (g.current >= g.target) {
      g.current -= g.target;
      g.timesReached += 1;
      reachedNow = true;
      ch.dares.push({ id: id(), kind: 'goal', title: g.title, text: g.objective, bits: 0, viewerId: null, viewerName: 'Community goal', status: 'approved', createdAt: now(), decidedAt: null, message: '' });
    }
    txs[r.transactionId] = { at: now(), channelId: auth.channelId, userId: r.userId, ref: 'goal' };
    store.touch();
    return { message: reachedNow ? 'Goal reached! The dare was sent to the streamer.' : 'Thanks! Added to the goal.', goal: goalView(g) };
  }

  async function goalDemo(auth, body) {
    const ch = channelOf(auth);
    if (!ch.settings.freeMenuMode) throw new ApiError(403, 'closed', 'Test mode is off.');
    if (!ch.goal) throw new ApiError(404, 'no_goal', 'No goal is running.');
    if (!auth.loggedIn) throw new ApiError(403, 'identity_required', 'Please log in to Twitch.');
    limit('goaldemo:' + auth.channelId + ':' + auth.opaqueId, 30, 10 * 60 * 1000);
    const amount = Number(body && body.amount);
    if (![10, 50, 100].includes(amount)) throw new ApiError(400, 'bad_request', 'Invalid amount.');
    const g = ch.goal;
    g.current += amount;
    let reached = false;
    while (g.current >= g.target) {
      g.current -= g.target;
      g.timesReached += 1;
      reached = true;
      ch.dares.push({ id: id(), kind: 'goal', title: g.title, text: g.objective, bits: 0, viewerId: null, viewerName: 'Community goal', status: 'approved', createdAt: now(), decidedAt: null, message: '' });
    }
    store.touch();
    return { message: reached ? 'Goal reached! The dare was sent to the streamer.' : 'Added to the goal (test mode).', goal: goalView(g) };
  }

  async function vote(auth, body) {
    if (!auth.loggedIn) throw new ApiError(403, 'identity_required', 'Please log in to Twitch to vote.');
    limit('vote:' + auth.channelId + ':' + auth.opaqueId, 30, 60 * 1000);
    sweep();
    const ch = channelOf(auth);
    const p = ch.poll;
    if (!p || p.status !== 'open') throw new ApiError(409, 'no_poll', 'There is no vote running right now.');
    const opt = p.options.find((o) => o.id === bodyString(body, 'optionId', 80));
    if (!opt) throw new ApiError(404, 'not_found', 'That option does not exist.');
    const prev = p.voters[auth.opaqueId];
    if (prev === opt.id) return { message: 'Vote saved.', poll: pollView(p, auth) };
    if (prev) p.options.find((o) => o.id === prev).votes -= 1;
    opt.votes += 1;
    p.voters[auth.opaqueId] = opt.id;
    store.touch();
    return { message: 'Vote saved.', poll: pollView(p, auth) };
  }

  async function ask(auth, body) {
    if (!auth.loggedIn || !auth.userId) throw new ApiError(403, 'identity_required', 'Please share your Twitch identity to ask a question.');
    const ch = channelOf(auth);
    if (!ch.settings.qaOpen) throw new ApiError(403, 'closed', 'Questions are closed right now.');
    limit('ask:' + auth.channelId + ':' + auth.opaqueId, 3, 10 * 60 * 1000);
    const verdict = await moderate(bodyString(body, 'text', 1000), 'question');
    const name = await twitch.getDisplayName(auth.userId);
    const q = { id: id(), text: verdict.text, viewerId: auth.opaqueId, viewerName: name, status: verdict.status === 'approved' ? 'approved' : 'rejected', voters: [], createdAt: now(), message: verdict.message };
    ch.questions.push(q);
    store.touch();
    return { question: questionView(q, auth), message: verdict.status === 'approved' ? 'Question sent!' : verdict.message };
  }

  async function upvote(auth, body) {
    if (!auth.loggedIn) throw new ApiError(403, 'identity_required', 'Please log in to Twitch to vote.');
    limit('upvote:' + auth.channelId + ':' + auth.opaqueId, 60, 60 * 1000);
    const ch = channelOf(auth);
    const q = ch.questions.find((x) => x.id === bodyString(body, 'questionId', 80));
    if (!q || !['approved', 'shown'].includes(q.status)) throw new ApiError(404, 'not_found', 'Question not found.');
    const i = q.voters.indexOf(auth.opaqueId);
    if (i >= 0) q.voters.splice(i, 1);
    else q.voters.push(auth.opaqueId);
    store.touch();
    return { votes: q.voters.length, voted: i < 0 };
  }

  // ---------- streamer routes ----------
  async function streamerState(auth) {
    requireStreamer(auth);
    sweep();
    const ch = channelOf(auth);
    const byStatus = (s) => ch.dares.filter((d) => d.status === s).sort((a, b) => a.createdAt - b.createdAt).map((d) => dareView(d, auth));
    const history = ch.dares.filter((d) => ['completed', 'declined', 'skipped'].includes(d.status)).sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).slice(0, 10).map((d) => dareView(d, auth));
    const qs = (s) => ch.questions.filter((q) => q.status === s).sort((a, b) => b.voters.length - a.voters.length || a.createdAt - b.createdAt).map((q) => questionView(q, auth));
    return {
      role: auth.role,
      settings: settingsView(ch),
      catalog: CATALOG.map((d) => ({ ...publicView(d), disabled: ch.settings.disabled.includes(d.id) })),
      waiting: byStatus('approved'),
      accepted: byStatus('accepted'),
      history,
      poll: pollView(ch.poll, auth),
      lastPoll: !ch.poll ? pollView(ch.lastPoll, auth) : null,
      goal: goalView(ch.goal),
      questions: { shown: qs('shown'), waiting: qs('approved'), answered: qs('answered').slice(0, 5) },
      serverTime: now(),
    };
  }

  async function dareAction(auth, dareId, action) {
    requireStreamer(auth);
    limit('streamer:' + auth.channelId, 180, 60 * 1000);
    const rule = TRANSITIONS[action];
    if (!rule) throw new ApiError(404, 'not_found', 'Unknown action.');
    const ch = channelOf(auth);
    const d = ch.dares.find((x) => x.id === dareId);
    if (!d) throw new ApiError(404, 'not_found', 'Dare not found.');
    if (!rule.from.includes(d.status)) throw new ApiError(409, 'bad_state', 'That dare is already ' + d.status + '.');
    d.status = rule.to;
    d.decidedAt = now();
    if (action === 'complete') d.completedAt = now();
    store.touch();
    return { dare: dareView(d, auth) };
  }

  async function updateSettings(auth, body) {
    requireStreamer(auth);
    const ch = channelOf(auth);
    const s = ch.settings;
    if (!body || typeof body !== 'object') throw new ApiError(400, 'bad_request', 'Invalid settings.');
    for (const k of ['customDaresOpen', 'qaOpen', 'freeMenuMode']) {
      if (body[k] !== undefined) {
        if (typeof body[k] !== 'boolean') throw new ApiError(400, 'bad_request', 'Invalid ' + k + '.');
        s[k] = body[k];
      }
    }
    if (body.toggleDare !== undefined) {
      const cat = findById(String(body.toggleDare));
      if (!cat) throw new ApiError(404, 'not_found', 'Unknown dare.');
      s.disabled = s.disabled.includes(cat.id) ? s.disabled.filter((x) => x !== cat.id) : [...s.disabled, cat.id];
    }
    store.touch();
    return { settings: settingsView(ch) };
  }

  async function startPoll(auth, body) {
    requireStreamer(auth);
    const ch = channelOf(auth);
    sweep();
    if (ch.poll) throw new ApiError(409, 'poll_open', 'A vote is already running. Close it first.');
    const ids = body && Array.isArray(body.options) ? body.options : null;
    const duration = Number(body && body.durationSec);
    if (!ids || ids.length < 2 || ids.length > 4) throw new ApiError(400, 'bad_request', 'Pick 2 to 4 options.');
    if (!Number.isInteger(duration) || duration < POLL_MIN || duration > POLL_MAX) throw new ApiError(400, 'bad_request', 'Choose a time from ' + POLL_MIN + ' to ' + POLL_MAX + ' seconds.');
    const options = [];
    const seen = new Set();
    for (const raw of ids) {
      const ref = String(raw);
      if (seen.has(ref)) throw new ApiError(400, 'bad_request', 'Options must be different.');
      seen.add(ref);
      if (ref.startsWith('cat:')) {
        const cat = findById(ref.slice(4));
        if (!cat) throw new ApiError(400, 'bad_request', 'Unknown dare.');
        options.push({ id: id(), source: 'catalog', catalogId: cat.id, title: cat.title, text: cat.objective, votes: 0 });
      } else if (ref.startsWith('dare:')) {
        const d = ch.dares.find((x) => x.id === ref.slice(5) && x.status === 'approved');
        if (!d) throw new ApiError(400, 'bad_request', 'That dare is no longer waiting.');
        options.push({ id: id(), source: 'dare', dareId: d.id, title: d.title === 'Viewer dare' ? 'Dare from ' + d.viewerName : d.title, text: d.text, votes: 0 });
      } else {
        throw new ApiError(400, 'bad_request', 'Unknown option.');
      }
    }
    ch.poll = { id: id(), status: 'open', options, voters: {}, startedAt: now(), closesAt: now() + duration * 1000 };
    store.touch();
    return { poll: pollView(ch.poll, auth) };
  }

  async function endPoll(auth) {
    requireStreamer(auth);
    const ch = channelOf(auth);
    if (!ch.poll) throw new ApiError(409, 'no_poll', 'No vote is running.');
    closePoll(ch, 'streamer');
    return { lastPoll: pollView(ch.lastPoll, auth) };
  }

  async function setGoal(auth, body) {
    requireStreamer(auth);
    const ch = channelOf(auth);
    if (body && body.clear === true) {
      ch.goal = null;
      store.touch();
      return { goal: null };
    }
    const cat = findById(String(body && body.dareId));
    const target = Number(body && body.target);
    if (!cat) throw new ApiError(400, 'bad_request', 'Pick a dare from the menu.');
    if (!Number.isInteger(target) || target < 50 || target > 5000) throw new ApiError(400, 'bad_request', 'The goal must be between 50 and 5000 Bits.');
    ch.goal = { dareId: cat.id, title: cat.title, objective: cat.objective, target, current: 0, timesReached: 0 };
    store.touch();
    return { goal: goalView(ch.goal) };
  }

  async function questionAction(auth, questionId, action) {
    requireStreamer(auth);
    const ch = channelOf(auth);
    const q = ch.questions.find((x) => x.id === questionId);
    if (!q) throw new ApiError(404, 'not_found', 'Question not found.');
    if (action === 'show') {
      if (!['approved', 'hidden'].includes(q.status)) throw new ApiError(409, 'bad_state', 'Cannot show that question.');
      for (const o of ch.questions) if (o.status === 'shown') o.status = 'approved';
      q.status = 'shown';
    } else if (action === 'answered') {
      if (!['shown', 'approved'].includes(q.status)) throw new ApiError(409, 'bad_state', 'Cannot mark that question.');
      q.status = 'answered';
    } else if (action === 'hide') {
      if (!['approved', 'shown'].includes(q.status)) throw new ApiError(409, 'bad_state', 'Cannot hide that question.');
      q.status = 'hidden';
    } else {
      throw new ApiError(404, 'not_found', 'Unknown action.');
    }
    store.touch();
    return { ok: true };
  }

  // ---------- routing ----------
  const routes = [];
  const add = (method, pattern, role, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), role, handler });

  add('GET', '/api/state', 'any', (a) => viewerState(a));
  add('POST', '/api/dare/custom', 'any', (a, b) => submitCustom(a, b));
  add('POST', '/api/dare/menu', 'any', (a, b) => submitMenuFree(a, b));
  add('POST', '/api/bits/receipt', 'any', (a, b) => receipt(a, b));
  add('POST', '/api/goal/demo', 'any', (a, b) => goalDemo(a, b));
  add('POST', '/api/vote', 'any', (a, b) => vote(a, b));
  add('POST', '/api/question', 'any', (a, b) => ask(a, b));
  add('POST', '/api/question/upvote', 'any', (a, b) => upvote(a, b));
  add('GET', '/api/streamer/state', 'streamer', (a) => streamerState(a));
  add('POST', '/api/streamer/dare/:id/:action', 'streamer', (a, b, p) => dareAction(a, p.id, p.action));
  add('POST', '/api/streamer/settings', 'streamer', (a, b) => updateSettings(a, b));
  add('POST', '/api/streamer/poll', 'streamer', (a, b) => startPoll(a, b));
  add('POST', '/api/streamer/poll/close', 'streamer', (a) => endPoll(a));
  add('POST', '/api/streamer/goal', 'streamer', (a, b) => setGoal(a, b));
  add('POST', '/api/streamer/question/:id/:action', 'streamer', (a, b, p) => questionAction(a, p.id, p.action));

  // ---------- http plumbing ----------
  function clientIp(req) {
    const fwd = config.trustProxy && req.headers['x-forwarded-for'];
    return (fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
  }

  function allowedOrigin(origin) {
    if (!origin) return null;
    if (config.devHarness) return origin;
    if (config.clientId && origin === 'https://' + config.clientId + '.ext-twitch.tv') return origin;
    if (config.allowedOrigins.includes(origin)) return origin;
    return null;
  }

  function send(res, status, obj, extra) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(extra || {}) });
    res.end(body);
  }

  function readJson(req, max) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers['content-type'] || '');
      if (!type.toLowerCase().startsWith('application/json')) return reject(new ApiError(415, 'bad_content_type', 'Send JSON.'));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          if (size - c.length <= max) reject(new ApiError(413, 'too_large', 'That request is too large.', { connection: 'close' }));
          return; // throw the rest away
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          resolve(v && typeof v === 'object' ? v : {});
        } catch (e) {
          reject(new ApiError(400, 'bad_json', 'That was not valid JSON.'));
        }
      });
      req.on('error', () => reject(new ApiError(400, 'bad_request', 'Request failed.')));
    });
  }

  function serveFile(res, file, transform) {
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'not_found', message: 'Not found.' });
      const out = transform ? transform(data) : data;
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': 'frame-ancestors https://www.twitch.tv https://dashboard.twitch.tv https://supervisor.ext-twitch.tv https://*.ext-twitch.tv' });
      res.end(out);
    });
  }

  function apiBaseForZip(req) {
    if (config.publicUrl) return config.publicUrl;
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return proto + '://' + host;
  }

  function extensionFiles(apiBase) {
    const names = ['viewer.html', 'component.html', 'mobile.html', 'live_config.html', 'config.html', 'app.js', 'styles.css'];
    const files = names.map((n) => ({ name: n, data: fs.readFileSync(path.join(EXT_DIR, n)) }));
    files.push({ name: 'settings.js', data: Buffer.from('window.CL_SETTINGS = ' + JSON.stringify({ apiBase }) + ';\n') });
    return files;
  }

  function devToken(url) {
    const q = url.searchParams;
    const user = (q.get('user') || '1001').replace(/\D/g, '').slice(0, 12) || '1001';
    const role = ['viewer', 'broadcaster', 'moderator'].includes(q.get('role')) ? q.get('role') : 'viewer';
    const channel = (q.get('channel') || '9999').replace(/\D/g, '').slice(0, 12) || '9999';
    const anon = q.get('anon') === '1';
    const linked = q.get('linked') !== '0';
    const payload = { exp: Math.floor(now() / 1000) + 3600, channel_id: channel, opaque_user_id: (anon ? 'A' : 'U') + user, role };
    if (!anon && linked) payload.user_id = user;
    return signHs256(payload, config.secretKeys[0]);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    const allow = allowedOrigin(origin);
    const cors = allow ? { 'access-control-allow-origin': allow, vary: 'Origin' } : { vary: 'Origin' };

    try {
      if (req.method === 'OPTIONS') {
        if (!allow) return send(res, 403, { error: 'origin_not_allowed', message: 'Origin not allowed.' });
        res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' });
        return res.end();
      }

      if (url.pathname === '/health') return send(res, 200, { ok: true, secretBytes: config.secretKeys[0].length, secrets: config.secretKeys.length });
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('ChallengeLive server is running.\n' + (config.devHarness ? 'Test mode is ON: open /dev/\n' : '') + 'Hosted Test zip: /extension.zip\n');
      }

      if (req.method === 'GET' && url.pathname === '/extension.zip') {
        const zip = makeZip(extensionFiles(apiBaseForZip(req)));
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="challengelive-hosted-test.zip"', 'cache-control': 'no-store' });
        return res.end(zip);
      }

      if (req.method === 'GET' && url.pathname.startsWith('/extension/')) {
        const name = path.basename(url.pathname);
        if (!['viewer.html', 'component.html', 'mobile.html', 'live_config.html', 'config.html', 'app.js', 'styles.css', 'settings.js'].includes(name)) return send(res, 404, { error: 'not_found', message: 'Not found.' });
        if (name === 'settings.js') {
          res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
          return res.end('window.CL_SETTINGS = ' + JSON.stringify({ apiBase: '' }) + ';\n');
        }
        return serveFile(res, path.join(EXT_DIR, name));
      }

      if (config.devHarness && url.pathname.startsWith('/dev')) {
        if (url.pathname === '/dev/token') return send(res, 200, { token: devToken(url) });
        if (url.pathname === '/dev/receipt') {
          const sku = url.searchParams.get('sku') || '';
          const user = (url.searchParams.get('user') || '1001').replace(/\D/g, '');
          const dare = findDareBySku(sku);
          const goal = findGoalProduct(sku);
          const amount = dare ? dare.bits : goal ? goal.bits : 1;
          const payload = { topic: 'bits_transaction_receipt', exp: Math.floor(now() / 1000) + 3600, data: { transactionId: 'dev-' + crypto.randomUUID(), time: new Date(now()).toISOString(), userId: user, product: { sku, displayName: sku, cost: { amount, type: 'bits' }, inDevelopment: true } } };
          return send(res, 200, { transactionReceipt: signHs256(payload, config.secretKeys[0]) });
        }
        if (url.pathname === '/dev/twitch-ext.js') return serveFile(res, path.join(DEV_DIR, 'twitch-ext.js'));
        if (url.pathname === '/dev/' || url.pathname === '/dev') return serveFile(res, path.join(DEV_DIR, 'index.html'));
        const m = url.pathname.match(/^\/dev\/(viewer|component|mobile|live_config|config)\.html$/);
        if (m) {
          return serveFile(res, path.join(EXT_DIR, m[1] + '.html'), (data) =>
            Buffer.from(
              String(data)
                .replace(/https:\/\/extension-files\.twitch\.tv\/helper\/v1\/twitch-ext\.min\.js/, '/dev/twitch-ext.js')
                .replace(/(href|src)="(styles\.css|settings\.js|app\.js)"/g, '$1="/extension/$2"')
            )
          );
        }
        return send(res, 404, { error: 'not_found', message: 'Not found.' });
      }

      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not_found', message: 'Not found.' }, cors);

      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) return send(res, 404, { error: 'not_found', message: 'Not found.' }, cors);

      limit('ip:' + clientIp(req), 300, 60 * 1000);
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) throw new ApiError(401, 'missing_token', 'Please open ChallengeLive from Twitch.');
      let auth;
      try {
        auth = twitch.verifyClientToken(header.slice(7).trim());
      } catch (err) {
        limit('badtoken:' + clientIp(req), 30, 60 * 1000);
        throw err;
      }
      if (route.role === 'streamer' && !isStreamer(auth)) throw new ApiError(403, 'forbidden', 'Only the channel owner can do that.');
      if (route.method === 'GET') limit('read:' + auth.channelId + ':' + auth.opaqueId, 120, 60 * 1000);

      const params = url.pathname.match(route.re).groups || {};
      const body = req.method === 'POST' ? await readJson(req, 4096) : {};
      const result = await route.handler(auth, body, params);
      return send(res, 200, result, cors);
    } catch (err) {
      if (err instanceof ApiError) return send(res, err.status, { error: err.code, message: err.message }, { ...cors, ...err.headers });
      // eslint-disable-next-line no-console
      console.error('[server] unexpected error:', err && err.stack ? err.stack : err);
      return send(res, 500, { error: 'server_error', message: 'Something went wrong on our side.' }, cors);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  return { server, handle, sweep, close: () => { clearInterval(sweeper); clearInterval(pruner); } };
}

module.exports = { createApp, TRANSITIONS };
