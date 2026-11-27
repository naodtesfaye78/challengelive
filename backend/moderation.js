'use strict';

/**
 * moderation.js - the safety gate for everything viewers type (custom dares and questions).
 *
 * It FAILS CLOSED: if anything is unclear, broken or slow, the text is NOT approved.
 * Order: clean the text -> block prompt-injection tricks -> ask the provider -> validate its answer.
 */

const LIMITS = { dare: { min: 10, max: 300 }, question: { min: 8, max: 200 } };

const MESSAGES = {
  invalid_input: 'Please write between {min} and {max} characters.',
  prompt_injection: 'That text was not accepted. Please write a normal dare.',
  unsafe: 'Sorry, that one is not allowed. Try something safe the streamer can do alone.',
  too_vague: 'Make it specific: add a number or a time (for example "20 push-ups in 60 seconds").',
  uncertain: 'We could not confirm that is safe, so it was not approved. Try a simpler, solo dare.',
  unavailable: 'The safety check is not available right now. Please try again in a minute.',
  link_or_contact: 'Please do not include links or contact details.',
};

function cleanText(input) {
  return String(input === undefined || input === null ? '' : input)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .trim();
}

// ---- prompt injection ----
const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier)( \w+)? (instructions|rules|prompts?)/i,
  /disregard (the |all |any )?(previous|prior|above|system)/i,
  /(you are|act as|pretend to be) (now )?(a |an |the )?(different|new|unrestricted|jailbroken)/i,
  /system prompt/i,
  /(reveal|show|print|repeat) (your|the) (instructions|prompt|rules)/i,
  /\bjailbreak/i,
  /\bdan mode\b/i,
  /(set|mark|return|output|respond with|answer)[^.]{0,30}\b(safe|approved?)\b/i,
  /\{\s*["']?safe["']?\s*:/i,
  /<\/?\s*(system|assistant|user|dare_text)\b/i,
  /(moderator|reviewer|assistant|ai)[, ]+(please )?(approve|accept)/i,
  /already (been )?(approved|verified|moderated|checked)/i,
  /this (dare |question )?is (safe|approved)/i,
];
const COMPACT = ['ignorepreviousinstructions', 'ignoreallinstructions', 'ignoreprior', 'disregardprevious', 'systemprompt', 'youarenowdan', 'markthisassafe', 'approvethisdare'];

function detectPromptInjection(text) {
  const matches = [];
  for (const re of INJECTION) if (re.test(text)) matches.push(String(re));
  const squashed = text.toLowerCase().replace(/[^a-z]/g, '');
  for (const c of COMPACT) if (squashed.includes(c)) matches.push('compact:' + c);
  return { detected: matches.length > 0, matches };
}

// ---- links / contact details (questions and dares) ----
const LINK_OR_CONTACT = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|tv|ly|me|co|xyz|app)\b|@[a-z0-9_]{3,}|\b\d{3}[\s.-]?\d{3,4}[\s.-]?\d{4}\b|\b[\w.+-]+@[\w-]+\.\w+\b|discord\.gg)/i;

// ---- providers ----
function loadProvider(name) {
  if (name === 'mock') return require('./providers/mock');
  if (name === 'anthropic') return require('./providers/anthropic');
  throw new Error('Unknown MODERATION_PROVIDER "' + name + '". Use mock or anthropic.');
}

function msg(code) {
  return MESSAGES[code] || MESSAGES.uncertain;
}

function createModerator(options) {
  const o = options || {};
  const provider = o.provider || loadProvider(o.providerName || 'mock');
  const timeoutMs = o.timeoutMs || 8000;

  /** Returns { status: 'approved'|'rejected', code, message, text } */
  return async function moderate(rawText, mode) {
    const kind = mode === 'question' ? 'question' : 'dare';
    const lim = LIMITS[kind];
    const text = cleanText(rawText);
    const reject = (code) => ({ status: 'rejected', code, message: msg(code).replace('{min}', lim.min).replace('{max}', lim.max), text });

    if (text.length < lim.min || text.length > lim.max) return reject('invalid_input');
    if (detectPromptInjection(text).detected) return reject('prompt_injection');
    if (LINK_OR_CONTACT.test(text)) return reject('link_or_contact');

    let verdict;
    let timer;
    try {
      verdict = await Promise.race([
        provider.assess(text, kind),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('moderation timeout')), timeoutMs);
        }),
      ]);
    } catch (err) {
      return reject('unavailable');
    } finally {
      clearTimeout(timer);
    }

    if (!verdict || typeof verdict !== 'object') return reject('uncertain');
    if (verdict.safe === false) return reject('unsafe');
    if (verdict.safe !== true) return reject('uncertain');
    if (kind === 'dare' && verdict.specific !== true) return reject('too_vague');
    return { status: 'approved', code: 'ok', message: '', text };
  };
}

module.exports = { createModerator, cleanText, detectPromptInjection, loadProvider, MESSAGES, LIMITS };
