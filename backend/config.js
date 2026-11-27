'use strict';

/**
 * config.js - reads settings from environment variables (never from code).
 * See README.md for what each one means.
 */

// Used ONLY when DEV_HARNESS=1 (the fake-Twitch test mode). Refused in production.
const DEV_SECRET_B64 = Buffer.from('dev-only-secret-dev-only-secret-0123456789').toString('base64');

function loadConfig(env) {
  const e = env || process.env;
  const production = e.NODE_ENV === 'production';
  const devHarness = e.DEV_HARNESS === '1';
  if (devHarness && production) throw new Error('DEV_HARNESS=1 is not allowed when NODE_ENV=production.');

  const raw = devHarness ? DEV_SECRET_B64 : e.TWITCH_EXTENSION_SECRET || '';
  const secretKeys = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Buffer.from(s, 'base64'));
  if (secretKeys.length === 0) {
    throw new Error('TWITCH_EXTENSION_SECRET is not set. Copy it from the Twitch Developer Console (Extension Settings > Extension Client Secret).');
  }

  const provider = (e.MODERATION_PROVIDER || 'mock').trim();
  if (provider === 'anthropic' && !e.ANTHROPIC_API_KEY) {
    throw new Error('MODERATION_PROVIDER=anthropic needs ANTHROPIC_API_KEY.');
  }
  if (production && provider === 'mock') {
    // Not fatal, so a first deploy works, but loudly flagged.
    // eslint-disable-next-line no-console
    console.warn('[config] WARNING: MODERATION_PROVIDER=mock is a simple keyword checker. Use anthropic for real use.');
  }

  return Object.freeze({
    production,
    devHarness,
    port: Number(e.PORT) || 3000,
    secretKeys,
    clientId: (e.TWITCH_EXTENSION_CLIENT_ID || '').trim(),
    apiClientId: (e.TWITCH_API_CLIENT_ID || e.TWITCH_EXTENSION_CLIENT_ID || '').trim(),
    apiClientSecret: (e.TWITCH_API_CLIENT_SECRET || '').trim(),
    allowedOrigins: (e.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: (e.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    dataFile: e.DATA_FILE || './data/challengelive.json',
    moderationProvider: provider,
    moderationTimeoutMs: Number(e.MODERATION_TIMEOUT_MS) || 8000,
    trustProxy: e.TRUST_PROXY !== '0',
  });
}

module.exports = { loadConfig, DEV_SECRET_B64 };
