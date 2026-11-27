'use strict';

/**
 * catalog.js - the FIXED menu of paid dares and the community-goal products.
 *
 * Twitch rule: Bits products ("SKUs") are created in the Twitch Developer Console
 * and are chosen by the extension, so the paid menu is fixed and viewers cannot
 * type their own text and pay for it. Every dare here is for the streamer ALONE.
 *
 * Each `sku` must be created in the Twitch console with the SAME text and amount.
 */

const CATALOG = [
  { id: 'squat-storm', sku: 'cl_squats_50', bits: 100, title: 'Squat Storm', difficulty: 'Medium', timeLimitSec: 120, objective: 'Do 50 bodyweight squats in 2 minutes.', rules: ['Count out loud.', 'Thighs parallel to the floor on each rep.'], safety: 'Stop if you feel pain or dizzy.' },
  { id: 'pushup-streak', sku: 'cl_pushups_30', bits: 200, title: 'Push-up Streak', difficulty: 'Hard', timeLimitSec: 120, objective: 'Do 30 push-ups in 2 minutes.', rules: ['Chest gets within a fist of the floor.', 'Knee push-ups count as half.'], safety: 'Stop if you feel pain.' },
  { id: 'plank-90', sku: 'cl_plank_90', bits: 200, title: 'Plank 90', difficulty: 'Hard', timeLimitSec: 90, objective: 'Hold a plank for 90 seconds.', rules: ['Timer on screen.', 'Best time counts if you drop.'], safety: 'Skip it if you have a wrist or back injury.' },
  { id: 'wall-sit-60', sku: 'cl_wallsit_60', bits: 150, title: 'Wall Sit 60', difficulty: 'Medium', timeLimitSec: 60, objective: 'Hold a wall sit for 60 seconds.', rules: ['Thighs parallel to the floor.', 'Timer on screen.'], safety: 'Stop if your knees hurt.' },
  { id: 'chorus-30', sku: 'cl_chorus_30', bits: 100, title: 'Chorus Time', difficulty: 'Easy', timeLimitSec: 30, objective: 'Sing 30 seconds of any song you choose, with full energy.', rules: ['You pick the song.', 'Stand up and perform it.'], safety: 'Keep the volume friendly to people nearby.' },
  { id: 'accent-120', sku: 'cl_accent_120', bits: 100, title: 'Accent Mode', difficulty: 'Medium', timeLimitSec: 120, objective: 'Talk in a funny accent for 2 minutes without dropping it.', rules: ['Keep talking the whole time.', 'Chat can call out slips.'], safety: 'Keep it friendly, not mocking real groups of people.' },
  { id: 'monologue-60', sku: 'cl_monologue_60', bits: 150, title: 'Dramatic Monologue', difficulty: 'Medium', timeLimitSec: 60, objective: 'Give a 60-second dramatic speech about the object nearest to you.', rules: ['Stay in character the whole minute.', 'Add one big plot twist.'], safety: 'Keep it friendly.' },
  { id: 'dance-30', sku: 'cl_dance_30', bits: 100, title: 'Dance Break', difficulty: 'Easy', timeLimitSec: 30, objective: 'Dance non-stop for 30 seconds.', rules: ['No standing still.', 'Face the camera.'], safety: 'Clear the floor space first.' },
  { id: 'twister-10', sku: 'cl_twister_10', bits: 100, title: 'Tongue Twister Ten', difficulty: 'Medium', timeLimitSec: 90, objective: 'Say a tongue twister of chat\'s choice 10 times in a row without a mistake.', rules: ['Restart after a mistake.', 'Chat picks the twister.'], safety: 'No risk. Have water nearby.' },
  { id: 'documentary-120', sku: 'cl_documentary_120', bits: 150, title: 'Nature Documentary', difficulty: 'Medium', timeLimitSec: 120, objective: 'Narrate everything you do for 2 minutes like a nature documentary host.', rules: ['Whisper-dramatic voice.', 'Keep narrating the whole time.'], safety: 'Keep it friendly.' },
];

// Products for the community goal. The streamer picks the dare and the target.
const GOAL_PRODUCTS = [
  { sku: 'cl_goal_10', bits: 10 },
  { sku: 'cl_goal_50', bits: 50 },
  { sku: 'cl_goal_100', bits: 100 },
];

const SKU_PATTERN = /^[a-z0-9_]{3,40}$/;

function findById(id) {
  return CATALOG.find((d) => d.id === id) || null;
}
function findDareBySku(sku) {
  return CATALOG.find((d) => d.sku === sku) || null;
}
function findGoalProduct(sku) {
  return GOAL_PRODUCTS.find((p) => p.sku === sku) || null;
}

function publicView(d) {
  return { id: d.id, title: d.title, difficulty: d.difficulty, timeLimitSec: d.timeLimitSec, objective: d.objective, rules: d.rules, safety: d.safety, bits: d.bits, sku: d.sku };
}

function validateCatalog() {
  const problems = [];
  const skus = new Set();
  const ids = new Set();
  for (const d of CATALOG) {
    if (!SKU_PATTERN.test(d.sku)) problems.push(d.id + ': bad sku');
    if (skus.has(d.sku)) problems.push(d.id + ': duplicate sku');
    if (ids.has(d.id)) problems.push(d.id + ': duplicate id');
    skus.add(d.sku);
    ids.add(d.id);
    if (!Number.isInteger(d.bits) || d.bits < 1 || d.bits > 10000) problems.push(d.id + ': bits must be 1-10000');
    if (!d.objective || d.objective.length < 10) problems.push(d.id + ': objective too short');
  }
  for (const p of GOAL_PRODUCTS) {
    if (skus.has(p.sku)) problems.push(p.sku + ': duplicate sku');
    skus.add(p.sku);
  }
  return problems;
}

module.exports = { CATALOG, GOAL_PRODUCTS, findById, findDareBySku, findGoalProduct, publicView, validateCatalog };
