'use strict';
const { loadConfig, DEV_SECRET_B64 } = require('../backend/config');
const { createStore } = require('../backend/store');
const { createModerator } = require('../backend/moderation');
const { createTwitchService } = require('../backend/twitchService');
const { createApp } = require('../backend/app');
const { signHs256 } = require('../backend/jwt');

const SECRET = Buffer.from(DEV_SECRET_B64, 'base64');

async function start(opts) {
  const o = opts || {};
  const config = loadConfig({ DEV_HARNESS: o.dev === false ? undefined : '1', TWITCH_EXTENSION_SECRET: DEV_SECRET_B64, NODE_ENV: 'test', TWITCH_EXTENSION_CLIENT_ID: 'abc123' });
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const store = createStore({ file: null, now });
  const moderate = o.moderate || createModerator({ providerName: 'mock' });
  const twitch = createTwitchService({ secretKeys: config.secretKeys, now });
  const app = createApp({ config, store, moderate, twitch, now });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  function token(role, user, channel, extra) {
    const payload = { exp: Math.floor(clock.t / 1000) + 3600, channel_id: channel || '555', opaque_user_id: 'U' + user, role: role || 'viewer', user_id: String(user), ...(extra || {}) };
    for (const k of Object.keys(payload)) if (payload[k] === null) delete payload[k];
    return signHs256(payload, SECRET);
  }
  function receipt(sku, user, amount, txId, extra) {
    return signHs256({ topic: 'bits_transaction_receipt', exp: Math.floor(clock.t / 1000) + 3600, data: { transactionId: txId || 'tx-' + Math.random(), time: new Date().toISOString(), userId: String(user), product: { sku, displayName: sku, cost: { amount, type: 'bits' }, inDevelopment: true } }, ...(extra || {}) }, SECRET);
  }
  async function call(method, path, tok, body, headers) {
    const res = await fetch(base + path, { method, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers || {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch (e) { /* not json */ }
    return { status: res.status, json, headers: res.headers };
  }
  async function stop() { app.close(); store.close(); await new Promise((r) => app.server.close(r)); }
  return { base, clock, token, receipt, call, stop, store, SECRET };
}

module.exports = { start, SECRET };
