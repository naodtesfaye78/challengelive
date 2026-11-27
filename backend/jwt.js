'use strict';

/**
 * jwt.js - checks the signed "tokens" Twitch gives every viewer.
 * Only HS256 is accepted. The signature is checked BEFORE the contents are trusted.
 */

const crypto = require('crypto');

class JwtError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // malformed | bad_algorithm | bad_signature | expired
  }
}

function fromB64u(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function toB64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function verifyHs256(token, keys, opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  const skewSec = o.clockToleranceSec === undefined ? 5 : o.clockToleranceSec;
  const requireExp = o.requireExp !== false;

  if (typeof token !== 'string' || token.length > 4096) throw new JwtError('malformed');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed');

  let header;
  try {
    header = JSON.parse(fromB64u(parts[0]).toString('utf8'));
  } catch (e) {
    throw new JwtError('malformed');
  }
  if (!header || header.alg !== 'HS256') throw new JwtError('bad_algorithm');

  const given = fromB64u(parts[2]);
  const data = parts[0] + '.' + parts[1];
  const good = keys.some((key) => {
    const expected = crypto.createHmac('sha256', key).update(data).digest();
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
  if (!good) throw new JwtError('bad_signature');

  let payload;
  try {
    payload = JSON.parse(fromB64u(parts[1]).toString('utf8'));
  } catch (e) {
    throw new JwtError('malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new JwtError('malformed');

  if (typeof payload.exp === 'number') {
    if (payload.exp * 1000 < now() - skewSec * 1000) throw new JwtError('expired');
  } else if (requireExp) {
    throw new JwtError('expired');
  }
  return payload;
}

function signHs256(payload, key) {
  const head = toB64u(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = toB64u(Buffer.from(JSON.stringify(payload)));
  const sig = toB64u(crypto.createHmac('sha256', key).update(head + '.' + body).digest());
  return head + '.' + body + '.' + sig;
}

module.exports = { verifyHs256, signHs256, JwtError };
