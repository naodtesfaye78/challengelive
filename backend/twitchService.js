'use strict';

/**
 * twitchService.js - everything that checks or asks Twitch.
 *  verifyClientToken: who is calling (channel + role come ONLY from this signed token)
 *  verifyBitsReceipt: the receipt Twitch gives after Bits are used
 *  getDisplayName:    a viewer's Twitch name (optional; needs TWITCH_API_CLIENT_SECRET)
 */

const { ApiError } = require('./errors');
const { verifyHs256, JwtError } = require('./jwt');

const NUMERIC_ID = /^\d{1,20}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TX_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ROLES = new Set(['broadcaster', 'moderator', 'viewer']);

function cleanName(name, fallback) {
  const s = String(name || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .trim()
    .slice(0, 40);
  return s || fallback;
}

function createTwitchService(options) {
  const o = options || {};
  const keys = o.secretKeys;
  const now = o.now || (() => Date.now());
  const fetchImpl = o.fetchImpl || ((...a) => fetch(...a));
  const log = o.log || console;
  const clientId = o.apiClientId || '';
  const clientSecret = o.apiClientSecret || '';
  if (!Array.isArray(keys) || !keys.length) throw new Error('createTwitchService needs secretKeys');

  function verifyClientToken(token) {
    let c;
    try {
      c = verifyHs256(token, keys, { now });
    } catch (err) {
      if (err instanceof JwtError) {
        if (err.code === 'expired') throw new ApiError(401, 'token_expired', 'Your session expired. Please reload the extension.');
        throw new ApiError(401, 'invalid_token', 'We could not verify your Twitch session. (' + err.code + ')');
      }
      throw err;
    }
    const bad = (why) => new ApiError(401, 'invalid_token', 'We could not verify your Twitch session. (bad_' + why + ')');
    const userId = c.user_id === undefined || c.user_id === '' ? null : c.user_id;
    if (typeof c.channel_id !== 'string' || !NUMERIC_ID.test(c.channel_id)) throw bad('channel');
    if (typeof c.role !== 'string' || !ROLES.has(c.role)) throw bad('role');
    if (typeof c.opaque_user_id !== 'string' || !OPAQUE_ID.test(c.opaque_user_id)) throw bad('user');
    if (userId !== null && (typeof userId !== 'string' || !NUMERIC_ID.test(userId))) throw bad('userid');
    return { channelId: c.channel_id, role: c.role, opaqueId: c.opaque_user_id, userId, loggedIn: c.opaque_user_id[0] === 'U' };
  }

  function verifyBitsReceipt(token) {
    const bad = () => new ApiError(400, 'invalid_receipt', 'That Bits receipt could not be verified.');
    let p;
    try {
      p = verifyHs256(token, keys, { now, requireExp: false });
    } catch (err) {
      if (err instanceof JwtError) throw bad();
      throw err;
    }
    if (p.topic !== 'bits_transaction_receipt') throw bad();
    const d = p.data;
    if (!d || typeof d !== 'object') throw bad();
    if (typeof d.transactionId !== 'string' || !TX_ID.test(d.transactionId)) throw bad();
    if (typeof d.userId !== 'string' || !NUMERIC_ID.test(d.userId)) throw bad();
    const prod = d.product;
    const sku = prod && typeof prod === 'object' ? prod.sku : undefined;
    if (typeof sku !== 'string' || !/^[^\s]{1,255}$/.test(sku)) throw bad();
    const amount = prod.cost ? Number(prod.cost.amount) : NaN;
    return {
      transactionId: d.transactionId,
      userId: d.userId,
      sku,
      bitsAmount: Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : null,
      inDevelopment: prod.inDevelopment === true,
    };
  }

  const names = new Map();
  let appToken = null;

  async function getAppToken(force) {
    if (!force && appToken && appToken.until > now()) return appToken.value;
    const res = await fetchImpl('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error('token request HTTP ' + res.status);
    const j = await res.json();
    if (!j.access_token) throw new Error('no access_token');
    appToken = { value: j.access_token, until: now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
    return appToken.value;
  }

  async function lookup(userId) {
    for (let i = 0; i < 2; i += 1) {
      const t = await getAppToken(i > 0);
      const res = await fetchImpl('https://api.twitch.tv/helix/users?id=' + encodeURIComponent(userId), {
        headers: { authorization: 'Bearer ' + t, 'client-id': clientId },
        signal: AbortSignal.timeout(4000),
      });
      if (res.status === 401 && i === 0) continue;
      if (!res.ok) throw new Error('Get Users HTTP ' + res.status);
      const j = await res.json();
      const u = j && Array.isArray(j.data) ? j.data[0] : null;
      return u ? u.display_name || u.login || null : null;
    }
    return null;
  }

  async function getDisplayName(userId) {
    const fallback = 'Viewer-' + String(userId || '0000').slice(-4);
    if (!userId) return fallback;
    const hit = names.get(userId);
    if (hit && hit.until > now()) return hit.name;
    let name = null;
    if (clientId && clientSecret) {
      try {
        name = await lookup(userId);
      } catch (err) {
        log.error('[twitch] name lookup failed:', err.message);
      }
    }
    const final = cleanName(name, fallback);
    names.set(userId, { name: final, until: now() + (name ? 6 * 3600 * 1000 : 60 * 1000) });
    if (names.size > 5000) names.delete(names.keys().next().value);
    return final;
  }

  return { verifyClientToken, verifyBitsReceipt, getDisplayName };
}

module.exports = { createTwitchService, cleanName };
