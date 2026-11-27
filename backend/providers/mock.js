'use strict';

/**
 * providers/mock.js - a simple keyword safety checker, so everything works with no AI key.
 * It is strict: it only approves plain exercise/performance dares that include a number.
 * It is NOT good enough for real use - switch to providers/anthropic.js (MODERATION_PROVIDER=anthropic).
 */

const name = 'mock';

function words(list) {
  return new RegExp('\\b(?:' + list.join('|') + ')\\b', 'i');
}

const HARD = [
  words(['fight', 'fights', 'fighting', 'punch', 'punching', 'slap', 'slapping', 'hit', 'hitting', 'kick', 'kicking', 'attack', 'hurt', 'hurting', 'kill', 'shoot', 'stab', 'beat', 'beating', 'tackle', 'assault', 'choke', 'choking', 'strangle']),
  words(['weapon', 'weapons', 'gun', 'guns', 'knife', 'knives', 'sword', 'blade', 'firearm', 'pistol', 'rifle', 'taser', 'explosive', 'explosives', 'bomb']),
  words(['steal', 'stealing', 'shoplift', 'shoplifting', 'rob', 'robbing', 'break into', 'breaking into', 'sneak into', 'trespass', 'trespassing', 'vandalize', 'vandalism', 'graffiti', 'smash', 'destroy', 'hack', 'illegal']),
  words(['drive', 'driving', 'car', 'motorcycle', 'traffic', 'blindfold', 'blindfolded', 'speeding', 'road', 'highway', 'intersection', 'cross the street', 'scooter', 'skateboard']),
  words(['roof', 'rooftop', 'balcony', 'cliff', 'bridge', 'ledge', 'jump off', 'jumping off', 'fall', 'stunt', 'parkour', 'fire', 'flame', 'burn', 'burning', 'fireworks', 'breath', 'faint', 'pass out', 'ice bath', 'climb']),
  words(['alcohol', 'beer', 'vodka', 'whiskey', 'shots', 'drunk', 'chug', 'vape', 'smoke', 'cigarette', 'drug', 'drugs', 'weed', 'cocaine', 'pill', 'pills', 'ghost pepper', 'ghost peppers', 'carolina reaper', 'hot sauce', 'cinnamon', 'gallon', 'raw egg', 'raw eggs']),
  words(['sex', 'sexual', 'naked', 'nude', 'strip', 'underwear', 'kiss', 'kissing', 'twerk', 'twerking', 'lap dance', 'grope', 'touch', 'touching', 'flirt', 'lick']),
  words(['child', 'children', 'kid', 'kids', 'minor', 'baby', 'elderly', 'homeless', 'disabled', 'pregnant']),
  words(['follow', 'following', 'stalk', 'chase', 'spy', 'doxx', 'dox', 'address', 'phone number', 'real name', 'knock on', 'doorbell', 'harass', 'insult', 'bully', 'scare']),
  words(['suicide', 'self harm', 'self-harm', 'hurt yourself', 'kill yourself', 'starve', 'stop eating', 'stay awake', 'overdose', 'purge']),
];

const SOFT = words(['stranger', 'strangers', 'someone', 'people', 'person', 'random', 'passerby', 'neighbor', 'neighbour', 'customer', 'cashier', 'waiter', 'waitress', 'police', 'cop']);

const NUMBER = /\b\d+\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|hundred)\b/i;

const ACTIVITY = words(['push-?ups?', 'press-?ups?', 'squats?', 'sit-?ups?', 'burpees?', 'jumping jacks?', 'lunges?', 'planks?', 'wall sits?', 'crunches', 'mountain climbers', 'star jumps?', 'sing', 'dance', 'rap', 'hum', 'recite', 'tongue twisters?', 'accent', 'impression', 'monologue', 'chorus', 'narrate', 'poem']);

// Questions: block clearly bad topics; otherwise allow ordinary questions.
const BAD_QUESTION = words(['sex', 'sexual', 'naked', 'nude', 'porn', 'kill', 'suicide', 'self-harm', 'dox', 'doxx', 'address', 'phone number', 'password', 'credit card', 'idiot', 'stupid', 'ugly', 'hate you', 'racist', 'nazi', 'slur', 'rape', 'drugs', 'cocaine']);

async function assess(text, kind) {
  const t = String(text).toLowerCase();
  if (kind === 'question') {
    if (BAD_QUESTION.test(t)) return { safe: false, specific: true };
    return { safe: true, specific: true };
  }
  const hasNumber = NUMBER.test(t);
  if (HARD.some((re) => re.test(t))) return { safe: false, specific: hasNumber };
  if (SOFT.test(t)) return { safe: 'uncertain', specific: hasNumber };
  if (ACTIVITY.test(t) && hasNumber) return { safe: true, specific: true };
  return { safe: 'uncertain', specific: hasNumber };
}

module.exports = { name, assess };
