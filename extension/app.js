/* ChallengeLive screens: the viewer panel and the streamer Live Dashboard.
   No inline scripts, no libraries. Text from viewers is always shown as plain text. */
(function () {
  'use strict';

  var view = document.body.getAttribute('data-view');
  var root = document.getElementById('app');
  var ext = window.Twitch && window.Twitch.ext;
  var API = (window.CL_SETTINGS && window.CL_SETTINGS.apiBase) || '';
  if (view === 'config' || !ext || !root) return;

  var auth = null;
  var state = null;
  var lastJson = '';
  var tab = view === 'live' ? 'queue' : 'dares';
  var notice = null; // { kind, text }
  var drafts = { dare: '', question: '', goalTarget: '200', goalDare: '', pollDuration: '60' };
  var pollPick = {};
  var busy = false;
  var failures = 0;
  var timer = null;
  var bitsEnabled = false;
  var linked = false;

  // ---------- tiny helpers ----------
  function h(tag, props) {
    var el = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === false || v === null || v === undefined) return;
      if (k === 'class') el.className = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i += 1) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }

  function api(method, path, body) {
    if (!auth) return Promise.reject(new Error('Not ready yet.'));
    return fetch(API + path, {
      method: method,
      headers: Object.assign({ authorization: 'Bearer ' + auth.token }, body !== undefined ? { 'content-type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var err = new Error(json.message || 'Something went wrong. Please try again.');
          err.code = json.error;
          throw err;
        }
        return json;
      });
    });
  }

  function say(kind, text) { notice = { kind: kind, text: text }; render(true); }

  function act(fn) {
    if (busy) return;
    busy = true;
    notice = null;
    render(true);
    Promise.resolve().then(fn).then(function (res) {
      if (res && res.message) {
        var refused = (res.dare && res.dare.status === 'rejected') || (res.question && res.question.status === 'rejected');
        notice = { kind: refused ? 'bad' : 'ok', text: res.message };
      }
    }).catch(function (err) {
      notice = { kind: 'bad', text: err.message };
    }).then(function () {
      busy = false;
      return refresh();
    });
  }

  // ---------- data loading ----------
  function refresh() {
    if (!auth) return Promise.resolve();
    var path = view === 'live' ? '/api/streamer/state' : '/api/state';
    return api('GET', path).then(function (s) {
      failures = 0;
      state = s;
      render(true);
    }).catch(function (err) {
      failures += 1;
      if (!state) { notice = { kind: 'bad', text: err.message }; render(true); }
    });
  }

  function schedule() {
    clearTimeout(timer);
    var base = view === 'live' ? 3000 : 6000;
    var wait = base * Math.min(4, 1 + failures) + Math.floor(Math.random() * 800);
    timer = setTimeout(function () {
      if (document.hidden) { schedule(); return; }
      refresh().then(schedule);
    }, wait);
  }

  // ---------- small UI pieces ----------
  function remember(el, key) {
    el.setAttribute('data-key', key);
    el.addEventListener('input', function () { drafts[key] = el.value; });
    return el;
  }
  function when(ms) {
    var s = Math.max(0, Math.round((ms - Date.now()) / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function statusTag(d) {
    var map = { pending: ['Checking...', ''], approved: ['Waiting for the streamer', 'warn'], accepted: ['Streamer said yes!', 'ok'], declined: ['Streamer passed', 'bad'], skipped: ['Skipped', ''], completed: ['Done!', 'ok'], rejected: ['Not approved', 'bad'] };
    var m = map[d.status] || [d.status, ''];
    return h('span', { class: 'tag ' + m[1] }, m[0]);
  }
  function bar(value, max) {
    var pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
    var span = h('span', {});
    span.style.width = pct + '%';
    return h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': value, 'aria-valuemax': max }, span);
  }
  function noticeBox() {
    return notice ? h('div', { class: 'notice ' + notice.kind, role: 'status' }, notice.text) : null;
  }
  function tabs(list) {
    return h('div', { class: 'tabs', role: 'tablist' }, list.map(function (t) {
      return h('button', { class: 'tab', role: 'tab', 'aria-selected': tab === t.id ? 'true' : 'false', onclick: function () { tab = t.id; notice = null; render(true); } }, t.label, t.dot ? h('span', { class: 'dot' }) : null);
    }));
  }

  // ---------- viewer screens ----------
  function idBlock() {
    if (!state.loggedIn) return h('div', { class: 'notice' }, 'Log in to Twitch to take part.');
    if (!linked || !state.linked) {
      return h('div', { class: 'notice' }, h('p', {}, 'To send dares or questions, share your Twitch name with this extension.'),
        h('button', { class: 'btn small', onclick: function () { ext.actions.requestIdShare(); } }, 'Share my Twitch name'));
    }
    return null;
  }

  function bitsButton(sku, bits, label) {
    return h('button', { class: 'btn small', disabled: busy, onclick: function () {
      notice = null;
      try { ext.bits.useBits(sku); } catch (e) { say('bad', 'Bits are not available right now.'); }
    } }, label || ('Use ' + bits + ' Bits'));
  }

  function viewerDares() {
    var s = state.settings;
    var out = [];
    out.push(idBlock());
    if (s.customDaresOpen) {
      out.push(h('div', { class: 'card' },
        h('h3', {}, 'Write your own dare (free)'),
        h('p', { class: 'muted small' }, 'Make it specific, with a number or time. Only things the streamer can do alone. An AI safety check runs first.'),
        remember(h('textarea', { maxlength: '300', placeholder: 'Example: Do 20 push-ups in 60 seconds', value: drafts.dare }), 'dare'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: busy || !state.linked, onclick: function () {
          var text = drafts.dare;
          act(function () { return api('POST', '/api/dare/custom', { text: text }).then(function (r) { if (r.dare && r.dare.status === 'approved') drafts.dare = ''; return r; }); });
        } }, 'Send dare'))));
    } else {
      out.push(h('div', { class: 'notice' }, 'Custom dares are paused. Pick from the menu below.'));
    }
    out.push(h('h2', {}, 'Dare menu'));
    if (!bitsEnabled && !s.freeMenuMode) out.push(h('p', { class: 'muted small' }, 'Bits are not available on this channel right now, so menu dares are view-only.'));
    if (s.freeMenuMode) out.push(h('p', { class: 'muted small' }, 'Test mode is on: menu dares are free right now.'));
    state.menu.forEach(function (d) {
      var action = null;
      if (s.freeMenuMode) action = h('button', { class: 'btn small', disabled: busy || !state.loggedIn, onclick: function () { act(function () { return api('POST', '/api/dare/menu', { dareId: d.id }); }); } }, 'Send for free');
      else if (bitsEnabled) action = bitsButton(d.sku, d.bits);
      out.push(h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h3', {}, d.title), h('span', { class: 'tag' }, d.difficulty + (d.bits ? ' · ' + d.bits + ' Bits' : ''))),
        h('p', {}, d.objective),
        h('p', { class: 'muted small' }, 'Rules: ' + d.rules.join(' ') + ' Safety: ' + d.safety),
        action ? h('div', { class: 'actions' }, action) : null));
    });
    var board = state.board;
    out.push(h('h2', {}, 'In the queue (' + board.length + ')'));
    if (!board.length) out.push(h('p', { class: 'muted' }, 'Nothing yet. Be the first!'));
    board.slice(0, 10).forEach(function (d) {
      out.push(h('div', { class: 'card' + (d.status === 'accepted' ? ' now' : '') }, h('div', { class: 'row' }, h('strong', {}, d.title === 'Viewer dare' ? d.text : d.title), statusTag(d)), h('div', { class: 'who' }, 'from ' + d.viewerName + (d.chatPick ? ' · chat pick' : ''))));
    });
    return out;
  }

  function pollBlock(poll, canVote) {
    var out = [];
    var total = poll.totalVotes || 0;
    poll.options.forEach(function (o) {
      var mine = poll.myChoice === o.id;
      var isWin = poll.status === 'closed' && poll.winnerId === o.id;
      var content = [h('div', { class: 'row' }, h('strong', {}, o.title), h('span', { class: 'tag ' + (isWin ? 'ok' : '') }, o.votes + (o.votes === 1 ? ' vote' : ' votes') + (isWin ? ' · winner' : ''))), h('div', { class: 'small muted' }, o.text), bar(o.votes, Math.max(total, 1))];
      if (canVote) out.push(h('button', { class: 'opt' + (mine ? ' mine' : ''), disabled: busy || !state.loggedIn, 'aria-pressed': mine ? 'true' : 'false', onclick: function () { act(function () { return api('POST', '/api/vote', { optionId: o.id }); }); } }, content));
      else out.push(h('div', { class: 'opt' + (isWin ? ' mine' : '') }, content));
    });
    return out;
  }

  function viewerVote() {
    var out = [];
    if (state.poll) {
      out.push(h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Vote on the next dare'), h('span', { class: 'tag ok' }, 'Closes in ' + when(state.poll.closesAt))), h('p', { class: 'muted small' }, 'Free to vote. One vote each; you can change it until the vote closes.')));
      if (!state.loggedIn) out.push(h('div', { class: 'notice' }, 'Log in to Twitch to vote.'));
      out = out.concat(pollBlock(state.poll, true));
    } else if (state.lastPoll) {
      out.push(h('h2', {}, 'Last vote'));
      out = out.concat(pollBlock(state.lastPoll, false));
    } else {
      out.push(h('p', { class: 'muted pad' }, 'No vote is running. When the streamer starts one, it will show up here.'));
    }
    return out;
  }

  function viewerGoal() {
    var g = state.goal;
    if (!g) return [h('p', { class: 'muted pad' }, 'No community goal right now.')];
    var out = [h('div', { class: 'card' },
      h('h3', {}, 'Community goal: ' + g.title),
      h('p', {}, g.objective),
      bar(g.current, g.target),
      h('p', { class: 'small muted' }, g.current + ' of ' + g.target + ' Bits' + (g.timesReached ? ' · reached ' + g.timesReached + (g.timesReached === 1 ? ' time' : ' times') : '')),
      h('p', { class: 'small muted' }, 'When the goal is full, the dare is sent to the streamer, who decides whether to do it.'))];
    if (state.settings.freeMenuMode) {
      out.push(h('p', { class: 'muted small' }, 'Test mode is on: add to the goal for free.'));
      out.push(h('div', { class: 'actions' }, [10, 50, 100].map(function (n) { return h('button', { class: 'btn small', disabled: busy || !state.loggedIn, onclick: function () { act(function () { return api('POST', '/api/goal/demo', { amount: n }); }); } }, 'Add ' + n); })));
    } else if (bitsEnabled) {
      out.push(h('div', { class: 'actions' }, state.goalProducts.map(function (p) { return bitsButton(p.sku, p.bits, 'Give ' + p.bits + ' Bits'); })));
    } else {
      out.push(h('p', { class: 'muted small' }, 'Bits are not available on this channel right now.'));
    }
    return out;
  }

  function viewerQA() {
    var out = [idBlock()];
    if (state.settings.qaOpen) {
      out.push(h('div', { class: 'card' }, h('h3', {}, 'Ask the streamer (free)'),
        remember(h('textarea', { maxlength: '200', placeholder: 'Your question', value: drafts.question }), 'question'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: busy || !state.linked, onclick: function () {
          var text = drafts.question;
          act(function () { return api('POST', '/api/question', { text: text }).then(function (r) { if (r.question && r.question.status === 'approved') drafts.question = ''; return r; }); });
        } }, 'Send question'))));
    } else out.push(h('div', { class: 'notice' }, 'Questions are closed right now.'));
    if (!state.questions.length) out.push(h('p', { class: 'muted' }, 'No questions yet.'));
    state.questions.forEach(function (q) {
      var canVote = q.status === 'approved' || q.status === 'shown';
      out.push(h('div', { class: 'card' + (q.status === 'shown' ? ' now' : '') },
        h('div', { class: 'row' }, h('span', { class: 'tag ' + (q.status === 'shown' ? 'ok' : q.status === 'rejected' ? 'bad' : '') }, q.status === 'shown' ? 'Answering now' : q.status === 'answered' ? 'Answered' : q.status === 'rejected' ? 'Not approved' : 'Waiting'), canVote ? h('button', { class: 'btn small ' + (q.voted ? '' : 'ghost'), disabled: busy || !state.loggedIn, onclick: function () { act(function () { return api('POST', '/api/question/upvote', { questionId: q.id }); }); } }, (q.voted ? 'Liked · ' : 'Like · ') + q.votes) : null),
        h('p', {}, q.text), h('div', { class: 'who' }, 'from ' + q.viewerName), q.message ? h('p', { class: 'small', style: 'color:#ff9aa2' }, q.message) : null));
    });
    return out;
  }

  function viewerMine() {
    var out = [];
    if (!state.mine.length) out.push(h('p', { class: 'muted pad' }, 'Your dares will show up here.'));
    state.mine.forEach(function (d) {
      out.push(h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, d.title === 'Viewer dare' ? 'Your dare' : d.title), statusTag(d)), h('p', {}, d.text), d.status === 'rejected' && d.message ? h('p', { class: 'small', style: 'color:#ff9aa2' }, d.message) : null));
    });
    return out;
  }

  function renderViewer() {
    var list = [{ id: 'dares', label: 'Dares' }, { id: 'vote', label: 'Vote', dot: !!state.poll }, { id: 'goal', label: 'Goal' }, { id: 'qa', label: 'Q&A' }, { id: 'mine', label: 'Mine' }];
    var body = { dares: viewerDares, vote: viewerVote, goal: viewerGoal, qa: viewerQA, mine: viewerMine }[tab]();
    return [h('div', { class: 'top' }, h('span', { class: 'brand' }, 'ChallengeLive'), h('span', { class: 'tag' }, 'Live Dares')), tabs(list), h('div', { class: 'panel' }, noticeBox(), body)];
  }

  // ---------- streamer screens ----------
  function dareCard(d, buttons) {
    return h('div', { class: 'card' + (d.status === 'accepted' ? ' now' : '') },
      h('div', { class: 'row' }, h('strong', {}, d.title === 'Viewer dare' ? 'Viewer dare' : d.title), h('span', { class: 'tag ' + (d.bits ? 'pick' : '') }, d.kind === 'paid' ? d.bits + ' Bits' : d.kind === 'custom' ? 'Free' : d.kind === 'vote' ? 'Chat vote' : d.kind === 'goal' ? 'Goal' : 'Test')),
      h('p', {}, d.text),
      h('div', { class: 'who' }, 'from ' + d.viewerName + (d.chatPick ? ' · chat pick' : '')),
      buttons ? h('div', { class: 'actions' }, buttons) : null);
  }
  function dareBtn(d, action, label, cls) {
    return h('button', { class: 'btn small ' + (cls || ''), disabled: busy, onclick: function () { act(function () { return api('POST', '/api/streamer/dare/' + d.id + '/' + action, {}); }); } }, label);
  }

  function streamerQueue() {
    var out = [];
    out.push(h('h2', {}, 'Doing now'));
    if (!state.accepted.length) out.push(h('p', { class: 'muted' }, 'Nothing accepted yet.'));
    state.accepted.forEach(function (d) { out.push(dareCard(d, [dareBtn(d, 'complete', 'Completed', 'good'), dareBtn(d, 'skip', 'Skip', 'ghost'), dareBtn(d, 'decline', 'Decline', 'danger')])); });
    out.push(h('h2', {}, 'Waiting (' + state.waiting.length + ')'));
    if (!state.waiting.length) out.push(h('p', { class: 'muted' }, 'No dares waiting. Viewers can send dares from the panel.'));
    state.waiting.forEach(function (d) { out.push(dareCard(d, [dareBtn(d, 'accept', 'Accept', 'good'), dareBtn(d, 'skip', 'Skip', 'ghost'), dareBtn(d, 'decline', 'Decline', 'danger')])); });
    if (state.history.length) {
      out.push(h('h2', {}, 'Recent'));
      state.history.forEach(function (d) { out.push(h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', {}, d.title === 'Viewer dare' ? d.text : d.title), statusTag(d)))); });
    }
    return out;
  }

  function streamerVote() {
    var out = [];
    if (state.poll) {
      out.push(h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Vote running'), h('span', { class: 'tag ok' }, 'Closes in ' + when(state.poll.closesAt))), h('p', { class: 'muted small' }, state.poll.totalVotes + ' votes so far')));
      out = out.concat(pollBlock(state.poll, false));
      out.push(h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: busy, onclick: function () { act(function () { return api('POST', '/api/streamer/poll/close', {}).then(function () { return { message: 'Vote closed. The winner was added to your Waiting list.' }; }); }); } }, 'Close vote now')));
      return out;
    }
    if (state.lastPoll) { out.push(h('h2', {}, 'Last vote')); out = out.concat(pollBlock(state.lastPoll, false)); }
    out.push(h('h2', {}, 'Start a vote'));
    out.push(h('p', { class: 'muted small' }, 'Pick 2 to 4 dares. Viewers vote for free. The winner goes into your Waiting list.'));
    var picked = Object.keys(pollPick).filter(function (k) { return pollPick[k]; });
    var choices = [];
    state.waiting.filter(function (d) { return d.kind === 'custom'; }).forEach(function (d) { choices.push({ ref: 'dare:' + d.id, label: 'Viewer dare: ' + d.text }); });
    state.catalog.filter(function (d) { return !d.disabled; }).forEach(function (d) { choices.push({ ref: 'cat:' + d.id, label: d.title }); });
    choices.forEach(function (c) {
      out.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!pollPick[c.ref], onchange: function (e) { pollPick[c.ref] = e.target.checked; render(true); } }), c.label));
    });
    out.push(h('label', { class: 'small muted' }, 'How long'), (function () {
      var sel = h('select', { 'data-key': 'pollDuration', onchange: function (e) { drafts.pollDuration = e.target.value; } }, [['30', '30 seconds'], ['60', '1 minute'], ['120', '2 minutes'], ['300', '5 minutes']].map(function (o) { return h('option', { value: o[0], selected: drafts.pollDuration === o[0] }, o[1]); }));
      sel.value = drafts.pollDuration;
      return sel;
    })());
    out.push(h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: busy || picked.length < 2 || picked.length > 4, onclick: function () {
      act(function () { return api('POST', '/api/streamer/poll', { options: picked, durationSec: Number(drafts.pollDuration) }).then(function () { pollPick = {}; return { message: 'Vote started!' }; }); });
    } }, 'Start vote (' + picked.length + ' picked)')));
    return out;
  }

  function streamerGoal() {
    var out = [];
    var g = state.goal;
    if (g) {
      out.push(h('div', { class: 'card' }, h('h3', {}, g.title), h('p', {}, g.objective), bar(g.current, g.target), h('p', { class: 'small muted' }, g.current + ' of ' + g.target + ' Bits · reached ' + g.timesReached + ' times'),
        h('div', { class: 'actions' }, h('button', { class: 'btn danger small', disabled: busy, onclick: function () { act(function () { return api('POST', '/api/streamer/goal', { clear: true }).then(function () { return { message: 'Goal ended.' }; }); }); } }, 'End goal'))));
    }
    out.push(h('h2', {}, g ? 'Start a new goal' : 'Set a goal'));
    out.push(h('p', { class: 'muted small' }, 'Viewers give Bits together. When it is full, the dare you chose is sent to your Waiting list, and you decide whether to do it.'));
    var sel = h('select', { 'data-key': 'goalDare', onchange: function (e) { drafts.goalDare = e.target.value; } }, state.catalog.filter(function (d) { return !d.disabled; }).map(function (d) { return h('option', { value: d.id }, d.title); }));
    sel.value = drafts.goalDare || (state.catalog[0] && state.catalog[0].id) || '';
    if (!drafts.goalDare && sel.value) drafts.goalDare = sel.value;
    out.push(sel);
    out.push(h('label', { class: 'small muted' }, 'Goal size in Bits (50 to 5000)'));
    out.push(remember(h('input', { type: 'number', min: '50', max: '5000', step: '10', value: drafts.goalTarget }), 'goalTarget'));
    out.push(h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: busy, onclick: function () {
      act(function () { return api('POST', '/api/streamer/goal', { dareId: drafts.goalDare, target: Number(drafts.goalTarget) }).then(function () { return { message: 'Goal started!' }; }); });
    } }, 'Start goal')));
    return out;
  }

  function streamerQA() {
    var out = [];
    var qs = state.questions;
    function qCard(q, buttons) {
      return h('div', { class: 'card' + (q.status === 'shown' ? ' now' : '') }, h('div', { class: 'row' }, h('span', { class: 'who' }, 'from ' + q.viewerName), h('span', { class: 'tag' }, q.votes + ' likes')), h('p', {}, q.text), h('div', { class: 'actions' }, buttons));
    }
    function qBtn(q, action, label, cls) {
      return h('button', { class: 'btn small ' + (cls || ''), disabled: busy, onclick: function () { act(function () { return api('POST', '/api/streamer/question/' + q.id + '/' + action, {}); }); } }, label);
    }
    out.push(h('h2', {}, 'Answering now'));
    if (!qs.shown.length) out.push(h('p', { class: 'muted' }, 'No question picked.'));
    qs.shown.forEach(function (q) { out.push(qCard(q, [qBtn(q, 'answered', 'Answered', 'good'), qBtn(q, 'hide', 'Hide', 'ghost')])); });
    out.push(h('h2', {}, 'Questions (' + qs.waiting.length + ')'));
    if (!qs.waiting.length) out.push(h('p', { class: 'muted' }, 'No questions waiting.'));
    qs.waiting.forEach(function (q) { out.push(qCard(q, [qBtn(q, 'show', 'Pick this one', ''), qBtn(q, 'answered', 'Answered', 'ghost'), qBtn(q, 'hide', 'Hide', 'danger')])); });
    return out;
  }

  function streamerSettings() {
    var s = state.settings;
    function toggle(key, label) {
      return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s[key], disabled: busy, onchange: function (e) { var o = {}; o[key] = e.target.checked; act(function () { return api('POST', '/api/streamer/settings', o); }); } }), label);
    }
    var out = [h('div', { class: 'card' }, toggle('customDaresOpen', 'Viewers can write their own dares'), toggle('qaOpen', 'Viewers can ask questions'), toggle('freeMenuMode', 'Test mode: menu dares and goal are free (no Bits)'),
      h('p', { class: 'muted small' }, 'Use test mode to try everything on a channel that cannot receive Bits yet. Turn it off before real use.'))];
    out.push(h('h2', {}, 'Dare menu'));
    out.push(h('p', { class: 'muted small' }, 'Untick any dare you do not want on the menu.'));
    state.catalog.forEach(function (d) {
      out.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !d.disabled, disabled: busy, onchange: function () { act(function () { return api('POST', '/api/streamer/settings', { toggleDare: d.id }); }); } }), d.title + ' (' + d.bits + ' Bits)'));
    });
    return out;
  }

  function renderStreamer() {
    if (state.role !== 'broadcaster') return [h('div', { class: 'pad' }, 'Only the channel owner can use this dashboard.')];
    var list = [{ id: 'queue', label: 'Dares' + (state.waiting.length ? ' (' + state.waiting.length + ')' : '') }, { id: 'vote', label: 'Vote', dot: !!state.poll }, { id: 'goal', label: 'Goal' }, { id: 'qa', label: 'Q&A' + (state.questions.waiting.length ? ' (' + state.questions.waiting.length + ')' : '') }, { id: 'settings', label: 'Settings' }];
    var body = { queue: streamerQueue, vote: streamerVote, goal: streamerGoal, qa: streamerQA, settings: streamerSettings }[tab]();
    return [h('div', { class: 'top' }, h('span', { class: 'brand' }, 'ChallengeLive'), h('span', { class: 'tag ok' }, 'You decide everything')), tabs(list), h('div', { class: 'panel' }, noticeBox(), body)];
  }

  // ---------- render ----------
  function render(force) {
    if (!state) {
      root.replaceChildren(h('div', { class: 'pad' }, noticeBox() || h('p', { class: 'muted' }, 'Loading ChallengeLive...')));
      return;
    }
    var snapshot = JSON.stringify([state, tab, notice, busy, bitsEnabled, linked, Object.keys(pollPick).filter(function (k) { return pollPick[k]; })]);
    if (!force && snapshot === lastJson) return;
    var active = document.activeElement;
    var key = active && active.getAttribute ? active.getAttribute('data-key') : null;
    var start = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    var scroll = window.scrollY;
    lastJson = snapshot;
    var nodes = view === 'live' ? renderStreamer() : renderViewer();
    root.replaceChildren.apply(root, nodes);
    window.scrollTo(0, scroll);
    if (key) {
      var again = root.querySelector('[data-key="' + key + '"]');
      if (again && again.tagName !== 'SELECT') { again.focus(); if (start !== null) try { again.setSelectionRange(start, start); } catch (e) { /* number inputs */ } }
    }
  }

  // ---------- start ----------
  ext.onError(function () { /* Twitch shows its own errors */ });
  ext.features.onChanged(function () { bitsEnabled = !!ext.features.isBitsEnabled; render(true); });
  if (ext.viewer && ext.viewer.onChanged) ext.viewer.onChanged(function () { linked = !!ext.viewer.isLinked; refresh(); });

  ext.bits.onTransactionComplete(function (tx) {
    act(function () { return api('POST', '/api/bits/receipt', { receipt: tx.transactionReceipt }); });
  });
  ext.bits.onTransactionCancelled(function () { say('', 'No Bits were used.'); });

  ext.onAuthorized(function (a) {
    auth = a;
    bitsEnabled = !!ext.features.isBitsEnabled;
    linked = !!ext.viewer.isLinked;
    refresh().then(schedule);
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
})();
