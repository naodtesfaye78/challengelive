'use strict';

/**
 * store.js - saves everything in one JSON file (no database to set up).
 * All changes happen inside the single Node process, so they cannot collide.
 * Files are written safely (temp file, then rename) so a crash can't corrupt them.
 */

const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const FINAL = new Set(['rejected', 'declined', 'skipped', 'completed']);

function createStore(options) {
  const o = options || {};
  const file = o.file || null; // null = memory only (tests)
  const now = o.now || (() => Date.now());
  const log = o.log || console;
  let db = { v: 1, channels: {}, tx: {} };
  let timer = null;
  let dirty = false;

  function defaults() {
    return {
      settings: { customDaresOpen: true, qaOpen: true, freeMenuMode: false, disabled: [] },
      dares: [],
      questions: [],
      poll: null,
      lastPoll: null,
      goal: null,
    };
  }

  function load() {
    if (!file) return;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.channels && parsed.tx) db = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try {
          fs.renameSync(file, file + '.corrupt-' + now());
        } catch (e) { /* ignore */ }
        log.error('[store] data file was unreadable; started fresh (old file kept as .corrupt-*)');
      }
    }
    prune();
  }

  function writeNow() {
    if (!file || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    } catch (err) {
      dirty = true;
      log.error('[store] could not save:', err.message);
    }
  }

  function touch() {
    dirty = true;
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      writeNow();
    }, 150);
    timer.unref();
  }

  function channel(id) {
    if (!db.channels[id]) {
      db.channels[id] = defaults();
      touch();
    }
    return db.channels[id];
  }

  function prune() {
    const t = now();
    for (const ch of Object.values(db.channels)) {
      ch.dares = ch.dares.filter((d) => !(FINAL.has(d.status) && t - (d.decidedAt || d.createdAt) > 30 * DAY));
      ch.questions = ch.questions.filter((q) => !((q.status === 'answered' || q.status === 'hidden' || q.status === 'rejected') && t - q.createdAt > 30 * DAY));
    }
    for (const [k, v] of Object.entries(db.tx)) if (t - v.at > 120 * DAY) delete db.tx[k];
    touch();
  }

  function close() {
    if (timer) clearTimeout(timer);
    timer = null;
    writeNow();
  }

  load();
  return { channel, touch, prune, close, flush: writeNow, channels: () => db.channels, tx: () => db.tx };
}

module.exports = { createStore, FINAL };
