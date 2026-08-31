// ---------- Scoring definitions ----------

const UPPER_CATS = [
  { key: "ones", name: "Ones", face: 1, money: 0 },
  { key: "twos", name: "Twos", face: 2, money: 0 },
  { key: "threes", name: "Threes", face: 3, money: 0 },
  { key: "fours", name: "Fours", face: 4, money: 0 },
  { key: "fives", name: "Fives", face: 5, money: 0 },
  { key: "sixes", name: "Sixes", face: 6, money: 0 },
];

// Lower-section money scales roughly with how hard the hand is to land;
// Five of a Kind stays the clear standout reward.
const LOWER_CATS = [
  { key: "onePair", name: "One Pair", money: 2 },
  { key: "twoPairs", name: "Two Pairs", money: 3 },
  { key: "threeKind", name: "Three of a Kind", money: 4 },
  { key: "fourKind", name: "Four of a Kind", money: 6 },
  { key: "smallStraight", name: "Small Straight (1-5)", money: 7 },
  { key: "largeStraight", name: "Large Straight (2-6)", money: 8 },
  { key: "fullHouse", name: "Full House", money: 5 },
  { key: "chance", name: "Chance", money: 1 },
  { key: "yatzy", name: "Five of a Kind", money: 10 },
];

// Only available once the player has enough dice (Extra Dice perks) - each
// of these categories needs at least minDice dice to even be possible, and
// most need 6 - Seven of a Kind needs a 2nd Extra Dice (7 dice total).
const EXTRA_CATS = [
  { key: "threePairs", name: "Three Pairs", money: 9, minDice: 6 },
  { key: "twoThreeKind", name: "Two Three of a Kinds", money: 9, minDice: 6 },
  { key: "majorStraight", name: "Major Straight (1-6)", money: 10, minDice: 6 },
  { key: "sixKind", name: "Six of a Kind", money: 12, minDice: 6 },
  { key: "sevenKind", name: "Seven of a Kind", money: 14, minDice: 7 },
];

const ALL_CATS = [...UPPER_CATS, ...LOWER_CATS, ...EXTRA_CATS];
const UPPER_BONUS_THRESHOLD = 63;
const UPPER_BONUS_AMOUNT = 50;

function roundDownTo5(n) {
  return Math.floor(n / 5) * 5;
}

// The run opens with two lower-section-only warm-up games before the full
// 15-category main game. Their targets are fractions of the main game's
// base target, rounded down to the nearest 5.
const BASE_TARGET = 150;
const SMALL_GAME_TARGETS = {
  small1: roundDownTo5(BASE_TARGET / 5),
  small2: roundDownTo5(BASE_TARGET / 4),
};

// Main-game targets grow exponentially - 150 at level 1, +20% compounding
// each level after that - rounded down to the nearest 5. Steady Nerves and
// High Stakes don't discount/inflate the computed target directly - they
// adjust the growth RATE itself: Steady Nerves slows it by
// STEADY_NERVES_GROWTH_REDUCTION_PER_STACK per stack (20% -> 17% -> 14% at
// its 2-stack cap), High Stakes speeds it up by
// HIGH_STAKES_GROWTH_INCREASE_PER_STACK per stack (20% -> 22% -> 24%...,
// uncapped).
const MAIN_TARGET_BASE = 150;
const MAIN_TARGET_GROWTH_RATE = 1.20;
const STEADY_NERVES_MAX_STACKS = 2;
const STEADY_NERVES_GROWTH_REDUCTION_PER_STACK = 0.03;
const HIGH_STAKES_GROWTH_INCREASE_PER_STACK = 0.02;

// Refreshing the shop slots costs money, rising by REFRESH_COST_INCREMENT
// each use within the same shop session - reset back to REFRESH_COST_BASE
// whenever a fresh set of slots is presented (showNextRoundPrompt).
// Declared this early so newRunState() (which runs before the rest of the
// shop code below) can reference it without a temporal-dead-zone crash.
const REFRESH_COST_BASE = 8;
const REFRESH_COST_INCREMENT = 2;

// Rerolling the 3 offered perks at a level-up modal costs a flat fee (no
// escalation, unlike the shop's Refresh).
const PERK_REROLL_COST = 60;

// Each perk offered at a level-up has this independent chance of being
// shiny - a shiny copy still gets its own visible perk-card slot, it just
// doesn't count against the normal slot cap (see effectivePerkSlotCount()).
const SHINY_PERK_CHANCE = 0.025;

// Lucky Skip: every skipPackOffer() call (declining a category OR rule pack)
// permanently banks this much extra Shiny/Boosted chance per owned copy,
// into state.luckySkipBonus - earned bonus is never retroactively undone if
// the card itself is later removed, matching how Savings Bond's already-
// locked money stays locked. Applied identically to both mechanics (see
// effectiveShinyChance() / effectiveCategoryCardBoostChance()).
const LUCKY_SKIP_BONUS_PER_STACK = 0.005;

function effectiveShinyChance() {
  return SHINY_PERK_CHANCE + state.luckySkipBonus;
}

// Steady Nerves (capped at STEADY_NERVES_MAX_STACKS) and High Stakes
// (uncapped) both adjust the main-game growth rate - computed fresh from
// current ownership every time rather than baked into a mutable running
// total, so nothing can drift or double-apply across level transitions.
// Takes an explicit state object (not the global) since this also needs to
// run on a not-yet-assigned loaded/merged save inside sanitizeTargetProgression,
// before that object becomes the live state.
function computeMainTarget(s, level) {
  const steadyNervesStacks = Math.min(
    STEADY_NERVES_MAX_STACKS,
    (s.perksOwned || []).filter((p) => p.id === "easyTarget").length
  );
  const highStakesStacks = (s.perksOwned || []).filter((p) => p.id === "highStakes").length;
  const growthRate = MAIN_TARGET_GROWTH_RATE
    - STEADY_NERVES_GROWTH_REDUCTION_PER_STACK * steadyNervesStacks
    + HIGH_STAKES_GROWTH_INCREASE_PER_STACK * highStakesStacks;
  const raw = MAIN_TARGET_BASE * Math.pow(growthRate, Math.max(0, level - 1));
  return roundDownTo5(raw);
}

// Small games only run for a handful of turns, chosen freely from the lower
// section - not "fill every category" like the main game. Base value; the
// Extra Round perk can raise state.smallGameTurnLimit above this.
const BASE_SMALL_GAME_TURN_LIMIT = 3;

// The lower-section categories currently in play: each EXTRA_CATS entry
// only appears once the player has at least its own minDice (6 for most,
// 7 for Seven of a Kind) - not a single blanket 6-dice gate for all of them.
function lowerCategories() {
  return [...LOWER_CATS, ...EXTRA_CATS.filter((cat) => state.diceCount >= cat.minDice)];
}

// Which categories are in play for the current phase: the two small games
// only use the lower section, the main game uses everything.
function activeCategories() {
  const lower = lowerCategories();
  return state.phase === "main" ? [...UPPER_CATS, ...lower] : lower;
}

// How many turns the current phase lasts.
function turnLimit() {
  if (state.phase !== "main") return state.smallGameTurnLimit;
  // Main games always get a flat 15 turns (upper + lower categories) by
  // default, regardless of dice count - Extra Dice/the Extra Cats it
  // unlocks add more categories to choose FROM, not more turns to fill
  // them all in, so owning it is a real tradeoff rather than a free bonus.
  const baseTurns = UPPER_CATS.length + LOWER_CATS.length;
  // Make it count shaves 2 turns off the main game per active copy - never
  // below 1, however many are stacked. The Hourglass shaves a flat 2 more
  // on top, regardless of Make it Count stacks - see activeBossModifier().
  const reduction = 2 * activeMakeItCountStacks() + (activeBossModifier()?.id === "theHourglass" ? 2 : 0);
  const limit = Math.max(1, baseTurns - reduction);
  // Sabotage/The Culler both permanently remove categories from play for
  // the rest of the level (see categoryIsBlocked()'s own comment) - if
  // that ever leaves fewer categories still fillable than there are turns
  // left to fill them, the extra turns can never be committed anywhere
  // (every remaining category is either already used or blocked for
  // good), stranding the player in throw-with-nowhere-to-commit limbo
  // instead of actually ending the level. Capping the turn count to match
  // is what actually prevents that, rather than just describing it.
  //
  // The Turnkey is excluded from this cap on purpose even though its own
  // block also turns permanent (once its 4-category threshold is hit) -
  // it uniquely lets the SAME category be recommitted indefinitely (see
  // commitScore()'s allowRepeat), so there's always somewhere to throw
  // into regardless of how many categories are blocked; nothing is ever
  // actually stranded there. The Gatekeeper is excluded for the opposite
  // reason: its block is re-picked fresh every turn and empties out
  // entirely once few turns remain (refreshGatekeeperBlocks()) rather
  // than ever being permanent, so it was never a real loss of a slot to
  // begin with - counting it here would UNDER-count how many turns are
  // actually still usable.
  if (activeBossModifier()?.id !== "theTurnkey") {
    const permanentlyBlockedCount = activeCategories().filter(
      (cat) => state.blockedCategoryKeys.includes(cat.key) || state.cullerBlockedCategoryKeys.includes(cat.key)
    ).length;
    const fillableCategories = activeCategories().length - permanentlyBlockedCount;
    return Math.min(limit, Math.max(1, fillableCategories));
  }
  return limit;
}

// How many turns remain in the current level, INCLUDING the one in
// progress - e.g. on the level's literal last turn (state.turn ===
// turnLimit()) this is 1, not 0, matching how a player actually reads it
// ("this is my last shot"). Shared by both the danger vignette
// (updateDangerVignette()) and the turn stat's own danger-red text
// (renderStats()), so a rule card/boss that changes turnLimit() (Make it
// Count, The Hourglass) is reflected identically by both.
function turnsLeftInLevel() {
  return turnLimit() - state.turn + 1;
}

const CAT_BY_KEY = Object.fromEntries(ALL_CATS.map((cat) => [cat.key, cat]));

// Gated perks (All Luck, Sixth Sense) recompute their effect fresh
// from perksOwned + a live prerequisite check every time they're used,
// rather than baking a fixed value in once at pick time - so if the
// prerequisite (Wild Die / Extra Dice) is ever not actually in effect, the
// gated perk's bonus quietly does nothing instead of applying anyway.
function effectiveWildActiveEvery() {
  if (state.wildIndices.length === 0) return 3;
  const hasFlyer = activePerksOwned().some((p) => p.id === "frequentFlyer");
  return hasFlyer ? 2 : 3;
}

function effectiveExtraCatMoneyMultiplier() {
  if (state.diceCount <= 5) return 1;
  const count = activePerksOwned().filter((p) => p.id === "sixthSense").length;
  return 1 + count * 0.5;
}

// How many Make it count copies are still within their 3-game window - each
// one independently ticks down (see tickMakeItCount) once per game (small
// or main) it's actually active for, so different copies can be at
// different points in their own countdown.
function activeMakeItCountStacks() {
  return state.perksOwned.filter((p) => p.id === "makeItCount" && (p.gamesRemaining || 0) > 0).length;
}

// Make it Count's money multiplier per active stack, additive across stacks
// (2 copies = 1 + 0.5*2 = 2x, not 1.5 squared) - referenced by its own desc
// text and commitScore()'s money calculation, so both always agree.
const MAKE_IT_COUNT_MONEY_MULT_PER_STACK = 1;

// Ticks every owned Make it count copy down by one game and drops any that
// just expired - called once per actual game conclusion: every small game
// (from showNextRoundPrompt) and every main game (from startNextLevel's
// main-just-finished branch). Never called for the shop-to-shop phase
// transitions themselves, so a copy bought in a small-game shop isn't
// docked a charge for a game that already happened before it existed.
function tickMakeItCount() {
  state.perksOwned = state.perksOwned.filter((p) => {
    if (p.id !== "makeItCount") return true;
    p.gamesRemaining -= 1;
    return p.gamesRemaining > 0;
  });
}

// Ticks Fire Sale down by one shop and drops it once its coverage runs out -
// called once per fresh shop presentation (see showNextRoundPrompt()), never
// for a mid-shop re-render, so the shop it's bought in still counts as its
// first covered one without being double-charged.
function tickFireSale() {
  state.perksOwned = state.perksOwned.filter((p) => {
    if (p.id !== "fireSale") return true;
    p.shopsRemaining -= 1;
    return p.shopsRemaining > 0;
  });
}

// Wild dice only actually act wild every Nth round (3 by default, lower
// with the All Luck perk) - other rounds they're just normal dice, so
// the perk isn't a permanent guaranteed-best-face card.
function activeWildIndices() {
  return state.turn % effectiveWildActiveEvery() === 0 ? state.wildIndices : [];
}

// True if throwing again would actually change this die - false for a held
// die, The Warden's locked one, or a wild-active one (none of which ever
// reroll). Used to block a throw that would visibly do nothing at all (see
// rollDice()) - Vice-cemented dice stay held forever once cemented, so
// state.held already covers them without a separate check here.
function dieCanReroll(i) {
  if (state.held[i]) return false;
  if (i === state.bossLockedDieIndex) return false;
  if (activeWildIndices().includes(i)) return false;
  return true;
}

function counts(dice) {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const v of dice) c[v]++;
  return c;
}

// All of these operate on the player's full dice pool, whatever size it is
// (5 normally, more with Extra Dice perks) - extra dice directly grow what
// a hand can score (e.g. seven 6s scores 42 in Sixes, not a capped 30),
// rather than just improving the odds of hitting some fixed 5-dice cap.
function computeRawScore(key, dice) {
  const c = counts(dice);
  const sum = dice.reduce((a, b) => a + b, 0);
  const faces = new Set(dice);

  switch (key) {
    case "ones": return c[1] * 1;
    case "twos": return c[2] * 2;
    case "threes": return c[3] * 3;
    case "fours": return c[4] * 4;
    case "fives": return c[5] * 5;
    case "sixes": return c[6] * 6;
    case "onePair": {
      let best = 0;
      for (let f = 6; f >= 1; f--) if (c[f] >= 2) { best = f * 2; break; }
      return best;
    }
    case "twoPairs": {
      const pairFaces = [];
      for (let f = 6; f >= 1; f--) if (c[f] >= 2) pairFaces.push(f);
      if (pairFaces.length >= 2) return pairFaces[0] * 2 + pairFaces[1] * 2;
      return 0;
    }
    case "threeKind": {
      for (let f = 6; f >= 1; f--) if (c[f] >= 3) return f * 3;
      return 0;
    }
    case "fourKind": {
      for (let f = 6; f >= 1; f--) if (c[f] >= 4) return f * 4;
      return 0;
    }
    case "smallStraight":
      return [1, 2, 3, 4, 5].every((f) => faces.has(f)) ? 15 : 0;
    case "largeStraight":
      return [2, 3, 4, 5, 6].every((f) => faces.has(f)) ? 20 : 0;
    case "majorStraight":
      return [1, 2, 3, 4, 5, 6].every((f) => faces.has(f)) ? 25 : 0;
    case "fullHouse": {
      // A three-of-a-kind face plus a pair on a *different* face - checked
      // this way (not just "some face has 3, some face has 2") so a single
      // face with 4+ copies can't satisfy both halves of the pattern itself.
      // Scored on just those 5 dice (face*3 + face*2), not the full pool -
      // with 6+ dice, any leftover die not part of the pattern shouldn't
      // inflate the score. When more than one valid triple+pair split
      // exists (possible with 6+ dice), the best one wins.
      let best = 0;
      for (let f = 1; f <= 6; f++) {
        if (c[f] < 3) continue;
        for (let g = 1; g <= 6; g++) {
          if (g === f || c[g] < 2) continue;
          const score = f * 3 + g * 2;
          if (score > best) best = score;
        }
      }
      return best;
    }
    case "chance":
      return sum;
    case "yatzy":
      return c.some((n) => n >= 5) ? 50 : 0;
    case "threePairs": {
      const pairFaces = [];
      for (let f = 6; f >= 1; f--) if (c[f] >= 2) pairFaces.push(f);
      return pairFaces.length >= 3 ? sum : 0;
    }
    case "twoThreeKind": {
      const tripleFaces = [];
      for (let f = 6; f >= 1; f--) if (c[f] >= 3) tripleFaces.push(f);
      return tripleFaces.length >= 2 ? sum + 10 : 0;
    }
    case "sixKind":
      return c.some((n) => n >= 6) ? 60 : 0;
    case "sevenKind":
      return c.some((n) => n >= 7) ? 70 : 0;
    default:
      return 0;
  }
}

// Best score for a category given the player's full dice pool, trying every
// possible face (1-6) for any wild positions, since a wild die may show
// whatever face is best. Deliberately state-free (pure function of its
// arguments) - some tooling evals just this scoring section in isolation.
function bestScoreForCategory(key, dice, wildIndices) {
  wildIndices = (wildIndices || []).filter((i) => i < dice.length);

  const cat = CAT_BY_KEY[key];
  if (cat && cat.minDice && dice.length < cat.minDice) return 0;

  if (wildIndices.length === 0) return computeRawScore(key, dice);

  let best = -1;
  const trial = [...dice];

  function recurse(pos) {
    if (pos === wildIndices.length) {
      const s = computeRawScore(key, trial);
      if (s > best) best = s;
      return;
    }
    for (let face = 1; face <= 6; face++) {
      trial[wildIndices[pos]] = face;
      recurse(pos + 1);
    }
  }
  recurse(0);
  return best;
}

// Six-Seven's flat base-score adjustment (+10 Six/Seven of a Kind, -15 Five
// of a Kind per stack) - applied once to the chosen score, never to a miss
// (score <= 0 stays a miss) and never below 0 (a nerfed hit still counts as
// a hit, just for less).
function applySixSevenBonus(key, score) {
  if (score <= 0) return score;
  const stacks = state.perksOwned.filter((p) => p.id === "sixSeven").length;
  if (stacks === 0) return score;
  if (key === "sixKind" || key === "sevenKind") return score + 10 * stacks;
  if (key === "yatzy") return Math.max(0, score - 15 * stacks);
  return score;
}

const BASE_POINTS_BONUS = 5;

// Each owned Base Points copy locks in its own random target category at
// pick time (instance.categoryKey) - this sums up +10 per copy whose target
// matches the category actually being scored, so multiple copies landing on
// the same category compound.
function basePointsBonusFor(key) {
  return state.perksOwned.filter((p) => p.id === "basePoints" && p.categoryKey === key).length * BASE_POINTS_BONUS;
}

// Coin Die (see RULE_POOL): each owned instance marked one random die index
// at one random face value the moment it was picked - pays out
// COIN_DIE_PAYOUT whenever that exact die is showing that exact face at
// commit time, independent of category/phase/whether the hand actually
// scored anything.
const COIN_DIE_PAYOUT = 2;
function coinDieMoneyGain(dice) {
  return state.perksOwned.filter((p) => p.id === "coinDie" && dice[p.dieIndex] === p.faceValue).length * COIN_DIE_PAYOUT;
}

// Lucky Die (see PERK_POOL): the single owned instance's marked die,
// whether it genuinely contributes to the category actually being
// committed - same usedFacesForCategory bar Blue Die/Streak Die use, wild
// dice excluded the same way. Doesn't stack (only one instance can ever
// exist), so no need to sum across multiple owned copies like the other
// die-mod cards do.
function luckyDieContributes(instance, key, dice, wildIndices) {
  return !wildIndices.includes(instance.dieIndex) && usedFacesForCategory(key, dice, wildIndices).has(dice[instance.dieIndex]);
}

// All Luck (frequentFlyer) adds its own flat bonus to both chances
// independently - owning it doesn't make the two outcomes any less mutually
// exclusive per roll, it just widens both slices of the same roll.
function luckyDieChances() {
  const bonus = state.perksOwned.some((p) => p.id === "frequentFlyer") ? LUCKY_DIE_ALL_LUCK_BONUS : 0;
  return { money: LUCKY_DIE_MONEY_CHANCE + bonus, double: LUCKY_DIE_DOUBLE_CHANCE + bonus };
}

// Resolved exactly once per real commit (see commitScore()) - genuine
// randomness, so this must never be called from a preview/render path, or
// the player could "peek" outcomes by re-rendering, and calling it twice
// for the same commit would silently re-roll (and could disagree with
// itself). A single roll split into two mutually exclusive outcome ranges -
// "[+$10] or [2X Final score]" (see the card's own visual cue), never both
// from the same activation.
function resolveLuckyDie(key, dice, wildIndices) {
  const instance = state.perksOwned.find((p) => p.id === "luckyDie");
  if (!instance || !luckyDieContributes(instance, key, dice, wildIndices)) return null;
  const chances = luckyDieChances();
  const roll = Math.random();
  if (roll < chances.money) return { type: "money", dieIndex: instance.dieIndex };
  if (roll < chances.money + chances.double) return { type: "double", dieIndex: instance.dieIndex };
  return null;
}

// Pairs/Trips/Quads/Straights (see RULE_POOL) key off the dice pattern of
// the hand actually thrown, not the category it gets filed into - so a
// small straight committed into Chance still pays out Straights if owned.
// Independent checks: a four of a kind trivially also contains a pair and a
// three of a kind, so several of these can fire on the very same commit.
const HAND_PAIR_BONUS = 2;
const HAND_TRIPS_BONUS = 3;
const HAND_QUADS_BONUS = 4;
const HAND_STRAIGHT_BONUS = 10;

function handContainsStraight(dice, wildIndices) {
  return bestScoreForCategory("smallStraight", dice, wildIndices) > 0
    || bestScoreForCategory("largeStraight", dice, wildIndices) > 0
    || bestScoreForCategory("majorStraight", dice, wildIndices) > 0;
}

const HAND_PATTERN_RULES = [
  { id: "handPairs", bonus: HAND_PAIR_BONUS, matches: (dice, wildIndices) => bestScoreForCategory("onePair", dice, wildIndices) > 0 },
  { id: "handTrips", bonus: HAND_TRIPS_BONUS, matches: (dice, wildIndices) => bestScoreForCategory("threeKind", dice, wildIndices) > 0 },
  { id: "handQuads", bonus: HAND_QUADS_BONUS, matches: (dice, wildIndices) => bestScoreForCategory("fourKind", dice, wildIndices) > 0 },
  { id: "handStraights", bonus: HAND_STRAIGHT_BONUS, matches: handContainsStraight },
];

// Low Roller doesn't fit the flat "does the pattern match" shape above - it
// scales with how many dice actually show a low face, so it's handled as
// its own per-die count rather than a HAND_PATTERN_RULES entry. A wild die
// always resolves in the player's favor for whatever's being checked (same
// principle as bestScoreForCategory's own wild handling), so it counts as
// low here regardless of what it resolves to for the category itself.
const LOW_ROLLER_BONUS_PER_DIE = 1;

function lowRollerBonus(dice, wildIndices) {
  return dice.reduce((sum, v, i) => {
    const effective = wildIndices.includes(i) ? 1 : v;
    return sum + (effective <= 3 ? LOW_ROLLER_BONUS_PER_DIE : 0);
  }, 0);
}

// Sums every owned pattern card's contribution to this specific dice hand,
// and separately reports which ones actually fired (used to highlight them
// in the rule inventory - see highlightedRuleCardIds) plus a per-card
// breakdown (id + its own amount - used by ruleCardScoreBreakdown() to
// build the scorecard's "+X" tooltip).
function handPatternBonus(dice, wildIndices) {
  let total = 0;
  const ids = [];
  const breakdown = [];
  HAND_PATTERN_RULES.forEach((rule) => {
    const stacks = state.perksOwned.filter((p) => p.id === rule.id).length;
    if (stacks > 0 && rule.matches(dice, wildIndices)) {
      const amount = rule.bonus * stacks;
      total += amount;
      ids.push(rule.id);
      breakdown.push({ id: rule.id, amount });
    }
  });
  const lowRollerStacks = state.perksOwned.filter((p) => p.id === "handLowRoller").length;
  if (lowRollerStacks > 0) {
    const perDieTotal = lowRollerBonus(dice, wildIndices);
    if (perDieTotal > 0) {
      const amount = perDieTotal * lowRollerStacks;
      total += amount;
      ids.push("handLowRoller");
      breakdown.push({ id: "handLowRoller", amount });
    }
  }
  return { total, ids, breakdown };
}

// Which face(s) actively satisfy `key`'s scoring pattern, mirroring
// computeRawScore()'s own per-category logic but tracking which face(s) it
// used instead of the score itself. A face is either fully "used" or not -
// e.g. 4 real 6s scoring "threeKind" only strictly needs 3 of them, but all
// 4 still count as used (they share the same face value, so treating one as
// "unused" would be an arbitrary, meaningless distinction for Leftovers'
// per-face-value bonus below). Chance/Three Pairs/Two Three-of-a-Kinds
// already sum every die directly into their own score, so every face
// counts as used for them - crediting leftover dice on top would just
// double-pay the same dice. Wild dice are excluded from the counts here
// entirely (their own stale leftover state.dice value shouldn't count
// toward completing a pattern) - a known simplification: a pattern that
// only completes WITH a wild's help (e.g. 3 real 6s + 1 wild forming Four
// of a Kind) reads as "nothing used" by this function even though the
// category itself does score, so those 3 real 6s would count as unused
// too. Deemed an acceptable edge case rather than fully reasoning through
// which specific face a wild "should" be credited toward.
function usedFacesForCategory(key, dice, wildIndices) {
  const c = counts(dice.filter((_, i) => !wildIndices.includes(i)));
  switch (key) {
    case "ones": return new Set(c[1] > 0 ? [1] : []);
    case "twos": return new Set(c[2] > 0 ? [2] : []);
    case "threes": return new Set(c[3] > 0 ? [3] : []);
    case "fours": return new Set(c[4] > 0 ? [4] : []);
    case "fives": return new Set(c[5] > 0 ? [5] : []);
    case "sixes": return new Set(c[6] > 0 ? [6] : []);
    case "onePair": {
      for (let f = 6; f >= 1; f--) if (c[f] >= 2) return new Set([f]);
      return new Set();
    }
    case "twoPairs": {
      const pairFaces = [];
      for (let f = 6; f >= 1; f--) if (c[f] >= 2) pairFaces.push(f);
      return pairFaces.length >= 2 ? new Set(pairFaces.slice(0, 2)) : new Set();
    }
    case "threeKind": {
      for (let f = 6; f >= 1; f--) if (c[f] >= 3) return new Set([f]);
      return new Set();
    }
    case "fourKind": {
      for (let f = 6; f >= 1; f--) if (c[f] >= 4) return new Set([f]);
      return new Set();
    }
    case "fullHouse": {
      let best = 0;
      let bestFaces = new Set();
      for (let f = 1; f <= 6; f++) {
        if (c[f] < 3) continue;
        for (let g = 1; g <= 6; g++) {
          if (g === f || c[g] < 2) continue;
          const score = f * 3 + g * 2;
          if (score > best) { best = score; bestFaces = new Set([f, g]); }
        }
      }
      return bestFaces;
    }
    case "smallStraight":
      return new Set([1, 2, 3, 4, 5].every((f) => c[f] > 0) ? [1, 2, 3, 4, 5] : []);
    case "largeStraight":
      return new Set([2, 3, 4, 5, 6].every((f) => c[f] > 0) ? [2, 3, 4, 5, 6] : []);
    case "majorStraight":
      return new Set([1, 2, 3, 4, 5, 6].every((f) => c[f] > 0) ? [1, 2, 3, 4, 5, 6] : []);
    case "yatzy": {
      for (let f = 1; f <= 6; f++) if (c[f] >= 5) return new Set([f]);
      return new Set();
    }
    case "sixKind": {
      for (let f = 1; f <= 6; f++) if (c[f] >= 6) return new Set([f]);
      return new Set();
    }
    case "sevenKind": {
      for (let f = 1; f <= 6; f++) if (c[f] >= 7) return new Set([f]);
      return new Set();
    }
    case "chance":
    case "threePairs":
    case "twoThreeKind":
      return new Set([1, 2, 3, 4, 5, 6]);
    default:
      return new Set();
  }
}

// Leftovers' own bonus: sum of every real (non-wild) die's face value that
// did NOT contribute to `key`'s winning pattern. A wild die is never
// counted either way - it has no fixed face of its own (see rollDice(),
// which never even rolls one while it's wild-active).
function unusedDiceSum(key, dice, wildIndices) {
  const usedFaces = usedFacesForCategory(key, dice, wildIndices);
  let sum = 0;
  dice.forEach((v, i) => {
    if (wildIndices.includes(i)) return;
    if (!usedFaces.has(v)) sum += v;
  });
  return sum;
}

// Each Card Pack pick for a category adds +0.5x to its permanent score
// multiplier (1x baseline, so one card makes it 1.5x, two make it 2x, ...).
// The Culler's own +0.2x (see applyCullerEffect()) is layered on top live,
// off cullerBoostedCategoryKeys, rather than folded into categoryBonus
// itself - that field is a whole-run, permanent stat (survives every
// startNextLevel() rebuild via its own carry entry), but the Culler's boost
// is only supposed to last for its own boss level. cullerBoostedCategoryKeys
// is NOT carried forward the same way (it resets fresh every level, see
// newRunState()), so reading it live here is what makes the boost expire on
// its own the moment the level ends, with nothing left to remember to
// reverse.
function categoryCardMultiplier(key) {
  const cullerBoost = state.cullerBoostedCategoryKeys.includes(key) ? CULLER_CATEGORY_BONUS_STEP : 0;
  return 1 + (state.categoryBonus[key] || 0) + cullerBoost;
}

// Which score-boosting rule card ids (Base Points, Six-Seven, or a
// hand-pattern card like Pairs/Trips/Quads/Straights/Low Roller) would
// contribute to this specific category/dice combination - used both to
// give the scorecard's live score preview a purple pulse calling out the
// boost before it's actually committed, and to pulse the same card's pill
// in the rule inventory (see ruleCardAffectsAnyRow()). Callers are
// expected to only check this once the underlying hand is a genuine hit
// (see the raw > 0 gate used everywhere else these bonuses apply) - it
// doesn't re-check that itself.
function ruleCardIdsBoostingScore(key, dice, wildIndices) {
  const ids = [];
  if (basePointsBonusFor(key) > 0) ids.push("basePoints");
  const sixSevenStacks = state.perksOwned.filter((p) => p.id === "sixSeven").length;
  if (sixSevenStacks > 0 && (key === "sixKind" || key === "sevenKind" || key === "yatzy")) ids.push("sixSeven");
  ids.push(...handPatternBonus(dice, wildIndices).ids);
  if (leftoversBonusFor(key, dice, wildIndices) > 0) ids.push("leftovers");
  if (streakDieBonusFor(key, dice, wildIndices) > 0) ids.push("streakDie");
  if (blueDieBonusFor(key, dice, wildIndices) > 0) ids.push("blueDie");
  return ids;
}

function ruleCardBoostsScore(key, dice, wildIndices) {
  return ruleCardIdsBoostingScore(key, dice, wildIndices).length > 0;
}

// Per-card breakdown of the combined point delta every score-boosting rule
// card (Six-Seven, Base Points, a hand-pattern card) would add to this
// category/dice combination, before any scaling (category multiplier/
// Hotline/Lucky Number) is applied - see scoreBreakdownForCategory() and
// addCatRow() for how each entry actually gets scaled for display (Six-
// Seven's own delta scales with the category multiplier, the rest don't).
// Used to build the "+X" label's tooltip in addCatRow(), so the player can
// see exactly where the bonus is coming from instead of just one number.
function ruleCardScoreBreakdown(key, dice, wildIndices) {
  const breakdown = [];
  const basePointsAmount = basePointsBonusFor(key);
  if (basePointsAmount > 0) breakdown.push({ id: "basePoints", name: "Base Points", amount: basePointsAmount });

  const baseHit = bestScoreForCategory(key, dice, wildIndices);
  if (baseHit > 0) {
    const sixSevenDelta = applySixSevenBonus(key, baseHit) - baseHit;
    if (sixSevenDelta !== 0) breakdown.push({ id: "sixSeven", name: "Six-Seven", amount: sixSevenDelta });
  }

  handPatternBonus(dice, wildIndices).breakdown.forEach(({ id, amount }) => {
    const rule = RULE_POOL.find((r) => r.id === id);
    breakdown.push({ id, name: rule ? rule.name : id, amount });
  });

  const leftoversAmount = leftoversBonusFor(key, dice, wildIndices);
  if (leftoversAmount > 0) breakdown.push({ id: "leftovers", name: "Leftovers", amount: leftoversAmount });

  const streakDieAmount = streakDieBonusFor(key, dice, wildIndices);
  if (streakDieAmount > 0) breakdown.push({ id: "streakDie", name: "Streak Die", amount: streakDieAmount });

  const blueDieAmount = blueDieBonusFor(key, dice, wildIndices);
  if (blueDieAmount > 0) breakdown.push({ id: "blueDie", name: "Blue Die", amount: blueDieAmount });

  return breakdown;
}

// Whether a given score-boosting rule card would affect ANY currently
// reachable row with the dice as they stand right now - used to pulse its
// pill in the rule inventory even before any hand is committed, so the
// player can see at a glance which of their cards are "live" this turn.
// Main game only, same scoping as the per-cell glow itself - small games
// don't show a numeric score preview per category, so there's nothing for
// this to meaningfully call out there.
function ruleCardAffectsAnyRow(id) {
  if (state.phase !== "main" || !state.rolled || state.awaitingNextRound) return false;
  const wildIndices = activeWildIndices();
  return activeCategories().some((cat) => {
    if (state.scorecard[cat.key] != null || categoryIsBlocked(cat.key)) return false;
    const raw = applySixSevenBonus(cat.key, bestScoreForCategory(cat.key, state.dice, wildIndices));
    if (raw <= 0) return false;
    return ruleCardIdsBoostingScore(cat.key, state.dice, wildIndices).includes(id);
  });
}

// Applies Six-Seven's flat adjustment, Base Points' flat per-category bonus,
// the dice-pattern bonuses (Pairs/Trips/Quads/Straights), and any permanent
// per-category multiplier (from Card Pack purchases) on top of the base
// score - only when the hand actually hits (never turns a whiff into a
// positive score, since the bonuses/multiplier only ever scale a hit).
// Same computation as scoreWithCategoryBonus(), but split into the raw dice
// value (Six-Seven's own delta folded in, same as the hand itself - it
// scales with the category multiplier), the flat rule-card ("gamerule")
// bonus on top of it (Base Points + hand-pattern cards - these do NOT scale
// with the category multiplier), the pre-category-multiplier base, and the
// multiplier itself - rather than one combined number - lets the score-
// commit animation (see commitScore()/playScoreCommitAnimation()) count up
// through each as its own distinct, individually visible step, and lets the
// live scorecard preview (see addCatRow()) scale each piece correctly.
// `base` (rawHand + bonusTotal) is a positive-score sanity check for
// playScoreCommitAnimation() - it is NOT what catMult is applied to (that's
// rawHand alone, see afterCatMult); the animation itself now recomputes its
// own post-category-multiplier value (rawHand * catMult) directly, to
// display the multiplier stage before the rule-card bonus stage.
// Leftovers, gated by owned stacks (each copy adds its own full unused-dice
// sum, same "every owned copy independently adds its amount" shape as
// basePointsBonusFor()/handPatternBonus() above).
function leftoversBonusFor(key, dice, wildIndices) {
  const stacks = state.perksOwned.filter((p) => p.id === "leftovers").length;
  if (stacks === 0) return 0;
  return unusedDiceSum(key, dice, wildIndices) * stacks;
}

// Streak Die (see PERK_POOL): each owned instance marked one random die at
// pick time and starts with its own bonus at 0. Whenever that die
// contributes to the committed category (same usedFacesForCategory bar
// Blue Die uses) IN A BOSS (main phase only - a small-game commit still
// pays out whatever it already grew to, it just never grows further there),
// its bonus grows by STREAK_DIE_GROWTH_PER_HIT and the grown value is what
// gets added to score THIS same hand, not just future ones -
// streakDieBonusFor() below already assumes that growth happens whenever
// it's actually going to (it has to, so the live scorecard preview shows
// what committing right now would actually pay), and growStreakDie() is
// what actually applies it, called once from commitScore() itself,
// separately, so the preview never grows anything just by being rendered.
const STREAK_DIE_GROWTH_PER_HIT = 1;

function streakDieContributes(instance, key, dice, wildIndices) {
  return !wildIndices.includes(instance.dieIndex) && usedFacesForCategory(key, dice, wildIndices).has(dice[instance.dieIndex]);
}

function streakDieBonusFor(key, dice, wildIndices) {
  const growthThisHand = state.phase === "main" ? STREAK_DIE_GROWTH_PER_HIT : 0;
  return state.perksOwned
    .filter((p) => p.id === "streakDie" && streakDieContributes(p, key, dice, wildIndices))
    .reduce((sum, p) => sum + p.bonus + growthThisHand, 0);
}

// The actual mutation streakDieBonusFor() above assumed would happen -
// called once per real commit (see commitScore()), after the score itself
// has already been computed, so this only raises the floor for next time,
// it never changes what THIS hand banks. Boss-only, matching the
// growthThisHand gate above - a small-game commit already assumed +0
// growth, so this must agree and do nothing there too.
function growStreakDie(key, dice, wildIndices) {
  if (state.phase !== "main") return;
  state.perksOwned.forEach((p) => {
    if (p.id === "streakDie" && streakDieContributes(p, key, dice, wildIndices)) {
      p.bonus += STREAK_DIE_GROWTH_PER_HIT;
    }
  });
}

// Blue Die (see RULE_POOL): each owned instance marked one random die
// index (all 6 faces, not just one - see renderDie()) the moment it was
// picked. Whenever that exact die's current face is one of the faces
// usedFacesForCategory() says actually counted toward the committed
// category (same "genuinely part of the scoring pattern, not just present"
// bar Leftovers' own unusedDiceSum() uses - and the same known wild
// simplification noted there), its face value gets added to score. Kept as
// its own separate breakdown field rather than folded into bonusTotal, so
// playScoreCommitAnimation() can give it its own distinct reveal stage.
function blueDieBonusFor(key, dice, wildIndices) {
  const usedFaces = usedFacesForCategory(key, dice, wildIndices);
  return state.perksOwned
    .filter((p) => p.id === "blueDie" && !wildIndices.includes(p.dieIndex) && usedFaces.has(dice[p.dieIndex]))
    .reduce((sum, p) => sum + dice[p.dieIndex], 0);
}

function scoreBreakdownForCategory(key, dice, wildIndices) {
  const baseHit = bestScoreForCategory(key, dice, wildIndices);
  const rawHand = applySixSevenBonus(key, baseHit);
  if (rawHand <= 0) return { rawHand, sixSevenDelta: 0, bonusTotal: 0, blueBonus: 0, base: rawHand, catMult: 1, afterCatMult: rawHand };
  const sixSevenDelta = rawHand - baseHit;
  const bonusTotal = basePointsBonusFor(key) + handPatternBonus(dice, wildIndices).total + leftoversBonusFor(key, dice, wildIndices)
    + streakDieBonusFor(key, dice, wildIndices);
  const blueBonus = blueDieBonusFor(key, dice, wildIndices);
  const base = rawHand + bonusTotal + blueBonus;
  const catMult = categoryCardMultiplier(key);
  return { rawHand, sixSevenDelta, bonusTotal, blueBonus, base, catMult, afterCatMult: rawHand * catMult + bonusTotal + blueBonus };
}

function scoreWithCategoryBonus(key, dice, wildIndices) {
  return scoreBreakdownForCategory(key, dice, wildIndices).afterCatMult;
}

// Formats a multiplier for display, trimmed to at most one decimal place
// with no trailing ".0" (e.g. 1.5 -> "1.5x", 2 -> "2x").
function formatMultiplier(m) {
  const rounded = Math.round(m * 10) / 10;
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${text}x`;
}

// Same idea as formatMultiplier(), but keeps 2 decimal places instead of
// rounding down to 1 - needed by playScoreCommitAnimation()'s reveal
// stages, since an xMult perk that grows in 0.05 steps (Streaker) or reads
// a 0.05-precision live value (Minimalist/Skipper stacks compounding)
// would otherwise get visibly misrepresented (1.05x rounding up to "1.1x",
// not matching the perk card's own badge one pixel away). String(rounded)
// (not toFixed(2)) so a clean value still reads "1.5x", not "1.50x".
function formatMultiplierPrecise(m) {
  const rounded = Math.round(m * 100) / 100;
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded);
  return `${text}x`;
}

// Formats a 0-1 fraction as a percentage, showing a decimal only when the
// value actually needs one (5% stays "5%", but Lucky Skip's stacking 0.5%
// bumps show as "5.5%", "6%", "6.5%"...).
function formatPercent(fraction) {
  const rounded = Math.round(fraction * 1000) / 10;
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${text}%`;
}

// ---------- Perks ----------

// True while fewer than `max` copies of `id` are owned - used by a perk's
// available() to stop offering it once it's hit its stack cap.
function stackAvailable(state, id, max) {
  return state.perksOwned.filter((p) => p.id === id).length < max;
}

// Demolisher / Skipper: like First Instinct, an xMult perk - but instead of
// a fixed bonus gated by a per-turn condition, their own xMult starts at 0
// and permanently grows by a fixed step every time a specific action
// happens (deleting a perk via the trash can / skipping a card pack), never
// resetting. xMultCondition is unconditionally true - the growing value
// itself, not a per-turn trigger, is the whole mechanic - so it applies to
// every hand committed. Each owned copy tracks its own xMult independently
// and adds on top of the others, same as any other stacked xMult perk (see
// the ×1 baseline + additive-sum combine in commitScore()).
const DEMOLISHER_MULT_STEP = 0.25;
const SKIPPER_MULT_STEP = 0.1;
// Minimalist's own xMult isn't stored/grown like the two above - it's read
// live off state every time it's needed (see its xMult(state) function and
// resolveXMult()), so there's nothing to persist between commits.
const EMPTY_SLOT_MULT_STEP = 0.4;
const MINIMALIST_DESC = `Score +${EMPTY_SLOT_MULT_STEP}x Mult per empty perk slot. (Stacks)`;

// These 3 growing xMult perks' descriptions are static now - each card's own
// live current multiplier is already shown on its persistent badge (see
// renderPerks()'s "if (perk.xMult)" block), so the desc text itself no
// longer needs a per-instance "Current multiplier: xN" refresh. "Grows" is
// the deliberate wording for these 3 (and Streaker/Straight Shot below) -
// they're also the ones flagged cumulative: true, which shows the "↑"
// corner badge (see renderPerks()/buildCollectionCard()) so it's clear at a
// glance which cards accumulate forever vs. every other xMult card, which
// just applies the same fixed multiplier each time.
const DEMOLISHER_DESC = `Grows +${DEMOLISHER_MULT_STEP}x Mult per perk destroyed, however it happens. (Stacks)`;
const SKIPPER_DESC = `Grows +${SKIPPER_MULT_STEP}x Mult per card pack skipped. (Stacks)`;

// Grows every owned copy of `id` by `step` (rounded to avoid float drift
// from repeated 0.1/0.25 additions) - called once per trigger event (a
// delete, a skip), regardless of which specific card was deleted/which pack
// was skipped.
function growXMultPerk(id, step) {
  state.perksOwned.forEach((p) => {
    if (p.id !== id) return;
    p.xMult = Math.round((p.xMult + step) * 100) / 100;
  });
}

const STREAKER_MULT_STEP = 0.05;
const STREAKER_DESC = `Grows +${STREAKER_MULT_STEP}x Mult per streak hand. Resets to +0x on a scratch. (Stacks)`;

// Straight Shot: same growing shape as Demolisher/Skipper above (permanent,
// never resets) - but the trigger is scoring into a Straight category
// itself, so it's grown from inside commitScore() (see updateStraightShot())
// rather than from a global one-off event like a delete/skip. Still only
// ever APPLIES on that same kind of commit (xMultCondition below, unchanged
// from before) - growing it doesn't make it start affecting other hands too.
const STRAIGHT_SHOT_MULT_STEP = 0.2;
const STRAIGHT_SHOT_DESC = `Permanently adds +${STRAIGHT_SHOT_MULT_STEP}x Mult per Straight scored. Score by committing a Straight. (Stacks)`;

// Lowball's own xMult isn't stored/grown either - same live-read-off-state
// approach as Minimalist, just counting low dice in the hand actually being
// committed (see lowRollerBonus(), reused as-is - LOW_ROLLER_BONUS_PER_DIE
// is 1, so its return value already IS the raw low-die count).
const LOW_DICE_MULT_STEP = 0.15;
const LOWBALL_DESC = `Score +${LOW_DICE_MULT_STEP}x Mult per die showing 1, 2, or 3 this hand. (Stacks)`;

// Called once per main-game commitScore() - hit is whether that hand
// actually scored (thisTurnScore > 0) rather than scratching a category.
// Every owned Streaker copy grows together on a hit, or all reset together
// on a scratch - same "one global event, every copy reacts" shape as
// growXMultPerk(), just with a reset branch instead of always growing.
function updateStreaker(hit) {
  state.perksOwned.forEach((p) => {
    if (p.id !== "streaker") return;
    p.xMult = hit ? Math.round((p.xMult + STREAKER_MULT_STEP) * 100) / 100 : 0;
  });
}

// Straight Shot: grows every owned copy by STRAIGHT_SHOT_MULT_STEP whenever
// a hand is actually committed into a Straight category (its own
// xMultCondition, unchanged) - called from inside commitScore() itself
// (see there) rather than from a single global trigger point like
// Demolisher/Skipper's delete/skip, since "scoring a straight" only ever
// happens as part of a commit.
function growStraightShot(key, hit) {
  if (!hit || !["smallStraight", "largeStraight", "majorStraight"].includes(key)) return;
  growXMultPerk("straightShot", STRAIGHT_SHOT_MULT_STEP);
}

// Mulligan: one revert shared between Small Game 1 and Small Game 2 (using
// it in either one blocks the other - see mulliganUsedThisSmallPair, which
// startNextLevel() deliberately carries forward unchanged across that one
// transition instead of resetting it like every other per-level field), and
// a separate one for the Boss (mulliganUsedThisBoss, which does just reset
// fresh every startNextLevel() call, see newRunState()). mulliganSnapshot
// itself is deliberately NOT part of `state` - it needs to survive holding
// onto owned perk instances' own apply/remove/xMultCondition function
// references, which a plain JSON round-trip (or structuredClone) would
// drop or choke on.
let mulliganSnapshot = null;

function mulliganAvailable() {
  if (!state.perksOwned.some((p) => p.id === "mulligan")) return false;
  return state.phase === "main" ? !state.mulliganUsedThisBoss : !state.mulliganUsedThisSmallPair;
}

// Deep-clones plain data (objects/arrays/primitives), but copies a function
// value by reference instead of trying to recurse into it - the one thing
// a plain JSON.parse(JSON.stringify(...)) round-trip gets wrong for this
// state shape (it would silently drop every function property instead).
function cloneForMulligan(value) {
  if (Array.isArray(value)) return value.map(cloneForMulligan);
  if (value && typeof value === "object") {
    const copy = {};
    for (const k in value) copy[k] = cloneForMulligan(value[k]);
    return copy;
  }
  return value;
}

// Called from the very top of commitScore(), once every one of its own
// early-return guards has already passed - captures state exactly as it
// was right before this commit's own mutations begin, so a later revert
// can restore it precisely. Skipped entirely (and any previous snapshot
// invalidated) once Mulligan is unavailable, so a stale snapshot from
// earlier this level can never linger past its actual usefulness.
function captureMulliganSnapshot() {
  mulliganSnapshot = mulliganAvailable() ? cloneForMulligan(state) : null;
}

// Restores the last captured pre-commit snapshot, then resets the dice
// fields back to fresh regardless of what the snapshot itself held (it was
// taken with that hand's dice already thrown) - "re-roll that hand from
// scratch" means the player gets the same turn back, not the exact same
// already-rolled dice.
function useMulligan() {
  if (!mulliganSnapshot) return;
  const diceCount = mulliganSnapshot.diceCount;
  // Small games: if the commit being undone was the one that reached the
  // turn limit and opened the Card Pack shop (see showNextRoundPrompt()),
  // the snapshot itself predates that shop ever being rolled - it would
  // otherwise revert state.shopSlots back to empty and blank the shop back
  // to placeholder slots while the redo is in progress. Carried forward
  // here instead so the already-seen offer keeps showing (inert - still
  // gated on awaitingNextRound elsewhere - until the redo is genuinely
  // committed) rather than looking like it vanished.
  const liveShopSlots = state.shopSlots;
  const liveRefreshCost = state.refreshCost;
  const liveRerollCountThisShop = state.rerollCountThisShop;
  const liveShopPurchasesLocked = state.shopPurchasesLocked;
  // Third Time's the Charm: same "this shop's own bookkeeping, not the
  // reverted hand's" reasoning as the 4 fields above - a lock queued up by
  // this shop's own Refresh (or already being drained by it) predates
  // whatever hand is being undone, so it shouldn't be reverted away either.
  const liveThirdTimesCharmPendingBossLock = state.thirdTimesCharmPendingBossLock;
  const liveThirdTimesCharmLocksRemaining = state.thirdTimesCharmLocksRemaining;
  state = mulliganSnapshot;
  mulliganSnapshot = null;
  if (state.phase === "main") {
    state.mulliganUsedThisBoss = true;
  } else {
    state.mulliganUsedThisSmallPair = true;
    state.shopSlots = liveShopSlots;
    state.refreshCost = liveRefreshCost;
    state.rerollCountThisShop = liveRerollCountThisShop;
    state.shopPurchasesLocked = liveShopPurchasesLocked;
    state.thirdTimesCharmPendingBossLock = liveThirdTimesCharmPendingBossLock;
    state.thirdTimesCharmLocksRemaining = liveThirdTimesCharmLocksRemaining;
  }
  state.dice = freshDice(diceCount);
  state.dieRotation = freshDieRotations(diceCount);
  state.held = freshHeld(diceCount);
  state.rolled = false;
  state.rollsUsedThisTurn = 0;
  rollAnimationActive = false; // in case a throw was mid-animation when this was clicked
  renderAll();
  rollBtn.focus();
  saveState();
}

// Head Start's flat bonus, and Unfair Advantage's own (larger) flat bonus -
// Unfair Advantage no longer boosts Head Start, it replaces it outright
// (see its own entry below), so these are two independent constants now
// rather than one card scaling the other's amount.
const HEAD_START_BONUS = 100;
const UNFAIR_ADVANTAGE_BONUS = 200;

// Bulk Discount: flat $ off every Card Pack's base price - see
// effectiveCardPackPrice(), which takes this off BEFORE Fire Sale/Third
// Time's the Charm's percentage cuts apply on top of that already-lowered
// number, matching this card's own "default price" wording.
const BULK_DISCOUNT_AMOUNT = 2;

// Lucky Die: independent per-hand chances (see resolveLuckyDie(), called
// once from commitScore() itself - genuine randomness, unlike every other
// die-mod card, so it can't be a pure function the live scorecard preview
// safely re-evaluates on every render). All Luck (frequentFlyer) adds
// LUCKY_DIE_ALL_LUCK_BONUS to both, independently.
const LUCKY_DIE_MONEY_CHANCE = 0.05;
const LUCKY_DIE_DOUBLE_CHANCE = 0.05;
const LUCKY_DIE_ALL_LUCK_BONUS = 0.02;
const LUCKY_DIE_MONEY_AMOUNT = 10;

// Ordered to match the Card Collection's intended display order (see
// renderCollection) - PERK_POOL's own array order IS that display order,
// since the collection just iterates it directly. Sampling for level-up/
// pack offers is unaffected (samplePerks shuffles a copy).
const PERK_POOL = [
  {
    id: "extraReroll",
    name: "Extra Throw",
    desc: "+1 Throw on every turn in Bosses.",
    stacks: true,
    apply(state) { state.bonusRerolls += 1; },
    remove(state) { state.bonusRerolls -= 1; },
  },
  {
    id: "extraRound",
    name: "Extra Round",
    desc: "+1 Turn in Small games.",
    stacks: true,
    apply(state) { state.smallGameTurnLimit += 1; },
    remove(state) { state.smallGameTurnLimit -= 1; },
  },
  {
    id: "extraPerkSlot",
    name: "Extra Perk",
    desc: "Unlocks a new Perk slot.",
    stacks: true,
    // Doesn't render its own card (see renderPerks) - it only raises how
    // many slots effectivePerkSlotCount() reports, computed live from how
    // many copies are owned.
    apply() {},
    remove() {},
  },
  {
    id: "extraLife",
    name: "Extra Life",
    desc: "If you fail to reach a target, destroy this card and skip to next level.",
    stacks: false,
    // Doesn't stack - capped to a single copy.
    available(state) { return stackAvailable(state, "extraLife", 1); },
    // Consumed automatically by endLevel() on a miss, not through the
    // trash can, so it needs no ongoing effect of its own to apply/reverse.
    apply() {},
    remove() {},
  },
  {
    id: "extraDice",
    name: "Extra Dice",
    desc: "+1 Dice. (Stacks up to 2 times)",
    stacks: 2,
    available(state) { return stackAvailable(state, "extraDice", 2); },
    apply(state) { state.diceCount += 1; },
    remove(state) { state.diceCount -= 1; },
  },
  {
    id: "wildDie",
    name: "Wild Die",
    desc: "One of your dice becomes wild every 3rd round. It counts as whatever face scores best.",
    stacks: false,
    // Doesn't stack - capped to a single copy.
    available(state) { return stackAvailable(state, "wildDie", 1); },
    apply(state) {
      const allIndices = Array.from({ length: state.diceCount }, (_, i) => i);
      const free = allIndices.filter((i) => !state.wildIndices.includes(i));
      if (free.length) state.wildIndices.push(free[0]);
    },
    remove(state) { state.wildIndices.pop(); },
  },
  {
    id: "frequentFlyer",
    name: "All Luck",
    desc: `Wild Die triggers one round sooner. Hotline hits one more category. Adds +${formatPercent(LUCKY_DIE_ALL_LUCK_BONUS)} to both of Lucky Die's chances. (Does not stack)`,
    stacks: false, // presence-only check (some()), a 2nd copy would do nothing more
    available(state) { return stackAvailable(state, "frequentFlyer", 1); },
    apply() {}, // effect is recomputed live from perksOwned in effectiveWildActiveEvery() / doubleOrNothingTargetCount()
    remove() {},
  },
  {
    id: "easyTarget",
    name: "Steady Nerves",
    desc: "Slows target growth each level by -3%. 20% normally. (Stacks up to 2 times)",
    stacks: STEADY_NERVES_MAX_STACKS,
    // Only worth offering once you don't already have the max 2 stacks.
    available(state) { return stackAvailable(state, "easyTarget", STEADY_NERVES_MAX_STACKS); },
    apply() {}, // effect is recomputed live from perksOwned in computeMainTarget()
    remove() {},
  },
  {
    id: "moneyHand",
    name: "Small Change",
    desc: "In Boss, Scoring a hand with no active multiplier (No Mult, No Hotline) pays $1. Stacks.",
    stacks: true,
    apply() {}, // effect is recomputed live each commit in commitScore()
    remove() {},
  },
  {
    id: "doubleOrNothing",
    name: "Hotline",
    desc: "Every turn, multiplies the score of a random not-yet-filled category by 1.5x in Bosses, or the money from a random category by 1.5x in Small games. (Stacks up to 2 times)",
    stacks: 2,
    available(state) { return stackAvailable(state, "doubleOrNothing", 2); },
    apply() {}, // effect is recomputed live each turn via rerollDoubleTarget() / doubleOrNothingTargetCount()
    remove() {},
  },
  {
    id: "luckyMultiplier",
    name: "Lucky Number",
    desc: "+15% score on every category. (Stacks up to 2 times)",
    stacks: 2,
    available(state) { return stackAvailable(state, "luckyMultiplier", 2); },
    apply(state) { state.scoreMultiplier += 0.15; },
    remove(state) { state.scoreMultiplier -= 0.15; },
  },
  {
    id: "mulligan",
    name: "Mulligan",
    desc: "Undo your last throw and current hand. Usable once during Small games and once during Boss.",
    stacks: false, // presence-only check (some()), a 2nd copy would do nothing more
    available(state) { return stackAvailable(state, "mulligan", 1); },
    apply() {},
    remove() {},
  },
  {
    id: "leftovers",
    name: "Leftovers",
    desc: "Adds the face value of every die that didn't contribute to the category you scored. Adds score after multiplier, before X mult. (Stacks)",
    stacks: true,
    apply() {}, // effect is recomputed live from perksOwned in leftoversBonusFor()
    remove() {},
  },
  {
    id: "streakDie",
    name: "Streak Die",
    cumulative: true, // permanently growing bonus - see the "↑" corner badge in renderPerks()/buildCollectionCard()
    desc: `Marks one random die. Every hand where that die contributes to the category you commit, its own bonus gets added to your score - and in Bosses only, grows by +${STREAK_DIE_GROWTH_PER_HIT} first. (Does not stack)`,
    stacks: false, // presence-only check (some()), a 2nd copy would do nothing more
    available(state) { return stackAvailable(state, "streakDie", 1); },
    apply(state, instance) {
      instance.dieIndex = Math.floor(Math.random() * state.diceCount);
      instance.bonus = 0;
    },
    remove() {}, // bonus already banked into any past scores stays banked, nothing to reverse
  },
  {
    id: "startingBonus",
    name: "Head Start",
    desc: `Gain a flat ${HEAD_START_BONUS} bonus on level score while this perk is active.`,
    stacks: true,
    apply(state) { state.bonusPoints += HEAD_START_BONUS; },
    remove(state) { state.bonusPoints -= HEAD_START_BONUS; },
  },
  {
    id: "unfairAdvantage",
    name: "Unfair Advantage",
    tint: "orange",
    desc: `Replaces Head Start. Gain a flat ${UNFAIR_ADVANTAGE_BONUS} bonus on level score while this perk is active.`,
    requires: "Head Start",
    stacks: false, // presence-only check (some()), extra copies do nothing more
    // Only worth offering while Head Start is actually owned - there'd be
    // nothing for it to replace otherwise - and only once itself.
    available(state) {
      return state.perksOwned.some((p) => p.id === "startingBonus") && stackAvailable(state, "unfairAdvantage", 1);
    },
    // Replaces every owned Head Start copy outright (reversing each one's
    // own bonus first) rather than boosting them - Head Start and Unfair
    // Advantage are mutually exclusive from here on.
    apply(state) {
      state.perksOwned = state.perksOwned.filter((p) => {
        if (p.id !== "startingBonus") return true;
        state.bonusPoints -= HEAD_START_BONUS;
        return false;
      });
      state.bonusPoints += UNFAIR_ADVANTAGE_BONUS;
    },
    remove(state) { state.bonusPoints -= UNFAIR_ADVANTAGE_BONUS; },
  },
  {
    id: "sixthSense",
    name: "Sixth Sense",
    tint: "orange",
    desc: "+50% money from Three Pairs, Two Three of a Kinds, Six of a Kind, and Seven of a Kind. (Stacks up to 2 times) Needs Extra Dice to work.",
    requires: "Extra Dice",
    stacks: 2,
    // Only worth offering with at least one Extra Dice perk active, and below its own stack cap.
    available(state) { return state.diceCount > 5 && stackAvailable(state, "sixthSense", 2); },
    apply() {}, // effect is recomputed live from perksOwned in effectiveExtraCatMoneyMultiplier()
    remove() {},
  },
  {
    // X Multiplier perks (candy-red-tinted) each add their own bonus on top
    // of a flat ×1 baseline, only when their own condition is met - see
    // commitScore()'s xMult/xMultCondition handling. Stacks additively (2
    // copies of a +1x card plus the ×1 baseline = ×3 total, not ×1 applied
    // twice).
    id: "firstInstinct",
    name: "First Instinct",
    tint: "red",
    desc: "Score +1x Mult committing with no rerolls this turn (Stacks)",
    stacks: true,
    xMult: 1,
    xMultCondition(state) { return state.rollsUsedThisTurn === 1; },
    apply() {}, // the multiplication itself happens live in commitScore()
    remove() {},
  },
  {
    id: "demolisher",
    name: "Demolisher",
    tint: "red",
    cumulative: true, // permanently growing X mult - see the "↑" corner badge in renderPerks()/buildCollectionCard()
    desc: DEMOLISHER_DESC,
    stacks: true,
    xMult: 0,
    xMultCondition() { return true; }, // no per-turn gate - the ever-growing xMult itself is the mechanic
    apply() {}, // fresh instance always starts at +0x - its own badge (see renderPerks) already shows the live current value, the desc no longer needs syncing
    remove() {},
  },
  {
    id: "skipper",
    name: "Skipper",
    tint: "red",
    cumulative: true, // see Demolisher's comment above
    desc: SKIPPER_DESC,
    stacks: true,
    xMult: 0,
    xMultCondition() { return true; },
    apply() {},
    remove() {},
  },
  {
    id: "minimalist",
    name: "Minimalist",
    tint: "red",
    desc: MINIMALIST_DESC,
    stacks: true,
    // A function instead of a plain number - read live off state every time
    // it's needed (see resolveXMult()) rather than stored/grown on the
    // instance, since "how many slots are empty right now" can change from
    // any perk pick/delete/replace, not just this card's own actions.
    xMult(state) {
      const occupied = state.perksOwned.filter(isSlotOccupyingPerk).length;
      const empty = Math.max(0, effectivePerkSlotCount() - occupied);
      return Math.round(EMPTY_SLOT_MULT_STEP * empty * 100) / 100;
    },
    xMultCondition() { return true; },
    apply() {},
    remove() {},
  },
  {
    id: "streaker",
    name: "Streaker",
    tint: "red",
    cumulative: true, // see Demolisher's comment above
    desc: STREAKER_DESC,
    stacks: true,
    xMult: 0,
    xMultCondition() { return true; },
    apply() {},
    remove() {},
  },
  {
    id: "uppercut",
    name: "Uppercut",
    tint: "red",
    desc: "Score +0.5x Mult scoring an upper category. (Ones - Sixes) (Stacks)",
    stacks: true,
    xMult: 0.5,
    xMultCondition(state, key) { return UPPER_CATS.some((c) => c.key === key); },
    apply() {},
    remove() {},
  },
  {
    id: "milestone",
    name: "Milestone",
    tint: "red",
    desc: "Score +2x Mult on turns 5, 10, and 15. (Stacks)",
    stacks: true,
    xMult: 2,
    xMultCondition(state) { return state.phase === "main" && [5, 10, 15].includes(state.turn); },
    apply() {},
    remove() {},
  },
  {
    id: "straightShot",
    name: "Straight Shot",
    tint: "red",
    cumulative: true, // permanently growing X mult - see the "↑" corner badge in renderPerks()/buildCollectionCard()
    desc: STRAIGHT_SHOT_DESC,
    stacks: true,
    xMult: 0,
    xMultCondition(state, key) { return ["smallStraight", "largeStraight", "majorStraight"].includes(key); },
    apply() {},
    remove() {},
  },
  {
    id: "lowball",
    name: "Lowball",
    tint: "red",
    desc: LOWBALL_DESC,
    stacks: true,
    xMult(state) {
      const lowDiceCount = lowRollerBonus(state.dice, activeWildIndices());
      return Math.round(LOW_DICE_MULT_STEP * lowDiceCount * 100) / 100;
    },
    xMultCondition() { return true; }, // always "active" - the live count itself naturally floors at the +0x baseline
    apply() {},
    remove() {},
  },
  {
    id: "fullHouseMult",
    name: "Full House",
    tint: "red",
    desc: "Score +0.5x Mult when the hand forms a Full House, Commit any category. (Stacks)",
    stacks: true,
    xMult: 0.5,
    xMultCondition(state) { return bestScoreForCategory("fullHouse", state.dice, activeWildIndices()) > 0; },
    apply() {},
    remove() {},
  },
  {
    id: "allIn",
    name: "All In",
    tint: "red",
    desc: "Score +1x Mult every hand, fixed, doesn't grow. Lose 1 Throw per turn in Bosses. (Stacks)",
    stacks: true,
    xMult: 1,
    xMultCondition() { return true; },
    apply(state) { state.bonusRerolls -= 1; },
    remove(state) { state.bonusRerolls += 1; },
  },
];

// ---------- Rule cards (Rule Pack) ----------

// How many main games a Savings Bond copy locks its money up for before
// paying back double - referenced by its own desc text, the rule
// inventory's per-copy "games left" display, and the maturity check in
// startNextLevel(), so all 3 always agree with each other.
const SAVINGS_BOND_MATURITY_GAMES = 3;

// Which reroll of the shop Third Time's the Charm's discount kicks in on,
// 0-based (index 1 = the 2nd reroll, landing on the 3rd set of offers) -
// referenced by its own desc text, refreshShopSlots() (arms the boss-shop
// lock) and hasThirdTimesCharmDiscount() (checked live off
// rerollCountThisShop once it's past this point), so all 3 always agree on
// which reroll it is. THIRD_TIMES_CHARM_DISCOUNT is how much cheaper every
// pack in the shop is once that's happened.
const THIRD_TIMES_CHARM_TRIGGER_REROLL_INDEX = 1;
const THIRD_TIMES_CHARM_DISCOUNT = 0.5;

// Fire Sale: how many shop presentations the discount covers (the shop it's
// bought in counts as the first one), and how much it takes off. Doesn't
// stack (see its RULE_POOL entry's available()) - a 2nd copy would only
// risk pushing the discount past 100%, so simplicity wins over letting
// copies extend the duration instead.
const FIRE_SALE_SHOPS = 4;
const FIRE_SALE_DISCOUNT = 0.3;

// Compound Interest: $COMPOUND_INTEREST_PER_STEP for every
// $COMPOUND_INTEREST_STEP currently held, paid once every main game (boss)
// concluded from the moment it's picked onward - see startNextLevel()'s
// "main just finished" branch. Never retroactively for a boss that already
// concluded before it was bought.
const COMPOUND_INTEREST_STEP = 10;
const COMPOUND_INTEREST_PER_STEP = 1;

// Golden Touch: chance per Card Pack purchase to refund half its cost.
const GOLDEN_TOUCH_CHANCE = 0.1;

// Rule cards are a separate pool offered by the purple Rule (3) pack, picked
// via its own confirm flow rather than applying instantly on click (some
// need a follow-up choice, like which perk to scrap). "persistent" ones
// become an owned perk instance (reusing all the normal perk machinery -
// display, drag reorder, trash deletion); the rest just fire their apply()
// once and leave nothing behind to remove later.
// Display/Collection order (and tint grouping) is deliberate, not just
// insertion order: destructive cards first, then temporary/expiring cards
// (pink tint), then the permanent base-value boosts in their own fixed
// order, then everything else (blue tint). See tint usage in
// renderRuleInventory()/renderRuleOfferModal()/renderCollection().
const RULE_POOL = [
  {
    id: "cleanSlate",
    name: "Clean Slate",
    desc: "Removes a random owned perk. Pays $20 per perk card you currently own.",
    persistent: false,
    stacks: false, // instant one-shot effect, no owned instance to accumulate
    apply(state) {
      // Rule cards (persistent instances like High Stakes) aren't perks and
      // are kept separate from the perk-removal pool, same as Extra Perk
      // (isSlotOccupyingPerk's other exclusion) - it never renders its own
      // card anywhere in the game, so it can't sensibly be "the perk that
      // got randomly destroyed" either, same reasoning as
      // isEdictDestroyablePerk()'s own exclusion. Payout is based on how
      // many perk cards were owned before this one gets removed - shielded
      // ones still count toward it (you still own the card), they just
      // can't be the one actually picked below.
      const removableIndices = state.perksOwned
        .map((p, i) => i)
        .filter((i) => isSlotOccupyingPerk(state.perksOwned[i]));
      state.money += 20 * removableIndices.length;
      const destroyableIndices = removableIndices.filter((i) => !state.perksOwned[i].shielded);
      if (destroyableIndices.length > 0) {
        removePerkInstance(destroyableIndices[Math.floor(Math.random() * destroyableIndices.length)]);
      }
    },
  },
  {
    id: "selectiveCut",
    name: "Selective Cut",
    desc: "Choose one owned perk to remove. Gain $40.",
    persistent: false,
    needsPerkSelection: true,
    stacks: false, // instant one-shot effect, no owned instance to accumulate
    apply(state, instance, selectedPerkIndex) {
      if (selectedPerkIndex != null && state.perksOwned[selectedPerkIndex]) {
        removePerkInstance(selectedPerkIndex);
      }
      state.money += 40;
    },
  },
  {
    id: "oooShiny",
    name: "Ooo Shiny",
    desc: "Randomly destroys half of your owned perks. Uneven amount rounds down. Destroys max 3 Perks. Lets you choose one of the survivors to make shiny.",
    persistent: false,
    needsPerkSelection: true,
    // Each pick genuinely can turn a different perk shiny (and costs more
    // random ones) - it does stack in effect, but `stacks` here only drives
    // the Collection screen's "(stacks)" badge, so it's left false to hide
    // that badge specifically for this card.
    stacks: false,
    apply(state, instance, selectedPerkIndex) {
      // The random removal targets were already rolled the moment this card
      // was selected (see oooShinyRemovedPerks) so the picker could offer
      // only the perks that would actually survive - grab the chosen perk
      // by reference before removing anything, since removePerkInstance()
      // splices the array and would shift tracked indices out from under it.
      const chosen = selectedPerkIndex != null ? state.perksOwned[selectedPerkIndex] : null;
      oooShinyRemovedPerks.forEach((removedPerk) => {
        const removeAt = state.perksOwned.indexOf(removedPerk);
        if (removeAt !== -1) removePerkInstance(removeAt);
      });
      if (!chosen) return;
      chosen.shiny = true;
    },
  },
  {
    id: "savingsBond",
    name: "Savings Bond",
    tint: "pink",
    desc: `Locks up all your money right now. Pays it back doubled once ${SAVINGS_BOND_MATURITY_GAMES} Bosses have passed. Money earned after locking it in is still yours to spend freely.`,
    persistent: true,
    stacks: true, // each pick locks up whatever cash you're holding at that moment, independently
    apply(state, instance) {
      instance.lockedAmount = state.money;
      instance.mainGamesElapsed = 0;
      state.money = 0;
    },
    // Reverses the lock if this copy is ever destroyed before maturing
    // (e.g. via a future removal path) - refunds exactly what was taken,
    // no bonus, since it never matured.
    remove(state, instance) { state.money += instance.lockedAmount || 0; },
  },
  {
    id: "makeItCount",
    name: "Make it count",
    tint: "pink",
    desc: `Multiplies the money earned from every hand scored in a small game by ${1 + MAKE_IT_COUNT_MONEY_MULT_PER_STACK}x per active copy, but the main game gets 2 fewer turns. Lasts 3 games. (Stacks)`,
    persistent: true,
    stacks: true,
    apply(state, instance) { instance.gamesRemaining = 3; },
    remove() {}, // both effects are recomputed live from perksOwned, nothing to reverse
  },
  {
    id: "sabotage",
    name: "Sabotage",
    tint: "pink",
    desc: "Blocks your highest-multiplier category for the next Boss. Gain $35.",
    persistent: false,
    stacks: true, // repeated picks compound (each blocks another category)
    // Doesn't pick a category yet - just banks a stack. Which categories
    // actually get blocked is resolved by resolveSabotageBlocks(), called
    // right as the main game begins, using categoryBonus/diceCount as they
    // stand at that instant.
    apply(state) {
      state.sabotageStacks = (state.sabotageStacks || 0) + 1;
      state.money += 35;
    },
  },
  {
    id: "fireSale",
    name: "Fire Sale",
    tint: "pink",
    desc: `Every Card Pack in the shop is ${formatPercent(FIRE_SALE_DISCOUNT)} cheaper for the next ${FIRE_SALE_SHOPS} shops (the one you're in now counts as the first).`,
    persistent: true,
    stacks: false, // presence-only check (some()) - a 2nd copy risks pushing the discount past 100%
    available(state) { return stackAvailable(state, "fireSale", 1); },
    apply(state, instance) { instance.shopsRemaining = FIRE_SALE_SHOPS; },
    remove() {}, // effect is recomputed live from perksOwned/shopsRemaining, nothing to reverse
  },
  {
    id: "highStakes",
    name: "High Stakes",
    tint: "pink",
    desc: "Adds 2% to the main game's per-level target growth rate (e.g. 20% becomes 22%, stacks). Doubles your money right now.",
    persistent: true,
    stacks: true,
    apply(state) {
      state.money *= 2;
    },
  },
  {
    id: "coinDie",
    name: "Coin Die",
    tint: "pink",
    desc: `Adds a coin to a random die face. Commit a hand with coin and gain $${COIN_DIE_PAYOUT}. (Stacks)`,
    persistent: true,
    stacks: true,
    apply(state, instance) {
      instance.dieIndex = Math.floor(Math.random() * state.diceCount);
      instance.faceValue = 1 + Math.floor(Math.random() * 6);
    },
    remove() {}, // dieIndex/faceValue picked once at draw time, nothing to reverse
  },
  {
    id: "luckyDie",
    name: "Lucky Die",
    tint: "pink",
    desc: `Marks one random die Lucky. Any hand it contributes to has a ${formatPercent(LUCKY_DIE_MONEY_CHANCE)} chance to pay $${LUCKY_DIE_MONEY_AMOUNT}, and a separate ${formatPercent(LUCKY_DIE_DOUBLE_CHANCE)} chance to double the whole final score. (Does not stack)`,
    persistent: true,
    stacks: false, // presence-only check (some()), a 2nd copy would do nothing more
    available(state) { return stackAvailable(state, "luckyDie", 1); },
    apply(state, instance) {
      instance.dieIndex = Math.floor(Math.random() * state.diceCount);
    },
    remove() {}, // nothing ongoing to reverse - each activation was its own one-off event
  },
  {
    id: "compoundInterest",
    name: "Compound Interest",
    tint: "pink",
    desc: `After every boss you clear from now on, gain $${COMPOUND_INTEREST_PER_STEP} for every $${COMPOUND_INTEREST_STEP} you currently have.`,
    persistent: true,
    stacks: false, // presence-only check (some()), a 2nd copy would do nothing more
    available(state) { return stackAvailable(state, "compoundInterest", 1); },
    apply() {}, // effect is recomputed live from perksOwned in startNextLevel()
    remove() {},
  },
  {
    id: "storeExpansion",
    name: "Store Expansion",
    tint: "pink",
    desc: "Adds a 4th Card Pack slot to every shop.",
    persistent: true,
    stacks: false, // presence-only check (some()) - a 2nd copy would do nothing more (only one extra slot exists to unlock)
    available(state) { return stackAvailable(state, "storeExpansion", 1); },
    apply() {}, // effect is recomputed live from perksOwned in rollShopSlots()/effectiveShopSlotCount()
    remove() {},
  },
  {
    id: "bulkDiscount",
    name: "Bulk Discount",
    tint: "pink",
    desc: `Lowers every Card Pack's default price by $${BULK_DISCOUNT_AMOUNT}.`,
    persistent: true,
    stacks: false, // presence-only check (some()), a 2nd copy would do nothing more
    available(state) { return stackAvailable(state, "bulkDiscount", 1); },
    apply() {}, // effect is recomputed live from perksOwned in effectiveCardPackPrice()
    remove() {},
  },
  {
    id: "blueDie",
    name: "Blue Die",
    desc: "Paints one die's dots dark blue. Commit a hand with that die contributing, and its face value gets added to your score too. (Stacks up to 3 times)",
    persistent: true,
    stacks: 3,
    available(state) { return stackAvailable(state, "blueDie", 3); },
    apply(state, instance) {
      instance.dieIndex = Math.floor(Math.random() * state.diceCount);
    },
    remove() {}, // bonus already banked into any past scores stays banked, nothing to reverse
  },
  {
    id: "basePoints",
    name: "Base Points",
    desc: `Adds +${BASE_POINTS_BONUS} points to one random category's score. (Stacks)`,
    persistent: true,
    stacks: true,
    apply(state, instance) {
      const pool = [...UPPER_CATS, ...LOWER_CATS, ...EXTRA_CATS.filter((cat) => state.diceCount >= cat.minDice)];
      instance.categoryKey = pool[Math.floor(Math.random() * pool.length)].key;
    },
    remove() {}, // bonus already banked into any past scores stays banked, nothing to reverse
  },
  {
    id: "handPairs",
    name: "Pairs",
    desc: `Adds +${HAND_PAIR_BONUS} points to any hand you commit if the dice contain a Pair. (Stacks)`,
    persistent: true,
    stacks: true,
    apply() {}, // effect is recomputed live from perksOwned in handPatternBonus()
    remove() {},
  },
  {
    // Named "Trips" (not "Threes") to avoid colliding with the actual
    // "Threes" upper-section category - same for "Quads" below vs "Fours".
    id: "handTrips",
    name: "Trips",
    desc: `Adds +${HAND_TRIPS_BONUS} points to any hand you commit if the dice contain a Three of a Kind. (Stacks)`,
    persistent: true,
    stacks: true,
    apply() {},
    remove() {},
  },
  {
    id: "handQuads",
    name: "Quads",
    desc: `Adds +${HAND_QUADS_BONUS} points to any hand you commit if the dice contain a Four of a Kind. (Stacks)`,
    persistent: true,
    stacks: true,
    apply() {},
    remove() {},
  },
  {
    id: "sixSeven",
    name: "Six-Seven",
    desc: "Adds +10 points to Six of a Kind and Seven of a Kind. Lowers Five of a Kind's score by 15. (Stacks)",
    persistent: true,
    stacks: true,
    apply() {}, // effect is recomputed live from perksOwned in applySixSevenBonus()
    remove() {},
  },
  {
    id: "handStraights",
    name: "Straights",
    desc: `Adds +${HAND_STRAIGHT_BONUS} points to any hand you commit if the dice contain a Straight of any kind. (Stacks)`,
    persistent: true,
    stacks: true,
    apply() {},
    remove() {},
  },
  {
    id: "handLowRoller",
    name: "Low Roller",
    desc: `Adds +${LOW_ROLLER_BONUS_PER_DIE} point per die showing 1, 2, or 3 (Stacks).`,
    persistent: true,
    stacks: true,
    apply() {}, // effect is recomputed live from perksOwned in handPatternBonus()
    remove() {},
  },
  {
    id: "luckySkip",
    name: "Lucky Skip",
    tint: "blue",
    desc: `Every time you skip a card pack, adds ${formatPercent(LUCKY_SKIP_BONUS_PER_STACK)} to Shiny, Boosted, and Mega chance. (Stacks)`,
    persistent: true,
    stacks: true,
    apply() {}, // the actual bonus is banked into state.luckySkipBonus by skipPackOffer() itself, per skip event
    remove() {}, // bonus already earned from past skips is permanent, never reversed
  },
  {
    id: "thirdTimesTheCharm",
    name: "Third Time's the Charm",
    tint: "blue",
    desc: `3rd Set of shops offer all packs -${formatPercent(THIRD_TIMES_CHARM_DISCOUNT)} for the rest of the game. But the next shops after Boss are locked.`,
    persistent: true,
    stacks: false, // presence-only check (some()), a 2nd copy would do nothing more
    available(state) { return stackAvailable(state, "thirdTimesTheCharm", 1); },
    apply() {}, // effect is recomputed live from perksOwned in refreshShopSlots() / hasThirdTimesCharmDiscount() / startNextLevel()
    remove() {},
  },
  {
    id: "goldenTouch",
    name: "Golden Touch",
    tint: "blue",
    desc: `Every Card Pack purchase has a ${formatPercent(GOLDEN_TOUCH_CHANCE)} chance to refund half its cost.`,
    persistent: true,
    stacks: false, // presence-only check (some()), a 2nd copy would do nothing more
    available(state) { return stackAvailable(state, "goldenTouch", 1); },
    apply() {}, // the refund roll happens live in openCardPack() per purchase
    remove() {},
  },
];

// Rule cards that remove one of your own perks - visually flagged red
// wherever they're shown so their destructive cost is obvious at a glance.
const DESTRUCTIVE_RULE_IDS = ["cleanSlate", "selectiveCut", "oooShiny"];

// Rule cards capped at a single copy (see each one's own available():
// stackAvailable(state, id, 1)) that then stick around permanently for the
// rest of the run once picked - unlike Fire Sale (also capped at 1, but
// expires after FIRE_SALE_SHOPS shops) or the destructive/Sabotage cards
// above (never owned at all - they apply once instantly, see
// renderRuleOfferModal()'s own !rule.persistent check). Flagged "(one time)"
// wherever these are shown, since picking a 2nd copy was never on the table
// to begin with.
const UNIQUE_PERMANENT_RULE_IDS = ["compoundInterest", "thirdTimesTheCharm", "goldenTouch", "storeExpansion", "bulkDiscount", "luckyDie", "streakDie"];

// Small corner-badge glyph shown on every rule card, matching its color
// group: red (destructive) = x, pink (tint) = $, blue (tint) = ?, purple
// (untinted - the base-value-boost family) = +.
function ruleCardIcon(rule) {
  if (DESTRUCTIVE_RULE_IDS.includes(rule.id)) return "×";
  if (rule.tint === "pink") return "$";
  if (rule.tint === "blue") return "?";
  return "+";
}

// 1 owned -> 0 (unusable), 2-3 -> 1, 4-5 -> 2, 6+ -> 3 (capped).
function oooShinyRemovalCount(removableCount) {
  return Math.min(3, Math.floor(removableCount / 2));
}

function samplePerks(state, n) {
  const pool = PERK_POOL.filter((perk) => !perk.available || perk.available(state));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

function isDoubleTarget(key) {
  return (state.doubleTargets || []).includes(key);
}

// Hotline's per-category multiplier (score in the main game, money in small
// games) - not a literal double anymore, hence the rename away from "Double
// or Nothing".
const HOTLINE_MULTIPLIER = 1.5;

// All Luck no longer stacks at all (see its PERK_POOL entry) - a 2nd copy
// can't even be owned, but this stays a presence check (some()) rather than
// a flat +1, matching how the card is defined everywhere else.
function doubleOrNothingTargetCount() {
  const donCount = activePerksOwned().filter((p) => p.id === "doubleOrNothing").length;
  const flyerBonus = activePerksOwned().some((p) => p.id === "frequentFlyer") ? 1 : 0;
  return donCount + flyerBonus;
}

// Hotline picks a fresh random category (two, with All Luck) every turn -
// not-yet-filled ones in the main game (since its effect multiplies score,
// and a filled category can't be re-scored), or any category at all in
// small games (since there its effect multiplies money, and repeat throws
// into an already-used category still pay out there). Called at every turn
// boundary (see commitScore/startNextLevel) rather than baked in at pick
// time, same live-recompute pattern as the other gated perks.
function rerollDoubleTarget() {
  const hasPerk = activePerksOwned().some((p) => p.id === "doubleOrNothing");
  if (!hasPerk) {
    state.doubleTargets = [];
    return;
  }
  const pool = state.phase === "main"
    ? activeCategories().filter((cat) => state.scorecard[cat.key] == null)
    : lowerCategories();

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const count = Math.min(doubleOrNothingTargetCount(), shuffled.length);
  state.doubleTargets = shuffled.slice(0, count).map((cat) => cat.key);
}

// ---------- Main game modifiers (placeholder) ----------

// Boss modifiers - one gets randomly picked fresh every time a main game
// starts (see startNextLevel()), displayed above the hand banner while
// state.phase is "main" (see renderMainGameModifier()). Each has a unique
// gameplay feature, dispatched off its own `id` - activeBossModifier()
// resolves the current one from state.mainGameModifierIndex, and its actual
// effect lives wherever that id gets checked (e.g. rollDice() for
// "theWarden"/"theTempest"). `category` drives which color a boss renders
// in (see renderMainGameModifier()/renderBosses()) - "dice" bosses mess
// with the dice themselves, "perk" bosses mess with an owned perk instead.
const MAIN_GAME_MODIFIERS = [
  {
    id: "theWarden",
    title: "The Warden",
    category: "dice",
    desc: "Right after your first throw each hand, The Warden locks one random die in place. It can't be thrown again that turn.",
  },
  {
    id: "theTempest",
    title: "The Tempest",
    category: "dice",
    desc: "Right after your first throw, The Tempest forces one random die to reroll once more - you can't hold it until after that next throw.",
  },
  {
    id: "theVice",
    title: "The Vice",
    category: "dice",
    desc: "The moment you lock a die and throw, The Vice cements whatever's currently held in place for the rest of that hand.",
  },
  {
    id: "theVoid",
    title: "The Void",
    category: "dice",
    desc: "Roll one die to find out which face The Void consumes. Consumed face becomes blank.",
  },
  {
    id: "theWeight",
    title: "The Weight",
    category: "dice",
    // See rollFace()/WEIGHTED_DIE_FACE_CHANCES - every real throw for the
    // whole level uses these odds instead of the normal uniform 1-in-6 each.
    desc: "The Weight loads every die against you for the whole level. Low faces favored on every throw.",
  },
  {
    id: "theCensor",
    title: "The Censor",
    category: "perk",
    desc: "The Censor keeps one random eligible perk silenced. Every turn it chooses a perk to silence randomly.",
  },
  {
    id: "theEdict",
    title: "The Edict",
    category: "perk",
    desc: "Before you can enter, The Edict makes you choose one owned perk to destroy. That perk is gone for the rest of the run.",
  },
  {
    id: "theGatekeeper",
    title: "The Gatekeeper",
    category: "hand",
    desc: "Every turn, The Gatekeeper blocks 3 random unfilled categories. Once only 5 turns remain in the level, it backs off and leaves the board open.",
  },
  {
    id: "theCuller",
    title: "The Culler",
    category: "hand",
    desc: "The Culler removes your 2 most-boosted categories from play. Every other category is raised by +0.2x in exchange.",
  },
  {
    id: "theTurnkey",
    title: "The Turnkey",
    category: "hand",
    desc: "Commit the same category over and over, as many times as you want. But once you've touched 4 different categories, The Turnkey locks every other one. No chance allowed.",
  },
  {
    id: "theTaxman",
    title: "The Taxman",
    category: "money",
    desc: "Reaching the target early still ends your turns the moment it happens - The Taxman just makes sure none of those leftover throws convert into money. Coin Die and Lucky Die's money don't get past him either.",
  },
  {
    id: "theLandlord",
    title: "The Landlord",
    category: "money",
    desc: "The Landlord charges $2 rent the instant every turn begins, whether you can afford it or not. Your money is allowed to go negative while the rent is due.",
  },
  {
    id: "theHourglass",
    title: "The Hourglass",
    category: "turns",
    desc: "The Hourglass shaves 2 turns off the level's limit before you've even thrown a single die.",
  },
  {
    id: "theUndertaker",
    title: "The Undertaker",
    category: "turns",
    desc: "Every other turn, The Undertaker takes one reroll away. Your full throw allowance is back the turns in between.",
  },
  {
    id: "theThief",
    title: "The Thief",
    category: "dice",
    // Its own grey instead of the plain default dice-category purple - see
    // .tint-grey (mainGameModifier()/renderNextBossLabel()/renderBosses())
    // and startNextLevel()'s diceCountForNewLevel, the ONE thing that
    // actually enacts this (a temporary state.diceCount - 1 for the whole
    // level, restored the instant it ends - every other dice-count-aware
    // system, from EXTRA_CATS eligibility to the tray itself, already reads
    // that value live, so nothing else needed to change).
    tint: "grey",
    desc: "The Thief steals one random die the moment the level begins. It's gone for the whole Boss.",
  },
];

// Which owned perks a "perk" boss (The Censor/The Edict) can actually
// silence - scoped to perks whose effect is read fresh from state.perksOwned
// every time it matters (money bonuses, the xMult framework, wild-die/
// Hotline target selection), never a perk like Extra Throw/Lucky Number
// whose bonus gets folded into a permanent stat once at pick time (state.
// bonusRerolls/scoreMultiplier) - silencing one of those would mean
// reversing and later reapplying that stat, which is a much riskier
// mutation than simply skipping the perk in a filter for one turn/level.
const BOSS_BLOCKABLE_PERK_IDS = [
  "moneyHand", "sixthSense", "frequentFlyer", "doubleOrNothing",
  "firstInstinct", "demolisher", "skipper", "minimalist", "streaker", "uppercut", "milestone",
];

// Deliberately does NOT check p.shielded - a Perk Shield Token protects a
// perk from being destroyed (see isEdictDestroyablePerk()/removePerkInstance()
// callers below), never from The Censor's temporary per-turn/level silencing,
// which doesn't remove anything from state.perksOwned at all.
function isBossBlockablePerk(p) {
  return BOSS_BLOCKABLE_PERK_IDS.includes(p.id);
}

// Which owned perks The Edict's picker (see renderEdictPicker()) actually
// offers to destroy - normal perk-slot cards only (same scope as
// isSlotOccupyingPerk()): excludes Extra Perk, which never renders its own
// card anywhere else in the game and would be a strange, out-of-place
// "sacrifice" to suddenly show as one, and excludes persistent rule/gamerule
// cards (Savings Bond, High Stakes, etc.) - The Edict forces trashing a
// perk, not a rule card. Used both to build the picker's own option list
// and to gate every "is there anything to show the picker for at all"
// check (rollDice(), startNextLevel(), the reload-resume check) -
// otherwise a player who only owns Extra Perk copies and/or rule cards
// would get a mandatory picker with nothing clickable in it.
// Deliberately does NOT check p.shielded - The Edict's mandatory sacrifice
// is a deliberate, player-CHOSEN removal (the player picks exactly which
// card to lose), and a Perk Shield Token only protects against RANDOM
// destruction (Clean Slate/Ooo Shiny) - see hasSelectiveCutTarget's own
// comment in renderRuleOfferModal() for the exact same reasoning applied to
// Selective Cut, the other deliberate-pick destructive rule.
function isEdictDestroyablePerk(p) {
  return p.id !== "extraPerkSlot" && !p.persistent;
}

// The one perk instance currently silenced by The Censor (or null) -
// freshly re-picked (see pickNewCensorTarget()) the moment the level
// starts and again every time a hand gets allocated to a category. The
// Edict has no equivalent here - its mandatory pre-level choice destroys a
// perk outright (see renderEdictPicker()), so there's nothing left to
// silence/filter once it's resolved, the perk is simply gone from
// state.perksOwned already.
function currentlyBlockedPerkInstanceId() {
  const boss = activeBossModifier();
  if (!boss) return null;
  if (boss.id === "theCensor") return state.bossBlockedPerkInstanceId;
  return null;
}

// The Censor's own re-pick, called once when a level with this boss begins
// (see startNextLevel()) and again every time a hand gets committed (see
// commitScore()) - always lands on SOME eligible perk if one's owned, or
// null if nothing eligible is currently owned. Deliberately excludes
// whichever instance is already silenced from its own re-roll (as long as
// there's at least one other eligible perk to switch to) - a genuinely
// different perk each time, not a coin flip that often just repicks itself.
function pickNewCensorTarget() {
  const eligiblePerks = state.perksOwned.filter(isBossBlockablePerk);
  if (eligiblePerks.length === 0) {
    state.bossBlockedPerkInstanceId = null;
    return;
  }
  const pool = eligiblePerks.length > 1
    ? eligiblePerks.filter((p) => p.instanceId !== state.bossBlockedPerkInstanceId)
    : eligiblePerks;
  state.bossBlockedPerkInstanceId = pool[Math.floor(Math.random() * pool.length)].instanceId;
}

// state.perksOwned with whichever single instance is currently boss-
// silenced removed - every scoring/money/wild-selection check that should
// respect a "perk" boss reads through this instead of state.perksOwned
// directly. Persistent rule-card instances are never eligible for blocking
// in the first place, so filtering them out here would never matter, but
// this only ever removes at most the one specifically blocked id anyway.
function activePerksOwned() {
  const blockedId = currentlyBlockedPerkInstanceId();
  if (blockedId == null) return state.perksOwned;
  return state.perksOwned.filter((p) => p.instanceId !== blockedId);
}

// Resolves the current run's active boss (or null outside the main phase /
// before one's been rolled) - shared by every boss-specific feature check.
// A Boss Skip Token (see USABLE_POOL/activateUsable()) neutralizes the boss
// for the rest of the level entirely through this one choke point: every
// live, per-turn boss check (dice/perk/hand/money/turns) reads its category
// off activeBossModifier()?.id, so returning null here once
// state.bossEffectSkipped is set silently deactivates all of them with no
// other call site needing its own awareness of the token. The two
// exceptions are effects baked into state ONCE at level start rather than
// re-checked live - The Thief's stolen die and any already-resolved forced
// choice (The Edict's sacrifice, The Void's rolled face) - which
// activateUsable() must undo/ignore explicitly since nulling this getter
// can't retroactively un-happen them.
function activeBossModifier() {
  if (state.phase !== "main" || state.mainGameModifierIndex == null || state.bossEffectSkipped) return null;
  return MAIN_GAME_MODIFIERS[state.mainGameModifierIndex] || null;
}

// ---------- Usable items ----------

// One-time-use items, sold only from the boss-only shop slot (see
// renderPackShop()'s "main" branch, pickRandomUsableId(), buyBossUsable())
// - unlike perks/rule cards these never occupy a perk-slot; owned copies
// live in state.usablesOwned and are listed in the sidebar's "Usables"
// panel (renderUsableInventory()), where clicking an activatable one spends
// it immediately (see activateUsable()).
const USABLE_POOL = [
  {
    id: "bossSkipToken",
    name: "Boss Skip Token",
    desc: "Activate before your first throw in a Boss to skip its effect for the rest of the level, as if no Boss modifier were active at all.",
    cost: 40,
  },
  {
    id: "freeRerollToken",
    name: "Free Reroll Token",
    desc: "Activate during a Card Pack shop to make its next Refresh cost $0. Comes with 3 uses - spent one at a time, removed once all 3 are gone.",
    cost: 20,
    // Starting charge count for a freshly-bought instance (see
    // buyBossUsable()) - NOT itself a live count, that lives on the owned
    // instance (instance.charges, decremented by activateUsable()).
    charges: 3,
  },
  {
    id: "doubleDownToken",
    name: "Double Down Token",
    desc: "Activate any time to double whatever score your very next committed hand banks.",
    cost: 15,
  },
  {
    id: "perkRerollToken",
    name: "Perk Reroll Token",
    desc: "Activate to pick one owned perk and reroll it into a random new one.",
    cost: 15,
  },
  {
    id: "perkShieldToken",
    name: "Perk Shield Token",
    desc: "Activate to pick one owned perk and shield it. Clean Slate and Ooo Shiny can no longer randomly destroy it - deliberate removal (The Edict, Selective Cut, trashing it, or replacing it with another perk) still can.",
    cost: 30,
  },
];

// Picks which USABLE_POOL item the boss shop slot will offer - used both by
// newRunState() (the very first boss the run will ever reach) and
// startNextLevel()'s "main just finished" branch (every boss after that),
// both pre-rolling a full cycle ahead into nextBossUsableOffer, mirroring
// advanceBossRotation()/nextMainGameModifierIndex exactly, so the "Next:
// [boss]" label's info badge (see renderNextBossLabel()) can preview it
// throughout both small games leading up to that boss. Every usable can
// only ever be bought once per run - purchasedIds (state.usablesPurchasedIds,
// see buyBossUsable()) is what enforces that, taken as a plain argument
// rather than read directly off state so this stays callable from
// newRunState() itself (before state exists yet - always [] there, nothing
// bought this run). Returns null once every item has been bought (pool
// exhausted) - renderPackShop()'s "main" branch and renderNextBossLabel()'s
// info badge both already treat a null offer as "nothing to show/sell".
// Skips the Math.random() draw entirely with exactly one eligible item
// left rather than calling it just to always land on that one index -
// nothing depends on that draw happening, and burning one for no reason
// would shift every OTHER Math.random()-driven roll one call later.
function pickRandomUsableId(purchasedIds) {
  const eligible = USABLE_POOL.filter((u) => !purchasedIds.includes(u.id));
  if (eligible.length === 0) return null;
  return eligible.length === 1
    ? eligible[0].id
    : eligible[Math.floor(Math.random() * eligible.length)].id;
}

// Whether the given owned usable instance can be activated right now -
// shared by the sidebar panel (to grey out a not-yet-usable card) and
// activateUsable() itself (the actual gate).
function usableActivatable(item) {
  if (item.id === "bossSkipToken") {
    return state.phase === "main" && !state.rolled && !state.bossEffectSkipped && activeBossModifier() != null;
  }
  if (item.id === "freeRerollToken") {
    // Same window refreshShopSlots() itself requires (phase check added on
    // top since awaitingNextRound alone can also be true mid-Boss, which
    // never has a Refresh button/Card Pack shop at all - see
    // renderPackShop()'s "main" branch). Already-active excluded too - a
    // 2nd activation before the free Refresh is actually spent would just
    // waste a charge for no additional effect.
    return state.phase !== "main" && state.awaitingNextRound && !state.pendingPackOffer && !state.freeRerollActive;
  }
  if (item.id === "doubleDownToken") {
    // Usable any time a hand is actually in progress, unlike the other two
    // (no boss/shop restriction) - just needs a real level live (not the
    // shop/buy-phase interlude between rounds, where there's no "next hand"
    // to double any time soon), no modal in the way, and not already
    // primed (a 2nd activation before the first is spent would just waste
    // a charge for no extra effect, same reasoning as Free Reroll Token
    // above).
    return !state.gameOver && !state.awaitingNextRound && modalOverlay.classList.contains("hidden") && !state.doubleDownActive;
  }
  if (item.id === "perkRerollToken") {
    // No boss/shop restriction, same as Double Down above - just needs no
    // modal already in the way (this one opens its own, see
    // renderPerkRerollPicker()) and at least one real, slot-occupying perk
    // actually owned to reroll (same scope The Edict's own mandatory picker
    // uses - excludes Extra Perk and persistent rule/gamerule cards).
    return !state.gameOver && modalOverlay.classList.contains("hidden") && state.perksOwned.some(isSlotOccupyingPerk);
  }
  if (item.id === "perkShieldToken") {
    // Same scope/restrictions as Perk Reroll Token above, plus an already-
    // shielded perk doesn't count - nothing left for a 2nd shield to do to it.
    return !state.gameOver && modalOverlay.classList.contains("hidden")
      && state.perksOwned.some((p) => isSlotOccupyingPerk(p) && !p.shielded);
  }
  return false;
}

// Activates one owned usable instance (by instanceId - see
// renderUsableInventory()), deleting it once it has nothing left to give.
// Boss Skip Token's own effect is mostly just flipping state.bossEffectSkipped
// on - activeBossModifier() itself (see its own comment) is the actual
// choke point that silently neutralizes every live per-turn boss check from
// there. The Thief is the one exception: its stolen die was already baked
// into state.diceCount the instant the level began, so it needs an explicit
// restore here rather than relying on activeBossModifier() alone. Free
// Reroll Token instead carries its own remaining-uses counter
// (instance.charges, seeded from USABLE_POOL's own charges field by
// buyBossUsable()) - each activation spends one and only deletes the
// instance once the last one is gone, unlike Boss Skip Token's always-one-
// shot deletion.
function activateUsable(instanceId) {
  const index = state.usablesOwned.findIndex((u) => u.instanceId === instanceId);
  if (index === -1) return;
  const item = state.usablesOwned[index];
  if (!usableActivatable(item)) return;

  let spent = true; // whether this activation uses up the instance entirely

  if (item.id === "bossSkipToken") {
    if (activeBossModifier()?.id === "theThief") {
      state.diceCount += 1;
      resizeDiceArraysToCount(state.diceCount);
    }
    state.bossEffectSkipped = true;
  } else if (item.id === "freeRerollToken") {
    // Deliberately does NOT touch state.refreshCost itself - see
    // refreshShopSlots(), which reads freeRerollActive to charge $0 for the
    // very next Refresh while still escalating refreshCost off its real
    // (pre-free) value, so the Refresh after THAT one costs what it always
    // would have, not $0 + REFRESH_COST_INCREMENT.
    state.freeRerollActive = true;
    item.charges -= 1;
    spent = item.charges <= 0;
  } else if (item.id === "doubleDownToken") {
    // Consumed by the commit itself, not here - see commitScore()/
    // finishCommitScore(). This just arms it.
    state.doubleDownActive = true;
  } else if (item.id === "perkRerollToken") {
    // NOT consumed here, unlike every other usable above - opens its own
    // picker instead (see renderPerkRerollPicker()), which only actually
    // spends this instance once the player confirms a pick and the reroll
    // completes (applyPerkReroll()). Backing out via Back keeps the token,
    // same as any other optional/player-initiated choice in this game (a
    // Card Pack offer can be skipped for free, for instance).
    spent = false;
    renderPerkRerollPicker(instanceId);
  } else if (item.id === "perkShieldToken") {
    // Same deal as Perk Reroll Token just above - not consumed here, opens
    // its own picker instead (see renderPerkShieldPicker()), only actually
    // spent once a perk is chosen (applyPerkShield()).
    spent = false;
    renderPerkShieldPicker(instanceId);
  }

  if (spent) state.usablesOwned.splice(index, 1);
  renderAll();
  saveState();
}

// Perk Reroll Token's picker - same flat clickable-pack-card-list template
// as The Edict's own mandatory sacrifice picker (renderEdictPicker()), just
// optional (a Back button, no forced choice) and reusing the same
// isSlotOccupyingPerk scope (excludes Extra Perk and persistent rule/
// gamerule cards - nothing to visibly "reroll" there). usableInstanceId is
// threaded through to confirmPerkReroll() below, which is the point this
// token instance actually gets spent - opening this picker does NOT spend
// it (see activateUsable()).
function renderPerkRerollPicker(usableInstanceId) {
  modalBox.innerHTML = "";
  modalBox.classList.add("perk-choice-modal");

  const h2 = document.createElement("h2");
  h2.textContent = "Perk Reroll Token";
  const p = document.createElement("p");
  p.textContent = "Choose one owned perk to reroll into a random new one:";

  const optWrap = document.createElement("div");
  optWrap.className = "perk-options perk-choice-options";

  // "Back" (not "Cancel") - leaving via this button returns to the Usables
  // panel with the token still owned and unspent, same as never having
  // clicked it at all (see activateUsable(), which doesn't spend it either
  // - only a completed reroll does, in applyPerkReroll()).
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "modal-btn";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => {
    hideModal();
    renderAll();
    rollBtn.focus();
  });
  const btnRow = document.createElement("div");
  btnRow.className = "modal-btn-row";
  btnRow.appendChild(backBtn);

  // Declared before the forEach below (each card's click handler closes
  // over it) - the whole popup stays open and in place for the spin (see
  // beginPerkRerollSpin()), it's only ever this ONE button that needs to
  // react to a spin starting (disabled so backing out mid-reveal isn't
  // possible - see there).
  state.perksOwned.filter(isSlotOccupyingPerk).forEach((perk) => {
    const card = document.createElement("div");
    card.className = "pack-card pack-card-large perk-choice-card" + (perk.tint ? ` tint-${perk.tint}` : "");
    attachCardTilt(card);
    if (perk.shiny) decorateShiny(card);
    if (perk.shielded) decorateShielded(card);

    const name = document.createElement("div");
    name.className = "pack-card-name";
    name.textContent = perk.name;

    const desc = document.createElement("div");
    desc.className = "pack-card-rule-desc";
    desc.textContent = perk.desc;

    card.appendChild(name);
    card.appendChild(desc);
    if (typeof perk.xMult !== "undefined") {
      const multBadge = document.createElement("div");
      multBadge.className = "perk-card-xmult-badge";
      multBadge.textContent = `+${resolveXMult(perk, state)}x`;
      card.appendChild(multBadge);
    }
    card.addEventListener("click", () => beginPerkRerollSpin(perk, card, name, desc, optWrap, backBtn, p, usableInstanceId));
    optWrap.appendChild(card);
  });

  modalBox.appendChild(h2);
  modalBox.appendChild(p);
  modalBox.appendChild(optWrap);
  modalBox.appendChild(btnRow);
  modalOverlay.classList.remove("hidden");
  modalBox.focus();
}

// Perk Shield Token's picker - same flat clickable-pack-card-list template
// as Perk Reroll Token's own picker just above, minus the spin/reveal (a
// shield just applies instantly, nothing to animate). Already-shielded
// perks are left out entirely - a 2nd shield would have nothing left to do.
// usableInstanceId is threaded through to applyPerkShield() below, which is
// the point this token instance actually gets spent - opening this picker
// does NOT spend it (see activateUsable()).
function renderPerkShieldPicker(usableInstanceId) {
  modalBox.innerHTML = "";
  modalBox.classList.add("perk-choice-modal");

  const h2 = document.createElement("h2");
  h2.textContent = "Perk Shield Token";
  const p = document.createElement("p");
  p.textContent = "Choose one owned perk to shield - Clean Slate and Ooo Shiny can no longer randomly destroy it:";

  const optWrap = document.createElement("div");
  optWrap.className = "perk-options perk-choice-options";

  // "Back" (not "Cancel") - same reasoning as Perk Reroll Token's own Back
  // button: leaving this way returns to the Usables panel with the token
  // still owned and unspent.
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "modal-btn";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => {
    hideModal();
    renderAll();
    rollBtn.focus();
  });
  const btnRow = document.createElement("div");
  btnRow.className = "modal-btn-row";
  btnRow.appendChild(backBtn);

  state.perksOwned.filter((perk) => isSlotOccupyingPerk(perk) && !perk.shielded).forEach((perk) => {
    const card = document.createElement("div");
    card.className = "pack-card pack-card-large perk-choice-card" + (perk.tint ? ` tint-${perk.tint}` : "");
    attachCardTilt(card);
    if (perk.shiny) decorateShiny(card);

    const name = document.createElement("div");
    name.className = "pack-card-name";
    name.textContent = perk.name;

    const desc = document.createElement("div");
    desc.className = "pack-card-rule-desc";
    desc.textContent = perk.desc;

    card.appendChild(name);
    card.appendChild(desc);
    if (typeof perk.xMult !== "undefined") {
      const multBadge = document.createElement("div");
      multBadge.className = "perk-card-xmult-badge";
      multBadge.textContent = `+${resolveXMult(perk, state)}x`;
      card.appendChild(multBadge);
    }
    card.addEventListener("click", () => applyPerkShield(perk, usableInstanceId));
    optWrap.appendChild(card);
  });

  modalBox.appendChild(h2);
  modalBox.appendChild(p);
  modalBox.appendChild(optWrap);
  modalBox.appendChild(btnRow);
  modalOverlay.classList.remove("hidden");
  modalBox.focus();
}

// Marks the chosen perk instance shielded and spends the token - looked up
// by object identity (state.perksOwned.indexOf(perk)), same reasoning as
// renderEdictPicker()/applyPerkReroll(): the array can shift under a stale
// index while the picker is open (e.g. a mid-run save/reload elsewhere).
function applyPerkShield(perk, usableInstanceId) {
  const index = state.perksOwned.indexOf(perk);
  if (index !== -1) state.perksOwned[index].shielded = true;

  const usableIndex = state.usablesOwned.findIndex((u) => u.instanceId === usableInstanceId);
  if (usableIndex !== -1) state.usablesOwned.splice(usableIndex, 1);

  hideModal();
  renderAll();
  rollBtn.focus();
  saveState();
}

// Candidate pool for the spin's decorative intermediate flips (see
// beginPerkRerollSpin() below) - same availability-filtered pool
// samplePerks() itself draws from, so the reel never flips through
// (even just momentarily, mid-spin) something that couldn't actually be
// offered as the real outcome.
function spinCandidatePerks() {
  return PERK_POOL.filter((perk) => !perk.available || perk.available(state));
}

// Each entry is how long (ms) that step's card stays on screen before
// flipping to the next one - starts fast and stretches out, reading as a
// slot-machine reel decelerating into its landing rather than a flat
// strobe. The step AFTER the last entry is the real, already-rolled
// outcome (see beginPerkRerollSpin()), not another random flip.
const PERK_REROLL_SPIN_DELAYS = [70, 70, 80, 90, 100, 120, 140, 170, 210, 260, 320, 420, 550];
const PERK_REROLL_POP_MS = 350;
// Extra pause AFTER the pop settles, holding the landed card on screen
// before the actual perk swap happens and the popup closes - without this
// the close would follow the pop almost immediately, barely giving the
// result a moment to actually be read.
const PERK_REROLL_HOLD_MS = 1000;

// Spins IN PLACE on the exact card the player clicked - the popup itself
// (every other card, the Back button) stays right where it was, only
// this one card's own content rapidly flips through random candidates,
// slowing down over PERK_REROLL_SPIN_DELAYS's steps, then lands on
// `sampled` - rolled up FRONT, before the spin even starts, not at the
// end, so the deceleration is landing on a value that's already decided
// rather than picking one only once the animation happens to stop (which
// would make the "slowing down" beats meaningless - there'd be nothing for
// them to be leading toward yet). Every OTHER card is locked out
// (perk-reroll-inactive, dimmed and unclickable) and Back is disabled the
// instant the spin starts, since backing out of a reveal already in
// motion isn't a real choice. Plays a quick scale-up-then-back "pop" once
// landed, then hands off to applyPerkReroll() - the actual state mutation
// (destroying the old instance, adding the new one, spending the token)
// only happens after the pop + hold settle, not before, so the visible
// reveal always matches what state ends up holding.
function beginPerkRerollSpin(perk, card, nameEl, descEl, optWrap, backBtn, instructionEl, usableInstanceId) {
  const sampled = samplePerks(state, 1)[0];

  instructionEl.textContent = "Rerolling...";
  backBtn.disabled = true;
  optWrap.querySelectorAll(".pack-card").forEach((c) => {
    if (c !== card) c.classList.add("perk-reroll-inactive");
  });

  let multBadge = card.querySelector(".perk-card-xmult-badge");
  const showCard = (def) => {
    card.className = "pack-card pack-card-large perk-choice-card perk-reroll-spinning" + (def.tint ? ` tint-${def.tint}` : "");
    nameEl.textContent = def.name;
    descEl.textContent = def.desc;
    if (multBadge) { multBadge.remove(); multBadge = null; }
    if (typeof def.xMult !== "undefined") {
      multBadge = document.createElement("div");
      multBadge.className = "perk-card-xmult-badge";
      multBadge.textContent = `+${resolveXMult(def, state)}x`;
      card.appendChild(multBadge);
    }
  };

  const candidates = spinCandidatePerks();
  let step = 0;
  const spinStep = () => {
    if (step >= PERK_REROLL_SPIN_DELAYS.length) {
      if (sampled) {
        showCard(sampled);
      } else {
        card.className = "pack-card pack-card-large perk-choice-card perk-reroll-spinning";
        nameEl.textContent = "Nothing to reroll into";
        descEl.textContent = "Every perk is already at its cap right now.";
      }
      card.classList.add("perk-reroll-pop");
      // Replaced with different text, not cleared to "" - blanking this
      // line out would shrink the popup's own content height right as the
      // card lands (.modal has no fixed height, just auto-sizes to
      // content), reading as the whole popup visibly scaling down instead
      // of just the card popping.
      instructionEl.textContent = sampled ? "Rerolled!" : "No luck!";
      setTimeout(() => applyPerkReroll(perk, sampled, usableInstanceId), PERK_REROLL_POP_MS + PERK_REROLL_HOLD_MS);
      return;
    }
    showCard(candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : perk);
    setTimeout(spinStep, PERK_REROLL_SPIN_DELAYS[step]);
    step++;
  };
  spinStep();
}

// The actual reroll, run only once beginPerkRerollSpin()'s reveal has
// finished playing: destroys the picked perk instance (through
// removePerkInstance(), the same single choke point every other deliberate
// perk destruction in the game already routes through, so Demolisher/
// Skipper growth, dice-array resizing, and the double-target reroll all
// fire exactly as they would for a trash-can delete) and drops `sampled`
// (already rolled - see beginPerkRerollSpin()) into the EXACT SAME perk
// slot - capturing slotIndex before the removal is what makes that
// possible, since removePerkInstance() itself never touches perkSlotOrder
// (that's normally left to the next syncPerkSlotOrder() call, which would
// otherwise just drop the new perk into the first empty slot rather than
// the one just vacated). Looks the clicked perk up by object identity
// (state.perksOwned.indexOf(perk)), not a cached index, for the same
// reason renderEdictPicker() does - the array can shift under a stale
// index. No refund for the replaced perk - this is a transformation, not a
// sale.
function applyPerkReroll(perk, sampled, usableInstanceId) {
  const index = state.perksOwned.indexOf(perk);
  if (index === -1) { hideModal(); renderAll(); return; }

  const slotIndex = state.perkSlotOrder.indexOf(perk.instanceId);
  removePerkInstance(index, { animate: false });

  if (sampled) {
    const instance = { ...sampled };
    sampled.apply(state, instance);
    // Assigned explicitly (rather than left for syncPerkSlotOrder() to
    // lazily backfill) so it exists immediately, in time for the
    // perkSlotOrder assignment right below.
    instance.instanceId = state.nextPerkInstanceId++;
    state.perksOwned.push(instance);
    if (slotIndex !== -1) state.perkSlotOrder[slotIndex] = instance.instanceId;
  }

  const usableIndex = state.usablesOwned.findIndex((u) => u.instanceId === usableInstanceId);
  if (usableIndex !== -1) state.usablesOwned.splice(usableIndex, 1);

  hideModal();
  renderAll();
  rollBtn.focus();
  saveState();
}

// The Turnkey: Chance is blocked from turn 1 (it's the one category that
// always scores something regardless of what you rolled, which would
// otherwise trivialize "commit the same category over and over" - forcing
// a real one closes that loophole). Once 4 different (non-Chance)
// categories have been committed to at least once on top of that, every
// OTHER never-touched category locks shut too, for the rest of the level -
// derived fresh from state.scorecard rather than tracked in its own field,
// since "touched" already means exactly "has a non-null score" and the set
// can never grow past 4 once this kicks in (a blocked category can never
// become touched, Chance included). Self-stabilizing, nothing to reset per
// level.
function turnkeyBlockedCategoryKeys() {
  if (activeBossModifier()?.id !== "theTurnkey") return [];
  const keys = activeCategories().map((cat) => cat.key);
  const touched = keys.filter((key) => state.scorecard[key] != null);
  const alwaysBlocked = keys.filter((key) => key === "chance");
  if (touched.length < 4) return alwaysBlocked;
  return keys.filter((key) => !touched.includes(key));
}

// Whether `key` is currently off limits for any reason - Sabotage/The
// Culler (both permanent for the rest of the level), The Gatekeeper (this
// turn only), or The Turnkey (permanent, but only once its 4-category
// threshold is reached). The single check every gating/eligibility site
// below should go through, so a new blocking source never has to be hunted
// down and added in three different places again.
function categoryIsBlocked(key) {
  return state.blockedCategoryKeys.includes(key)
    || state.cullerBlockedCategoryKeys.includes(key)
    || state.gatekeeperBlockedCategoryKeys.includes(key)
    || turnkeyBlockedCategoryKeys().includes(key);
}

// The Gatekeeper: re-rolls which 3 unfilled, not-otherwise-blocked
// categories are off limits this turn - called once when the level starts (turn 1)
// and again every time a hand gets committed and a new turn begins (see
// startNextLevel()/commitScore()). Deliberately keyed off turnLimit() (the
// actual turn count for this level, Make it Count reductions included) so
// "5 turns left" always means the same thing the Turn stat shows. Once that
// few turns remain, the block list is emptied and stays empty for the rest
// of the level - the board opens back up rather than staying frozen on
// whatever 3 happened to be blocked last.
const GATEKEEPER_BLOCK_COUNT = 3;
const GATEKEEPER_STOP_TURNS_REMAINING = 5;
function refreshGatekeeperBlocks() {
  if (activeBossModifier()?.id !== "theGatekeeper") {
    state.gatekeeperBlockedCategoryKeys = [];
    return;
  }
  const turnsRemainingIncludingThis = turnLimit() - state.turn + 1;
  if (turnsRemainingIncludingThis <= GATEKEEPER_STOP_TURNS_REMAINING) {
    state.gatekeeperBlockedCategoryKeys = [];
    return;
  }
  const eligible = activeCategories().filter(
    (cat) => state.scorecard[cat.key] == null && !categoryIsBlocked(cat.key)
  );
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  state.gatekeeperBlockedCategoryKeys = shuffled.slice(0, GATEKEEPER_BLOCK_COUNT).map((cat) => cat.key);
}

// The Culler: a one-time effect fired the instant a level with this boss
// begins (see startNextLevel()) - permanently removes its 2 most category-
// bonus-boosted categories (a tie broken randomly, via the pre-sort
// shuffle below) from play for the rest of the level (state.
// cullerBlockedCategoryKeys - kept separate from Sabotage's own
// blockedCategoryKeys, see newRunState()), then flags every other active
// category as Culler-boosted (cullerBoostedCategoryKeys) - categoryCardMultiplier()
// is what actually applies the +0.2x live, for as long as this level lasts.
// Deliberately NOT folded into categoryBonus itself (unlike pickPackCard()'s
// permanent grants into that same field) - this boost is only supposed to
// last for this one boss level, and cullerBoostedCategoryKeys already resets
// fresh every level on its own, so there's nothing to remember to reverse.
const CULLER_REMOVE_COUNT = 2;
const CULLER_CATEGORY_BONUS_STEP = 0.2;
function applyCullerEffect() {
  if (activeBossModifier()?.id !== "theCuller") return;
  const active = activeCategories();
  const eligible = active.filter(
    (cat) => state.scorecard[cat.key] == null && !categoryIsBlocked(cat.key)
  );
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  shuffled.sort((a, b) => (state.categoryBonus[b.key] || 0) - (state.categoryBonus[a.key] || 0));
  const removedKeys = shuffled.slice(0, CULLER_REMOVE_COUNT).map((cat) => cat.key);
  removedKeys.forEach((key) => {
    if (!state.cullerBlockedCategoryKeys.includes(key)) state.cullerBlockedCategoryKeys.push(key);
  });
  active.forEach((cat) => {
    if (removedKeys.includes(cat.key)) return;
    if (!state.cullerBoostedCategoryKeys.includes(cat.key)) state.cullerBoostedCategoryKeys.push(cat.key);
  });
}

// The Landlord: charges flat rent the instant each turn begins - turn 1 in
// startNextLevel(), turn N+1 in commitScore()'s own turn-advance block -
// same two call sites every other per-turn boss hook uses (see
// refreshGatekeeperBlocks()). Deliberately never floored at 0 - unlike
// every other way money changes (shop purchases/rerolls all guard
// affordability before spending), rent is owed regardless of whether the
// player can cover it, so state.money is allowed to go negative here.
const LANDLORD_RENT_PER_TURN = 2;
function chargeLandlordRent() {
  if (activeBossModifier()?.id !== "theLandlord") return;
  state.money -= LANDLORD_RENT_PER_TURN;
}

// ---------- Game state ----------

function freshScorecard() {
  const sc = {};
  for (const cat of ALL_CATS) sc[cat.key] = null;
  return sc;
}

function freshUseCounts() {
  const counts = {};
  for (const cat of ALL_CATS) counts[cat.key] = 0;
  return counts;
}

function freshDice(diceCount) {
  return Array(diceCount).fill(1);
}

function freshDieRotations(diceCount) {
  return Array.from({ length: diceCount }, () => ({ x: 0, y: 0 }));
}

function freshHeld(diceCount) {
  return Array(diceCount).fill(false);
}

function newRunState(diceCount) {
  diceCount = diceCount || 5;
  return {
    phase: "small1",
    level: 1,
    target: SMALL_GAME_TARGETS.small1,
    // Remembers where the main game's progression should resume once the
    // small-game interlude (small1 -> small2) finishes. Level 1 with no
    // perks/multiplier yet is just MAIN_TARGET_BASE itself - computeMainTarget()
    // isn't called here since it reads the (not-yet-assigned) global state.
    nextMainLevel: 1,
    nextMainTarget: MAIN_TARGET_BASE,
    // The boss the upcoming main level will actually use (see
    // startNextLevel()'s small2 -> main branch, which now just consumes
    // this instead of rolling fresh) - pre-rolled a full cycle ahead so the
    // "Next: [boss]" label (see renderNextBossLabel()) has something to
    // show throughout both small games leading up to it. Nothing's been
    // played yet this run, so advanceBossRotation() picks from the full set.
    nextMainGameModifierIndex: advanceBossRotation([], null).nextIndex,
    // Every boss played so far in the CURRENT bag-cycle (see
    // advanceBossRotation()) - every boss must come up once before any of
    // them can repeat. Carried forward across level transitions in
    // startNextLevel()'s own carry object, unlike most other per-run fields
    // here which just reset for free on this newRunState() rebuild.
    playedBossIds: [],
    awaitingNextRound: false,
    turn: 1,
    diceCount,
    dice: freshDice(diceCount),
    dieRotation: freshDieRotations(diceCount),
    held: freshHeld(diceCount),
    rolled: false,
    rollsUsedThisTurn: 0,
    // The Warden's boss feature - which die index (if any) got randomly
    // locked after this hand's first throw. Reset every new hand, see
    // rollDice() and commitScore()'s normal turn-advance block.
    bossLockedDieIndex: null,
    // The Tempest's boss feature - which die index (if any) got randomly
    // forced to keep rerolling (can't be held) after this hand's first
    // throw. Same reset points as bossLockedDieIndex above.
    bossForcedRerollDieIndex: null,
    // The Vice's boss feature - indices cemented in place by a throw (see
    // rollDice()): freely held/unheld right up until the next throw, then
    // locked for good. Grows over the course of a hand, same reset points
    // as the two fields above.
    viceLockedIndices: [],
    // The Censor's boss feature - which owned perk instance (if any) is
    // silenced this hand. Re-picked every hand, reset the same way as the
    // three dice-boss fields above.
    bossBlockedPerkInstanceId: null,
    // The Void's boss feature - which face (1-6) the player rolled for this
    // level (see renderVoidRollModal()) - that face comes up blank
    // everywhere a real throw lands on it. Null until that roll happens;
    // NOT reset per turn after that - only cleared by the natural full
    // state rebuild the next time startNextLevel() runs, same as
    // edictSacrificeResolved below.
    voidBlockedFace: null,
    // The Edict's boss feature - whether the player has already made their
    // mandatory pre-level choice yet (see renderEdictPicker()) - the chosen
    // perk itself is destroyed outright (spliced out of perksOwned), so
    // there's no instance id to track afterward, just whether it's been
    // resolved yet this level. NOT reset per turn - only ever cleared by
    // the natural full state rebuild the next time startNextLevel() runs,
    // since it's deliberately left out of that function's `carry` object.
    edictSacrificeResolved: false,
    // Mulligan's boss feature - whether the player has already spent their
    // one Boss revert. NOT reset per turn - only ever cleared by the
    // natural full state rebuild the next time startNextLevel() runs
    // (transitioning into a fresh main level), since it's deliberately left
    // out of that function's `carry` object, same as edictSacrificeResolved
    // above. The actual revert-target snapshot lives outside state entirely
    // (see mulliganSnapshot), since it needs to hold things state itself
    // can't safely deep-clone (owned perk instances' apply/remove/
    // xMultCondition functions).
    mulliganUsedThisBoss: false,
    // Mulligan's small-game feature - Small Game 1 and Small Game 2 share
    // ONE use between them (using it in either blocks the other) - unlike
    // mulliganUsedThisBoss above, startNextLevel() deliberately DOES carry
    // this forward across the small1 -> small2 transition specifically (see
    // there), only resetting it fresh once a whole new small1/small2 pair
    // begins.
    mulliganUsedThisSmallPair: false,
    // The Gatekeeper's boss feature - which up-to-3 unfilled categories are
    // off limits this turn (see refreshGatekeeperBlocks()). Reset every turn
    // (including turn 1, in startNextLevel()), so it's fine that it's left
    // out of the `carry` object like edictSacrificeResolved above.
    gatekeeperBlockedCategoryKeys: [],
    // The Culler's boss feature - its 2 permanently-removed categories for
    // this level (see applyCullerEffect()). Kept separate from Sabotage's
    // own blockedCategoryKeys so the rule-inventory panel's "Sabotage" entry
    // (see renderRuleInventory()) never misattributes a Culler removal to a
    // Sabotage card the player may not even own. NOT reset per turn - only
    // cleared by the natural full state rebuild the next time
    // startNextLevel() runs, since it's left out of the `carry` object.
    cullerBlockedCategoryKeys: [],
    // The Culler's boss feature - every active category that received its
    // +0.2x categoryBonus this level (everything except the 2 removed
    // ones), so the scorecard can render those cells' filled score in a
    // grayer tone than a normal fill - see applyCullerEffect() and the
    // "filled" branch of addCatRow() in renderScorecard(). NOT reset per
    // turn, same lifecycle as cullerBlockedCategoryKeys above.
    cullerBoostedCategoryKeys: [],
    baseRerolls: 2, // + 1 initial throw = 3 total throws by default
    bonusRerolls: 0,
    wildIndices: [],
    scoreMultiplier: 1,
    bonusPoints: 0,
    smallGameTurnLimit: BASE_SMALL_GAME_TURN_LIMIT,
    scorecard: freshScorecard(),
    categoryUseCount: freshUseCounts(),
    perksOwned: [],
    gameOver: false,
    completedLevelsTotal: 0,
    money: 10,
    // Index into MAIN_GAME_MODIFIERS - null outside the main phase (or
    // before the first main game has started); (re)rolled each time
    // startNextLevel() transitions into "main".
    mainGameModifierIndex: null,
    // Permanent per-category point bonuses bought from Card Packs - carried
    // across the whole run, unlike scorecard/categoryUseCount.
    categoryBonus: {},
    // The 3 categories/rule ids currently offered by an opened, not-yet-
    // resolved pack (null when no pack is open) - pendingPackKind says
    // which ("category" or "rule") pendingPackOffer's entries are. Reset
    // each small-game completion, never carried to the next phase.
    pendingPackOffer: null,
    pendingPackKind: null,
    // Which of pendingPackOffer's category keys (if any) rolled Boosted -
    // reset whenever a new pack is opened or the offer is resolved/skipped.
    pendingPackBoostedKeys: [],
    // Which of pendingPackOffer's perk ids (if any, Perk Pack only) rolled
    // Shiny - same reset lifecycle as pendingPackBoostedKeys above.
    pendingPackShinyKeys: [],
    // True when the current category pack offer is a Mega Pack (rolled at
    // open time, see effectiveMegaChance()/openCardPack()) - every eligible
    // category is offered instead of just packType.cardCount of them. Rule
    // packs can never roll one.
    pendingPackIsMega: false,
    // The 3 Card Pack shop slots - each a pack type name, or null once
    // that slot has been bought. Rolled fresh each small-game completion
    // and only re-rolled after that via the Refresh button, so buying one
    // slot doesn't disturb the other two.
    shopSlots: [],
    // What the Refresh button currently costs - rises by $1 per use, reset
    // to REFRESH_COST_BASE each time showNextRoundPrompt presents a fresh shop.
    refreshCost: REFRESH_COST_BASE,
    // Third Time's the Charm bookkeeping: how many times Refresh has been
    // used in the current shop (reset each showNextRoundPrompt) - also what
    // hasThirdTimesCharmDiscount() reads to tell whether this shop has
    // reached its 3rd+ set of offers yet. Reaching that set also arms
    // thirdTimesCharmPendingBossLock, consumed the next time a boss
    // concludes (see startNextLevel()'s "main just finished" branch), which
    // loads thirdTimesCharmLocksRemaining with 2 - the small1 and small2
    // shops that follow. Each showNextRoundPrompt() call drains one charge,
    // locking that shop's purchases (shopPurchasesLocked) until it's gone.
    rerollCountThisShop: 0,
    // Free Reroll Token's own effect (see activateUsable()) - makes the
    // NEXT Refresh cost $0 without touching refreshCost itself, so the
    // escalation (refreshCost += REFRESH_COST_INCREMENT, see
    // refreshShopSlots()) still climbs from whatever the real price already
    // was, not from 0. Reset fresh every shop, same lifecycle as
    // refreshCost/rerollCountThisShop above.
    freeRerollActive: false,
    thirdTimesCharmPendingBossLock: false,
    thirdTimesCharmLocksRemaining: 0,
    shopPurchasesLocked: false,
    // Lucky Skip's permanently-banked bonus (see LUCKY_SKIP_BONUS_PER_STACK)
    // added on top of SHINY_PERK_CHANCE / CATEGORY_CARD_BOOST_CHANCE - grows
    // every time a card pack is skipped while at least one copy is owned,
    // never shrinks once earned.
    luckySkipBonus: 0,
    // Sabotage's blocked categories for the upcoming main game only (empty
    // otherwise) - resolved all at once by resolveSabotageBlocks() right as
    // that main game starts, then cleared once it concludes.
    blockedCategoryKeys: [],
    // How many Sabotage picks are waiting to be resolved into actual
    // blockedCategoryKeys - accumulates through small1/small2, spent (reset
    // to 0) the moment the main game begins.
    sabotageStacks: 0,
    // Which perk instance (by instanceId, assigned lazily in
    // syncPerkSlotOrder) sits in each perk-card slot - null for an empty
    // slot. Lets a perk be dropped into any slot, gaps included, instead of
    // owned perks always packing left. instanceId counter persists across
    // the whole run so ids never collide even as perks come and go.
    perkSlotOrder: [],
    nextPerkInstanceId: 1,
    // Hotline's current target categories for this turn (empty without the
    // perk; two instead of one with All Luck). Recomputed by
    // rerollDoubleTarget() at every turn boundary rather than carried/reset
    // by hand.
    doubleTargets: [],
    // Main game only: the turn number at which the target was first reached
    // this level (null until then). Freezes the "turns left" snapshot used
    // to pay out the turns-left-into-money bonus exactly once per level.
    targetReachedTurn: null,
    // One-time-use items bought from the boss-only shop slot (see
    // USABLE_POOL/renderPackShop()'s "main" branch) - each a plain
    // {id, instanceId} entry, unlike perksOwned's pool-linked instances,
    // since no usable currently carries any per-copy progress or apply/
    // remove function that would need re-linking on load. Whole-run
    // resource like perksOwned/money - carried forward across every phase
    // transition in startNextLevel()'s own carry object.
    usablesOwned: [],
    nextUsableInstanceId: 1,
    // Every USABLE_POOL id ever bought this run (see buyBossUsable()) - each
    // usable can only ever be bought once per run, same "one time" cap as
    // UNIQUE_PERMANENT_RULE_IDS, just tracked separately since a usable can
    // fully leave usablesOwned (consumed/spent) while still needing to stay
    // excluded from future offers forever after. Whole-run resource like
    // playedBossIds - carried forward across every phase transition in
    // startNextLevel()'s own carry object.
    usablesPurchasedIds: [],
    // Which USABLE_POOL item the boss shop slot is offering THIS level -
    // consumed from nextBossUsableOffer below the instant a main level
    // begins (see startNextLevel()'s small2 -> main branch), nulled the
    // instant it's bought (buyBossUsable()). Per-level, NOT carried, same
    // lifecycle as mulliganUsedThisBoss below.
    bossUsableOffer: null,
    // The item NEXT boss's shop slot will offer (null once every item has
    // been bought - see pickRandomUsableId()) - pre-rolled a full cycle
    // ahead, same reasoning and lifecycle as nextMainGameModifierIndex
    // above (which this mirrors exactly): lets the "Next: [boss]" label's
    // own info badge (see renderNextBossLabel()) show it throughout both
    // small games leading up to that boss, rather than leaving it a
    // surprise until the shop slot itself is on screen. Nothing's been
    // bought yet this run, so nothing is excluded from the very first roll.
    nextBossUsableOffer: pickRandomUsableId([]),
    // Boss Skip Token's own effect - see activateUsable() and
    // activeBossModifier()'s own comment for how setting this neutralizes
    // the active boss for the rest of the level. Per-level, NOT carried,
    // same lifecycle as mulliganUsedThisBoss below.
    bossEffectSkipped: false,
    // Double Down Token's own effect - doubles whatever the very next hand
    // committed (any phase) actually banks, then clears itself the instant
    // that commit happens (see commitScore()/finishCommitScore()). Never
    // carried - a commit always happens well within the same level it was
    // activated in, long before any phase transition could reach it.
    doubleDownActive: false,
  };
}

// ---------- Save / load ----------

const SAVE_KEY = "roguelikeYatzySave";

function saveState() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch (e) {
    // Storage unavailable (private browsing, quota, etc.) - progress just
    // won't survive a refresh; nothing else to do about it here.
  }
}

// Repairs corrupted/missing target-progression fields in place, e.g. from a
// save written before some field existed (undefined + a number = NaN, which
// then compounds into every future target forever) or one that already went
// NaN (which itself serializes to null in JSON, so "present" doesn't mean
// "valid" either). Reconstructs from the level count (independent of the
// corrupted field) via the same exponential formula real targets use,
// rather than resetting to the level-1 base target, which would be far too
// easy this deep into a run.
function sanitizeTargetProgression(s) {
  if (!Array.isArray(s.perksOwned)) s.perksOwned = [];

  const approxLevel = Number.isFinite(s.nextMainLevel) ? s.nextMainLevel
    : Number.isFinite(s.level) ? s.level : 1;

  if (!Number.isFinite(s.target)) {
    if (s.phase === "small1") s.target = SMALL_GAME_TARGETS.small1;
    else if (s.phase === "small2") s.target = SMALL_GAME_TARGETS.small2;
    else s.target = computeMainTarget(s, approxLevel);
  }
  if (!Number.isFinite(s.nextMainTarget)) {
    s.nextMainTarget = computeMainTarget(s, approxLevel);
  }
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const loaded = JSON.parse(raw);
    // Merged onto a fresh baseline rather than trusted as-is: a save
    // written before some field existed would otherwise leave that field
    // undefined instead of falling back to a sane default.
    const merged = { ...newRunState(loaded.diceCount), ...loaded };
    sanitizeTargetProgression(merged);

    // JSON strips functions, so re-link each owned perk back to its real
    // PERK_POOL entry (apply/remove/available) - merged with the saved
    // instance data (e.g. Head Start's appliedAmount) rather than replaced
    // by it, so per-copy data survives a reload too. Persistent rule-card
    // instances (e.g. High Stakes) live in RULE_POOL instead, not
    // PERK_POOL, so they need the same treatment or they'd silently vanish
    // from perksOwned on every reload.
    merged.perksOwned = (loaded.perksOwned || [])
      .map((p) => {
        const real = PERK_POOL.find((r) => r.id === p.id) || RULE_POOL.find((r) => r.id === p.id);
        return real ? { ...real, ...p } : null;
      })
      .filter(Boolean);
    return merged;
  } catch (e) {
    return null;
  }
}

let state = loadSavedState() || newRunState();

// ---------- DOM refs ----------

const diceTray = document.getElementById("diceTray");
const rollBtn = document.getElementById("rollBtn");
const restartBtn = document.getElementById("restartBtn");
const debugMoneyBtn = document.getElementById("debugMoneyBtn");
const particlesToggleBtn = document.getElementById("particlesToggleBtn");
const rollsLeftEl = document.getElementById("rollsLeft");
const mulliganBtn = document.getElementById("mulliganBtn");
const scoreBody = document.getElementById("scoreBody");
const scoreTable = document.getElementById("scoreTable");
const diceArea = document.getElementById("diceArea");
const scorecardPanel = document.getElementById("scorecardPanel");
const perkSlots = document.getElementById("perkSlots");
const handBanner = document.getElementById("handBanner");
const mainGameModifier = document.getElementById("mainGameModifier");
const mainGameModifierTitle = document.getElementById("mainGameModifierTitle");
const mainGameModifierBox = document.getElementById("mainGameModifierBox");
const mainGameModifierDesc = document.getElementById("mainGameModifierDesc");
const nextBossLabel = document.getElementById("nextBossLabel");
const nextBossLabelText = document.getElementById("nextBossLabelText");
const nextBossTooltip = document.getElementById("nextBossTooltip");
const nextBossUsableBadge = document.getElementById("nextBossUsableBadge");
const nextBossUsableBadgeText = document.getElementById("nextBossUsableBadgeText");
const nextBossUsableTooltip = document.getElementById("nextBossUsableTooltip");
const ruleInventory = document.getElementById("ruleInventory");
const usableInventory = document.getElementById("usableInventory");
const perkTrash = document.getElementById("perkTrash");
const perkTrashIcon = perkTrash.querySelector(".perk-trash-icon");
const PERK_TRASH_IDLE_ICON = "🗑";
const goldenTouchGainCue = document.getElementById("goldenTouchGainCue");
const moneyGainCue = document.getElementById("moneyGainCue");
const bonusSlots = document.getElementById("bonusSlots");
const refreshPackBtn = document.getElementById("refreshPackBtn");
const packOfferBanner = document.getElementById("packOfferBanner");

const statLevel = document.getElementById("statLevel");
const statScore = document.getElementById("statScore");
const statTarget = document.getElementById("statTarget");
const statTurn = document.getElementById("statTurn");
const statMoney = document.getElementById("statMoney");
const statGrandTotal = document.getElementById("statGrandTotal");

const appEl = document.getElementById("app");
const bossArrivalVignette = document.getElementById("bossArrivalVignette");
const turnTransitionSweep = document.getElementById("turnTransitionSweep");
const dangerVignette = document.getElementById("dangerVignette");
const radialFlash = document.getElementById("radialFlash");
const handBannerGodRays = document.getElementById("handBannerGodRays");
const emberParticlesBack = document.getElementById("emberParticlesBack");
const emberParticlesMid = document.getElementById("emberParticlesMid");
const emberParticlesFront = document.getElementById("emberParticlesFront");
const purpleParticlesBack = document.getElementById("purpleParticlesBack");
const purpleParticlesMid = document.getElementById("purpleParticlesMid");
const purpleParticlesFront = document.getElementById("purpleParticlesFront");
const rainParticlesBack = document.getElementById("rainParticlesBack");
const rainParticlesMid = document.getElementById("rainParticlesMid");
const rainParticlesFront = document.getElementById("rainParticlesFront");
const ashParticlesBack = document.getElementById("ashParticlesBack");
const ashParticlesMid = document.getElementById("ashParticlesMid");
const ashParticlesFront = document.getElementById("ashParticlesFront");
const leafParticlesBack = document.getElementById("leafParticlesBack");
const leafParticlesMid = document.getElementById("leafParticlesMid");
const leafParticlesFront = document.getElementById("leafParticlesFront");

// A soft light beam sweeping once across the screen the instant a new turn
// actually begins - see .turn-transition-sweep/@keyframes
// turnTransitionSweepMove in style.css. Restarting the animation cleanly
// (remove, force reflow, re-add) mirrors sweepSituationalBackground()'s own
// pattern, so back-to-back turns each get their own full sweep instead of
// the 2nd one silently no-op'ing because the class never actually left.
function triggerTurnTransitionSweep() {
  turnTransitionSweep.classList.remove("sweeping");
  void turnTransitionSweep.offsetWidth;
  turnTransitionSweep.classList.add("sweeping");
}

// A subtle red vignette that pulses faster/stronger as the level itself
// runs low on turns - keyed off turnLimit(), which already accounts for
// rule cards/bosses that change it (Make it Count, The Hourglass), so
// "3 left" always means the same thing regardless of what raised or
// lowered the cap. Boss/main game only - small games have no turn limit
// to run out against (see turnLimit()), so there's nothing to warn about.
// Updated every renderControls() call, so it clears immediately once a
// round ends, not just on the next roll.
const DANGER_VIGNETTE_TIERS = {
  3: { peakOpacity: 0.08, duration: "2.2s" },
  2: { peakOpacity: 0.16, duration: "1.5s" },
  1: { peakOpacity: 0.28, duration: "1s" },
};
function updateDangerVignette(turnsLeft) {
  const tier = DANGER_VIGNETTE_TIERS[turnsLeft];
  if (!tier) {
    dangerVignette.classList.remove("danger-active");
    return;
  }
  dangerVignette.style.setProperty("--danger-peak-opacity", tier.peakOpacity);
  dangerVignette.style.setProperty("--danger-pulse-duration", tier.duration);
  dangerVignette.classList.add("danger-active");
}

// The turn stat's own text reads increasingly red in step with the same
// tiers as the vignette above (3/2/1 turns left) - a second, more literal
// cue right next to the number itself, not just an ambient background
// effect. Same main-game-only scope as the vignette (see renderStats()'s
// call site) - small games have no turn limit to run out against.
const TURN_DANGER_TEXT_CLASSES = ["turn-danger-3", "turn-danger-2", "turn-danger-1"];
function updateTurnDangerText(turnsLeft) {
  statTurn.classList.remove(...TURN_DANGER_TEXT_CLASSES);
  if (turnsLeft >= 1 && turnsLeft <= 3) statTurn.classList.add(`turn-danger-${turnsLeft}`);
}

const CAT_ROW_INK_FILL_DURATION_MS = 500;
// The "ink fill" wipe on a just-committed scorecard row - spawned as a
// single fixed-position overlay sized to the row's own
// getBoundingClientRect() and appended to <body>, rather than a background
// on each td, so the wipe reads as one continuous sweep crossing the whole
// row instead of three cells each wiping locally from their own midpoint
// at the same time. See .cat-row-ink-fill-overlay/@keyframes catRowInkFill
// in style.css.
function triggerCatRowInkFill(tr) {
  const rect = tr.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = "cat-row-ink-fill-overlay";
  overlay.style.top = `${rect.top}px`;
  overlay.style.left = `${rect.left}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  document.body.appendChild(overlay);
  overlay.addEventListener("animationend", () => overlay.remove(), { once: true });
  setTimeout(() => overlay.remove(), CAT_ROW_INK_FILL_DURATION_MS + 200);
}

const modalOverlay = document.getElementById("modalOverlay");
const modalBox = document.getElementById("modalBox");

const collectionBtn = document.getElementById("collectionBtn");
const collectionOverlay = document.getElementById("collectionOverlay");
const collectionModal = document.getElementById("collectionModal");
// The actual overflow-clipping ancestor for every card inside the modal -
// .collection-modal-body scrolls (overflow-y: auto) and clips horizontally
// (overflow-x: hidden) to make that possible, while collectionModal itself
// (the outer flex container, padded wider than this inner scroller) doesn't
// clip at all. A tooltip clamped against collectionModal's own bounds (see
// buildCollectionCard()'s attachClampedTooltip() call) could still measure
// as "within bounds" while sitting in that padding gap outside the real
// clipping box, getting silently cut off there instead - clamping against
// this element instead is what the leftmost/rightmost cards actually need.
const collectionModalBody = collectionModal.querySelector(".collection-modal-body");
const collectionBackBtn = document.getElementById("collectionBackBtn");
const collectionPerks = document.getElementById("collectionPerks");
const collectionCategoryCards = document.getElementById("collectionCategoryCards");
const collectionRuleCards = document.getElementById("collectionRuleCards");
const collectionUsables = document.getElementById("collectionUsables");
const perksChanceLabel = document.getElementById("perksChanceLabel");
const categoryChanceLabel = document.getElementById("categoryChanceLabel");
const megaChanceLabel = document.getElementById("megaChanceLabel");

const bossesBtn = document.getElementById("bossesBtn");
const bossesOverlay = document.getElementById("bossesOverlay");
const bossesBackBtn = document.getElementById("bossesBackBtn");
const bossesList = document.getElementById("bossesList");

// ---------- Rendering ----------

// Animates a stat label counting up (or down) from whatever it currently
// shows to a new value, instead of snapping - used for the money/score/total
// score labels everywhere they change. Re-calling this on an element that's
// still mid-animation cancels the old run and continues smoothly from
// whatever value is currently on screen, rather than the two fighting.
const activeCountUps = new WeakMap();

// The last state.money value renderStats() has already reacted to (shown
// a gain cue/spark burst for) - deliberately real state, NOT re-derived
// from statMoney.textContent the way it used to be. That text only
// updates via animateCountUp's own deferred rAF loop (see step() below),
// not synchronously when animateCountUp is called - so if renderStats()
// ever runs twice for the same gain within one synchronous tick (it does:
// a small game's last turn commits through endLevel(), which calls
// renderStats() directly, then falls straight into showNextRoundPrompt(),
// which calls renderStats() again before any frame has painted), the
// second call used to see the SAME stale pre-gain text as the first and
// recompute the same "gain" all over again - a guaranteed duplicate cue,
// and in any case where a frame happened to slip in between the two
// (or a totally unrelated render lands mid-animation later), whatever
// partial amount the animation had reached by then instead of the real
// gain, which is how a second, wrong "+$N" (0 included) could show up
// alongside a perfectly correct first one. Tracking this separately from
// the DOM makes a repeated call with an unchanged state.money a reliable,
// deterministic no-op regardless of animation timing.
// 0 (not null) to match statMoney's own static "0" placeholder in
// index.html - the very first renderStats() call should behave exactly
// like every call after it, comparing against that same starting point.
let lastKnownMoney = 0;

// While a count-up runs, the text grows continuously in step with its own
// progress (peaking exactly as the number lands), then eases back down to
// its normal size over COUNT_UP_SHRINK_MS once it's done.
const COUNT_UP_GROW_SCALE = 1.35;
const COUNT_UP_SHRINK_MS = 500;

function animateCountUp(el, to, duration = 1000, onComplete) {
  // `to` itself is validated too, not just `from` below - a bad caller
  // value (rather than merely non-numeric leftover DOM text) would
  // otherwise poison every arithmetic step past this point (NaN propagates
  // through +/-/*, and NaN !== NaN means the safeFrom === to short-circuit
  // right below would never even catch it), showing "NaN" for the whole
  // animation instead of ever settling on a real number.
  const safeTo = Number.isFinite(to) ? to : 0;
  const from = Number(el.textContent);
  const safeFrom = Number.isFinite(from) ? from : safeTo;

  const prevToken = activeCountUps.get(el);
  if (prevToken) prevToken.cancelled = true;

  // .stat span:last-child's own CSS transitions `color` (used by the turn-
  // cue callout) - preserved alongside our inline `transform` transition
  // below rather than overwritten, since setting .style.transition replaces
  // the whole property, not just the parts we care about here.
  const shrinkTransition = `transform ${COUNT_UP_SHRINK_MS}ms ease, color 0.2s ease`;

  if (safeFrom === safeTo) {
    el.textContent = safeTo;
    // A previous run may have been interrupted mid-grow, leaving the scale
    // stuck above 1x - always settle it back down even when there's no new
    // number to animate toward.
    el.style.transition = shrinkTransition;
    el.style.transform = "scale(1)";
    if (onComplete) onComplete();
    return;
  }

  const token = { cancelled: false };
  activeCountUps.set(el, token);

  const raf = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(Date.now()), 16);
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const start = now();

  // No transform transition while the grow itself is being driven
  // frame-by-frame below (color's is kept) - only the shrink-back at the
  // end gets one (set right before the final scale(1) is applied), so the
  // two phases never fight each other.
  el.style.transition = "color 0.2s ease";

  function step() {
    if (token.cancelled) return;
    const t = Math.min(1, (now() - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(safeFrom + (safeTo - safeFrom) * eased);
    el.style.transform = `scale(${1 + (COUNT_UP_GROW_SCALE - 1) * eased})`;
    if (t < 1) {
      raf(step);
    } else {
      el.style.transition = shrinkTransition;
      el.style.transform = "scale(1)";
      if (onComplete) onComplete();
    }
  }
  raf(step);
}

const PIP_PATTERNS = {
  // The Void's blank face (see createDieFace()) - no active pips at all.
  0: [],
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};

// Fixed value on each cube face (opposite faces sum to 7, like a real die).
const FACE_VALUE_BY_POSITION = { front: 1, right: 2, top: 3, bottom: 4, left: 5, back: 6 };

// Cube rotation (deg, mod 360) that brings a given value's face to the front.
const FACE_ROTATION = {
  1: { x: 0, y: 0 },
  2: { x: 0, y: -90 },
  3: { x: -90, y: 0 },
  4: { x: 90, y: 0 },
  5: { x: 0, y: 90 },
  6: { x: 0, y: 180 },
};

// Shared by createDieFace()'s normal paint and playCoinDieRevealAnimation()'s
// own hand-placed one (see coinDieRevealPendingInstances below), so the two
// can never drift into painting visibly different marks. `count` is how
// many owned Coin Die instances share this exact die/face - each pays out
// independently (see coinDieMoneyGain()), so 2+ landing on the same spot
// gets a small stack number next to the coin instead of silently vanishing
// into a single indistinguishable badge.
function buildCoinMarkEl(count) {
  const wrap = document.createElement("span");
  wrap.className = "die-coin-mark";
  const icon = document.createElement("span");
  icon.className = "die-coin-mark-icon";
  icon.textContent = "$";
  wrap.appendChild(icon);
  let countEl = null;
  if (count > 1) {
    countEl = document.createElement("span");
    countEl.className = "die-coin-mark-count";
    countEl.textContent = String(count);
    wrap.appendChild(countEl);
  }
  return { wrap, icon, countEl };
}

function createDieFace(position, value, coinCount) {
  const face = document.createElement("div");
  face.className = "die-face " + position;
  const active = new Set(PIP_PATTERNS[value] || []);
  for (let p = 1; p <= 9; p++) {
    const pip = document.createElement("div");
    pip.className = "pip p" + p + (active.has(p) ? " active" : "");
    face.appendChild(pip);
  }
  // Coin Die (see RULE_POOL): paints the one face its random pick landed on,
  // so the player can actually see which physical face pays out before
  // committing, rather than having to remember/infer it.
  if (coinCount > 0) face.appendChild(buildCoinMarkEl(coinCount).wrap);
  return face;
}

// A wild die that's actually active this round never shows a real face -
// every side is a "?", since its rolled value doesn't matter (scoring
// substitutes whatever face is best regardless of what it "shows").
function createWildDieFace(position) {
  const face = document.createElement("div");
  face.className = "die-face die-face-wild " + position;
  const mark = document.createElement("span");
  mark.className = "wild-mark";
  mark.textContent = "?";
  face.appendChild(mark);
  return face;
}

function renderDie(index) {
  const scene = document.createElement("div");
  scene.className = "die-scene";
  // Double Down Token (see activateUsable()) - every die, not just one
  // (unlike Blue Die/Lucky Die/Streak Die/Coin Die above, which each mark
  // one specific dieIndex), for as long as it's primed.
  if (state.doubleDownActive) scene.classList.add("die-burning");
  if (state.held[index]) scene.classList.add("held");
  if (index === state.bossLockedDieIndex) scene.classList.add("boss-locked");
  if (index === state.bossForcedRerollDieIndex) scene.classList.add("boss-forced-reroll");
  // The Vice: cemented by an earlier throw this hand (see rollDice()) - a
  // flat icon overlay on the scene itself (not a face inside the rotating
  // cube), so it stays put and readable no matter which face is showing.
  const isViceLocked = state.viceLockedIndices.includes(index);
  if (isViceLocked) scene.classList.add("vice-locked");
  const isWildActive = activeWildIndices().includes(index);
  if (isWildActive) scene.classList.add("wild");
  // Blue Die (see RULE_POOL/blueDieBonusFor()): the whole die, every
  // face - unlike Coin Die's single marked face, this applies regardless of
  // which value happens to be showing, so a plain scene-level class (like
  // .held/.wild above) is enough - no per-face work needed in createDieFace().
  if (state.perksOwned.some((p) => p.id === "blueDie" && p.dieIndex === index)) {
    scene.classList.add("blue-die-marked");
  }
  // Lucky Die (see PERK_POOL) - a very subtle permanent pink tint on every
  // face (not just one), same whole-die reasoning as Blue Die above. Only
  // ever one instance (doesn't stack), so no count/stack handling needed.
  if (state.perksOwned.some((p) => p.id === "luckyDie" && p.dieIndex === index)) {
    scene.classList.add("lucky-die-marked");
  }
  scene.dataset.index = index;

  const cube = document.createElement("div");
  cube.className = "die-cube";

  if (isWildActive) {
    Object.keys(FACE_VALUE_BY_POSITION).forEach((position) => {
      cube.appendChild(createWildDieFace(position));
    });
    cube.style.transform = "rotateX(0deg) rotateY(0deg)";
  } else {
    // The Void: the physical cube geometry/rotation is untouched (that face
    // is still reached the exact same way it always was, via
    // FACE_ROTATION[N]/cornerRotationForValue(N) in rollDice()) - only what
    // gets PAINTED on whichever one face the player rolled at the start of
    // the level (see renderVoidRollModal()) changes, from its normal pip
    // pattern to blank, matching what a roll that lands there is now
    // actually worth.
    const voidBlockedFace = activeBossModifier()?.id === "theVoid" ? state.voidBlockedFace : null;
    // How many Coin Die instances, if any, marked each face value on this
    // specific die index - checked per-face below via displayValue, and
    // shown as a stack count once 2+ share the exact same face (see
    // buildCoinMarkEl()). An instance still mid-reveal (see
    // coinDieRevealPendingInstances) is excluded here on purpose -
    // playCoinDieRevealAnimation() paints its own contribution by hand once
    // the turn itself finishes, not before, so a render triggered mid-turn
    // (e.g. by an unrelated state change) can't leak it onto the face early.
    const coinFaceCounts = new Map();
    state.perksOwned
      .filter((p) => p.id === "coinDie" && p.dieIndex === index && !coinDieRevealPendingInstances.has(p))
      .forEach((p) => coinFaceCounts.set(p.faceValue, (coinFaceCounts.get(p.faceValue) || 0) + 1));
    Object.entries(FACE_VALUE_BY_POSITION).forEach(([position, value]) => {
      const displayValue = value === voidBlockedFace ? 0 : value;
      cube.appendChild(createDieFace(position, displayValue, coinFaceCounts.get(value) || 0));
    });
    const rot = state.dieRotation[index];
    cube.style.transform = `rotateX(${rot.x}deg) rotateY(${rot.y}deg)`;
  }

  scene.appendChild(cube);
  if (isViceLocked) {
    const lockIcon = document.createElement("span");
    lockIcon.className = "vice-lock-icon";
    lockIcon.textContent = "🔒";
    scene.appendChild(lockIcon);
  }
  // Streak Die (see PERK_POOL/streakDieBonusFor()): whole-die, like Blue
  // Die above, not per-face like Coin Die - shown as one combined badge for
  // every instance marking this die (they always grow in lockstep, sharing
  // the exact same trigger), so a Coin Die-style per-instance stack count
  // isn't needed here, just the total. Shown even at +0 (freshly picked,
  // never yet grown) so the marked die itself is still discoverable before
  // its first hit.
  const streakDieInstances = state.perksOwned.filter((p) => p.id === "streakDie" && p.dieIndex === index);
  if (streakDieInstances.length > 0) {
    const streakBadge = document.createElement("span");
    streakBadge.className = "die-streak-badge";
    streakBadge.textContent = `+${streakDieInstances.reduce((sum, p) => sum + p.bonus, 0)}`;
    scene.appendChild(streakBadge);
  }
  scene.addEventListener("click", () => toggleHold(index));
  return scene;
}

function renderDice() {
  diceTray.innerHTML = "";
  state.dice.forEach((_, i) => diceTray.appendChild(renderDie(i)));
}

function totalThrowsAllowed() {
  // Extra Throw only applies to the main game, not the small games.
  const bonus = state.phase === "main" ? state.bonusRerolls : 0;
  const total = 1 + state.baseRerolls + bonus;
  // The Undertaker: takes one reroll away on even turns only - odd turns
  // (including turn 1) keep the full allowance, so it alternates rather
  // than being a flat, permanent -1 every single hand. Floored at 1 so the
  // player is never left with literally nothing to throw.
  const undertakerReduction = activeBossModifier()?.id === "theUndertaker" && state.turn % 2 === 0 ? 1 : 0;
  return Math.max(1, total - undertakerReduction);
}

function upperSectionSum() {
  let upperSum = 0;
  for (const cat of UPPER_CATS) {
    const v = state.scorecard[cat.key];
    if (v != null) upperSum += v;
  }
  return upperSum;
}

function currentTotalScore() {
  let total = 0;
  for (const cat of [...UPPER_CATS, ...LOWER_CATS, ...EXTRA_CATS]) {
    const v = state.scorecard[cat.key];
    if (v != null) total += v;
  }
  if (upperSectionSum() >= UPPER_BONUS_THRESHOLD) total += UPPER_BONUS_AMOUNT;
  return total + state.bonusPoints;
}

// Every completed main level's final score, plus the current main level's
// live score-in-progress - a running lifetime total for the run. Small
// games don't count (see startNextLevel()'s completedLevelsTotal banking),
// so their live score doesn't transiently show here either, only to drop
// back out once the small game ends without ever having been banked.
function grandTotalScore() {
  return state.phase === "main"
    ? state.completedLevelsTotal + currentTotalScore()
    : state.completedLevelsTotal;
}

// Category key to flash orange on its next render (see commitScore()) -
// null when no flash is pending.
let pendingRowFlashKey = null;

// Rule card ids to highlight in the rule inventory (see renderRuleInventory)
// because they just contributed points or money to the hand that was
// committed - unlike pendingRowFlashKey, this isn't a one-shot flag: it
// stays populated across any number of re-renders until the player actually
// throws again (cleared at the top of rollDice()), so the highlight is
// visible the whole time they're deciding what to do with the new hand.
let highlightedRuleCardIds = new Set();

// Category-lock crack: which categories were blocked as of the last
// renderScorecard() call, for diffing against the current one to catch a
// genuinely NEW block (Gatekeeper's turn-to-turn reshuffle, The Turnkey's
// 4-category threshold) - see the category-lock-crack class applied below.
// null until the first call after a fresh level starts (reset in
// startNextLevel()), so that call's already-blocked categories (Sabotage/
// The Culler, both resolved before this ever runs) are captured as the
// baseline instead of misread as "newly" blocked.
let previouslyBlockedCategoryKeys = null;

function renderScorecard() {
  const currentBlockedKeys = new Set(activeCategories().filter((cat) => categoryIsBlocked(cat.key)).map((cat) => cat.key));
  const newlyBlockedKeys = previouslyBlockedCategoryKeys
    ? [...currentBlockedKeys].filter((key) => !previouslyBlockedCategoryKeys.has(key))
    : [];
  previouslyBlockedCategoryKeys = currentBlockedKeys;

  // Any category currently mid-playScoreCommitAnimation() (see
  // scoreCommitAnimatingKeys below) keeps its EXACT existing <tr> instead
  // of getting rebuilt - that animation holds a direct reference to its
  // cells and mutates them with real setTimeout-driven stages over several
  // seconds; nothing blocks the player from rolling/committing again well
  // before it finishes (commitScore() advances state synchronously,
  // unrelated to the animation), and rollDice()'s own scorecardRevealTimer
  // calls this function too. Without this, that next render would wipe the
  // row out from under the in-flight animation - its remaining stages would
  // then run invisibly on a detached node while the fresh row just shows
  // the already-correct final number, reading as the reveal randomly
  // skipping straight to the answer.
  const preservedRows = new Map();
  scoreCommitAnimatingKeys.forEach((key) => {
    const existing = scoreBody.querySelector(`tr[data-category-key="${key}"]`);
    if (existing) preservedRows.set(key, existing);
  });

  scoreBody.innerHTML = "";
  // Consumed immediately (not left set) so only the very next render - the
  // one commitScore() itself triggers - flashes the row; any later
  // re-render (rolling dice, hovering, etc.) must not replay it just
  // because a freshly rebuilt row happens to share that category key.
  const flashKey = pendingRowFlashKey;
  pendingRowFlashKey = null;

  // Lucky Number boosts every hand's score, so its rows get a subtle glow
  // to distinguish them from an unboosted score of the same number.
  const luckyActive = state.perksOwned.some((p) => p.id === "luckyMultiplier");

  const addSectionRow = (label, suffixNodes) => {
    const tr = document.createElement("tr");
    tr.className = "section-row";
    const td = document.createElement("td");
    td.colSpan = 3;
    td.textContent = label;
    (suffixNodes || []).forEach((node) => td.appendChild(node));
    tr.appendChild(td);
    scoreBody.appendChild(tr);
  };

  const addCatRow = (cat) => {
    const preserved = preservedRows.get(cat.key);
    if (preserved) {
      // The Turnkey: this row's own commit-reveal animation can still be
      // mid-flight when the player has already rolled a fresh hand to
      // repeat into it - the preserved node is frozen exactly as it was
      // the instant the animation grabbed it (before it ever had a chance
      // to render as selectable for a NEW throw), so without this it just
      // sits inert - no click handler, no selectable class - for the
      // remaining ~5s the reveal takes, reading as "won't let me commit
      // again." Only the tr's own interactivity is touched here, never
      // scoreTd's content - the animation's closures own that directly
      // (see playScoreCommitAnimation()) and would just get fought over by
      // a live-preview rebuild running at the same time. Bound at most
      // once per preserved node (tracked via a dataset flag) since this
      // whole branch re-runs on every render for as long as the category
      // stays preserved - a fresh commitScore() call bound on every one of
      // those renders would fire multiple times per real click.
      const blocked = state.phase === "main" && categoryIsBlocked(cat.key);
      const turnkeyRepeatable = state.phase === "main" && !blocked && activeBossModifier()?.id === "theTurnkey";
      const canThrow = state.rolled && !state.awaitingNextRound;
      if (turnkeyRepeatable && canThrow) {
        preserved.classList.add("selectable");
        preserved.tabIndex = 0;
        if (!preserved.dataset.turnkeyRepeatBound) {
          preserved.dataset.turnkeyRepeatBound = "1";
          preserved.addEventListener("click", () => commitScore(cat.key));
        }
      } else {
        preserved.classList.remove("selectable");
        preserved.removeAttribute("tabindex");
      }
      scoreBody.appendChild(preserved);
      return;
    }
    const tr = document.createElement("tr");
    // Always present (not just while selectable) so the just-committed row
    // can still be found afterward - see playScoreCommitAnimation(), which
    // looks it up only after the commit's own renderAll() has already
    // redrawn it as filled.
    tr.dataset.categoryKey = cat.key;
    const doubled = isDoubleTarget(cat.key);
    if (doubled) tr.classList.add("doubled");

    const moneyTd = document.createElement("td");
    moneyTd.className = "cat-money";
    if (state.phase === "main") {
      const cardMult = categoryCardMultiplier(cat.key);
      const totalMult = doubled ? cardMult * HOTLINE_MULTIPLIER : cardMult;
      if (totalMult !== 1) {
        moneyTd.textContent = formatMultiplier(totalMult);
        moneyTd.classList.add("cat-multiplier", doubled ? "cat-multiplier-doubled" : "cat-multiplier-card");
        // The Culler: an unfilled category's multiplier badge reads as a
        // muted gray-orange instead of the normal solid orange/green while
        // it's still open, so its +0.2x is visibly the boss's doing rather
        // than an owned card - see the "filled" branch below for the
        // matching treatment once the row actually gets committed.
        const filledAlready = state.scorecard[cat.key] != null;
        if (!filledAlready && state.cullerBoostedCategoryKeys.includes(cat.key)) {
          moneyTd.classList.add("cat-multiplier-culler");
        }
      } else {
        moneyTd.textContent = "-";
      }
    } else {
      // Make it count multiplies the money paid out per active copy -
      // reflect that in the preview too, not just the payout, with a
      // subtle glow calling out that it's boosted. Rounded the same way
      // commitScore() rounds the actual payout (a fractional multiplier
      // can otherwise land on a .5, showing a preview that doesn't match
      // what actually gets credited).
      const makeItCountStacks = activeMakeItCountStacks();
      const makeItCountMult = 1 + MAKE_IT_COUNT_MONEY_MULT_PER_STACK * makeItCountStacks;
      const totalMoney = Math.round(cat.money * (doubled ? HOTLINE_MULTIPLIER : 1) * makeItCountMult);
      if (totalMoney === 0) {
        moneyTd.textContent = "-";
      } else {
        moneyTd.textContent = `$${totalMoney}`;
        if (makeItCountStacks > 0) moneyTd.classList.add("cat-money-boosted");
      }
    }

    const nameTd = document.createElement("td");
    nameTd.className = "cat-name";
    nameTd.textContent = cat.name;
    const scoreTd = document.createElement("td");
    scoreTd.className = "cat-score";

    const canThrow = state.rolled && !state.awaitingNextRound;

    if (state.phase === "main") {
      // Main game: each category can only be locked in once - unless The
      // Turnkey is active, in which case a filled category stays
      // selectable/clickable forever instead of freezing (see
      // commitScore()'s allowRepeat), so it needs to keep falling through
      // to the canThrow branch below rather than stopping at "filled".
      const filled = state.scorecard[cat.key] != null;
      const blocked = categoryIsBlocked(cat.key);
      const turnkeyRepeatable = filled && !blocked && activeBossModifier()?.id === "theTurnkey";
      if (blocked) {
        // Sabotage/The Culler/The Turnkey (all permanent) or The Gatekeeper
        // (this turn only) - unselectable regardless of whether dice have
        // been rolled or the hand would otherwise fit.
        tr.classList.add("disabled", "blocked");
        scoreTd.textContent = "Blocked";
        if (newlyBlockedKeys.includes(cat.key)) {
          scoreTd.classList.add("category-lock-crack");
          // If a boss just arrived (see triggerBossArrivalSlam()) and its
          // own shake, or the scorecard's own top-to-bottom reveal (see
          // triggerScorecardReveal()), is still playing, hold the crack's
          // animation off until BOTH finish instead of letting them play at
          // once - an animation-delay on the (correctly, freshly-rendered)
          // node itself, not a deferred class addition, since this row gets
          // torn down and rebuilt on the next render long before a
          // setTimeout callback could safely reach it.
          const elapsedSinceSlam = bossArrivalSlamStartedAt != null ? Date.now() - bossArrivalSlamStartedAt : Infinity;
          const shakeDelay = Math.max(0, BOSS_ARRIVAL_SHAKE_DURATION_MS - elapsedSinceSlam);
          const elapsedSinceReveal = scorecardRevealStartedAt != null ? Date.now() - scorecardRevealStartedAt : Infinity;
          const revealDelay = Math.max(0, SCORECARD_REVEAL_DURATION_MS - elapsedSinceReveal);
          const crackDelay = Math.max(shakeDelay, revealDelay);
          if (crackDelay > 0) scoreTd.style.animationDelay = `${crackDelay}ms`;
        }
      } else if (filled && !(turnkeyRepeatable && canThrow)) {
        tr.classList.add("filled");
        if (state.cullerBoostedCategoryKeys.includes(cat.key)) tr.classList.add("culler-boosted");
        scoreTd.textContent = state.scorecard[cat.key];
        if (luckyActive) scoreTd.classList.add("lucky-glow");
      } else if (canThrow) {
        tr.classList.add("selectable");
        if (turnkeyRepeatable) tr.classList.add("filled");
        tr.tabIndex = 0;
        const wildIndices = activeWildIndices();
        const breakdown = scoreBreakdownForCategory(cat.key, state.dice, wildIndices);
        const raw = breakdown.afterCatMult;
        const preview = Math.round(raw * (doubled ? HOTLINE_MULTIPLIER : 1) * state.scoreMultiplier);
        // The number itself never changes to reflect a rule card's bonus
        // (Base Points, Six-Seven, a hand-pattern card) - it's called out
        // separately as a purple "+X" to its left instead. Committing this
        // row right now would still bank the full preview amount (base +
        // bonus) exactly as before - see commitScore(), unchanged - this
        // split only affects how the live preview displays it. Six-Seven's
        // own delta IS scaled by the category multiplier (it's folded into
        // the raw hand value, same as scoreBreakdownForCategory() does) -
        // Base Points/hand-pattern cards are not.
        const flatScaleUp = (doubled ? HOTLINE_MULTIPLIER : 1) * state.scoreMultiplier;
        const sixSevenScaleUp = breakdown.catMult * flatScaleUp;
        const bonusPreview = raw > 0
          ? Math.round(breakdown.sixSevenDelta * sixSevenScaleUp + breakdown.bonusTotal * flatScaleUp)
          : 0;
        // The Turnkey: this category already has a banked total from an
        // earlier commit - show it as a dim prefix so committing again
        // doesn't look like it's replacing that total, only adding to it
        // (see finishCommitScore()'s alreadyUsed accumulation).
        if (turnkeyRepeatable) {
          const bankedEl = document.createElement("span");
          bankedEl.className = "cat-score-banked";
          bankedEl.textContent = `${state.scorecard[cat.key]}+`;
          scoreTd.appendChild(bankedEl);
        }
        if (bonusPreview !== 0) {
          const bonusEl = document.createElement("span");
          bonusEl.className = "cat-score-bonus";
          bonusEl.textContent = bonusPreview > 0 ? `+${bonusPreview}` : String(bonusPreview);
          // Hovering the "+X" reveals exactly which rule card(s) it's made
          // of and how much each contributed (scaled the same way the
          // combined total above is), instead of leaving the player to
          // guess from the number alone.
          const ruleBreakdown = ruleCardScoreBreakdown(cat.key, state.dice, wildIndices);
          if (ruleBreakdown.length > 0) {
            const tooltip = document.createElement("div");
            tooltip.className = "perk-tooltip";
            tooltip.textContent = ruleBreakdown
              .map(({ id, name, amount }) => {
                const scaled = Math.round(amount * (id === "sixSeven" ? sixSevenScaleUp : flatScaleUp));
                return `${name} ${scaled > 0 ? "+" : ""}${scaled}`;
              })
              .join(", ");
            bonusEl.appendChild(tooltip);
            attachClampedTooltip(bonusEl, tooltip, scorecardPanel);
          }
          scoreTd.appendChild(bonusEl);
        }
        scoreTd.appendChild(document.createTextNode(String(preview - bonusPreview)));
        if (luckyActive) scoreTd.classList.add("lucky-glow");
        tr.addEventListener("click", () => commitScore(cat.key));
      } else {
        tr.classList.add("disabled");
        scoreTd.textContent = "-";
      }
    } else {
      // Small games: the same hand can be thrown into the same category
      // again, so a row stays clickable even after it's been used - one
      // checkmark accumulates per successful throw into it. Only a
      // category the current roll actually scores in is selectable (e.g.
      // Chance always fits since any roll sums to something); everything
      // else is grayed out rather than accepting a non-matching dump.
      const usedCount = state.categoryUseCount[cat.key];
      if (usedCount > 0) tr.classList.add("filled");

      const fitsRoll = canThrow && scoreWithCategoryBonus(cat.key, state.dice, activeWildIndices()) > 0;
      if (fitsRoll) {
        tr.classList.add("selectable");
        tr.tabIndex = 0;
        tr.dataset.categoryKey = cat.key;
        tr.addEventListener("click", () => commitScore(cat.key));
      } else {
        tr.classList.add("disabled");
      }
      scoreTd.textContent = "✓".repeat(usedCount);
    }

    tr.appendChild(moneyTd);
    tr.appendChild(nameTd);
    tr.appendChild(scoreTd);
    scoreBody.appendChild(tr);
    if (cat.key === flashKey) triggerCatRowInkFill(tr);
  };

  if (state.phase === "main") {
    const upperSum = upperSectionSum();
    const progress = document.createElement("span");
    progress.className = "upper-progress";
    progress.textContent = ` ${upperSum}/${UPPER_BONUS_THRESHOLD}`;
    const suffixNodes = [progress];
    if (upperSum >= UPPER_BONUS_THRESHOLD) {
      const bonus = document.createElement("span");
      bonus.className = "upper-bonus-reached";
      bonus.textContent = ` Bonus +${UPPER_BONUS_AMOUNT}`;
      suffixNodes.push(bonus);
    }
    addSectionRow("Upper Section", suffixNodes);
    UPPER_CATS.forEach(addCatRow);
    addSectionRow("Lower Section");
  }
  lowerCategories().forEach(addCatRow);

  // Keeps the rule inventory's "currently relevant" pulses (see
  // ruleCardAffectsAnyRow()) in sync with whatever dice the scorecard
  // preview above was just computed against - renderScorecard() is called
  // every time that changes (a fresh roll, a hold toggle, a commit), so
  // coupling this here means every call site gets it for free.
  renderRuleInventory();
  renderUsableInventory();
}

// Sibling panel to renderRuleInventory(), just below it (see
// #usableInventory in index.html) - lists state.usablesOwned instead of the
// perksOwned-derived rule cards. Unlike a rule card, each item here is
// clickable: usableActivatable() gates whether clicking it actually spends
// it (see activateUsable()), rendered as a dimmed, inert pill otherwise
// rather than hidden outright, so the player can see it's there and why it
// can't be used yet (the tooltip still explains the "why").
function renderUsableInventory() {
  usableInventory.innerHTML = "";
  if (state.usablesOwned.length === 0) {
    usableInventory.classList.add("hidden");
    return;
  }
  usableInventory.classList.remove("hidden");

  state.usablesOwned.forEach((instance) => {
    const usable = USABLE_POOL.find((u) => u.id === instance.id);
    if (!usable) return;
    const activatable = usableActivatable(instance);

    const item = document.createElement("div");
    item.className = "rule-inventory-item usable-item" + (activatable ? "" : " usable-item-inactive");
    // Multi-charge items (Free Reroll Token) show their remaining count
    // next to the name - one-shot items (instance.charges undefined, e.g.
    // Boss Skip Token) just show the plain name, same as before.
    item.textContent = instance.charges != null ? `${usable.name} ×${instance.charges}` : usable.name;

    const tooltip = document.createElement("div");
    tooltip.className = "perk-tooltip";
    const tooltipTitle = document.createElement("div");
    tooltipTitle.className = "perk-tooltip-title";
    tooltipTitle.textContent = usable.name;
    tooltip.appendChild(tooltipTitle);
    tooltip.appendChild(document.createTextNode(
      activatable ? usable.desc : `${usable.desc} (Not usable right now.)`
    ));
    item.appendChild(tooltip);
    attachFixedTooltip(item, tooltip);

    if (activatable) item.addEventListener("click", () => activateUsable(instance.instanceId));

    usableInventory.appendChild(item);
  });
}

const PERK_SLOT_COUNT = 4;
const PERK_DELETE_REFUND = 5;
const PERK_DELETE_REFUND_SHINY = 20;

// An xMult perk's own multiplier is usually a plain number (First Instinct,
// Demolisher, Skipper), but a perk like Minimalist needs to read live state
// (how many perk slots are empty right now) instead of a value stored on
// the instance - so xMult may also be a function(state). Both commitScore()
// and renderPerks()'s cue text resolve through this one helper so neither
// has to know which kind a given perk uses.
function resolveXMult(perk, state) {
  return typeof perk.xMult === "function" ? perk.xMult(state) : perk.xMult;
}

// A trailing "(+Nx)" for an owned X-mult perk instance's OWN current
// contribution, always the real live value (never gated by
// xMultBadgeIsActive() the way the perk-card badge is) - used wherever
// multiple copies of the same growing card (Demolisher, Skipper, Streaker,
// Straight Shot) need to read as genuinely different picks rather than
// identical duplicates, e.g. the perk-slots-full replace picker. Perks with
// no xMult at all get no tag.
function perkXMultTag(perk) {
  return typeof perk.xMult !== "undefined" ? ` (+${resolveXMult(perk, state)}x)` : "";
}

// Whether an xMult perk's badge (see renderPerks()) should show its real
// contribution right now, vs the neutral +0x baseline. Only perks whose
// xMultCondition depends on state alone (Milestone's turn gate, First
// Instinct's no-reroll gate) can actually be evaluated live here - one that
// also needs `key` (Uppercut's category check) can't know which category
// the player might commit into next, so it always shows its real value
// rather than guessing. Perks with no condition, or one that's always true
// (Demolisher/Skipper/Minimalist/Streaker), are always "active" too.
function xMultBadgeIsActive(perk, state) {
  if (!perk.xMultCondition) return true;
  if (perk.xMultCondition.length >= 2) return true;
  return !!perk.xMultCondition(state);
}

// Identity + origin slot of the perk currently being drag-reordered/deleted
// (both null when nothing is being dragged). Module level rather than
// DataTransfer-based since it never needs to survive leaving the window
// (perk cards only reorder within this page). Tracked by instanceId, not
// array index, since perkSlotOrder positions perks by slot, not by their
// position in state.perksOwned.
let draggedPerkInstanceId = null;
let draggedFromSlot = null;

// True for the moment between a successful trash-drop and the source
// card's own "dragend" firing right after it - lets dragend know to leave
// the trash can (and its gain cue) alone instead of hiding it immediately,
// so the cue actually has time to be seen.
let perkTrashCueActive = false;

// Extra Perk raises this without occupying a slot itself (see renderPerks).
// Extra Perk raises this without occupying a slot itself. Shiny perks (see
// SHINY_PERK_CHANCE) DO occupy their own real, visible slot - but it's an
// extra one layered on top of the normal cap, so owning one never
// contributes to "perk slots full" (isSlotOccupyingPerk still counts them
// in visibleCount, and this grows capacity by the exact same amount, so the
// two increases cancel out in every fullness check).
function effectivePerkSlotCount() {
  const extraPerkCopies = state.perksOwned.filter((p) => p.id === "extraPerkSlot").length;
  const shinyCopies = state.perksOwned.filter((p) => p.shiny && isSlotOccupyingPerk(p)).length;
  return PERK_SLOT_COUNT + extraPerkCopies + shinyCopies;
}

// True for perks that occupy a visible perk-card slot - excludes Extra Perk
// (raises capacity without occupying a slot itself) and persistent rule-card
// instances (tracked separately in the rule inventory, never in the perk
// slots, even though they live in the same perksOwned array).
function isSlotOccupyingPerk(p) {
  return p.id !== "extraPerkSlot" && !p.persistent;
}

// True for perks that occupy a slot AND count toward the normal cap -
// excludes shiny copies too (their slot is an extra one layered on top of
// the cap, see effectivePerkSlotCount(), so trading one away wouldn't
// actually make room for anything - never offer them as a "make room"
// candidate, even though they're still perfectly valid targets for
// unrelated removal mechanics like Clean Slate/Selective Cut).
function isNormalSlotPerk(p) {
  return isSlotOccupyingPerk(p) && !p.shiny;
}

// Maps each rendered perk card element to the perk instance it shows, so a
// FLIP reorder animation can find "the same card" before and after a
// re-render (matched by that stable instance reference, not DOM identity).
const cardToPerkInstance = new WeakMap();

// Backfills instanceId on any perk that doesn't have one yet (freshly
// picked, or loaded from a save predating this field), then reconciles
// state.perkSlotOrder against state.perksOwned: drops entries for perks
// that no longer exist, grows/shrinks to match effectivePerkSlotCount()
// (shrinking only ever removes trailing *empty* slots, never one that's
// occupied), and places any not-yet-slotted perk into the first empty slot.
// Perks intentionally are NOT auto-compacted otherwise, so a card dropped
// into slot 3 while slot 1 is empty just stays there.
function syncPerkSlotOrder() {
  state.perksOwned.forEach((p) => {
    if (p.instanceId == null) p.instanceId = state.nextPerkInstanceId++;
  });

  const visible = state.perksOwned.filter(isSlotOccupyingPerk);
  const validIds = new Set(visible.map((p) => p.instanceId));

  if (!Array.isArray(state.perkSlotOrder)) state.perkSlotOrder = [];
  state.perkSlotOrder = state.perkSlotOrder.map((id) => (id != null && validIds.has(id) ? id : null));

  const capacity = effectivePerkSlotCount();
  while (state.perkSlotOrder.length < capacity) state.perkSlotOrder.push(null);
  while (state.perkSlotOrder.length > capacity && state.perkSlotOrder[state.perkSlotOrder.length - 1] == null) {
    state.perkSlotOrder.pop();
  }

  const placedIds = new Set(state.perkSlotOrder.filter((id) => id != null));
  visible.forEach((perk) => {
    if (placedIds.has(perk.instanceId)) return;
    const emptyIndex = state.perkSlotOrder.indexOf(null);
    if (emptyIndex !== -1) state.perkSlotOrder[emptyIndex] = perk.instanceId;
    else state.perkSlotOrder.push(perk.instanceId);
    placedIds.add(perk.instanceId);
  });
}

// Adds the shiny hologram class to a perk card/option element - shared
// between the level-up offer buttons and the owned perk-slot cards, since a
// shiny instance keeps its shine once picked. The holo sheen animation
// itself (see .perk-card.shiny::before in style.css) is what reads as
// "shiny" - no separate corner badge on top of it.
function decorateShiny(el) {
  el.classList.add("shiny");
}

// Adds a small shield badge to the top-left corner of a perk card/option
// element - shared by every place an owned perk instance is rendered (see
// every "if (perk.shielded) decorateShielded(...)" call site), so a
// shielded perk reads as protected everywhere it shows up, not just in its
// home slot. Opposite corner from .perk-card-icon (top-right) and the
// xMult badge (top-center), so all three can coexist without overlapping.
function decorateShielded(el) {
  const badge = document.createElement("div");
  badge.className = "perk-shield-badge";
  badge.textContent = "\u{1F6E1}\u{FE0F}";
  el.appendChild(badge);
}

// ---------- Card tilt/parallax ----------
// A lightweight pointer-tracking 3D tilt + glare, shared by every "card"
// element in the game (perk cards, pack/collection cards) - purely
// cosmetic. Suspended during an actual drag (perk cards are draggable for
// slot reordering - fighting that with a tilt transform mid-drag would look
// broken) and reset on mouseleave so an idle card falls back to its own
// plain CSS hover state.
const CARD_TILT_MAX_DEG = 8;
const CARD_TILT_LIFT_PX = 8;

function attachCardTilt(el) {
  if (!el) return;
  el.classList.add("tilt-card");
  let dragging = false;

  function onMove(e) {
    if (dragging) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const rotateY = (px - 0.5) * 2 * CARD_TILT_MAX_DEG;
    const rotateX = (0.5 - py) * 2 * CARD_TILT_MAX_DEG;
    el.style.transform = `perspective(700px) translateY(-${CARD_TILT_LIFT_PX}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    el.style.setProperty("--tilt-x", `${px * 100}%`);
    el.style.setProperty("--tilt-y", `${py * 100}%`);
    el.classList.add("tilt-active");
  }

  function reset() {
    el.style.transform = "";
    el.classList.remove("tilt-active");
  }

  el.addEventListener("mousemove", onMove);
  el.addEventListener("mouseleave", reset);
  el.addEventListener("dragstart", () => { dragging = true; reset(); });
  el.addEventListener("dragend", () => { dragging = false; });
}

// Gentle RGB-split pulse marking a shiny perk or boosted category card's
// first reveal - a pair of offset color drop-shadows (which, unlike
// box-shadow, follow the actual silhouette of the card's own content, so
// it reads as a genuine chromatic-aberration ghost of the card rather than
// a plain colored rectangle), eased up to full strength and back down
// again as two explicit stages (not a single "snap on, ease off" flash -
// an instant onset reads as rapid/twitchy no matter how slow the fade back
// out is). Drives its own inline `transition`/`filter` throughout, so it
// never fights the card's own entrance flip (packCardFlipIn) over the
// shared `animation` shorthand property, and only relinquishes control
// back to .tilt-card's own default transition once the whole pulse is
// done. Both call sites invoke this while the card is still being
// assembled, before it's even inserted into the document - starting the
// rise synchronously right then would run on a detached, unpainted node
// and never be visible at all, so it's deferred to the next animation
// frame, by which point the caller has finished building and inserting it.
const CHROMATIC_SPLIT_FILTER = "drop-shadow(-2px 0 1px rgba(255, 45, 95, 0.53)) drop-shadow(2px 0 1px rgba(50, 210, 255, 0.53))";
const CHROMATIC_SPLIT_STAGE_MS = 1000;

function triggerChromaticSplit(el) {
  el.classList.add("tilt-card"); // guarantees .tilt-card's own default filter transition exists even if this card wasn't already tilt-enabled
  requestAnimationFrame(() => {
    el.style.transition = "none";
    el.style.filter = "";
    void el.offsetWidth;
    el.style.transition = `filter ${CHROMATIC_SPLIT_STAGE_MS}ms ease-in-out`;
    el.style.filter = CHROMATIC_SPLIT_FILTER;
    setTimeout(() => {
      el.style.filter = "";
      setTimeout(() => { el.style.transition = ""; }, CHROMATIC_SPLIT_STAGE_MS);
    }, CHROMATIC_SPLIT_STAGE_MS);
  });
}

// A single shine sweep across a boosted category pack card, starting
// immediately so it overlaps the card's own flip-in rotation instead of
// waiting for it to finish (unlike triggerChromaticSplit() above, which
// deliberately waits for the flip to complete) - card-pack-only, not perk
// cards, which already have their own persistent shimmer for shiny (see
// .perk-card.shiny::before in style.css). The actual class toggle is
// deferred a frame, same "card isn't inserted into the document yet at the
// call site" reason triggerChromaticSplit() defers too. Cleanup is a plain
// setTimeout matched to the CSS animation's own duration, not an
// animationend listener - an animationend can fire more than once for an
// element that ends up with more than one animation on it over its
// lifetime (this card's own packCardFlipIn entrance included), which was
// cutting the sweep off partway and then re-triggering it. The idempotency
// guard means a duplicate call (however it happened) can never restart an
// already-played sweep either.
const BOOSTED_SHINE_DURATION_MS = 1000;

function triggerBoostedShine(el) {
  if (el.dataset.boostedShinePlayed) return;
  el.dataset.boostedShinePlayed = "1";
  requestAnimationFrame(() => {
    el.classList.add("boosted-shine");
    setTimeout(() => el.classList.remove("boosted-shine"), BOOSTED_SHINE_DURATION_MS);
  });
}

function renderPerks() {
  perkSlots.innerHTML = "";
  syncPerkSlotOrder();

  const byInstanceId = new Map(state.perksOwned.map((p) => [p.instanceId, p]));

  state.perkSlotOrder.forEach((instanceId, slotIndex) => {
    const perk = instanceId != null ? byInstanceId.get(instanceId) : null;

    if (!perk) {
      // Empty slots are valid drop targets too - a card dropped here swaps
      // into this exact slot, leaving its old slot empty behind it.
      const slot = document.createElement("div");
      slot.className = "perk-slot";
      slot.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (draggedFromSlot === null || draggedFromSlot === slotIndex) return;
        swapPerkSlotsAnimated(draggedFromSlot, slotIndex);
        draggedFromSlot = slotIndex;
      });
      slot.addEventListener("drop", (e) => e.preventDefault());
      perkSlots.appendChild(slot);
      return;
    }

    // X Multiplier perks whose trigger condition holds right now (see
    // xMultBadgeIsActive()) get a gentle continuous hover - "this is live
    // this instant", not a one-off flash tied to whichever hand happened to
    // just be committed. Milestone hovers for the whole of turns 5/10/15,
    // not just the moment a hand happens to be scored on one of them; an
    // unconditionally-live perk (Demolisher/Skipper/Minimalist/Streaker)
    // simply hovers all the time, truthfully reflecting that it's always
    // contributing. Re-evaluated fresh on every render, so it naturally
    // turns on/off exactly when the condition itself does (each turn
    // advance and each throw already triggers a render). Main-game only -
    // small games commit far more rapidly, so a perk that's always active
    // there (nearly all of them) would just hover permanently, which reads
    // as noise rather than a meaningful signal.
    const xMultIsActive = !!(typeof perk.xMult !== "undefined" && state.phase === "main" && xMultBadgeIsActive(perk, state));
    // A "perk" boss (The Censor/The Edict) currently silencing this exact
    // instance - see currentlyBlockedPerkInstanceId()/activePerksOwned().
    const isBossBlocked = perk.instanceId === currentlyBlockedPerkInstanceId();
    const card = document.createElement("div");
    card.className = "perk-card" + (perk.tint ? ` tint-${perk.tint}` : "") + (xMultIsActive ? " perk-card-xmult-cue" : "") + (isBossBlocked ? " boss-blocked-perk" : "");
    card.textContent = perk.name;
    card.draggable = true;
    card.dataset.slotIndex = slotIndex;
    cardToPerkInstance.set(card, perk);
    attachCardTilt(card);
    if (perk.shiny) decorateShiny(card);
    if (perk.shielded) decorateShielded(card);

    const tooltip = document.createElement("div");
    tooltip.className = "perk-tooltip";
    tooltip.textContent = perk.desc;
    card.appendChild(tooltip);
    attachClampedTooltip(card, tooltip, diceArea);

    // xMult perks show their current effective contribution at all times,
    // not just while the red trigger cue is active - resolveXMult() handles
    // both the plain-number cards (First Instinct, Demolisher, Skipper,
    // Streaker) and Minimalist's live state-computed one identically. A perk
    // whose trigger condition isn't met right now (e.g. Milestone off turns
    // 5/10/15) shows the neutral +0x baseline instead of its real value, via
    // xMultBadgeIsActive() - a truthful "nothing happens if you commit this
    // instant" readout rather than an always-on number that never changes.
    if (typeof perk.xMult !== "undefined") {
      const multBadge = document.createElement("div");
      multBadge.className = "perk-card-xmult-badge";
      multBadge.textContent = `+${xMultBadgeIsActive(perk, state) ? resolveXMult(perk, state) : 0}x`;
      card.appendChild(multBadge);
    }

    // A permanently-growing X mult (Demolisher/Skipper/Streaker) - a small
    // corner glyph so it reads as visually distinct from the plain
    // conditional red X mult cards at a glance, without needing a whole
    // separate tint (a slightly darker red alone turned out too subtle to
    // actually notice - see PERK_POOL's cumulative field).
    if (perk.cumulative) {
      const cumulativeIcon = document.createElement("div");
      cumulativeIcon.className = "perk-card-icon";
      cumulativeIcon.textContent = "↑";
      card.appendChild(cumulativeIcon);
    }

    // Silenced by a "perk" boss (The Censor/The Edict) - a big X over the
    // (now grayscale, see CSS) card, unmissable at a glance.
    if (isBossBlocked) {
      const xMark = document.createElement("div");
      xMark.className = "boss-blocked-perk-x";
      xMark.textContent = "✕";
      card.appendChild(xMark);
    }

    card.addEventListener("dragstart", (e) => {
      draggedFromSlot = slotIndex;
      draggedPerkInstanceId = perk.instanceId;
      card.classList.add("dragging");
      perkTrash.classList.remove("hidden");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      perkTrash.classList.remove("drag-over");
      if (!perkTrashCueActive) {
        // Normal end (reordered, or dropped nowhere useful) - hide right away.
        perkTrash.classList.add("hidden");
        perkTrashIcon.textContent = PERK_TRASH_IDLE_ICON;
      }
      // Else: a delete just happened - showTrashGainCue()'s own timeout is
      // responsible for hiding the trash once its cue has actually been seen.
      perkTrashCueActive = false;
      draggedFromSlot = null;
      draggedPerkInstanceId = null;
    });

    // Reordering happens live as you drag over a new slot (Balatro-style
    // joker reordering), swapping with whatever's there (another card, or
    // nothing) so cards can land in any slot - including leaving gaps -
    // with the other cards animating out of the way, not just snapping
    // into place on drop.
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (draggedFromSlot === null || draggedFromSlot === slotIndex) return;
      swapPerkSlotsAnimated(draggedFromSlot, slotIndex);
      draggedFromSlot = slotIndex;
    });

    card.addEventListener("drop", (e) => e.preventDefault());

    perkSlots.appendChild(card);
  });
}

// Read-only snapshot of the player's current perk row, for embedding at the
// top of a perk-choice popup (see showLevelCompleteModal()) - the popup
// covers the real #perkSlots row underneath, and remembering everything
// already owned while picking a new one is exactly the thing this is
// answering. Same card look/tooltip as the real row, but no drag/drop and
// no boss-silencing overlay (this is a snapshot, not the live interactive
// row) - see the .owned-perks-summary-row CSS override for the non-
// interactive hover/cursor treatment. Returns null when nothing is owned
// yet, so callers can skip appending an empty section.
function buildOwnedPerksSummary() {
  const owned = state.perksOwned.filter(isSlotOccupyingPerk);

  const wrap = document.createElement("div");
  wrap.className = "owned-perks-summary";

  const label = document.createElement("div");
  label.className = "owned-perks-summary-label";
  label.textContent = "Your current perks:";
  wrap.appendChild(label);

  const row = document.createElement("div");
  row.className = "perk-slots owned-perks-summary-row";
  owned.forEach((perk) => {
    const card = document.createElement("div");
    card.className = "perk-card" + (perk.tint ? ` tint-${perk.tint}` : "");
    card.textContent = perk.name;
    attachCardTilt(card);
    if (perk.shiny) decorateShiny(card);
    if (perk.shielded) decorateShielded(card);

    const tooltip = document.createElement("div");
    tooltip.className = "perk-tooltip";
    tooltip.textContent = perk.desc;
    card.appendChild(tooltip);
    attachClampedTooltip(card, tooltip, modalBox);

    if (typeof perk.xMult !== "undefined") {
      const multBadge = document.createElement("div");
      multBadge.className = "perk-card-xmult-badge";
      multBadge.textContent = `+${xMultBadgeIsActive(perk, state) ? resolveXMult(perk, state) : 0}x`;
      card.appendChild(multBadge);
    }

    if (perk.cumulative) {
      const cumulativeIcon = document.createElement("div");
      cumulativeIcon.className = "perk-card-icon";
      cumulativeIcon.textContent = "↑";
      card.appendChild(cumulativeIcon);
    }

    row.appendChild(card);
  });
  // Empty slots too, same bare placeholder markup as the real perk-slots
  // row (renderPerks()) - otherwise "how many do I actually have open right
  // now" (extraPerkSlot/shiny copies included, via effectivePerkSlotCount())
  // wasn't visible at all in this read-only snapshot, only on the board
  // underneath the popup.
  const emptyCount = Math.max(0, effectivePerkSlotCount() - owned.length);
  for (let i = 0; i < emptyCount; i++) {
    const slot = document.createElement("div");
    slot.className = "perk-slot";
    row.appendChild(slot);
  }
  wrap.appendChild(row);
  return wrap;
}

function renderRuleInventory() {
  const activeRuleIds = RULE_POOL.filter((r) => r.persistent).map((r) => r.id);
  const grouped = new Map(); // rule id -> array of owned instances
  state.perksOwned.forEach((p) => {
    if (!activeRuleIds.includes(p.id)) return;
    if (!grouped.has(p.id)) grouped.set(p.id, []);
    grouped.get(p.id).push(p);
  });

  const items = [];
  grouped.forEach((instances, id) => {
    const rule = RULE_POOL.find((r) => r.id === id);
    const count = instances.length;
    // Savings Bond and Make it count copies each have their own independent
    // progress (locked amount / games remaining), so a plain "stacks" desc
    // would hide that - list each one's own state instead of just repeating
    // the card's static description.
    let desc = rule.desc;
    if (id === "savingsBond") {
      desc = `${rule.desc} ` + instances
        .map((inst) => {
          const gamesLeft = SAVINGS_BOND_MATURITY_GAMES - (inst.mainGamesElapsed || 0);
          return `$${inst.lockedAmount || 0} locked (${gamesLeft} main game${gamesLeft === 1 ? "" : "s"} left).`;
        })
        .join(" ");
    } else if (id === "makeItCount") {
      desc = `${rule.desc} ` + instances
        .map((inst) => {
          const gamesLeft = inst.gamesRemaining || 0;
          return `${gamesLeft} game${gamesLeft === 1 ? "" : "s"} left.`;
        })
        .join(" ");
    } else if (id === "luckySkip") {
      // The bonus is one shared, permanently-banked pool (not per-instance
      // progress like Savings Bond/Make it Count), so show the current
      // running total instead of per-copy state.
      desc = `${rule.desc} Current bonus: +${formatPercent(state.luckySkipBonus)} (Shiny/Boosted now at ${formatPercent(effectiveShinyChance())}, Mega now at ${formatPercent(effectiveMegaChance())}).`;
    } else if (id === "basePoints") {
      // Each copy locked in its own random category at pick time - list
      // which one, same per-instance pattern as Savings Bond/Make it Count.
      desc = `${rule.desc} ` + instances
        .map((inst) => {
          const cat = CAT_BY_KEY[inst.categoryKey];
          return `+${BASE_POINTS_BONUS} to ${cat ? cat.name : "?"}.`;
        })
        .join(" ");
    } else if (id === "fireSale") {
      const shopsLeft = instances[0].shopsRemaining || 0;
      desc = `${rule.desc} ${shopsLeft} shop${shopsLeft === 1 ? "" : "s"} left.`;
    }
    items.push({ id, tint: rule.tint, icon: ruleCardIcon(rule), label: count > 1 ? `${rule.name} ×${count}` : rule.name, desc });
  });

  // Sabotage isn't persistent (it's not pushed into perksOwned like High
  // Stakes) - its "active" state instead lives in sabotageStacks (picked,
  // not yet resolved - the target category isn't decided until the main
  // game actually starts) and blockedCategoryKeys (resolved, main game in
  // progress), so it needs its own check here.
  const pendingSabotage = state.sabotageStacks || 0;
  if (pendingSabotage > 0) {
    const sabotage = RULE_POOL.find((r) => r.id === "sabotage");
    const blockWord = pendingSabotage > 1 ? "blocks" : "block";
    items.push({
      id: "sabotage",
      tint: sabotage.tint,
      icon: ruleCardIcon(sabotage),
      label: sabotage.name,
      desc: `${sabotage.desc} ${pendingSabotage} ${blockWord} pending - decided once the main game starts.`,
    });
  } else if (state.blockedCategoryKeys && state.blockedCategoryKeys.length > 0) {
    const sabotage = RULE_POOL.find((r) => r.id === "sabotage");
    const blockedNames = state.blockedCategoryKeys
      .map((key) => (ALL_CATS.find((c) => c.key === key) || {}).name)
      .filter(Boolean)
      .join(", ");
    items.push({ id: "sabotage", tint: sabotage.tint, icon: ruleCardIcon(sabotage), label: sabotage.name, desc: `${sabotage.desc} Currently blocking: ${blockedNames}.` });
  }

  // Ordered by color/category (RULE_POOL's own order - destructive, then
  // temporary/pink, then the base-value boosts, then the rest/blue) rather
  // than pick order, so the panel stays grouped and predictable regardless
  // of the sequence cards were actually acquired in.
  items.sort((a, b) => RULE_POOL.findIndex((r) => r.id === a.id) - RULE_POOL.findIndex((r) => r.id === b.id));

  ruleInventory.innerHTML = "";
  if (items.length === 0) {
    ruleInventory.classList.add("hidden");
    return;
  }
  ruleInventory.classList.remove("hidden");

  items.forEach(({ id, tint, icon, label, desc }) => {
    // Same live "quieter purple pulse" treatment as ruleCardAffectsAnyRow()
    // (a hand-pattern card currently boosting some row) - Third Time's the
    // Charm and Fire Sale earn it the same way, just off their own live
    // condition instead: Third Time's the Charm once the shop it's showing
    // in has actually reached its discounted 3rd+ set of offers, Fire Sale
    // for as long as it still has shops left to discount (hasFireSale()) -
    // not merely owning either card in general.
    const isActive = ruleCardAffectsAnyRow(id)
      || (id === "thirdTimesTheCharm" && hasThirdTimesCharmDiscount())
      || (id === "fireSale" && hasFireSale());
    const item = document.createElement("div");
    item.className = "rule-inventory-item"
      + (tint ? ` tint-${tint}` : "")
      + (isActive ? " rule-inventory-item-active" : "")
      + (highlightedRuleCardIds.has(id) ? " rule-inventory-item-highlight" : "");
    item.textContent = label;

    if (icon) {
      const iconEl = document.createElement("span");
      iconEl.className = "rule-inventory-item-icon";
      iconEl.textContent = icon;
      item.appendChild(iconEl);
    }

    const tooltip = document.createElement("div");
    tooltip.className = "perk-tooltip";
    const tooltipTitle = document.createElement("div");
    tooltipTitle.className = "perk-tooltip-title";
    tooltipTitle.textContent = label;
    tooltip.appendChild(tooltipTitle);
    tooltip.appendChild(document.createTextNode(desc));
    item.appendChild(tooltip);
    attachFixedTooltip(item, tooltip);

    ruleInventory.appendChild(item);
  });
}

const PERK_REORDER_ANIM_MS = 200;

// FLIP-animates a slot swap: captures each visible card's current on-screen
// position (keyed by its stable perk instance, via cardToPerkInstance),
// swaps the two slots + re-renders, then plays each card from its old spot
// to its new one instead of letting it jump there instantly.
function swapPerkSlotsAnimated(fromSlot, toSlot) {
  if (fromSlot === toSlot) return;

  const prevRects = new Map();
  perkSlots.querySelectorAll(".perk-card").forEach((card) => {
    const inst = cardToPerkInstance.get(card);
    if (inst) prevRects.set(inst, card.getBoundingClientRect());
  });

  const tmp = state.perkSlotOrder[fromSlot];
  state.perkSlotOrder[fromSlot] = state.perkSlotOrder[toSlot];
  state.perkSlotOrder[toSlot] = tmp;
  renderPerks();
  saveState();

  perkSlots.querySelectorAll(".perk-card").forEach((card) => {
    const inst = cardToPerkInstance.get(card);
    const oldRect = inst && prevRects.get(inst);
    if (!oldRect) return;
    const newRect = card.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (!dx && !dy) return;

    card.style.transition = "none";
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    void card.offsetWidth; // force reflow so the transition below actually animates
    card.style.transition = `transform ${PERK_REORDER_ANIM_MS}ms ease`;
    card.style.transform = "";
    setTimeout(() => { card.style.transition = ""; }, PERK_REORDER_ANIM_MS + 20);
  });
}

// Extra Dice can shrink diceCount on delete - keep the dice/held/rotation
// arrays in sync (truncating extra entries, padding back up would only
// happen via picking Extra Dice again, never here) so the tray never shows
// stale dice for a die slot that no longer exists.
function resizeDiceArraysToCount(count) {
  state.dice = state.dice.slice(0, count);
  while (state.dice.length < count) state.dice.push(1);
  state.held = state.held.slice(0, count);
  while (state.held.length < count) state.held.push(false);
  state.dieRotation = state.dieRotation.slice(0, count);
  while (state.dieRotation.length < count) state.dieRotation.push({ x: 0, y: 0 });
  state.wildIndices = state.wildIndices.filter((i) => i < count);
}

// Shiny perks (a rare offer that never cost a normal perk slot to begin
// with) refund far more when scrapped - everything else refunds the plain
// flat amount.
function perkDeleteRefund(perk) {
  return perk.shiny ? PERK_DELETE_REFUND_SHINY : PERK_DELETE_REFUND;
}

// Plays a brief "puff up then dissolve" animation for a perk-slot card
// removed by anything other than the player dragging it to the trash - that
// flow already has its own removal feedback (the drag itself, plus the
// trash can's gain cue), so this covers every other way a normal perk card
// can disappear (Clean Slate, Selective Cut, Ooo Shiny, Extra Life burning
// itself, the level-up "replace" swap...), giving the player a clear "this
// card is gone" cue there too. A no-op for persistent rule-card instances
// (High Stakes, Savings Bond, Make it Count) - those live in the rule
// inventory's grouped text list, not as individual perk-slot cards, so
// there's no single on-screen card to animate.
//
// Animates a short-lived fixed-position CLONE rather than the live card -
// the real card is about to be removed from state and wiped by the next
// render (perkSlots.innerHTML = "" in renderPerks()), so a clone left
// exactly where the original was lets the animation keep playing in place
// completely independent of that re-render, with no need to delay it.
function playPerkDissolveAnimation(perkInstance) {
  const card = [...perkSlots.querySelectorAll(".perk-card")].find(
    (el) => cardToPerkInstance.get(el) === perkInstance
  );
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("perk-card-dissolve-ghost");
  ghost.style.position = "fixed";
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.margin = "0";
  ghost.style.pointerEvents = "none";
  // Below .modal-overlay's z-index (20) on purpose - a swap/removal often
  // fires right before the next screen opens (e.g. the replace-step swap
  // immediately calls startNextLevel()), and a still-animating ghost must
  // never visually block whatever modal or board state comes up next.
  ghost.style.zIndex = "15";
  document.body.appendChild(ghost);
  ghost.addEventListener("animationend", () => ghost.remove());
  setTimeout(() => ghost.remove(), 700); // safety net if animationend never fires
}

// Removes an owned perk instance and reverses its one-time effect (if any),
// keeping dice-related state consistent - but without touching money. Used
// both by the trash can (which adds its own flat refund) and by rule cards
// like Clean Slate / Selective Cut (which award their own different amount).
// animate defaults to true (the dissolve cue) - the trash can is the one
// caller that opts out, since it already has its own removal feedback.
// Returns the removed instance, or null if the index was invalid.
//
// This is the single choke point every deliberate perk destruction runs
// through (trash can, The Edict, Clean Slate/Selective Cut/Ooo Shiny, the
// perk-selection popup's replace-a-full-slot step, Extra Life's self-
// sacrifice) - so Demolisher's growth lives here rather than being repeated
// (and inevitably missed - see the popup replace step, which used to skip
// it) at every call site. Grown AFTER the splice above, so a Demolisher
// copy removed by its own destruction never grows itself, only whichever
// copies remain. Perks removed by their own natural lifecycle instead of a
// deliberate destruction (Savings Bond maturing, Make it Count/Fire Sale
// running out, Unfair Advantage folding Head Start into itself) don't go
// through this function, so they correctly don't grow it.
function removePerkInstance(index, { animate = true } = {}) {
  const removed = state.perksOwned[index];
  if (!removed) return null;
  if (animate) playPerkDissolveAnimation(removed);
  state.perksOwned.splice(index, 1);
  if (typeof removed.remove === "function") removed.remove(state, removed);
  // Golden Touch: a refund from an EARLIER purchase can still be pending
  // (see pendingGoldenTouchRefund) if that purchase's pack offer was
  // minimized rather than resolved right away - losing the card here (by
  // ANY of this function's callers: trash can, The Edict, Clean Slate/
  // Selective Cut, a Perk Reroll Token reroll...) must not let that
  // refund's own cue go on to surface LATER, out of context, for a card
  // the player no longer owns - reported live as "the glitch where Golden
  // Touch activated appears despite not owning the card". The money
  // itself was already legitimately granted at purchase time either way;
  // flushing the cue right here just ties its ANNOUNCEMENT to a moment
  // that actually makes sense (the instant the card is lost) instead of
  // some unrelated later action.
  if (removed.id === "goldenTouch") flushPendingGoldenTouchCue();
  growXMultPerk("demolisher", DEMOLISHER_MULT_STEP);
  resizeDiceArraysToCount(state.diceCount);
  rerollDoubleTarget(); // All Luck / Hotline ownership may have just changed
  return removed;
}

// Dragging a perk card into the trash instantly deletes it: any one-time
// effect it applied gets reversed via its own remove(), and its refund cue
// plays on the trash can itself.
function deletePerk(index) {
  const removed = removePerkInstance(index, { animate: false });
  if (!removed) return;
  const refund = perkDeleteRefund(removed);
  state.money += refund;
  renderAll();
  perkTrashCueActive = true; // tells the source card's dragend not to hide the trash early
  showTrashGainCue(refund);
  saveState();
}

function showTrashGainCue(amount) {
  const gainEl = perkTrash.querySelector(".perk-trash-gain");
  gainEl.textContent = `+$${amount}`;
  gainEl.classList.remove("hidden");
  gainEl.style.animation = "none";
  void gainEl.offsetWidth; // force reflow so the animation restarts even if it's already mid-play
  gainEl.style.animation = "";
  setTimeout(() => {
    gainEl.classList.add("hidden");
    perkTrash.classList.add("hidden");
    perkTrashIcon.textContent = PERK_TRASH_IDLE_ICON;
  }, 900);
}

// Terse "+$N" cue for every ordinary money gain - fires alongside
// triggerMoneySparkBurst() (see renderStats()) with the exact same gain
// amount, same float-and-fade shape as showTrashGainCue() but anchored to
// the Money stat instead of the trash can. Kept as its own element/cue
// (moneyGainCue, not goldenTouchGainCue below) so a Golden Touch refund
// message landing in this same spot moments later never gets cut off by an
// unrelated gain's cue, or vice versa.
const MONEY_GAIN_CUE_DURATION = 900;
function showMoneyGainCue(amount) {
  moneyGainCue.textContent = `+$${amount}`;
  moneyGainCue.classList.remove("hidden");
  moneyGainCue.style.animation = "none";
  void moneyGainCue.offsetWidth; // force reflow so the animation restarts even if it's already mid-play
  moneyGainCue.style.animation = "";
  setTimeout(() => moneyGainCue.classList.add("hidden"), MONEY_GAIN_CUE_DURATION);
}

// Golden Touch's refund message - anchored to the Money stat, same
// float-and-fade approach as showTrashGainCue() but holds onscreen longer
// (see .golden-touch-gain's goldenTouchMessageFade) since it's a full
// sentence rather than a terse "+$N".
const GOLDEN_TOUCH_CUE_DURATION = 2200;
// When the cue was last actually shown - null once it's confirmed hidden.
// Exists so renderStats() can self-heal it (see below) if the plain
// setTimeout below ever fails to fire on time (a backgrounded/throttled
// tab is the known way that happens - timers there can stall well past
// their delay), rather than leaving a stale "Golden Touch activated,
// Refunded $N" sitting on screen indefinitely, which reads exactly like it
// re-firing on every later hand commit even though nothing money-related
// is actually happening anymore.
let goldenTouchCueShownAt = null;
function showGoldenTouchCue(amount) {
  goldenTouchGainCue.textContent = `Golden Touch activated, Refunded $${amount}`;
  goldenTouchGainCue.classList.remove("hidden");
  goldenTouchGainCue.style.animation = "none";
  void goldenTouchGainCue.offsetWidth; // force reflow so the animation restarts even if it's already mid-play
  goldenTouchGainCue.style.animation = "";
  goldenTouchCueShownAt = Date.now();
  setTimeout(() => {
    goldenTouchGainCue.classList.add("hidden");
    goldenTouchCueShownAt = null;
  }, GOLDEN_TOUCH_CUE_DURATION);
}

function levelLabel() {
  if (state.phase === "small1") return "Small 1";
  if (state.phase === "small2") return "Small 2";
  return state.level;
}

// A handful of small gold particles bursting outward from the Money stat -
// see .money-spark/@keyframes moneySparkBurst in style.css. Each one picks
// its own random angle/distance via CSS custom properties and removes
// itself once its one-shot animation ends, so nothing needs cleanup here.
// Both the burst's size (particle size + travel distance + glow) and its
// duration scale together with how much money was actually gained - a $1
// tick plays at the plain 1x baseline, a $40+ windfall plays a full 6x
// bigger AND 6x slower/grander version, linearly interpolated in between
// (see moneySparkScaleForGain()) rather than every gain playing an
// identically-sized cue regardless of how much it actually was.
const MONEY_SPARK_COUNT = 6;
const MONEY_SPARK_MIN_DISTANCE = 14;
const MONEY_SPARK_DISTANCE_RANGE = 10;
const MONEY_SPARK_BASE_SIZE = 4;
const MONEY_SPARK_BASE_GLOW = 4;
const MONEY_SPARK_BASE_DURATION_MS = 600;
const MONEY_SPARK_SCALE_MIN_GAIN = 1;
const MONEY_SPARK_SCALE_MAX_GAIN = 40;
const MONEY_SPARK_SCALE_MIN = 1;
const MONEY_SPARK_SCALE_MAX = 6;

function moneySparkScaleForGain(gain) {
  const t = (gain - MONEY_SPARK_SCALE_MIN_GAIN) / (MONEY_SPARK_SCALE_MAX_GAIN - MONEY_SPARK_SCALE_MIN_GAIN);
  const clampedT = Math.min(1, Math.max(0, t));
  return MONEY_SPARK_SCALE_MIN + clampedT * (MONEY_SPARK_SCALE_MAX - MONEY_SPARK_SCALE_MIN);
}

function triggerMoneySparkBurst(gain) {
  const container = statMoney.parentElement;
  const scale = moneySparkScaleForGain(gain);
  const size = MONEY_SPARK_BASE_SIZE * scale;
  const glow = MONEY_SPARK_BASE_GLOW * scale;
  const duration = MONEY_SPARK_BASE_DURATION_MS * scale;
  for (let i = 0; i < MONEY_SPARK_COUNT; i++) {
    const spark = document.createElement("div");
    spark.className = "money-spark";
    const angle = (Math.PI * 2 * i) / MONEY_SPARK_COUNT + (Math.random() - 0.5) * 0.6;
    const distance = (MONEY_SPARK_MIN_DISTANCE + Math.random() * MONEY_SPARK_DISTANCE_RANGE) * scale;
    spark.style.setProperty("--spark-dx", `${Math.cos(angle) * distance}px`);
    spark.style.setProperty("--spark-dy", `${Math.sin(angle) * distance}px`);
    spark.style.width = `${size}px`;
    spark.style.height = `${size}px`;
    spark.style.boxShadow = `0 0 ${glow}px var(--gold)`;
    spark.style.animationDuration = `${duration}ms`;
    spark.addEventListener("animationend", () => spark.remove(), { once: true });
    container.appendChild(spark);
  }
}

function renderStats() {
  statLevel.textContent = levelLabel();
  // Small games have no target requirement and never count toward the
  // grand total anymore (see endLevel() / grandTotalScore()) - "---" makes
  // that visible instead of showing a score/target that no longer means
  // anything. Cancel any in-flight count-up first so it can't clobber the
  // "---" text after this render.
  if (state.phase === "main") {
    animateCountUp(statScore, currentTotalScore());
  } else {
    const prevToken = activeCountUps.get(statScore);
    if (prevToken) prevToken.cancelled = true;
    statScore.textContent = "---";
  }
  statTarget.textContent = state.phase === "main" ? state.target : "---";
  statTurn.textContent = `${state.turn} / ${turnLimit()}`;
  updateTurnDangerText(state.phase === "main" ? turnsLeftInLevel() : null);
  // Compare against lastKnownMoney (real tracked state), NOT statMoney's
  // own displayed text - see its own declaration for why reading the text
  // back is what let a single gain double-fire its cue. A genuine gain
  // (not a loss, and not just a re-render of an unchanged amount) gets a
  // spark burst and a "+$N" cue alongside the usual count-up pulse.
  const moneyBefore = lastKnownMoney;
  lastKnownMoney = state.money;
  animateCountUp(statMoney, state.money);
  if (state.money > moneyBefore) {
    const gain = state.money - moneyBefore;
    triggerMoneySparkBurst(gain);
    showMoneyGainCue(gain);
  }
  animateCountUp(statGrandTotal, grandTotalScore());
  // Self-healing (see goldenTouchCueShownAt/showGoldenTouchCue) - renderStats()
  // runs on essentially every commit/roll, so this guarantees the cue can
  // never actually stay stuck past one more render, even if its own
  // setTimeout got delayed (a backgrounded/throttled tab) or otherwise
  // never fired - it can only ever be a frame late, never indefinitely stuck.
  if (goldenTouchCueShownAt !== null && Date.now() - goldenTouchCueShownAt > GOLDEN_TOUCH_CUE_DURATION) {
    goldenTouchGainCue.classList.add("hidden");
    goldenTouchCueShownAt = null;
  }
}

// Boss intro reveal: the very first time a given boss's index is shown
// (tracked via lastShownBossIndex, reset to null whenever the banner goes
// back to hidden), its name pops oversized and settles to normal size over
// 1s (see .boss-title-reveal in style.css), while the description starts
// empty and only begins typing itself out - over the following 1s - once
// that settle finishes. If this same render also kicked off a Situational
// background sweep (see updateSituationalBackground()'s return value), the
// whole reveal is held off until the sweep-curtain has fully passed - so
// the pop/type-out always plays out in full view, never half-hidden
// mid-wipe. Re-renders of the same still-active boss (every other
// renderAll() call during that level) skip straight to the plain,
// fully-typed description instead of replaying the intro.
let lastShownBossIndex = null;
let bossIntroDelayTimer = null;
let bossDescTypeTimer = null;
let bossDescTypeInterval = null;
const BOSS_DESC_TYPE_DURATION_MS = 1000;
function clearBossIntroTimers() {
  clearTimeout(bossIntroDelayTimer);
  clearTimeout(bossDescTypeTimer);
  clearInterval(bossDescTypeInterval);
  bossIntroDelayTimer = null;
  bossDescTypeTimer = null;
  bossDescTypeInterval = null;
}
function typeBossDescription(text) {
  let shown = 0;
  const stepMs = Math.max(1, BOSS_DESC_TYPE_DURATION_MS / Math.max(text.length, 1));
  bossDescTypeInterval = setInterval(() => {
    shown++;
    mainGameModifierDesc.textContent = text.slice(0, shown);
    if (shown >= text.length) {
      clearInterval(bossDescTypeInterval);
      bossDescTypeInterval = null;
    }
  }, stepMs);
}
function playBossIntroAnimation(desc) {
  mainGameModifierTitle.classList.remove("boss-title-reveal");
  void mainGameModifierTitle.offsetWidth; // restart the pop cleanly if one was already mid-flight
  mainGameModifierTitle.classList.add("boss-title-reveal");
  bossDescTypeTimer = setTimeout(() => {
    bossDescTypeTimer = null;
    typeBossDescription(desc);
  }, BOSS_DESC_TYPE_DURATION_MS);
}

// Shows this main game's randomly-picked modifier (see startNextLevel())
// above the hand banner while state.phase is "main"; during a small game,
// the same slot instead names whichever small-game state is actually
// active (title only, no box/desc - there's no boss to describe) so the
// banner never just vanishes between boss levels: "Small Game 1"/"Small
// Game 2" while still throwing dice, "Buy Phase" once that round's target
// is hit and the card-pack shop is up (state.awaitingNextRound - see
// showNextRoundPrompt()). Only truly hidden (see .main-game-modifier-hidden)
// in the brief transitional state where phase is already "main" but no boss
// has been picked yet - occupying its reserved box even then, so nothing
// below it ever shifts.
function smallGameModifierLabel() {
  if (state.awaitingNextRound) return "Buy Phase";
  return state.phase === "small1" ? "Small Game 1" : "Small Game 2";
}
// The Void's blocked face is rolled fresh by the player (see
// renderVoidRollModal()) every time a level with it begins - append which
// one it actually landed on this time, rather than leaving the banner as a
// generic rules explainer.
function mainGameModifierDescFor(modifier) {
  // A Boss Skip Token (see activateUsable()) leaves the boss's own banner
  // showing - it's still the boss you're facing, just neutralized - but the
  // description should say so plainly rather than keep describing an effect
  // that no longer applies.
  if (state.bossEffectSkipped) {
    return "Skipped";
  }
  if (modifier.id === "theVoid" && state.voidBlockedFace != null) {
    return `${modifier.desc} This time Void has consumed ${state.voidBlockedFace}.`;
  }
  return modifier.desc;
}
function renderMainGameModifier() {
  if (state.phase !== "main") {
    updateSituationalBackground(null);
    // See the per-boss-category vine border rules in style.css (.boss-active,
    // .boss-tinted) - boss-tinted excludes a boss like The Thief, whose own
    // `tint` overrides its category's usual color, from the "purple" (plain
    // dice-category) rule, which only wants bosses actually SHOWING purple.
    // data-boss-tint carries WHICH tint (e.g. "grey"), the same way data-
    // boss-category carries which category, so a tinted boss's own
    // background/border rules (e.g. bg-grey.png) can target that specific
    // color instead of just "some tint or other".
    document.body.classList.remove("boss-active");
    document.body.classList.remove("boss-tinted");
    delete document.body.dataset.bossTint;
    lastShownBossIndex = null;
    clearBossIntroTimers();
    mainGameModifier.classList.remove("main-game-modifier-hidden");
    mainGameModifierTitle.textContent = smallGameModifierLabel();
    mainGameModifierTitle.className = "main-game-modifier-title main-game-modifier-title-store";
    mainGameModifierBox.classList.add("main-game-modifier-box-hidden");
    return;
  }
  if (state.mainGameModifierIndex == null) {
    mainGameModifier.classList.add("main-game-modifier-hidden");
    updateSituationalBackground(null);
    document.body.classList.remove("boss-active");
    document.body.classList.remove("boss-tinted");
    delete document.body.dataset.bossTint;
    lastShownBossIndex = null;
    clearBossIntroTimers();
    return;
  }
  const modifier = MAIN_GAME_MODIFIERS[state.mainGameModifierIndex];
  if (!modifier) {
    mainGameModifier.classList.add("main-game-modifier-hidden");
    updateSituationalBackground(null);
    document.body.classList.remove("boss-active");
    document.body.classList.remove("boss-tinted");
    delete document.body.dataset.bossTint;
    lastShownBossIndex = null;
    clearBossIntroTimers();
    return;
  }
  document.body.classList.add("boss-active");
  document.body.classList.toggle("boss-tinted", !!modifier.tint);
  if (modifier.tint) document.body.dataset.bossTint = modifier.tint;
  else delete document.body.dataset.bossTint;
  const sweeping = updateSituationalBackground(modifier);
  const isNewBoss = state.mainGameModifierIndex !== lastShownBossIndex;
  lastShownBossIndex = state.mainGameModifierIndex;

  mainGameModifierTitle.textContent = modifier.title;
  // Dice bosses render in the default purple; perk bosses (The Censor/The
  // Edict) in orange; hand bosses (The Gatekeeper/The Culler) in red - see
  // the .category-perk/.category-hand CSS rules. A boss can override that
  // with its own `tint` instead (The Thief's grey, distinct from its dice-
  // category siblings) - same tint-based approach RULE_POOL/PERK_POOL cards
  // already use for their own per-card color, independent of any semantic
  // grouping. The reveal pop (see playBossIntroAnimation() below) adds
  // .boss-title-reveal itself once it actually starts, rather than being
  // baked into this className.
  const categoryClass = modifier.tint
    ? ` tint-${modifier.tint}`
    : (modifier.category !== "dice" ? ` category-${modifier.category}` : "");
  mainGameModifierTitle.className = "main-game-modifier-title" + categoryClass;
  mainGameModifierBox.className = "main-game-modifier-box" + categoryClass;
  mainGameModifierBox.classList.remove("main-game-modifier-box-hidden");
  mainGameModifier.classList.remove("main-game-modifier-hidden");

  clearBossIntroTimers();
  const resolvedDesc = mainGameModifierDescFor(modifier);
  if (isNewBoss) {
    // Reserve the box's final height up front, before the text gets
    // cleared for typing - measured by briefly rendering the full desc
    // (synchronous, no repaint happens in between, so it's never actually
    // seen) then pinning that height via min-height. Without this, the
    // box would grow taller line by line as the typewriter reveals enough
    // characters to wrap onto a new line, instead of sitting at its final
    // size the whole time.
    mainGameModifierDesc.style.minHeight = "";
    mainGameModifierDesc.textContent = resolvedDesc;
    mainGameModifierDesc.style.minHeight = `${mainGameModifierDesc.offsetHeight}px`;
    mainGameModifierDesc.textContent = ""; // hidden right away regardless of whether a sweep delays the reveal itself
    if (sweeping) {
      bossIntroDelayTimer = setTimeout(() => {
        bossIntroDelayTimer = null;
        playBossIntroAnimation(resolvedDesc);
      }, SITUATIONAL_SWEEP_DURATION);
    } else {
      playBossIntroAnimation(resolvedDesc);
    }
  } else {
    mainGameModifierDesc.textContent = resolvedDesc;
  }
}

// "Next: [boss]" label - small games only, naming whichever boss was
// pre-rolled a full cycle ahead for the upcoming main level (see
// startNextLevel()'s nextMainGameModifierIndex handling). Hidden once main
// starts, since the real boss banner (renderMainGameModifier() above)
// takes over at that point. The tooltip's hover listeners are attached
// once at load (see below this function), not here - unlike the boss
// banner or perk cards, this element is never torn down/rebuilt, so
// re-attaching them on every render would just pile up duplicates.
function renderNextBossLabel() {
  if (state.phase === "main" || state.nextMainGameModifierIndex == null) {
    nextBossLabel.classList.add("hidden");
    return;
  }
  const boss = MAIN_GAME_MODIFIERS[state.nextMainGameModifierIndex];
  if (!boss) {
    nextBossLabel.classList.add("hidden");
    return;
  }
  const categoryClass = boss.tint ? ` tint-${boss.tint}` : (boss.category !== "dice" ? ` category-${boss.category}` : "");
  nextBossLabel.className = "next-boss-label" + categoryClass;
  nextBossLabelText.textContent = `Next: ${boss.title}`;
  nextBossTooltip.textContent = `${boss.title}: ${boss.desc}`;

  // null once every USABLE_POOL item has already been bought this run (see
  // pickRandomUsableId()) - nothing left to preview, so hide the badge
  // entirely rather than showing empty green text with a blank tooltip.
  const usable = USABLE_POOL.find((u) => u.id === state.nextBossUsableOffer);
  nextBossUsableBadge.classList.toggle("hidden", !usable);
  nextBossUsableBadgeText.textContent = usable ? usable.name : "";
  nextBossUsableTooltip.textContent = usable
    ? `Boss shop item: ${usable.name} ($${usable.cost}) - ${usable.desc}`
    : "";
}
attachClampedTooltip(nextBossLabel, nextBossTooltip, diceArea);
attachClampedTooltip(nextBossUsableBadge, nextBossUsableTooltip, diceArea);
// The badge is a DOM descendant of nextBossLabel, so CSS :hover on the
// label is ALSO true the instant the badge itself is hovered (the pointer
// is still within the label's own box) - without this, that would pop the
// label's own boss tooltip up at the same time as the badge's, overlapping
// it. Forcing the label tooltip's opacity off for as long as the badge
// specifically is hovered (inline style beats the class-based CSS rule)
// keeps the two mutually exclusive; clearing the override on mouseleave
// hands control back to the plain CSS :hover rule for the rest of the label.
nextBossUsableBadge.addEventListener("mouseenter", () => {
  nextBossTooltip.style.opacity = "0";
});
nextBossUsableBadge.addEventListener("mouseleave", () => {
  nextBossTooltip.style.opacity = "";
});

function renderControls() {
  // Mulligan: shown whenever there's an actual last commit to undo
  // (mulliganSnapshot is null until the first eligible commit captures one
  // - see captureMulliganSnapshot()), never past game over, and never while
  // a modal is covering the board (the perk-choice/game-over modal a main-
  // game turn-limit commit can open right away isn't something useMulligan()
  // knows how to undo). Deliberately NOT gated on awaitingNextRound itself -
  // a small game running out of turns opens its shop inline (no modal, see
  // showNextRoundPrompt()), so there's still a real board to revert on top
  // of; same for a main-game commit that reaches the target early (that one
  // only opens a modal once "Next Level" is actually clicked).
  const mulliganHidden = !mulliganSnapshot || state.gameOver || !modalOverlay.classList.contains("hidden");

  if (state.awaitingNextRound) {
    // A round concluding always makes any in-flight roll animation moot
    // (the button's meaning has already changed to Next Level/Round) -
    // self-heal here rather than remembering to reset this at every place
    // a round could conclude.
    if (rollAnimationActive) {
      if (rollAnimationSettleTimer !== null) {
        clearTimeout(rollAnimationSettleTimer);
        rollAnimationSettleTimer = null;
      }
      rollAnimationActive = false;
    }
    rollsLeftEl.textContent = "";
    rollBtn.disabled = coinDieRevealActive;
    rollBtn.textContent = state.phase === "main" ? "Next Level" : "Next Round";
    rollBtn.classList.remove("roll-btn-skip");
    mulliganBtn.classList.toggle("mulligan-btn-hidden", mulliganHidden);
    updateDangerVignette(null);
    return;
  }

  const throwsLeft = totalThrowsAllowed() - state.rollsUsedThisTurn;
  rollsLeftEl.textContent = `${throwsLeft} throw${throwsLeft === 1 ? "" : "s"} left`;
  // Never disabled while a roll is still animating (even with 0 throws
  // left) - it must stay clickable so Skip actually works.
  rollBtn.disabled = coinDieRevealActive || (!rollAnimationActive && (throwsLeft <= 0 || state.gameOver));
  rollBtn.textContent = rollAnimationActive ? "Skip" : (state.rolled ? "Throw Again" : "Throw Dice");
  rollBtn.classList.toggle("roll-btn-skip", rollAnimationActive);
  mulliganBtn.classList.toggle("mulligan-btn-hidden", mulliganHidden);
  updateDangerVignette(state.phase === "main" ? turnsLeftInLevel() : null);
}

function renderAll() {
  renderDice();
  renderScorecard(); // also renders the rule inventory (see its own end)
  renderPerks();
  renderMainGameModifier();
  renderNextBossLabel();
  renderStats();
  renderControls();
  renderPackShop();
}

// ---------- Actions ----------

// Instantly settles every die at its final rotation (skipping whatever
// tumble/bounce transition is still mid-flight - a freshly (re)created
// element has no in-progress CSS transition to interrupt, so simply
// rebuilding them snaps straight to rest) and reveals the scorecard preview
// it was withholding, if any - shared by holding a die mid-roll and by
// pressing Throw/Skip again while a roll is still animating (see
// rollDice()). Only kicks off the "Skip" -> "Throw Again" settle delay
// (finishRollAnimation()) when there was actually something active to
// settle, so an ordinary hold-toggle after a roll has long finished doesn't
// pointlessly restart it.
function skipRollAnimation() {
  renderDice();
  if (scorecardRevealTimer !== null) {
    clearTimeout(scorecardRevealTimer);
    scorecardRevealTimer = null;
    renderScorecard();
  }
  if (rollAnimationActive) finishRollAnimation();
}

// Brief shake cue on the Throw button - feedback for a blocked throw (every
// die is held/locked, see rollDice()). Removed and re-added rather than
// just added, so back-to-back blocked presses restart the animation each
// time instead of the 2nd+ press doing nothing visible (the class would
// already be present, and re-adding an already-present class doesn't
// restart a CSS animation).
const ROLL_BTN_SHAKE_MS = 400;
function shakeRollBtn() {
  rollBtn.classList.remove("roll-btn-shake");
  void rollBtn.offsetWidth;
  rollBtn.classList.add("roll-btn-shake");
  setTimeout(() => rollBtn.classList.remove("roll-btn-shake"), ROLL_BTN_SHAKE_MS);
}

function toggleHold(index) {
  if (!state.rolled) return; // can't hold before the first throw of the turn
  // A boss can block the actual hold-state change, but pressing a die's key
  // should still skip any in-flight roll animation regardless (that part
  // isn't a "choice" being blocked - it always happened before bosses
  // existed, and a locked/forced/vice-locked die is still a valid key to
  // press for that alone).
  const blockedByBoss = index === state.bossLockedDieIndex // The Warden: already forced-locked
    || index === state.bossForcedRerollDieIndex // The Tempest: must keep rerolling
    || state.viceLockedIndices.includes(index); // The Vice: cemented in by an earlier throw this hand
  if (!blockedByBoss) state.held[index] = !state.held[index];
  skipRollAnimation();
  saveState();
}

// Extra whole turns (plus whatever's needed to land on targetMod) so the
// cube visibly tumbles forward from wherever it currently sits, rather than
// snapping straight to the resting face.
function computeTumbleAngle(current, targetMod) {
  const spins = 3 + Math.floor(Math.random() * 3);
  const base = current + spins * 360;
  const targetNorm = ((targetMod % 360) + 360) % 360;
  const baseNorm = ((base % 360) + 360) % 360;
  let diff = targetNorm - baseNorm;
  if (diff < 0) diff += 360;
  return base + diff;
}

// Shortest angular path to targetMod - may go forward or backward, whichever
// is closer. Used for the short topple off a corner landing, which should
// read as a small tip in whichever direction is natural, not a lap around.
function shortestAngleTo(current, targetMod) {
  const targetNorm = ((targetMod % 360) + 360) % 360;
  const baseNorm = ((current % 360) + 360) % 360;
  let diff = targetNorm - baseNorm;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return current + diff;
}

// x = -arctan(1/sqrt(2)) in degrees: the tilt that points a cube's vertex
// straight at the viewer instead of a face. Combined with one of four Y
// rotations (45/135/-135/-45, each a quarter turn apart), this gives all
// 8 corner orientations - top/bottom picks the X sign, and the front-or-back
// + right-or-left pair picks which of the 4 Y angles.
const FACE_POSITION_BY_VALUE = { 1: "front", 2: "right", 3: "top", 4: "bottom", 5: "left", 6: "back" };

function cornerRotationForValue(value) {
  const position = FACE_POSITION_BY_VALUE[value];

  let vertical, horizontal, side;
  if (position === "top" || position === "bottom") {
    vertical = position;
    // Always the front variant here: for a top/bottom target the "back"
    // corner sits a full 135deg away in Y, while "front" is only 45deg -
    // the far one produces an oversized topple swing.
    horizontal = "front";
    side = Math.random() < 0.5 ? "right" : "left";
  } else if (position === "front" || position === "back") {
    horizontal = position;
    vertical = Math.random() < 0.5 ? "top" : "bottom";
    side = Math.random() < 0.5 ? "right" : "left";
  } else {
    side = position;
    vertical = Math.random() < 0.5 ? "top" : "bottom";
    horizontal = Math.random() < 0.5 ? "front" : "back";
  }

  const x = vertical === "top" ? -35.264 : 35.264;
  const magnitude = horizontal === "front" ? 45 : 135;
  const y = side === "right" ? -magnitude : magnitude;

  return { x, y };
}

const CORNER_LANDING_CHANCE = 1 / 80;

// Pending "reveal" timers, one slot per die. If a die is rerolled before its
// own pending reveal fires, that stale callback must be cancelled - otherwise
// it fires later and yanks the die back toward an old target mid-new-roll.
const dieRevealTimers = [null, null, null, null, null];

// Pending scorecard-reveal timer for the roll currently in flight. A new
// roll cancels it - otherwise a stale reveal from the previous throw could
// fire mid-new-roll and show the answer before the new dice finish.
let scorecardRevealTimer = null;

// True for the whole span from "a throw just started" through "0.3s after
// it finished or was skipped" - governs both the roll button's label
// ("Skip" instead of "Throw Again"/"Throw Dice") and whether pressing
// Enter/Space/clicking it while true skips the in-flight animation instead
// of starting a brand new (overlapping, confusing) roll.
let rollAnimationActive = false;
let rollAnimationSettleTimer = null;

// Called once a roll's animation has genuinely finished, whether that was
// by playing out naturally or by being skipped early - holds the button on
// "Skip" for one more beat (rather than flipping the instant the dice
// settle) before it becomes "Throw Again" and a press really does throw.
function finishRollAnimation() {
  if (rollAnimationSettleTimer !== null) clearTimeout(rollAnimationSettleTimer);
  rollAnimationSettleTimer = setTimeout(() => {
    rollAnimationSettleTimer = null;
    rollAnimationActive = false;
    renderControls();
  }, 300);
}

// True while a freshly-picked Coin Die's reveal (see
// playCoinDieRevealAnimation()) is turning the tray die to its marked face
// and back - rollDice()'s own guard and the rollBtn disable below both key
// off this so the player can't throw (or advance to the next level/round,
// the same button) out from under it.
let coinDieRevealActive = false;
const COIN_DIE_REVEAL_TURN_MS = 1700; // matches .die-cube's own CSS transition duration
const COIN_DIE_COIN_SPIN_MS = 400; // matches dieCoinSpinLand's own CSS animation duration
const COIN_DIE_POST_SPIN_PAUSE_MS = 400; // beat to actually look at the landed coin before turning away

// A Coin Die instance whose reveal is still in progress - renderDie()'s own
// coinFaces check excludes anything in here, so the badge can't show up on
// the face before it's actually turned into view (see playCoinDieRevealAnimation()).
const coinDieRevealPendingInstances = new Set();

// Turns the real tray die Coin Die just marked to its coin face (shortest
// path there), spins the coin onto it once it actually arrives (not before
// - see coinDieRevealPendingInstances), then turns back - shortest path
// again - to whatever resting rotation it already had, and only then frees
// the controls back up. Purely cosmetic (state.dieRotation itself is never
// touched, so nothing about the actual game state changes) but without it
// the player has no way to tell which physical die/face just got marked
// until they happen to roll it there themselves.
function playCoinDieRevealAnimation(instance) {
  const scene = diceTray.children[instance.dieIndex];
  const cube = scene && scene.querySelector(".die-cube");
  if (!cube) return; // diceCount shrank since the mark was picked - nothing to show
  coinDieRevealActive = true;
  coinDieRevealPendingInstances.add(instance);
  renderControls();

  const originalRotation = state.dieRotation[instance.dieIndex];
  const targetRotation = FACE_ROTATION[instance.faceValue];
  // Reset per-die stagger delay/duration left over from this die's last
  // real throw (see rollDice()'s tumble loop) - without this, the turn here
  // could inherit a stale delay and visually lag behind the click that
  // triggered it.
  cube.style.transitionDelay = "0s";
  cube.style.transitionDuration = `${COIN_DIE_REVEAL_TURN_MS}ms`;
  // This cube is a brand-new element renderAll() just created this same
  // synchronous tick (confirmRuleSelection() rebuilds the whole tray right
  // before calling this), with its resting transform set moments ago by
  // renderDie() - the browser hasn't painted that starting frame yet, so
  // without forcing it to commit here, the write below would coalesce with
  // it into a single style recalc and the turn would just snap straight to
  // its target with no visible transition at all.
  void cube.offsetHeight;
  // shortestAngleTo() (not computeTumbleAngle()'s multi-spin version) -
  // this is a quick "look, here" tip, not a real throw, so it should turn
  // whichever way is closer instead of tumbling through extra laps.
  const revealX = shortestAngleTo(originalRotation.x, targetRotation.x);
  const revealY = shortestAngleTo(originalRotation.y, targetRotation.y);
  cube.style.transform = `rotateX(${revealX}deg) rotateY(${revealY}deg)`;

  setTimeout(() => {
    // The turn has landed - paint the coin directly onto the DOM face that
    // now owns the marked value, by hand rather than through a normal
    // render (a renderDice() rebuild here would snap the cube back to its
    // untouched state.dieRotation transform, undoing the turn we're mid-way
    // through holding).
    const facePosition = Object.entries(FACE_VALUE_BY_POSITION).find(([, v]) => v === instance.faceValue)?.[0];
    const faceEl = facePosition ? cube.querySelector(`.die-face.${facePosition}`) : null;
    // Already in state.perksOwned by now (confirmRuleSelection() pushed it
    // before calling this) - the real, final count this exact die/face pays
    // out per matching commit, including this instance itself.
    const totalCount = state.perksOwned.filter(
      (p) => p.id === "coinDie" && p.dieIndex === instance.dieIndex && p.faceValue === instance.faceValue
    ).length;
    if (faceEl) {
      const existingMark = faceEl.querySelector(".die-coin-mark");
      if (!existingMark) {
        // First ever mark on this face - the coin itself spins in.
        const { wrap, icon } = buildCoinMarkEl(totalCount);
        icon.classList.add("die-coin-mark-pop");
        faceEl.appendChild(wrap);
      } else if (totalCount > 1) {
        // A later Coin Die stacking onto an already-marked face - the coin's
        // already there, so just the count next to it bumps/updates. Force a
        // reflow between removing and re-adding the pop class (same fix as
        // the die's own turn - see COIN_DIE_REVEAL_TURN_MS above) so a 3rd+
        // stack still replays the bump instead of it silently not
        // retriggering on an element that already had the class.
        let countEl = existingMark.querySelector(".die-coin-mark-count");
        if (!countEl) {
          countEl = document.createElement("span");
          countEl.className = "die-coin-mark-count";
          existingMark.appendChild(countEl);
        }
        countEl.textContent = String(totalCount);
        countEl.classList.remove("die-coin-mark-count-pop");
        void countEl.offsetWidth;
        countEl.classList.add("die-coin-mark-count-pop");
      }
    }
    // Safe to lift the suppression now - any future render (including one
    // that lands mid-spin) is free to paint this instance's badge normally,
    // since it's already sitting on the face by hand anyway.
    coinDieRevealPendingInstances.delete(instance);

    // Turn back waits one extra beat (COIN_DIE_POST_SPIN_PAUSE_MS) after the
    // coin's own spin-and-land animation finishes, rather than starting the
    // instant it does - long enough to actually register the landed coin
    // before the die turns away from it again.
    setTimeout(() => {
      const backX = shortestAngleTo(revealX, originalRotation.x);
      const backY = shortestAngleTo(revealY, originalRotation.y);
      cube.style.transform = `rotateX(${backX}deg) rotateY(${backY}deg)`;
      setTimeout(() => {
        coinDieRevealActive = false;
        renderControls();
      }, COIN_DIE_REVEAL_TURN_MS);
    }, COIN_DIE_COIN_SPIN_MS + COIN_DIE_POST_SPIN_PAUSE_MS);
  }, COIN_DIE_REVEAL_TURN_MS);
}

const LUCKY_DIE_CUE_MS = 2600; // how long the floating "Lucky Die: ..." label stays up

// Plays Lucky Die's activation cue on the real tray die - an inside-to-
// outward pink glow pulse (see .lucky-die-activate) plus a floating label
// naming which of the two outcomes actually happened. Called after
// finishCommitScore()'s own renderAll() (so it's grabbing the fresh DOM,
// same reasoning as playCoinDieRevealAnimation()), and independent of phase
// - unlike playScoreCommitAnimation() itself, which only ever plays in the
// main game, this still shows for a small-game money hit.
function playLuckyDieCue(luckyDieResult) {
  const scene = diceTray.children[luckyDieResult.dieIndex];
  if (!scene) return; // diceCount shrank since the mark was picked - nothing to show

  scene.classList.remove("lucky-die-activate");
  void scene.offsetWidth; // force a reflow so back-to-back activations replay the pulse
  scene.classList.add("lucky-die-activate");

  const label = document.createElement("div");
  label.className = "lucky-die-cue-label";
  label.innerHTML = luckyDieResult.type === "money"
    ? `Lucky Die<br>+$${LUCKY_DIE_MONEY_AMOUNT}`
    : "Lucky Die<br>2X Final Score";
  scene.appendChild(label);
  setTimeout(() => label.remove(), LUCKY_DIE_CUE_MS);
}

// The Weight's own loaded odds (see MAIN_GAME_MODIFIERS) - index 0 is face
// 1's chance, index 5 is face 6's, summing to exactly 1.
const WEIGHTED_DIE_FACE_CHANCES = [0.19, 0.18, 0.17, 0.16, 0.153, 0.147];

// Cumulative-threshold pick: roll one 0-1 float, walk the faces in order
// subtracting each one's own slice until the remainder goes negative -
// lands on whichever face's slice it fell into. The trailing `return 6` is
// just a float-rounding safety net (the weights already sum to exactly 1),
// never the normal path.
function rollWeightedFace() {
  let roll = Math.random();
  for (let face = 1; face <= 6; face++) {
    roll -= WEIGHTED_DIE_FACE_CHANCES[face - 1];
    if (roll < 0) return face;
  }
  return 6;
}

// Every real per-die roll (rollDice() below) goes through this - The
// Weight is the only thing that ever makes it deviate from a plain uniform
// 1-in-6 each.
function rollFace() {
  return activeBossModifier()?.id === "theWeight" ? rollWeightedFace() : 1 + Math.floor(Math.random() * 6);
}

function rollDice() {
  // pendingPackOffer can only ever be set while awaitingNextRound already
  // is (Card Packs only open during the small-game shop phase), so this is
  // structurally redundant today - kept explicit anyway (rather than relying
  // on that invariant silently) so a still-pending, merely-minimized offer
  // (see minimizePackOffer()) can never be rolled past even if that ever
  // changes.
  if (state.gameOver || state.awaitingNextRound || state.pendingPackOffer) return;
  // Coin Die's freshly-picked reveal (see playCoinDieRevealAnimation()) is
  // borrowing the real tray die's own cube transform to show where the coin
  // landed - a throw starting mid-reveal would either fight that transform
  // or roll right through it, so it's blocked until the die's back in its
  // resting position.
  if (coinDieRevealActive) return;
  if (rollAnimationActive) {
    skipRollAnimation();
    return;
  }
  // The Edict's mandatory choice should already be showing (see
  // startNextLevel()) whenever this could be true, but re-check here too -
  // defense in depth against e.g. a reload landing mid-choice.
  if (activeBossModifier()?.id === "theEdict" && !state.edictSacrificeResolved
    && state.perksOwned.some(isEdictDestroyablePerk)) {
    renderEdictPicker();
    return;
  }
  // The Void: same defense-in-depth re-check as The Edict above - a reload
  // landing mid-choice shouldn't let a real throw slip in ahead of it.
  if (activeBossModifier()?.id === "theVoid" && state.voidBlockedFace == null) {
    renderVoidRollModal();
    return;
  }
  const throwsLeft = totalThrowsAllowed() - state.rollsUsedThisTurn;
  if (throwsLeft <= 0) return;

  // Nothing would actually change (every die is held, boss-locked, or
  // wild) - block the throw entirely rather than silently burning one for
  // no visible effect, and shake the button as feedback.
  if (state.dice.every((_, i) => !dieCanReroll(i))) {
    shakeRollBtn();
    return;
  }

  if (scorecardRevealTimer !== null) {
    clearTimeout(scorecardRevealTimer);
    scorecardRevealTimer = null;
  }
  if (rollAnimationSettleTimer !== null) {
    clearTimeout(rollAnimationSettleTimer);
    rollAnimationSettleTimer = null;
  }
  rollAnimationActive = true;

  // A genuinely new throw starts here - whatever rule cards got highlighted
  // for the previous hand have had their moment; clear it before this
  // throw's own hand has a chance to earn a fresh highlight.
  if (highlightedRuleCardIds.size > 0) {
    highlightedRuleCardIds.clear();
    renderRuleInventory();
  }

  const isFirstThrowThisHand = state.rollsUsedThisTurn === 0;
  // The Tempest's forced reroll only ever covers the throw immediately
  // after the first one - this is that throw.
  const isSecondThrowThisHand = state.rollsUsedThisTurn === 1;
  state.rollsUsedThisTurn++;
  state.rolled = true;

  const sceneEls = [...diceTray.children];
  const wildActiveNow = activeWildIndices();
  let startDelay = 0;
  let maxCompletion = 0;

  // Both The Warden and The Tempest pick their one random die the same way,
  // right after the first throw of a hand - never a wild one, since that
  // wouldn't be rerolling anyway regardless of which boss is active.
  if (isFirstThrowThisHand) {
    const boss = activeBossModifier();
    const eligible = state.dice.map((_, i) => i).filter((i) => !wildActiveNow.includes(i));
    const pick = eligible.length > 0 ? eligible[Math.floor(Math.random() * eligible.length)] : null;
    // The Warden: locks one random die for the rest of this hand -
    // state.bossLockedDieIndex stays put through throws 2/3 once set, and
    // resets to null at the start of the next hand (see commitScore()'s
    // normal turn-advance block). Excluded from rerolling below.
    //
    // The class is applied directly to the existing scene element here (not
    // via a renderDice() call, which is what renderDie() normally paints
    // this from) - a full renderDice() rebuild would replace sceneEls out
    // from under the tumble animation being set up in the loop just below,
    // so this state change would otherwise sit invisible until some later,
    // unrelated full render (holding a die, skipping the animation) finally
    // painted it.
    if (boss?.id === "theWarden" && pick != null) {
      state.bossLockedDieIndex = pick;
      sceneEls[pick].classList.add("boss-locked");
    }
    // The Tempest: forces one random die to reroll on the very next throw -
    // achieved entirely by toggleHold() refusing to hold it in the
    // meantime, so the normal "unheld dice reroll" loop below does the
    // rest with no exclusion check needed here. Lifted again once that
    // throw actually happens (see isSecondThrowThisHand below) - it's a
    // one-time force, not a whole-hand restriction like The Warden's lock.
    if (boss?.id === "theTempest" && pick != null) {
      state.bossForcedRerollDieIndex = pick;
      sceneEls[pick].classList.add("boss-forced-reroll");
    }
  }

  // The forced die has now done its one mandatory reroll (this is that
  // throw) - free to be held normally from here on, same as any other die.
  // Same direct-DOM reasoning as the additions above: clear the cue off the
  // actual scene element right here too, or it would keep showing as
  // "forced" (now stale) until an unrelated full render happened to sweep
  // it away.
  if (isSecondThrowThisHand && state.bossForcedRerollDieIndex != null) {
    sceneEls[state.bossForcedRerollDieIndex].classList.remove("boss-forced-reroll");
    state.bossForcedRerollDieIndex = null;
  }

  // The Vice: whatever's currently held becomes cemented the instant a new
  // throw happens - toggleHold() then refuses to release it (see there).
  // Applied on every throw, not just the first, so each later throw locks
  // in whatever was newly held since the previous one too. A no-op on the
  // very first throw of a hand, since nothing can be held yet at that point.
  if (activeBossModifier()?.id === "theVice") {
    state.held.forEach((isHeld, i) => {
      if (isHeld && !state.viceLockedIndices.includes(i)) state.viceLockedIndices.push(i);
    });
  }

  state.dice.forEach((_, i) => {
    if (state.held[i]) return;
    // Excluded starting the throw AFTER it was locked, never the one that
    // picked it - that die still needs to roll normally this one time.
    if (!isFirstThrowThisHand && i === state.bossLockedDieIndex) return;
    // A wild die that's active this round never rolls - it stays showing
    // "?" and scoring substitutes whatever face is best regardless.
    if (wildActiveNow.includes(i)) return;

    if (dieRevealTimers[i] !== null) {
      clearTimeout(dieRevealTimers[i]);
      dieRevealTimers[i] = null;
    }

    const value = rollFace();
    // The Void: whichever face the player rolled at the start of the level
    // (see renderVoidRollModal()) is worth - and shown as - a blank 0
    // instead. The physical tumble below stays keyed off the raw `value`
    // throughout, never this stored one, so the cube still lands on the
    // exact same face it always would have.
    state.dice[i] = value === state.voidBlockedFace && activeBossModifier()?.id === "theVoid" ? 0 : value;

    const target = FACE_ROTATION[value];
    const prev = state.dieRotation[i];

    const totalDuration = 1.5 + Math.random() * 0.2;
    const myDelay = startDelay;
    startDelay += 0.4 + Math.random() * 0.1;

    const scene = sceneEls[i];
    const cube = scene.querySelector(".die-cube");

    scene.classList.remove("bouncing");
    void scene.offsetWidth; // restart the bounce animation
    scene.style.animationDuration = totalDuration + "s";
    scene.style.animationDelay = myDelay + "s";
    scene.classList.add("bouncing");

    const landsOnCorner = Math.random() < CORNER_LANDING_CHANCE;
    // Sometimes the die tumbles to a stop just short of its true face -
    // looking like it settled between two faces - then, after a brief
    // pause, tips the rest of the way to reveal the real result. The
    // held-short angle is small (not scaled to the huge multi-spin
    // distance), so the reveal is a gentle tip, never an abrupt jump.
    const wobbles = !landsOnCorner && Math.random() < 0.225;

    let finalRotation;
    let completion;

    if (landsOnCorner) {
      // Extremely rare: the die tumbles to a perfect, physically-improbable
      // balance on one corner, holds there, then topples onto the real face.
      // The corner shown always touches the rolled face, so the topple is a
      // short, natural tip rather than a jump to an unrelated side.
      const corner = cornerRotationForValue(value);
      const cornerRotation = {
        x: computeTumbleAngle(prev.x, corner.x),
        y: computeTumbleAngle(prev.y, corner.y),
      };
      finalRotation = {
        x: shortestAngleTo(cornerRotation.x, target.x),
        y: shortestAngleTo(cornerRotation.y, target.y),
      };

      const pauseDuration = 0.5;
      const toppleDuration = 0.3 + Math.random() * 0.15;
      const tumbleDuration = Math.max(0.5, totalDuration - pauseDuration - toppleDuration);

      cube.style.transitionDelay = myDelay + "s";
      cube.style.transitionDuration = tumbleDuration + "s";
      cube.style.transform = `rotateX(${cornerRotation.x}deg) rotateY(${cornerRotation.y}deg)`;

      dieRevealTimers[i] = setTimeout(() => {
        dieRevealTimers[i] = null;
        cube.style.transitionDelay = "0s";
        cube.style.transitionDuration = toppleDuration + "s";
        cube.style.transform = `rotateX(${finalRotation.x}deg) rotateY(${finalRotation.y}deg)`;
      }, (myDelay + tumbleDuration + pauseDuration) * 1000);
      completion = myDelay + tumbleDuration + pauseDuration + toppleDuration;
    } else if (wobbles) {
      finalRotation = {
        x: computeTumbleAngle(prev.x, target.x),
        y: computeTumbleAngle(prev.y, target.y),
      };
      const pauseDuration = 0.15 + Math.random() * 0.1;
      const revealDuration = 0.3 + Math.random() * 0.15;
      const tumbleDuration = Math.max(0.5, totalDuration - pauseDuration - revealDuration);
      const heldShort = {
        x: finalRotation.x - (8 + Math.random() * 10),
        y: finalRotation.y - (8 + Math.random() * 10),
      };

      cube.style.transitionDelay = myDelay + "s";
      cube.style.transitionDuration = tumbleDuration + "s";
      cube.style.transform = `rotateX(${heldShort.x}deg) rotateY(${heldShort.y}deg)`;

      dieRevealTimers[i] = setTimeout(() => {
        dieRevealTimers[i] = null;
        cube.style.transitionDelay = "0s";
        cube.style.transitionDuration = revealDuration + "s";
        cube.style.transform = `rotateX(${finalRotation.x}deg) rotateY(${finalRotation.y}deg)`;
      }, (myDelay + tumbleDuration + pauseDuration) * 1000);
      completion = myDelay + tumbleDuration + pauseDuration + revealDuration;
    } else {
      finalRotation = {
        x: computeTumbleAngle(prev.x, target.x),
        y: computeTumbleAngle(prev.y, target.y),
      };
      cube.style.transitionDelay = myDelay + "s";
      cube.style.transitionDuration = totalDuration + "s";
      cube.style.transform = `rotateX(${finalRotation.x}deg) rotateY(${finalRotation.y}deg)`;
      completion = myDelay + totalDuration;
    }

    state.dieRotation[i] = finalRotation;
    if (completion > maxCompletion) maxCompletion = completion;
  });

  renderControls();
  if (state.phase === "main") {
    animateCountUp(statScore, currentTotalScore());
  }
  // Perk cards update immediately, not deferred to the reveal timer below -
  // unlike the scorecard preview (a genuine spoiler risk, see the comment
  // on that timer), every xMult condition an X-mult perk reads (dice
  // values, rollsUsedThisTurn) is already fully finalized by this point in
  // the function, synchronously, before the tumble animation even starts
  // (the loop above only animates toward values state.dice already holds).
  // Waiting for the animation to settle here just meant First Instinct/
  // Lowball/etc.'s badge and hover-cue sat stale for however long that
  // throw's tumble happened to take (occasionally several seconds, with the
  // rare wobble/corner-landing reveal), with nothing wrong to actually wait
  // out.
  renderPerks();

  // Don't show what each category would score until every die has actually
  // finished rolling - otherwise the answer is visible on the scorecard
  // before the dice visually reveal it.
  scorecardRevealTimer = setTimeout(() => {
    scorecardRevealTimer = null;
    renderScorecard();
    finishRollAnimation();
  }, maxCompletion * 1000);

  saveState();
}

const SCORE_COMMIT_BASE_COUNT_MS = 800;
const SCORE_COMMIT_MULT_PAUSE_MS = 900;
const SCORE_COMMIT_STAGE_COUNT_MS = 700;

// Category keys with a playScoreCommitAnimation() sequence currently in
// flight - see renderScorecard()'s preservedRows, which keeps each of these
// rows' exact DOM node across a rebuild instead of replacing it out from
// under the running animation. A Set (not a single key) since nothing stops
// the player from committing a second hand before the first one's ~5s
// sequence finishes.
const scoreCommitAnimatingKeys = new Set();

// Each step below (base dice score, category multiplier, gamerule point
// bonus, Blue Die bonus, X multiplier) gets its own color, both for its
// own reveal cue and the count-up that follows it - a quick visual tag for
// which part of the formula is driving the number right now. The sequence
// settles back on the category-multiplier's orange once the X multiplier's
// own red beat finishes, rather than staying red.
const SCORE_COMMIT_COLOR_BASE = "var(--good)";
const SCORE_COMMIT_COLOR_GAMERULE = "var(--purple)";
const SCORE_COMMIT_COLOR_CATMULT = "var(--orange)";
const SCORE_COMMIT_COLOR_XMULT = "var(--danger)";
const SCORE_COMMIT_COLOR_BLUEDIE = "var(--blue-die)";
const SCORE_COMMIT_COLOR_LUCKY = "var(--purple-pink)";
// Same emerald every other Usable-related element uses (see .pack-card.usable/
// .rule-inventory-item.usable-item/.collection-card.usable in style.css).
const SCORE_COMMIT_COLOR_DOUBLEDOWN = "var(--emerald)";

// Plays the "count up the raw dice score (green); reveal the category
// multiplier (orange, highlighting it on the scoreboard) and count up to the
// new score - skipped at a neutral x1; reveal the gamerule point bonus
// (Base Points/Six-Seven/Pairs-Trips-Quads-Straights/Low Roller/Leftovers,
// purple) and count up to it - skipped at +0; reveal the Blue Die bonus
// (blue) and count up to it - skipped at +0; reveal the X multiplier (red,
// highlighting the perk card(s) that triggered it) and count up to the
// pre-Lucky-Die score - skipped at a neutral x1; reveal Lucky Die's double
// (pink "x2") and count up to the pre-Double-Down score - skipped entirely
// unless it actually triggered this commit; reveal Double Down Token's own
// double (emerald "x2") and count up to the true final score - skipped
// entirely unless IT triggered this commit; then settle back to orange"
// sequence in the just-committed row's own score cell - called from
// finishCommitScore(), AFTER its own renderAll() has already redrawn that
// row filled with the correct final value, so this is purely a decorative
// replay of how that number came to be, never gating anything (state has
// already fully advanced by the time this starts, exactly as it did before
// this existed - see commitScore()). A whiff (nothing to show) just leaves
// the row showing its already-correct value, no sequence to play. Every
// stage whose own contribution is neutral (see silentStage()) still counts
// silently through whatever range it would have covered - only the reveal
// text/pause is skipped, so the numbers never actually jump or desync.
function playScoreCommitAnimation(key, breakdown, doubled, thisTurnScore, bankedScore, triggeredXMults, luckyDieResult, preLuckyBankedScore, doubleDownTriggered, preDoubleDownScore) {
  if (breakdown.base <= 0 || thisTurnScore <= 0) return;

  const row = scoreBody.querySelector(`tr[data-category-key="${key}"]`);
  const scoreTd = row && row.querySelector(".cat-score");
  const moneyTd = row && row.querySelector(".cat-money");
  if (!scoreTd) return;

  // Claimed for the whole sequence - see renderScorecard()'s preservedRows,
  // which keeps this exact row out of any rebuild triggered by something
  // else (rolling the next hand, most commonly) while this is still running.
  scoreCommitAnimatingKeys.add(key);

  scoreTd.innerHTML = "";
  scoreTd.textContent = "0";
  scoreTd.style.color = SCORE_COMMIT_COLOR_BASE;

  const catMultForDisplay = breakdown.catMult * (doubled ? HOTLINE_MULTIPLIER : 1);
  // Matches the real formula (see scoreBreakdownForCategory()'s afterCatMult:
  // rawHand * catMult + bonusTotal + blueBonus) - the category multiplier
  // only ever scales the raw hand, never the flat bonuses, so this is the
  // genuine post-multiplier value, not another animation-only placeholder
  // like the old "base" was.
  const afterCatMultOnly = Math.round(breakdown.rawHand * catMultForDisplay);
  // What thisTurnScore would be if Blue Die had contributed nothing - same
  // Hotline/state.scoreMultiplier scaling thisTurnScore itself was computed
  // with (see commitScore()), just applied to rawHand*catMult+bonusTotal
  // instead of the real (+blueBonus) total. This is where the gamerule
  // stage lands, and where the Blue Die stage starts from.
  const scoreMultForDisplay = doubled ? HOTLINE_MULTIPLIER : 1;
  const thisTurnScoreBeforeBlue = Math.round(
    (breakdown.rawHand * breakdown.catMult + breakdown.bonusTotal) * scoreMultForDisplay * state.scoreMultiplier
  );
  const combinedXMult = 1 + triggeredXMults.reduce((sum, p) => sum + resolveXMult(p, state), 0);

  const countStage = (from, to, duration, color, next) => {
    // Guards against ever writing a literal "NaN" to the cell, even for an
    // instant - animateCountUp() has its own equivalent fallback for `to`,
    // but that only takes effect once IT runs a moment later; this direct
    // write happens first and isn't covered by that.
    const safeFrom = Number.isFinite(from) ? from : 0;
    const safeTo = Number.isFinite(to) ? to : safeFrom;
    scoreTd.textContent = String(safeFrom);
    scoreTd.style.color = color;
    if (safeFrom === safeTo) { next(); return; }
    // `next` is animateCountUp's own completion callback, not a parallel
    // setTimeout(next, duration) - the two are driven by different clocks
    // (rAF vs. the timer queue) and, even with matching durations, don't
    // reliably land in the same order every run. A setTimeout firing first
    // advances to the next stage's reveal text, and animateCountUp's own
    // trailing rAF frame - still in flight, unaware anything moved on -
    // then overwrites that fresh text with the plain number it was counting
    // toward. That's the exact race behind the reveal text (the "+N"/"xN"
    // stages) intermittently vanishing after only a few ms on screen.
    animateCountUp(scoreTd, safeTo, duration, next);
  };

  // Reveals `text` (in `color`) in the score cell for a beat (optionally
  // pulsing `extraEl` alongside it - the scoreboard's own multiplier badge,
  // for the category-multiplier stage), then counts from `from` up to `to`,
  // in that same color.
  const runRevealStage = (text, color, extraEl, from, to, next) => {
    scoreTd.textContent = text;
    scoreTd.style.color = color;
    scoreTd.classList.add("cat-score-reveal-cue");
    if (extraEl) extraEl.classList.add("cat-multiplier-pulse");
    setTimeout(() => {
      scoreTd.classList.remove("cat-score-reveal-cue");
      if (extraEl) extraEl.classList.remove("cat-multiplier-pulse");
      countStage(from, to, SCORE_COMMIT_STAGE_COUNT_MS, color, next);
    }, SCORE_COMMIT_MULT_PAUSE_MS);
  };

  // No reveal, no pause - just a plain (silent) count in whatever color the
  // sequence is already showing, straight through to `to`. Used instead of
  // runRevealStage() for the gamerule/Blue Die stages when their own
  // amount is 0, so an empty stage doesn't flash a "+0" for no reason - the
  // number just keeps counting as if that stage was never there.
  const silentStage = (from, to, next) => countStage(from, to, SCORE_COMMIT_STAGE_COUNT_MS, SCORE_COMMIT_COLOR_CATMULT, next);

  const afterAllStages = () => {
    scoreTd.textContent = String(bankedScore);
    scoreTd.style.color = SCORE_COMMIT_COLOR_CATMULT; // settle back to orange
    scoreCommitAnimatingKeys.delete(key);
  };
  // Double Down Token's own double - the true last stage, after even Lucky
  // Die, matching its own "double whatever the hand banks" wording (which
  // by the time this fires already includes Lucky Die's own double, if that
  // ALSO triggered on this exact commit). preDoubleDownScore === bankedScore
  // whenever this didn't trigger, so the silent branch is a genuine no-op.
  const doubleDownStage = () => {
    if (doubleDownTriggered) {
      runRevealStage("x2", SCORE_COMMIT_COLOR_DOUBLEDOWN, null, preDoubleDownScore, bankedScore, afterAllStages);
    } else {
      silentStage(preDoubleDownScore, bankedScore, afterAllStages);
    }
  };
  // Lucky Die's double-score outcome - after even the X multiplier, matching
  // the card's own "double the whole score after X mult" wording.
  // preLuckyBankedScore === preDoubleDownScore whenever this didn't trigger,
  // so the silent branch is a genuine no-op, not just a skipped reveal.
  const luckyDoubleStage = () => {
    if (luckyDieResult?.type === "double") {
      runRevealStage("x2", SCORE_COMMIT_COLOR_LUCKY, null, preLuckyBankedScore, preDoubleDownScore, doubleDownStage);
    } else {
      silentStage(preLuckyBankedScore, preDoubleDownScore, doubleDownStage);
    }
  };
  // The triggered perk card(s) already show their own live hover-active
  // state (see renderPerks()'s xMultIsActive, driven by xMultCondition
  // directly) - this stage just echoes the same combined number in the
  // score cell, it doesn't drive the perk card's own highlight at all.
  // Lands on preLuckyBankedScore, not bankedScore - that's the true post-
  // X-mult, pre-Lucky-Die value now (see luckyDoubleStage above).
  const xMultStage = () => {
    if (combinedXMult > 1) {
      runRevealStage(formatMultiplierPrecise(combinedXMult), SCORE_COMMIT_COLOR_XMULT, null, thisTurnScore, preLuckyBankedScore, luckyDoubleStage);
    } else {
      silentStage(thisTurnScore, preLuckyBankedScore, luckyDoubleStage);
    }
  };
  const blueStage = () => {
    if (breakdown.blueBonus > 0) {
      runRevealStage(`+${breakdown.blueBonus}`, SCORE_COMMIT_COLOR_BLUEDIE, null, thisTurnScoreBeforeBlue, thisTurnScore, xMultStage);
    } else {
      silentStage(thisTurnScoreBeforeBlue, thisTurnScore, xMultStage);
    }
  };
  const gameruleStage = () => {
    if (breakdown.bonusTotal > 0) {
      runRevealStage(`+${breakdown.bonusTotal}`, SCORE_COMMIT_COLOR_GAMERULE, null, afterCatMultOnly, thisTurnScoreBeforeBlue, blueStage);
    } else {
      silentStage(afterCatMultOnly, thisTurnScoreBeforeBlue, blueStage);
    }
  };
  const catMultStage = () => {
    if (catMultForDisplay > 1) {
      runRevealStage(formatMultiplierPrecise(catMultForDisplay), SCORE_COMMIT_COLOR_CATMULT, moneyTd, breakdown.rawHand, afterCatMultOnly, gameruleStage);
    } else {
      silentStage(breakdown.rawHand, afterCatMultOnly, gameruleStage);
    }
  };

  countStage(0, breakdown.rawHand, SCORE_COMMIT_BASE_COUNT_MS, SCORE_COMMIT_COLOR_BASE, catMultStage);
}

function commitScore(key) {
  if (!state.rolled || state.awaitingNextRound) return;
  if (state.phase === "main" && categoryIsBlocked(key)) return; // Sabotage/The Culler/The Gatekeeper/The Turnkey

  // Main game: each category can only be locked in once, as usual - unless
  // The Turnkey is active, which lets the same category be re-thrown into
  // indefinitely (repeats accumulate on top of what's already there, same
  // as small games below - see finishCommitScore()). Small games: the same
  // hand can always be thrown into the same category again.
  const turnkeyActive = activeBossModifier()?.id === "theTurnkey";
  const allowRepeat = state.phase !== "main" || turnkeyActive;
  const alreadyUsed = state.scorecard[key] != null;
  if (alreadyUsed && !allowRepeat) return;

  const breakdown = scoreBreakdownForCategory(key, state.dice, activeWildIndices());
  const raw = breakdown.afterCatMult;
  // Small games always require an actual fit, for every commit. Main game:
  // a fresh, never-used category can always be deliberately zeroed out
  // (same as normal play everywhere else), and under The Turnkey
  // specifically, so can a REPEAT - "each hand adds to its total instead
  // of being wasted" means literally every hand is committable there, not
  // just non-zero ones, so a bad reroll of an already-used category still
  // advances the turn instead of forcing another throw. Only a repeat
  // WITHOUT The Turnkey (impossible in practice - allowRepeat already
  // rejects that above - kept here for clarity, not reachability) would
  // still need to fit.
  if ((state.phase !== "main" || (alreadyUsed && !turnkeyActive)) && raw <= 0) return;

  // Mulligan: every one of this commit's own guards has now passed - this
  // is the last possible moment to capture "state right before this
  // commit" (see captureMulliganSnapshot()), before anything below starts
  // mutating it.
  captureMulliganSnapshot();

  // The Censor: this hand is definitely being allocated to a category from
  // here on (every early-return guard above has passed) - re-pick which
  // eligible perk stays silenced, before anything below reads it, so this
  // same commit already reflects the fresh pick rather than the one that
  // was active going into the hand.
  if (activeBossModifier()?.id === "theCensor") pickNewCensorTarget();

  // Hotline: multiplies score by HOTLINE_MULTIPLIER in the main game,
  // multiplies money by it in small games - never both, matching what's
  // actually visible/useful in each phase.
  const doubled = isDoubleTarget(key);
  const scoreMult = state.phase === "main" && doubled ? HOTLINE_MULTIPLIER : 1;

  const thisTurnScore = Math.round(raw * scoreMult * state.scoreMultiplier);

  // Streaker: main-game only, per its own design - a small-game commit
  // neither grows nor resets it. Deliberately updated BEFORE the xMult
  // combination below, so a hand that extends the streak already benefits
  // from its own just-grown value (and the cue shown after always matches
  // whatever multiplier actually applied to this hand, never a stale or
  // not-yet-applied one).
  if (state.phase === "main") updateStreaker(thisTurnScore > 0);
  growStraightShot(key, thisTurnScore > 0);
  // Same "did this genuinely hit" gate scoreBreakdownForCategory() itself
  // used before it ever called streakDieBonusFor() - a whiff (rawHand <= 0)
  // never had its assumed growth counted into breakdown.bonusTotal in the
  // first place, so nothing should grow here either.
  if (breakdown.rawHand > 0) growStreakDie(key, state.dice, activeWildIndices());

  // X Multiplier perks (e.g. First Instinct) add on top of a flat ×1
  // baseline, only when their own condition is met right now - never
  // touches money (everything below keeps using the pre-multiplier
  // thisTurnScore), only the score actually banked. Additive, not
  // multiplicative: 2 copies of a "+1x" card plus the ×1 baseline is ×3
  // total, not ×1 applied twice. The perk card's own hover-active state
  // (see renderPerks()) is driven live off xMultCondition on every render,
  // not by anything set here. xMultCondition receives (state, key) - key is
  // the category just committed, needed by perks like Uppercut that only
  // care which category this hand landed in, not just what state currently
  // looks like.
  let bankedScore = thisTurnScore;
  let triggeredXMults = [];
  if (thisTurnScore > 0) {
    triggeredXMults = activePerksOwned().filter((p) => typeof p.xMult !== "undefined" && p.xMultCondition && p.xMultCondition(state, key));
    if (triggeredXMults.length > 0) {
      const combinedXMult = 1 + triggeredXMults.reduce((sum, p) => sum + resolveXMult(p, state), 0);
      bankedScore = Math.round(thisTurnScore * combinedXMult);
    }
  }

  // Lucky Die: resolved fresh, exactly once, right here - after every other
  // multiplier has already landed (bankedScore is the true post-X-mult
  // value at this point), and before finishCommitScore() ever reads it, so
  // both the actual banked score and the animation's own final stage agree
  // on the same one-time roll. preLuckyBankedScore is kept separate so the
  // animation can show the X-mult stage landing on the PRE-double value,
  // then its own "x2" stage counting up from there - not skip straight to
  // the doubled number with nothing explaining the jump.
  const preLuckyBankedScore = bankedScore;
  const luckyDieResult = bankedScore > 0 ? resolveLuckyDie(key, state.dice, activeWildIndices()) : null;
  if (luckyDieResult?.type === "double") bankedScore *= 2;

  // Double Down Token (see activateUsable()): doubles whatever this hand
  // was actually going to bank, on top of everything above (Lucky Die
  // included, if both happen to land on the same commit) - consumed here,
  // the instant a commit genuinely goes through (every early-return guard
  // above has already passed), not merely on the throw that revealed it.
  // preDoubleDownScore kept separate for the same reason preLuckyBankedScore
  // is - so playScoreCommitAnimation() can land its Lucky Die stage on the
  // PRE-double value, then run its own "x2" stage counting up from there.
  const preDoubleDownScore = bankedScore;
  const doubleDownTriggered = state.doubleDownActive;
  if (doubleDownTriggered) {
    bankedScore *= 2;
    state.doubleDownActive = false;
  }

  finishCommitScore(key, breakdown, raw, doubled, thisTurnScore, bankedScore, triggeredXMults, alreadyUsed, luckyDieResult, preLuckyBankedScore, doubleDownTriggered, preDoubleDownScore);
}

function finishCommitScore(key, breakdown, raw, doubled, thisTurnScore, bankedScore, triggeredXMults, alreadyUsed, luckyDieResult, preLuckyBankedScore, doubleDownTriggered, preDoubleDownScore) {
  state.scorecard[key] = alreadyUsed ? state.scorecard[key] + bankedScore : bankedScore;
  state.categoryUseCount[key]++;
  // Only claim the bonus in the banner if it actually landed - a deliberate
  // whiff (raw <= 0, e.g. zeroing Ones in the main game) never gets the
  // bonus added by scoreWithCategoryBonus() in the first place.
  const basePointsBonus = raw > 0 ? basePointsBonusFor(key) : 0;
  let bannerLabel = basePointsBonus > 0 ? `${CAT_BY_KEY[key].name} +${basePointsBonus} points` : CAT_BY_KEY[key].name;
  // Double Down Token consumed on this exact commit - the only visible cue
  // the player gets that it actually triggered (no separate "primed"
  // indicator beforehand, same as Lucky Die's own reveal-only-on-commit
  // treatment).
  if (doubleDownTriggered) bannerLabel += " ×2!";
  showHandBanner(bannerLabel, handBannerTierForCategory(key));
  triggerHandBannerGodRays(key);

  // Highlight, in the rule inventory, every persistent rule card that just
  // contributed to this hand's points (same raw > 0 "actually landed" gate
  // as the banner above) - stays highlighted until the player throws again.
  // Main game only: Base Points/Six-Seven/the hand-pattern cards (Pairs,
  // Trips, Quads, Straights, Low Roller) only ever affect score, which is
  // meaningless in small games (only money is - see the money block below,
  // which is deliberately its own separate main-game-independent check) -
  // highlighting them there would celebrate a bonus that did nothing.
  if (raw > 0 && state.phase === "main") {
    if (basePointsBonus > 0) highlightedRuleCardIds.add("basePoints");
    const sixSevenStacks = state.perksOwned.filter((p) => p.id === "sixSeven").length;
    if (sixSevenStacks > 0 && (key === "sixKind" || key === "sevenKind" || key === "yatzy")) {
      highlightedRuleCardIds.add("sixSeven");
    }
    handPatternBonus(state.dice, activeWildIndices()).ids.forEach((id) => highlightedRuleCardIds.add(id));
    if (streakDieBonusFor(key, state.dice, activeWildIndices()) > 0) highlightedRuleCardIds.add("streakDie");
    if (breakdown.blueBonus > 0) highlightedRuleCardIds.add("blueDie");
  }
  // The row for `key` is still the pre-commit render at this point (nothing
  // has re-rendered the scorecard yet this call) - its position is exactly
  // "the scoreboard's line" the beam should launch from.
  spawnHandBannerBeam(scoreBody.querySelector(`tr[data-category-key="${key}"]`));
  // Flashed on whichever render comes next (see renderScorecard()) - the
  // row itself is about to be rebuilt by this same commit, so the class
  // can't just be added to the current element.
  pendingRowFlashKey = key;

  // The Taxman: same block the leftover-turns bonus already gets (see
  // showTurnsLeftBonusCue()) - none of these die-triggered money sources
  // convert into actual money either while he's active. Only the money
  // side - Lucky Die's OTHER outcome (doubling the score) is untouched,
  // The Taxman's own wording has only ever been about money.
  const taxmanBlocksMoney = activeBossModifier()?.id === "theTaxman";

  // Coin Die: independent of category, phase, or whether the hand actually
  // scored - purely "was this exact die showing its marked face the moment
  // you committed." Checked directly against state.dice (already final by
  // the time a commit can happen), not the score breakdown.
  const coinDieGain = coinDieMoneyGain(state.dice);
  if (coinDieGain > 0 && !taxmanBlocksMoney) {
    state.money += coinDieGain;
    highlightedRuleCardIds.add("coinDie");
  }

  // Lucky Die's money outcome - already resolved once in commitScore()
  // (see resolveLuckyDie()), applied here alongside every other money
  // source this same commit triggers. The double-score outcome needs no
  // separate handling here - bankedScore already reflects it, doubled
  // before this function was even called (and isn't blocked by The Taxman).
  if (luckyDieResult?.type === "money" && !taxmanBlocksMoney) state.money += LUCKY_DIE_MONEY_AMOUNT;

  // Money is a small-games thing only. It also only pays out for actually
  // landing the hand this turn, not for parking a bad roll in a high-value
  // category just to bank its money. The 6-dice-only categories get an
  // extra cut with Sixth Sense, and Make it Count multiplies the whole
  // thing on top - no strings attached (unlike Small Change below, this
  // isn't blocked by Hotline or a Card Pack multiplier already being
  // active). The tradeoff (2 fewer main-game turns per copy) is applied in
  // turnLimit().
  if (thisTurnScore > 0 && state.phase !== "main") {
    const isExtraCat = CAT_BY_KEY[key].minDice != null;
    const multiplier = isExtraCat ? effectiveExtraCatMoneyMultiplier() : 1;
    const moneyMult = doubled ? HOTLINE_MULTIPLIER : 1;
    const makeItCountStacks = activeMakeItCountStacks();
    const makeItCountMult = 1 + MAKE_IT_COUNT_MONEY_MULT_PER_STACK * makeItCountStacks;
    state.money += Math.round(CAT_BY_KEY[key].money * multiplier * moneyMult * makeItCountMult);
    if (makeItCountStacks > 0) highlightedRuleCardIds.add("makeItCount");
  }

  // Small Change: in Boss only, a hand scored with no active multiplier at
  // all (no Card Pack boost, not Hotline'd) pays $1 per stack.
  if (state.phase === "main" && thisTurnScore > 0 && !doubled && categoryCardMultiplier(key) === 1) {
    const smallChangeStacks = activePerksOwned().filter((p) => p.id === "moneyHand").length;
    if (smallChangeStacks > 0) state.money += smallChangeStacks;
  }

  // Main game: the instant the target is first reached, freeze how many
  // turns are left over - that's the amount that'll convert to money. Fires
  // once per level (targetReachedTurn guards re-triggering, and once this
  // branch sets awaitingNextRound below, commitScore's own top guard blocks
  // any further calls anyway).
  let turnsLeftBonus = 0;
  let justReachedTarget = false;
  if (state.phase === "main" && state.targetReachedTurn == null && currentTotalScore() >= state.target) {
    state.targetReachedTurn = state.turn;
    turnsLeftBonus = Math.max(0, turnLimit() - state.turn);
    justReachedTarget = true;
  }

  if (state.turn >= turnLimit()) {
    // Board's full regardless - normal ending either way.
    endLevel();
    return;
  }

  if (justReachedTarget) {
    // Turns left over: stop play immediately rather than letting the player
    // keep filling out the rest of the board - Throw Dice becomes Next
    // Level (see renderControls), which only then offers a perk to pick.
    state.awaitingNextRound = true;
    state.rolled = false;
    renderAll();
    triggerRadialFlash();
    if (state.phase === "main") playScoreCommitAnimation(key, breakdown, doubled, thisTurnScore, bankedScore, triggeredXMults, luckyDieResult, preLuckyBankedScore, doubleDownTriggered, preDoubleDownScore);
    // Suppressed for the money outcome specifically under The Taxman (see
    // taxmanBlocksMoney above) - nothing to celebrate if it didn't pay out.
    // The double-score outcome still shows normally either way.
    if (luckyDieResult && !(luckyDieResult.type === "money" && taxmanBlocksMoney)) playLuckyDieCue(luckyDieResult);
    // The just-committed scorecard row is no longer interactive after that
    // renderAll() rebuild - move focus to the Next Level button itself (same
    // as a normal turn advance does) so Enter/Space reliably hits its own
    // phase-aware click handler instead of whatever focus fell back to.
    rollBtn.focus();
    saveState();
    if (turnsLeftBonus > 0) showTurnsLeftBonusCue(turnsLeftBonus);
    return;
  }

  state.turn++;
  state.dice = freshDice(state.diceCount);
  state.dieRotation = freshDieRotations(state.diceCount);
  state.held = freshHeld(state.diceCount);
  state.rolled = false;
  state.rollsUsedThisTurn = 0;
  state.bossLockedDieIndex = null; // The Warden: re-picked fresh next hand
  state.bossForcedRerollDieIndex = null; // The Tempest: re-picked fresh next hand
  state.viceLockedIndices = []; // The Vice: fully free again next hand
  refreshGatekeeperBlocks(); // The Gatekeeper: re-picked fresh next turn
  chargeLandlordRent(); // The Landlord: this new turn's rent is due now
  rerollDoubleTarget();

  renderAll();
  triggerTurnTransitionSweep();
  if (state.phase === "main") playScoreCommitAnimation(key, breakdown, doubled, thisTurnScore, bankedScore, triggeredXMults, luckyDieResult, preLuckyBankedScore);
  // Suppressed for the money outcome specifically under The Taxman (see
  // taxmanBlocksMoney above) - nothing to celebrate if it didn't pay out.
  // The double-score outcome still shows normally either way.
  if (luckyDieResult && !(luckyDieResult.type === "money" && taxmanBlocksMoney)) playLuckyDieCue(luckyDieResult);
  rollBtn.focus(); // new turn: space/enter should throw again by default
  saveState();
}

// Briefly names the hand just played in the narrow banner above the perk
// cards, typing it out fast character-by-character and fading it back out
// shortly after. Restarting both timers (and forcing a reflow before
// re-adding the visible class) lets back-to-back commits each get their own
// full type-in/fade-in, instead of the 2nd commit silently no-op'ing
// because the class was already present from the 1st.
const HAND_BANNER_TYPE_SPEED_MS = 16;

// God rays fanning out from the hand banner - unlike the border/glow tier
// ladder above (which covers every category), this only fires for the 3
// rarest "of a kind" hands: Five/Six/Seven of a Kind. Strength still
// escalates across those three (same linear-scale idea as
// triggerMoneySparkBurst()'s gain-based sizing), just keyed off a fixed
// per-category fraction instead of the banked score.
const GOD_RAYS_STRENGTH_BY_CATEGORY = { yatzy: 0, sixKind: 0.5, sevenKind: 1 };
const GOD_RAYS_MIN_PEAK_OPACITY = 0.06;
const GOD_RAYS_MAX_PEAK_OPACITY = 0.18;
const GOD_RAYS_MIN_SCALE = 0.85;
const GOD_RAYS_MAX_SCALE = 1.3;
function godRaysStrengthForCategory(key) {
  return GOD_RAYS_STRENGTH_BY_CATEGORY[key] ?? 0;
}
function triggerHandBannerGodRays(key) {
  if (!(key in GOD_RAYS_STRENGTH_BY_CATEGORY)) {
    handBannerGodRays.classList.remove("bursting");
    return;
  }
  const strength = godRaysStrengthForCategory(key);
  const rect = handBanner.getBoundingClientRect();
  handBannerGodRays.style.left = `${rect.left + rect.width / 2}px`;
  handBannerGodRays.style.top = `${rect.top + rect.height / 2}px`;
  handBannerGodRays.style.setProperty(
    "--god-rays-peak-opacity",
    GOD_RAYS_MIN_PEAK_OPACITY + strength * (GOD_RAYS_MAX_PEAK_OPACITY - GOD_RAYS_MIN_PEAK_OPACITY)
  );
  handBannerGodRays.style.setProperty(
    "--god-rays-scale",
    GOD_RAYS_MIN_SCALE + strength * (GOD_RAYS_MAX_SCALE - GOD_RAYS_MIN_SCALE)
  );
  handBannerGodRays.classList.remove("bursting");
  void handBannerGodRays.offsetWidth;
  handBannerGodRays.classList.add("bursting");
}

// The banner's border/glow tier is keyed off which CATEGORY was scored,
// not the banked score - a Yatzy is a Yatzy whether it banked 50 points or
// 500 with every multiplier stacked. Tier 0 (absent from this map) is the
// plain default border - the six upper-section categories, One Pair, and
// Chance are common enough not to warrant calling out. Tiers 1-2 sit below
// Five of a Kind's own "current" look (tier 3); tiers 4-6 escalate past it
// for the rarer 6/7-dice-only hands. Major Straight shares tier 3 with
// Five of a Kind rather than getting its own rung.
const HAND_BANNER_TIER_BY_CATEGORY = {
  threeKind: 1,
  twoPairs: 1,
  fullHouse: 1,
  smallStraight: 1,
  largeStraight: 1,
  fourKind: 2,
  yatzy: 3,
  majorStraight: 3,
  twoThreeKind: 4,
  threePairs: 4,
  sixKind: 5,
  sevenKind: 6,
};
const HAND_BANNER_TIER_CLASSES = [1, 2, 3, 4, 5, 6].map((t) => `hand-banner-tier-${t}`);
function handBannerTierForCategory(key) {
  return HAND_BANNER_TIER_BY_CATEGORY[key] || 0;
}

let handBannerTimeout = null;
let handBannerTypeInterval = null;
function showHandBanner(name, tier) {
  if (handBannerTimeout) clearTimeout(handBannerTimeout);
  if (handBannerTypeInterval) clearInterval(handBannerTypeInterval);
  handBanner.textContent = "";
  handBanner.classList.remove("hand-banner-visible");
  handBanner.classList.remove(...HAND_BANNER_TIER_CLASSES);
  if (tier > 0) handBanner.classList.add(`hand-banner-tier-${tier}`);
  void handBanner.offsetWidth;
  handBanner.classList.add("hand-banner-visible");

  let charsShown = 0;
  handBannerTypeInterval = setInterval(() => {
    charsShown++;
    handBanner.textContent = name.slice(0, charsShown);
    if (charsShown >= name.length) {
      clearInterval(handBannerTypeInterval);
      handBannerTypeInterval = null;
    }
  }, HAND_BANNER_TYPE_SPEED_MS);

  handBannerTimeout = setTimeout(() => {
    handBanner.classList.remove("hand-banner-visible");
    handBannerTimeout = null;
  }, 1400);
}

// Drops one small fading dot at (x, y) - called repeatedly by
// spawnHandBannerBeam() as it moves, so the accumulated dots trace the
// actual curved path already traveled (a real trajectory, not a rotated
// rectangle trying to fake one). Each mark fades/shrinks itself out via a
// CSS transition and removes itself on a matching timeout.
const HAND_BANNER_TRAIL_FADE_MS = 350;
function spawnBeamTrailMark(x, y, opacity) {
  const mark = document.createElement("div");
  mark.className = "hand-banner-beam-trail-mark";
  mark.style.left = `${x}px`;
  mark.style.top = `${y}px`;
  mark.style.opacity = opacity;
  document.body.appendChild(mark);
  const raf = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(Date.now()), 16);
  // Set the fade target on the NEXT frame, after the initial opacity above
  // has actually painted - changing it in the same tick it's created would
  // just skip straight to the end state, no transition to see.
  raf(() => {
    mark.style.opacity = 0;
    mark.style.transform = "scale(0.4)";
  });
  setTimeout(() => mark.remove(), HAND_BANNER_TRAIL_FADE_MS + 50);
}

// Spawns a small glowing dot at the just-scored scorecard row's left edge
// and animates it, frame by frame (same rAF-driven technique as
// animateCountUp()), along a gentle curve over to the hand banner -
// smoothly interpolated every frame rather than jumping between a handful
// of CSS keyframe stops, which is what previously read as stuttering.
// Dropping a fading trail mark (see spawnBeamTrailMark()) each frame draws
// the actual path behind it instead of trying to keep a separate rotated
// element aligned with the curve's tangent, which is what previously made
// the trail look wrong. Fixed-position with real viewport coordinates so it
// works regardless of the board's grid/stacked layout.
const HAND_BANNER_BEAM_DURATION_MS = 700;
const HAND_BANNER_TRAIL_INTERVAL_MS = 26;
function spawnHandBannerBeam(fromEl) {
  if (!fromEl) return;
  const fromRect = fromEl.getBoundingClientRect();
  const toRect = handBanner.getBoundingClientRect();
  const startX = fromRect.left;
  const startY = fromRect.top + fromRect.height / 2;
  const endX = toRect.left + toRect.width / 2;
  const endY = toRect.top + toRect.height / 2;
  const dx = endX - startX;
  const dy = endY - startY;

  // A slight bow, not a straight line: nudge the path's midpoint off the
  // straight dx/dy line by a fraction of the travel distance, perpendicular
  // to it - randomizing which side each shot bows toward keeps repeated
  // beams from all looking identical. Capped so a long cross-board throw
  // doesn't get a comically wide arc.
  const distance = Math.hypot(dx, dy) || 1;
  const curveAmount = Math.min(40, distance * 0.25) * (Math.random() < 0.5 ? 1 : -1);
  const midX = dx * 0.5 + (-dy / distance) * curveAmount;
  const midY = dy * 0.5 + (dx / distance) * curveAmount;
  // Single quadratic Bezier (start (0,0) -> control -> end (dx,dy)) solved
  // so it passes through (midX, midY) at t=0.5: B(0.5) = 0.5*ctrl + 0.25*end
  // (the 0.25*start term drops out since start is the origin).
  const ctrlX = 2 * midX - 0.5 * dx;
  const ctrlY = 2 * midY - 0.5 * dy;

  function bezierPoint(t) {
    const mt = 1 - t;
    return { x: 2 * mt * t * ctrlX + t * t * dx, y: 2 * mt * t * ctrlY + t * t * dy };
  }

  const beam = document.createElement("div");
  beam.className = "hand-banner-beam";
  beam.style.left = `${startX}px`;
  beam.style.top = `${startY}px`;
  document.body.appendChild(beam);

  const raf = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(Date.now()), 16);
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const start = now();
  let lastTrailAt = -Infinity;

  function step() {
    const elapsed = now() - start;
    const t = Math.min(1, elapsed / HAND_BANNER_BEAM_DURATION_MS);
    const { x, y } = bezierPoint(t);
    // Quick pop in, hold at full size/opacity, quick fade+shrink near the end.
    const opacity = t < 0.12 ? t / 0.12 : t > 0.85 ? Math.max(0, (1 - t) / 0.15) : 1;
    const scale = t < 0.12 ? 0.6 + 0.4 * (t / 0.12) : t > 0.85 ? Math.max(0.4, 1 - 0.6 * ((t - 0.85) / 0.15)) : 1;
    beam.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    beam.style.opacity = opacity;

    if (elapsed - lastTrailAt >= HAND_BANNER_TRAIL_INTERVAL_MS) {
      lastTrailAt = elapsed;
      spawnBeamTrailMark(startX + x, startY + y, opacity);
    }

    if (t < 1) raf(step);
    else beam.remove();
  }
  raf(step);
}

// Non-blocking cue for the turns-left-into-money bonus: the turn label
// briefly announces "X left", then (once that's had a beat to register) the
// money counter counts that amount up - all while play continues normally
// underneath, unlike the old Skip-only version which had to pause the game.
function showTurnsLeftBonusCue(turnsLeft) {
  statTurn.textContent = `${turnsLeft} left`;
  statTurn.classList.add("turn-cue");

  setTimeout(() => {
    // The Taxman: the "N left" cue still shows (still useful information),
    // it just never turns into money - see activeBossModifier().
    if (activeBossModifier()?.id !== "theTaxman") {
      state.money += turnsLeft;
      animateCountUp(statMoney, state.money, 1200);
      // This bypasses renderStats()'s own before/after comparison (it
      // mutates and animates statMoney directly), so the spark burst and
      // "+$N" cue that every other gain gets need to be triggered by hand
      // here too, or this payout would be the one silent exception. Also
      // has to keep lastKnownMoney in sync by hand for the same reason -
      // the renderStats() call below (once the "N left" cue itself fades)
      // would otherwise still see the stale pre-bonus value there and
      // re-fire this exact same gain's cue all over again.
      triggerMoneySparkBurst(turnsLeft);
      showMoneyGainCue(turnsLeft);
      lastKnownMoney = state.money;
    }
    saveState();
  }, 400);

  setTimeout(() => {
    statTurn.classList.remove("turn-cue");
    renderStats(); // restore the normal "turn / limit" display
  }, 1200);
}

function endLevel() {
  // Reflect the just-committed final category (its new checkmark/score)
  // before any modal/prompt opens - otherwise the last hand of the level
  // never visibly updates, since nothing else re-renders the scorecard here.
  renderStats();
  renderScorecard();
  saveState();
  const total = currentTotalScore();
  // Small games have no target requirement - they're a resource-gathering
  // warmup before the real challenge, not something you can fail. Running
  // out of turns always advances to the next round regardless of score.
  if (state.phase !== "main") {
    showNextRoundPrompt();
    return;
  }
  if (total >= state.target) {
    triggerRadialFlash();
    showLevelCompleteModal(total);
  } else {
    const extraLifeIndex = state.perksOwned.findIndex((p) => p.id === "extraLife");
    if (extraLifeIndex !== -1) {
      // Destroyed on use, not through the trash can - no refund, and it
      // skips straight past the perk-choice modal into the next level.
      removePerkInstance(extraLifeIndex);
      saveState();
      startNextLevel();
    } else {
      showGameOverModal(total);
    }
  }
}

// Set right before the render that first shows a freshly-rolled shop's
// cards (see showNextRoundPrompt()) so renderPackShop() knows to flip them
// in - consumed (cleared) by that very render, never left set for any
// later re-render of the same shop.
let pendingShopFlipIn = false;

// Same one-shot pattern as pendingShopFlipIn, but for the "Choose a Card" /
// "Choose a Rule" pack-offer popup - set right as a pack is opened, consumed
// by whichever offer-modal renderer actually draws the initial cards, so
// later re-renders (e.g. selecting a rule card) don't replay the flip.
let pendingPackFlipIn = false;

// Golden Touch's refund amount, held here from the moment a pack is bought
// (openCardPack()) until the offer's own modal actually closes - a pick,
// a rule confirm, or a skip (see flushPendingGoldenTouchCue(), called from
// all three). Showing the cue any earlier would just be hidden behind that
// modal, which opens immediately after the purchase.
let pendingGoldenTouchRefund = null;

function flushPendingGoldenTouchCue() {
  if (pendingGoldenTouchRefund == null) return;
  showGoldenTouchCue(pendingGoldenTouchRefund);
  pendingGoldenTouchRefund = null;
}

// Strips the flip-in class once its one-shot animation actually finishes.
// Without this, packCardFlipIn's animation-fill-mode: both keeps holding
// (and so controlling, per the CSS cascade's animation-beats-normal-rules
// rule) the card's `transform` property indefinitely - which silently
// blocks the .pack-card:hover lift from ever applying to a card that was
// once flipped in, until the whole card gets torn down and recreated.
function clearFlipInOnAnimationEnd(el, onDone) {
  el.addEventListener("animationend", () => {
    el.classList.remove("pack-card-flip-in");
    if (onDone) onDone();
  }, { once: true });
}

// Small-game completions skip the perk-choice modal entirely: the roll
// button turns into a "Next Round" advance button, and the bonus card slots
// double as a Card Pack shop for the moment.
function showNextRoundPrompt() {
  state.awaitingNextRound = true;
  // Defense in depth, same reasoning as startNextLevel()'s/restartRun()'s own
  // reset: if a pack offer somehow made it here still unresolved, any Golden
  // Touch refund banked for it must be dropped right here too - otherwise it
  // sits around and gets wrongly flushed alongside some completely unrelated
  // LATER purchase, showing a refund cue for money that (from the player's
  // perspective, at that later point) came from nothing.
  pendingGoldenTouchRefund = null;
  state.pendingPackOffer = null;
  state.refreshCost = REFRESH_COST_BASE;
  state.rerollCountThisShop = 0;
  state.freeRerollActive = false;
  // Third Time's the Charm: this shop is one of the (up to 2) locked ones
  // queued up by reaching the discount in an earlier shop, once the boss
  // that followed it concluded (see startNextLevel()'s "main just finished"
  // branch) - drain one charge per shop presentation, locking purchases
  // here for as long as any remain.
  if (state.thirdTimesCharmLocksRemaining > 0) {
    state.shopPurchasesLocked = true;
    state.thirdTimesCharmLocksRemaining -= 1;
  } else {
    state.shopPurchasesLocked = false;
  }
  // A small game just concluded - one of Make it count's 3 games is spent,
  // and this fresh shop uses up one of Fire Sale's 2 covered shops.
  tickMakeItCount();
  tickFireSale();
  rollShopSlots();
  pendingShopFlipIn = true;
  renderControls();
  renderPackShop();
  renderMainGameModifier(); // "Small Game N" -> "Buy Phase" now that awaitingNextRound is set
  renderStats();
  // tickFireSale() above may have just expired Fire Sale's last covered
  // shop (removing it from perksOwned) - without this, the rule inventory
  // panel's "shops left" text and active-pulse (see renderRuleInventory()'s
  // own hasFireSale() check) would keep showing its pre-tick state for this
  // whole shop, until some unrelated action happened to trigger a render.
  renderRuleInventory();
  saveState();
}

// Three category-card pack sizes, the purple Rule pack (offers rule cards
// from RULE_POOL instead of category multiplier cards), and the gold Perk
// pack (offers PERK_POOL cards - the only way to get a perk outside a
// level-up pick).
const CARD_PACK_TYPES = [
  { name: "Card Pack (3)", price: 18, cardCount: 3, kind: "category" },
  { name: "Card Pack (4)", price: 22, cardCount: 4, kind: "category" },
  { name: "Card Pack (5)", price: 26, cardCount: 5, kind: "category" },
  { name: "Rule (3)", price: 20, cardCount: 3, kind: "rule" },
  { name: "Perk Pack (2)", price: 30, cardCount: 2, kind: "perk" },
  { name: "Perk Pack (3)", price: 35, cardCount: 3, kind: "perk" },
];
const CARD_PACK_MULTIPLIER_STEP = 0.5;

// How often each shop slot rolls a pack of each kind - a kind is picked
// first by these weights, THEN a specific size/price within that kind is
// picked uniformly (see rollPackType()) - so e.g. the 55 for "category" is
// split evenly across Card Pack (3)/(4)/(5), not applied to each one
// individually. Perk packs are deliberately rare (5%): they're the only way
// to get a perk outside a level-up pick, and pulling one of only 4 shop
// slots per round.
const CARD_PACK_KIND_WEIGHTS = { category: 56, rule: 40, perk: 4 };

// Picks a pack kind by CARD_PACK_KIND_WEIGHTS, then a specific CARD_PACK_TYPES
// entry of that kind uniformly at random (multiple sizes only exist for
// category and perk packs today - rule has just the one).
function rollPackType() {
  const totalWeight = Object.values(CARD_PACK_KIND_WEIGHTS).reduce((sum, w) => sum + w, 0);
  let roll = Math.random() * totalWeight;
  let chosenKind = null;
  for (const [kind, weight] of Object.entries(CARD_PACK_KIND_WEIGHTS)) {
    if (roll < weight) { chosenKind = kind; break; }
    roll -= weight;
  }
  const optionsOfKind = CARD_PACK_TYPES.filter((t) => t.kind === chosenKind);
  return optionsOfKind[Math.floor(Math.random() * optionsOfKind.length)];
}

// Each offered category card has this independent chance of being Boosted -
// a Boosted pick adds a full 1x instead of the usual 0.5x.
const CATEGORY_CARD_BOOST_CHANCE = 0.05;
const CATEGORY_CARD_BOOST_MULTIPLIER_STEP = 1;

function effectiveCategoryCardBoostChance() {
  return CATEGORY_CARD_BOOST_CHANCE + state.luckySkipBonus;
}

// Mega Pack: this chance, rolled once per category pack purchase (never
// rule packs - see openCardPack()), replaces the normal cardCount-sized
// offer with every single currently-available category in one go. Lucky
// Skip boosts it too, reusing the exact same banked bonus as Shiny/Boosted
// rather than tracking a separate running total.
const MEGA_PACK_CHANCE = 0.05;

function effectiveMegaChance() {
  return MEGA_PACK_CHANCE + state.luckySkipBonus;
}

function hasFireSale() {
  return state.perksOwned.some((p) => p.id === "fireSale" && (p.shopsRemaining || 0) > 0);
}

// True only while the CURRENT shop is showing exactly its 3rd set of offers
// (rerollCountThisShop landed exactly one past THIRD_TIMES_CHARM_TRIGGER_
// REROLL_INDEX, i.e. right after the 2nd reroll) - a 4th, 5th, etc. reroll
// past that point turns it back off, matching the card's own "3rd Set of
// shops" wording (that one set, not every set from the 3rd on). Live off
// rerollCountThisShop, not a banked/persistent flag, so it naturally turns
// back off the moment a fresh shop opens and resets that counter too, same
// as Fire Sale/Lucky Skip read their own state live rather than caching a
// computed result.
function hasThirdTimesCharmDiscount() {
  return state.perksOwned.some((p) => p.id === "thirdTimesTheCharm")
    && state.rerollCountThisShop === THIRD_TIMES_CHARM_TRIGGER_REROLL_INDEX + 1;
}

function hasBulkDiscount() {
  return state.perksOwned.some((p) => p.id === "bulkDiscount");
}

// Bulk Discount (BULK_DISCOUNT_AMOUNT, declared up with the other rule-card
// constants before RULE_POOL) comes off the base price first, flat, before
// Fire Sale/Third Time's the Charm's percentage cuts apply on top of that
// already-lowered number - matches its own desc ("Lowers... default price")
// and means owning both a flat and a percentage discount compounds instead
// of the flat one just being swallowed into the percentage math. Floored at
// $1 so a heavily-discounted cheap pack can never round down to free.
function effectiveCardPackPrice(packType) {
  let price = packType.price;
  if (hasBulkDiscount()) price = Math.max(1, price - BULK_DISCOUNT_AMOUNT);
  if (hasFireSale()) price *= 1 - FIRE_SALE_DISCOUNT;
  if (hasThirdTimesCharmDiscount()) price *= 1 - THIRD_TIMES_CHARM_DISCOUNT;
  return Math.round(price);
}

// Store Expansion adds a 4th slot - read live off perksOwned (like every
// other shop-economy card here) rather than banked once at pick time, so it
// applies starting with the very next shop that gets rolled, same timing as
// Fire Sale/Bulk Discount/Third Time's the Charm's own live checks.
const BASE_SHOP_SLOT_COUNT = 3;
function effectiveShopSlotCount() {
  return BASE_SHOP_SLOT_COUNT + (state.perksOwned.some((p) => p.id === "storeExpansion") ? 1 : 0);
}

// Fills every shop slot (3, or 4 with Store Expansion - see
// effectiveShopSlotCount()) with a fresh independent random pack type each
// (so duplicates can happen), weighted by kind via rollPackType() - used
// both when the shop first opens and whenever the player hits Refresh,
// regardless of which slots were already bought.
function rollShopSlots() {
  state.shopSlots = Array.from(
    { length: effectiveShopSlotCount() },
    () => rollPackType().name
  );
}

function refreshShopSlots() {
  if (!state.awaitingNextRound || state.pendingPackOffer) return;
  // Free Reroll Token (see activateUsable()) charges $0 for this one
  // Refresh without touching refreshCost itself - the escalation below
  // still climbs off the real (pre-free) value, so the Refresh AFTER this
  // one costs what it always would have.
  const cost = state.freeRerollActive ? 0 : state.refreshCost;
  if (state.money < cost) return;
  // Same reasoning as openCardPack()'s own invalidation - a lingering
  // Mulligan snapshot predates this shop, and a later revert would silently
  // refund whatever this refresh cost while refreshCost/rerollCountThisShop
  // themselves stay live (see useMulligan()), turning a paid reroll into a
  // free one after the fact.
  mulliganSnapshot = null;
  renderControls(); // hides the now-inert Revert button right away, rather than leaving it clickable-looking until some later render
  state.money -= cost;
  state.refreshCost += REFRESH_COST_INCREMENT;
  state.freeRerollActive = false;
  // Third Time's the Charm: crossing into the 3rd set of offers on THIS
  // reroll (checked against the counter's pre-increment value, right below)
  // arms the boss-shop lock - see startNextLevel()'s "main just finished"
  // branch, which is what actually turns this into 2 locked shops once the
  // next boss concludes. The discount itself needs no arming at all -
  // hasThirdTimesCharmDiscount() just reads rerollCountThisShop live, once
  // it's incremented past the trigger a few lines down.
  if (state.rerollCountThisShop === THIRD_TIMES_CHARM_TRIGGER_REROLL_INDEX
    && state.perksOwned.some((p) => p.id === "thirdTimesTheCharm")) {
    state.thirdTimesCharmPendingBossLock = true;
  }
  state.rerollCountThisShop += 1;
  rollShopSlots();
  pendingShopFlipIn = true;
  renderStats();
  renderPackShop();
  // Third Time's the Charm's rule-inventory pulse (see renderRuleInventory()'s
  // hasThirdTimesCharmDiscount() check) reads rerollCountThisShop live, but
  // nothing else called from here re-renders that panel - without this it
  // wouldn't actually light up until some unrelated action happened to
  // trigger a full render.
  renderRuleInventory();
  saveState();
}

// Each EXTRA_CATS entry is pointless to offer - and worth zero anywhere -
// until the player has its own minDice (Seven of a Kind needs 7, not just
// the usual 6).
function availableCategoryPool() {
  return [...UPPER_CATS, ...LOWER_CATS, ...EXTRA_CATS.filter((cat) => state.diceCount >= cat.minDice)];
}

function sampleCategoryKeys(n) {
  const shuffled = [...availableCategoryPool()];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n).map((cat) => cat.key);
}

// Mega Pack: every currently-available category in one offer, instead of
// just packType.cardCount of them - see openCardPack().
function allAvailableCategoryKeys() {
  return availableCategoryPool().map((cat) => cat.key);
}

function sampleRuleIds(n) {
  // Same gate as samplePerks() - excludes a non-stacking/capped rule card
  // (Fire Sale, Third Time's the Charm, Compound Interest, Golden Touch)
  // once it's already owned at its cap. Reads live off state.perksOwned via
  // stackAvailable() every call, so a card removed/expired later (see
  // tickFireSale()) becomes offerable again on its own, no extra bookkeeping
  // needed here.
  const shuffled = RULE_POOL.filter((rule) => !rule.available || rule.available(state));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // At most 1 destructive (red) rule card per offer - a pack that could
  // roll Clean Slate + Selective Cut + Ooo Shiny together would leave no
  // safe pick, forcing a perk sacrifice no matter which card is taken.
  const result = [];
  let destructiveUsed = false;
  for (const rule of shuffled) {
    if (result.length >= n) break;
    const isDestructive = DESTRUCTIVE_RULE_IDS.includes(rule.id);
    if (isDestructive && destructiveUsed) continue;
    if (isDestructive) destructiveUsed = true;
    result.push(rule.id);
  }
  return result;
}

function openCardPack(packType, slotIndex) {
  const price = effectiveCardPackPrice(packType);
  if (!state.awaitingNextRound || state.pendingPackOffer || state.money < price) return;
  if (state.shopPurchasesLocked) return; // Third Time's the Charm: this shop is locked
  if (state.shopSlots[slotIndex] !== packType.name) return; // stale click target
  // A lingering Mulligan snapshot (see captureMulliganSnapshot()) predates
  // this whole shop - useMulligan() deliberately keeps shopSlots/refreshCost
  // "live" so the shop doesn't visually vanish on a revert, but everything
  // else (money, perksOwned - where an owned Lucky Skip and its banked
  // state.luckySkipBonus live) would still snap back to before the shop
  // opened. Left alone, a later Revert click would silently erase whatever
  // gets bought/skipped from here on while the shop slot still shows as
  // spent - invalidate it the moment real money changes hands in this shop,
  // so Revert can only ever undo the hand that led into it, never a
  // purchase made after.
  mulliganSnapshot = null;
  renderControls(); // hides the now-inert Revert button right away, rather than leaving it clickable-looking until some later render
  state.money -= price;
  // Golden Touch: a chance to refund half of what was just spent. The
  // money-stat message is deferred (see pendingGoldenTouchRefund) until the
  // pack offer's own modal closes - showing it now would just be hidden
  // behind that modal, which opens right after this.
  if (state.perksOwned.some((p) => p.id === "goldenTouch") && Math.random() < GOLDEN_TOUCH_CHANCE) {
    const refund = Math.round(price / 2);
    state.money += refund;
    pendingGoldenTouchRefund = refund;
  }
  state.shopSlots[slotIndex] = null; // that slot is spent - the other two stay put
  state.pendingPackKind = packType.kind;
  // Mega Pack: rolled once per category-pack purchase, never for rule/perk packs.
  const isMega = packType.kind === "category" && Math.random() < effectiveMegaChance();
  state.pendingPackIsMega = isMega;
  if (packType.kind === "rule") {
    state.pendingPackOffer = sampleRuleIds(packType.cardCount);
    state.pendingPackBoostedKeys = [];
    state.pendingPackShinyKeys = [];
    // A fresh offer always starts at the "choose a rule card" step, never
    // still mid-selection from some earlier, unrelated offer - see
    // showPackOfferModal()'s own comment for why it no longer resets these
    // itself (that was the actual bug: resuming a MINIMIZED offer went
    // through the exact same reset, letting a destructive rule's random
    // preview be rerolled for free by minimizing and reopening).
    selectedRuleId = null;
    selectedPerkToRemoveIndex = null;
    oooShinyRemovedPerks = [];
  } else if (packType.kind === "perk") {
    // samplePerks() already excludes anything gated unavailable (a maxed
    // stack, a missing requirement) - same pool/rules as a level-up pick,
    // just reachable from the shop instead. Each offered card independently
    // rolls its own Shiny chance, same as showLevelCompleteModal()'s own
    // rollOptions() - tracked by id here (pendingPackShinyKeys) rather than
    // folded into the offer objects themselves, so pendingPackOffer can stay
    // a plain array of ids like every other pack kind's offer.
    const perks = samplePerks(state, packType.cardCount);
    state.pendingPackOffer = perks.map((p) => p.id);
    state.pendingPackBoostedKeys = [];
    state.pendingPackShinyKeys = perks.filter(() => Math.random() < effectiveShinyChance()).map((p) => p.id);
    // Same fresh-start guarantee as the rule branch above.
    selectedPerkPackId = null;
    selectedPerkPackReplaceIndex = null;
  } else {
    state.pendingPackOffer = isMega ? allAvailableCategoryKeys() : sampleCategoryKeys(packType.cardCount);
    state.pendingPackBoostedKeys = state.pendingPackOffer.filter(() => Math.random() < effectiveCategoryCardBoostChance());
    state.pendingPackShinyKeys = [];
  }
  pendingPackFlipIn = true;
  renderStats();
  renderPackShop();
  showPackOfferModal();
  saveState();
}

// Declines every offered card - the pack was still bought (money and the
// shop slot are already spent), this just means walking away with no
// category bonus (or rule) from it.
function skipPackOffer() {
  if (!state.pendingPackOffer) return;
  // Lucky Skip: banked permanently the moment the skip happens, not
  // recomputed later - so losing the card afterward never claws it back.
  const luckySkipStacks = state.perksOwned.filter((p) => p.id === "luckySkip").length;
  if (luckySkipStacks > 0) state.luckySkipBonus += LUCKY_SKIP_BONUS_PER_STACK * luckySkipStacks;
  // Skipper: every owned copy's own xMult grows, same permanent-and-never-
  // resetting treatment as Demolisher's growth hook in removePerkInstance().
  growXMultPerk("skipper", SKIPPER_MULT_STEP);
  state.pendingPackOffer = null;
  state.pendingPackKind = null;
  state.pendingPackBoostedKeys = [];
  state.pendingPackShinyKeys = [];
  state.pendingPackIsMega = false;
  selectedRuleId = null;
  selectedPerkToRemoveIndex = null;
  selectedPerkPackId = null;
  oooShinyRemovedPerks = [];
  hideModal();
  flushPendingGoldenTouchCue();
  renderPackShop();
  // Lucky Skip's tooltip ("Current bonus: ...") reads state.luckySkipBonus,
  // but renderPackShop() alone doesn't touch the rule inventory panel - so
  // without this, the just-earned bonus wouldn't show up there until some
  // unrelated action happened to trigger a full render. Same staleness risk
  // applies to Skipper's own perk-card tooltip, hence renderPerks() too.
  renderRuleInventory();
  renderPerks();
  saveState();
}

function pickPackCard(key) {
  if (!state.pendingPackOffer || !state.pendingPackOffer.includes(key)) return;
  const step = state.pendingPackBoostedKeys.includes(key)
    ? CATEGORY_CARD_BOOST_MULTIPLIER_STEP
    : CARD_PACK_MULTIPLIER_STEP;
  state.categoryBonus[key] = (state.categoryBonus[key] || 0) + step;
  state.pendingPackOffer = null;
  state.pendingPackKind = null;
  state.pendingPackBoostedKeys = [];
  state.pendingPackShinyKeys = [];
  state.pendingPackIsMega = false;
  hideModal();
  flushPendingGoldenTouchCue();
  renderPackShop();
  saveState();
}

// Collapses an open Card Pack offer into .pack-offer-banner instead of
// resolving it - state.pendingPackOffer is untouched, so the offer is still
// fully pending underneath (still blocks Refresh/buying another pack/
// Next Round exactly as it does while the popup itself is showing, see
// startNextLevel()'s own guard and renderPackShop()'s purchasable check).
// Reuses hideModal() to tear down the popup, then shows the banner right
// after - safe regardless of hideModal() also unconditionally hiding the
// banner itself (see there), since this always runs last.
function minimizePackOffer() {
  hideModal();
  // A plain if/else-if chain, not a two-way ternary - pendingPackKind has 3
  // possible values (category/rule/perk) since Perk Packs were added, and a
  // binary rule-vs-everything-else check would silently mislabel perk
  // offers as "Choose a Card".
  let label;
  if (state.pendingPackKind === "rule") label = "📦 Choose a Rule - tap to resume";
  else if (state.pendingPackKind === "perk") label = "📦 Choose a Perk - tap to resume";
  else label = "📦 Choose a Card - tap to resume";
  packOfferBanner.textContent = label;
  packOfferBanner.classList.remove("hidden");
}

// Brings a minimized offer back - hides the banner and re-opens the same
// popup showPackOfferModal() would have shown originally (it re-derives
// everything from state.pendingPackKind/pendingPackOffer, so this is just a
// normal re-render, not a special "restore" path).
function resumePackOffer() {
  packOfferBanner.classList.add("hidden");
  showPackOfferModal();
}
packOfferBanner.addEventListener("click", resumePackOffer);

// Small "-" button pinned to the top-right corner of an open Card Pack
// popup (see .pack-minimize-btn) - shared by both showPackOfferModal() and
// renderRuleOfferModal() rather than duplicated in each.
function createPackMinimizeBtn() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pack-minimize-btn";
  btn.title = "Minimize";
  btn.textContent = "–";
  btn.addEventListener("click", minimizePackOffer);
  return btn;
}

// Shows the offered cards as a large popup in the middle of the screen
// (reusing the modal overlay, which also suspends the game's keyboard
// shortcuts while a choice is pending) rather than filling the small bonus
// card slots in the dice panel. Branches on pendingPackKind: category packs
// apply instantly on click same as always; rule packs go to
// renderRuleOfferModal(), which also applies instantly on click except for
// the rules that need one more click to pick a perk to remove first; perk
// packs go to renderPerkOfferModal(), same "one more click" shape but for
// the "perk slots are full, replace one" case instead.
//
// Deliberately does NOT reset selectedRuleId/oooShinyRemovedPerks/
// selectedPerkPackId here (an earlier version did) - this is also the exact
// function resumePackOffer() calls to bring a minimized offer back, and
// resetting on every call let a player select a destructive rule (Clean
// Slate/Ooo Shiny), see its random preview, minimize before confirming, then
// reopen for a completely fresh reroll - repeatable for free as many times
// as they liked. Every path that actually RESOLVES an offer (pickPackCard/
// skipPackOffer/confirmPerkPackPick/confirmRuleSelection) already clears
// these itself, and openCardPack() can only start a new offer when none is
// already pending - so by the time this ever runs for a genuinely NEW offer,
// they're already back to null on their own.
function showPackOfferModal() {
  if (state.pendingPackKind === "rule") {
    renderRuleOfferModal();
    return;
  }
  if (state.pendingPackKind === "perk") {
    renderPerkOfferModal();
    return;
  }

  const flipIn = pendingPackFlipIn;
  pendingPackFlipIn = false;

  modalBox.innerHTML = "";
  modalBox.classList.add("pack-modal");
  // Mega Pack offers every available category at once (vs. the usual
  // packType.cardCount) - needs a wider, scrollable layout so a long list
  // doesn't overflow past the viewport with no way to reach the rest of it.
  modalBox.classList.toggle("pack-modal-mega", state.pendingPackIsMega);
  modalBox.appendChild(createPackMinimizeBtn());

  const h2 = document.createElement("h2");
  h2.textContent = state.pendingPackIsMega ? "Mega Pack! Choose a Card" : "Choose a Card";

  const cardsWrap = document.createElement("div");
  cardsWrap.className = "pack-modal-cards";

  state.pendingPackOffer.forEach((key) => {
    const cat = CAT_BY_KEY[key];
    const isBoosted = state.pendingPackBoostedKeys.includes(key);
    const card = document.createElement("div");
    card.className = "pack-card pack-card-large" + (isBoosted ? " boosted" : "") + (flipIn ? " pack-card-flip-in" : "");
    // The chromatic split is timed off the flip-in's own animationend
    // (same event that clears the flip-in class below), not fired right at
    // insertion - the card sits edge-on and opacity:0 for the first chunk
    // of that animation (see packCardFlipIn's own keyframes/stagger delay),
    // so a flash timed any earlier would play out entirely while invisible.
    if (flipIn) clearFlipInOnAnimationEnd(card, isBoosted ? () => triggerChromaticSplit(card) : undefined);
    // The shine sweep, unlike the chromatic split above, starts right away
    // so it overlaps the flip-in's own rotation instead of waiting for it
    // to finish - triggerBoostedShine() still defers its actual work by a
    // frame internally, for the same "card isn't inserted into the
    // document yet at this exact point in the loop" reason
    // triggerChromaticSplit() does.
    if (flipIn && isBoosted) triggerBoostedShine(card);
    attachCardTilt(card);

    const name = document.createElement("div");
    name.className = "pack-card-name";
    name.textContent = cat.name;

    const bonus = document.createElement("div");
    bonus.className = "pack-card-bonus";
    bonus.textContent = formatMultiplier(1 + (isBoosted ? CATEGORY_CARD_BOOST_MULTIPLIER_STEP : CARD_PACK_MULTIPLIER_STEP));

    card.appendChild(name);
    card.appendChild(bonus);
    if (isBoosted) {
      const boostedTag = document.createElement("div");
      boostedTag.className = "pack-card-boosted-tag";
      boostedTag.textContent = "Boosted";
      card.appendChild(boostedTag);
    }
    card.addEventListener("click", () => pickPackCard(key));
    cardsWrap.appendChild(card);
  });

  const skipBtnEl = document.createElement("button");
  skipBtnEl.className = "modal-btn pack-skip-btn";
  skipBtnEl.textContent = "Skip";
  skipBtnEl.addEventListener("click", skipPackOffer);

  // Wrapped in a centered flex row (not just relying on .modal's own
  // text-align) so it's never at the mercy of whatever else that row ends
  // up containing later - see the matching wrapper in renderRuleOfferModal().
  const btnRow = document.createElement("div");
  btnRow.className = "modal-btn-row";
  btnRow.appendChild(skipBtnEl);

  modalBox.appendChild(h2);
  modalBox.appendChild(cardsWrap);
  modalBox.appendChild(btnRow);
  modalOverlay.classList.remove("hidden");
  // Moves focus off whatever background control (rollBtn, a scorecard row,
  // ...) happened to hold it before this opened - modalBox has tabindex="-1"
  // specifically so it can take focus programmatically without joining the
  // normal tab order. Without this, a stray Enter/Space keypress could
  // natively activate that still-focused background element (native button
  // activation isn't stopped by the app's own "suspend shortcuts while a
  // modal is open" keydown guard below - that guard only skips ITS OWN
  // logic, it never calls preventDefault()), silently abandoning whatever
  // this modal was for - see the Golden Touch refund/pending pack offer
  // bug this was written to fix, where exactly that happened.
  modalBox.focus();
}

// Transient (not saved) selection state for the rule-offer modal - which
// rule card is highlighted, and (for Selective Cut) which owned perk is
// picked to be removed. Reset each time the modal is (re)opened.
let selectedRuleId = null;
let selectedPerkToRemoveIndex = null;

// Same idea for the Perk Pack offer modal - which offered perk was clicked
// (only matters once perk slots are full and a replace choice is needed,
// see renderPerkOfferModal()) and which currently-owned perk is picked to
// be replaced by it. Kept separate from the rule-offer pair above even
// though the shape is nearly identical, since the two modals are different
// features that happen to rhyme, not the same one.
let selectedPerkPackId = null;
let selectedPerkPackReplaceIndex = null;
// Ooo Shiny rolls its random removal targets the moment the card itself is
// selected (not at Confirm) so the perk picker can offer only the perks
// that would actually survive. Reset alongside the other selection state.
let oooShinyRemovedPerks = [];

// Rule cards apply the instant they're clicked - no separate Confirm step.
// The one exception is a rule that needs to know WHICH owned perk to
// remove (Selective Cut/Clean Slate/Ooo Shiny): clicking the card first
// reveals a perk-to-remove picker, and it's THAT click (on a perk option)
// that actually applies it.
function renderRuleOfferModal() {
  const flipIn = pendingPackFlipIn;
  pendingPackFlipIn = false;

  modalBox.innerHTML = "";
  modalBox.classList.add("pack-modal");
  modalBox.appendChild(createPackMinimizeBtn());

  const h2 = document.createElement("h2");
  h2.textContent = "Choose a Rule";

  const cardsWrap = document.createElement("div");
  cardsWrap.className = "pack-modal-cards";

  // Clean Slate / Selective Cut remove an owned perk - with no perk cards
  // to sacrifice they'd otherwise just be a free, no-cost payout, so they're
  // disabled (grayed out, unclickable) whenever nothing is actually visible
  // in the perk slots to remove. Ooo Shiny needs one more: it removes perks
  // BEFORE the picker even opens (count scales with how many are owned, see
  // oooShinyRemovalCount), so at least 2 must be owned for its removal count
  // to be non-zero and leave something behind to make shiny.
  //
  // A Perk Shield Token only protects a card from RANDOM destruction - Clean
  // Slate picks its victim blind, same as Ooo Shiny's own removal pool below,
  // so shielded perks are excluded from both. Selective Cut is a deliberate,
  // player-CHOSEN removal instead (the player picks exactly which card to
  // lose, same as The Edict's own mandatory sacrifice - see
  // isEdictDestroyablePerk()) - a shield never protects against that, so it
  // keeps the full, unfiltered scope here.
  const hasCleanSlateTarget = state.perksOwned.some((p) => isSlotOccupyingPerk(p) && !p.shielded);
  const hasSelectiveCutTarget = state.perksOwned.some(isSlotOccupyingPerk);
  // isSlotOccupyingPerk, not a bare !p.persistent check, for the same reason
  // as Clean Slate's own removableIndices above - an owned Extra Perk copy
  // never renders its own card, so it can't be part of "how many perks are
  // even eligible to be randomly destroyed" here either.
  const removableForShiny = state.perksOwned.filter((p) => isSlotOccupyingPerk(p) && !p.shielded).length;

  state.pendingPackOffer.forEach((ruleId) => {
    const rule = RULE_POOL.find((r) => r.id === ruleId);
    const isDisabled = ruleId === "oooShiny"
      ? oooShinyRemovalCount(removableForShiny) < 1
      : ruleId === "cleanSlate"
        ? !hasCleanSlateTarget
        : DESTRUCTIVE_RULE_IDS.includes(ruleId) && !hasSelectiveCutTarget;
    const card = document.createElement("div");
    card.className = "pack-card pack-card-large rule"
      + (DESTRUCTIVE_RULE_IDS.includes(ruleId) ? " destructive" : "")
      + (rule.tint ? ` tint-${rule.tint}` : "")
      + (selectedRuleId === ruleId ? " selected" : "")
      + (isDisabled ? " disabled" : "")
      + (flipIn ? " pack-card-flip-in" : "");
    if (flipIn) clearFlipInOnAnimationEnd(card);
    if (!isDisabled) attachCardTilt(card);

    const icon = document.createElement("div");
    icon.className = "pack-card-icon";
    icon.textContent = ruleCardIcon(rule);
    card.appendChild(icon);

    const name = document.createElement("div");
    name.className = "pack-card-name";
    name.textContent = rule.name;
    card.appendChild(name);

    // Capped-at-1, permanently-owned rule cards (Compound Interest/Third
    // Time's the Charm/Golden Touch) - a 2nd copy was never obtainable to
    // begin with, called out right under the name so that's clear before
    // picking.
    if (UNIQUE_PERMANENT_RULE_IDS.includes(ruleId)) {
      const oneTime = document.createElement("div");
      oneTime.className = "pack-card-one-time";
      oneTime.textContent = "(one time)";
      card.appendChild(oneTime);
    }

    const desc = document.createElement("div");
    desc.className = "pack-card-rule-desc";
    desc.textContent = rule.desc;
    card.appendChild(desc);
    if (isDisabled) {
      const note = document.createElement("div");
      note.className = "pack-card-rule-note";
      note.textContent = ruleId === "oooShiny" ? "Needs 2+ perks" : "No perks to remove";
      card.appendChild(note);
    } else {
      card.addEventListener("click", () => {
        selectedRuleId = ruleId;
        selectedPerkToRemoveIndex = null;
        // Rolled ONCE per offer, the first time Ooo Shiny is ever selected -
        // and never touched again for the rest of it (oooShinyRemovedPerks
        // deliberately isn't cleared when switching to a different card, so
        // reselecting Ooo Shiny later just finds it already non-empty here
        // and skips straight past this). No matter how many times the
        // player reselects it, browses other cards and comes back, or
        // minimizes and reopens the popup (see showPackOfferModal()'s own
        // comment), the same targets stay locked in - otherwise any of those
        // was a free "keep rerolling until I like the preview" button.
        if (ruleId === "oooShiny" && oooShinyRemovedPerks.length === 0) {
          // Shielded perks are never a random destroy target - they still
          // count as survivors eligible to be picked shiny below, though.
          // isSlotOccupyingPerk (not a bare !p.persistent check) also keeps
          // an owned Extra Perk copy out of this pool - same reasoning as
          // removableForShiny's own comment above.
          const removable = state.perksOwned.filter((p) => isSlotOccupyingPerk(p) && !p.shielded);
          const removeCount = oooShinyRemovalCount(removable.length);
          const shuffled = [...removable];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          oooShinyRemovedPerks = shuffled.slice(0, removeCount);
        }
        // Rule cards apply the instant they're clicked - the only exception
        // is a rule that still needs to know WHICH owned perk to remove
        // (Selective Cut/Clean Slate/Ooo Shiny), where clicking the card
        // just reveals that picker below (see needsPerkPick's own
        // computation further down) and picking a perk option is what
        // actually applies it - see that option's own click handler.
        // Selective Cut is a deliberate pick (shielded perks stay eligible -
        // see hasSelectiveCutTarget's own comment above); Ooo Shiny is the
        // only OTHER needsPerkSelection rule reaching here, and its own
        // isDisabled check above already guarantees a non-shielded target
        // exists whenever this is reachable, so excluding shielded here too
        // costs nothing and stays consistent with its random-pool scope.
        const hasRemovablePerk = ruleId === "oooShiny"
          ? state.perksOwned.some((p) => isSlotOccupyingPerk(p) && !p.shielded)
          : state.perksOwned.some(isSlotOccupyingPerk);
        if (rule.needsPerkSelection && hasRemovablePerk) {
          renderRuleOfferModal();
        } else {
          confirmRuleSelection();
        }
      });
    }
    cardsWrap.appendChild(card);
  });

  modalBox.appendChild(h2);
  modalBox.appendChild(cardsWrap);

  const selectedRule = selectedRuleId ? RULE_POOL.find((r) => r.id === selectedRuleId) : null;
  // Rule cards (persistent instances like High Stakes) and Extra Perk copies
  // aren't valid targets - isSlotOccupyingPerk excludes both, it only offers
  // actual owned perks to remove. Same shielded-exclusion split as the click
  // handler above (Selective Cut's deliberate pick stays eligible; Ooo
  // Shiny's random pool doesn't).
  const hasRemovablePerk = selectedRule?.id === "oooShiny"
    ? state.perksOwned.some((p) => isSlotOccupyingPerk(p) && !p.shielded)
    : state.perksOwned.some(isSlotOccupyingPerk);
  const needsPerkPick = !!(selectedRule && selectedRule.needsPerkSelection && hasRemovablePerk);
  // Only while the perk-to-remove picker below is actually showing - that's
  // the one part of this modal whose length tracks the player's whole
  // owned-perk count, not the fixed rule-card offer above it.
  modalBox.classList.toggle("modal-scrollable", needsPerkPick);

  if (needsPerkPick) {
    if (selectedRule.id === "oooShiny" && oooShinyRemovedPerks.length > 0) {
      const removedNote = document.createElement("div");
      removedNote.className = "pack-card-rule-note oooshiny-removed-note";
      const names = oooShinyRemovedPerks.map((p) => p.name).join(", ");
      removedNote.textContent = `Removed: ${names} - choose one of the rest to make shiny:`;
      modalBox.appendChild(removedNote);
    }
    const picker = document.createElement("div");
    picker.className = "rule-perk-picker";
    state.perksOwned.forEach((perk, index) => {
      // Excludes persistent rule cards AND Extra Perk copies (which never
      // render their own card and so can't sensibly be a "make it shiny"
      // pick either, on top of never being a destroy target - see
      // removableForShiny's own comment above).
      if (!isSlotOccupyingPerk(perk)) return;
      if (selectedRule.id === "oooShiny" && oooShinyRemovedPerks.includes(perk)) return;
      // A shielded perk stays fully listed here either way: for Selective
      // Cut it's a valid (deliberate) destroy target same as any other perk
      // (see hasSelectiveCutTarget's own comment above), and for Ooo Shiny
      // it's a valid shiny-survivor pick regardless (never a destroy target
      // there - see the random pool built above, which already excludes it).
      // The shield badge below still marks it either way, purely
      // informational here.
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "rule-perk-option" + (selectedPerkToRemoveIndex === index ? " selected" : "");
      if (perk.shiny) decorateShiny(opt);
      opt.textContent = perk.name + perkXMultTag(perk);
      if (perk.shielded) decorateShielded(opt);
      opt.addEventListener("click", () => {
        selectedPerkToRemoveIndex = index;
        confirmRuleSelection();
      });
      picker.appendChild(opt);
    });
    modalBox.appendChild(picker);
  }

  const skipBtnEl = document.createElement("button");
  skipBtnEl.className = "modal-btn pack-skip-btn";
  skipBtnEl.textContent = "Skip";
  skipBtnEl.addEventListener("click", skipPackOffer);

  // Wrapped in a centered flex row (not just relying on .modal's own
  // text-align) so it's never at the mercy of whatever else that row ends
  // up containing later - see the matching wrapper in showPackOfferModal().
  const btnRow = document.createElement("div");
  btnRow.className = "modal-btn-row";
  btnRow.appendChild(skipBtnEl);
  modalBox.appendChild(btnRow);

  modalOverlay.classList.remove("hidden");
  // Moves focus off whatever background control (rollBtn, a scorecard row,
  // ...) happened to hold it before this opened - modalBox has tabindex="-1"
  // specifically so it can take focus programmatically without joining the
  // normal tab order. Without this, a stray Enter/Space keypress could
  // natively activate that still-focused background element (native button
  // activation isn't stopped by the app's own "suspend shortcuts while a
  // modal is open" keydown guard below - that guard only skips ITS OWN
  // logic, it never calls preventDefault()), silently abandoning whatever
  // this modal was for - see the Golden Touch refund/pending pack offer
  // bug this was written to fix, where exactly that happened.
  modalBox.focus();
}

// Perk Pack offer - same "click a card, apply instantly" shape as the rule
// pack above, except the one-more-click case is "perk slots are full,
// choose which owned one to replace" instead of "which owned one to
// destroy". Mirrors showLevelCompleteModal()'s own choosePerk()/
// renderReplaceStep() logic (same effectivePerkSlotCount()/
// isSlotOccupyingPerk() rules for what counts as "full", same
// perkDeleteRefund() on the replaced copy) so a Perk Pack pick behaves
// identically to a level-up one - it just resolves back into the shop
// instead of advancing to the next level.
function renderPerkOfferModal() {
  const flipIn = pendingPackFlipIn;
  pendingPackFlipIn = false;

  modalBox.innerHTML = "";
  modalBox.classList.add("pack-modal");
  // Only while the replace-a-perk picker below is actually showing (slots
  // full, a non-exempt card was clicked) - that's the one part of this
  // modal whose length tracks the player's whole owned-perk count, not the
  // fixed 2-3 offered cards.
  modalBox.classList.toggle("modal-scrollable", !!selectedPerkPackId);
  modalBox.appendChild(createPackMinimizeBtn());

  const h2 = document.createElement("h2");
  h2.textContent = "Choose a Perk";

  const cardsWrap = document.createElement("div");
  cardsWrap.className = "pack-modal-cards";

  // Fixed at the top of every render (nothing changes it mid-modal, same as
  // showLevelCompleteModal()'s own isFullAtOpen) - whether taking ANY
  // offered card (other than Extra Perk/a shiny copy, neither of which ever
  // need a slot) would need to bump an existing one first.
  const visibleCount = state.perksOwned.filter(isSlotOccupyingPerk).length;
  const slotsFull = visibleCount >= effectivePerkSlotCount();

  state.pendingPackOffer.forEach((perkId) => {
    const def = PERK_POOL.find((p) => p.id === perkId);
    const perk = { ...def, shiny: state.pendingPackShinyKeys.includes(perkId) };
    const card = document.createElement("div");
    card.className = "pack-card pack-card-large perk-choice-card"
      + (perk.tint ? ` tint-${perk.tint}` : "")
      + (selectedPerkPackId === perkId ? " selected" : "")
      + (flipIn ? " pack-card-flip-in" : "");
    if (flipIn) clearFlipInOnAnimationEnd(card, perk.shiny ? () => triggerChromaticSplit(card) : undefined);
    attachCardTilt(card);
    if (perk.shiny) decorateShiny(card);

    const name = document.createElement("div");
    name.className = "pack-card-name";
    name.textContent = perk.name;

    const desc = document.createElement("div");
    desc.className = "pack-card-rule-desc";
    desc.textContent = perk.desc;

    card.appendChild(name);
    card.appendChild(desc);

    const canTakeFreely = perk.id === "extraPerkSlot" || perk.shiny || !slotsFull;
    card.addEventListener("click", () => {
      if (canTakeFreely) {
        confirmPerkPackPick(perk, null);
      } else {
        // Slots full - reveal the replace picker below instead of applying
        // yet (mirrors clicking a needsPerkSelection rule card above).
        selectedPerkPackId = perkId;
        selectedPerkPackReplaceIndex = null;
        renderPerkOfferModal();
      }
    });
    cardsWrap.appendChild(card);
  });

  modalBox.appendChild(h2);
  modalBox.appendChild(cardsWrap);

  if (selectedPerkPackId) {
    const chosenDef = PERK_POOL.find((p) => p.id === selectedPerkPackId);
    const chosenPerk = { ...chosenDef, shiny: state.pendingPackShinyKeys.includes(selectedPerkPackId) };

    const note = document.createElement("div");
    note.className = "pack-card-rule-note";
    note.textContent = `Perk slots full - choose a perk to remove and replace with ${chosenPerk.name}:`;
    modalBox.appendChild(note);

    const picker = document.createElement("div");
    picker.className = "rule-perk-picker";
    // Shiny copies included on purpose (isSlotOccupyingPerk, not
    // isNormalSlotPerk) - same reasoning as showLevelCompleteModal()'s own
    // renderReplaceStep(): a shiny copy's extra slot only exempts it from
    // counting toward "is the board full", not from being tradeable once it
    // already is.
    state.perksOwned.forEach((owned, index) => {
      if (!isSlotOccupyingPerk(owned)) return;
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "rule-perk-option" + (selectedPerkPackReplaceIndex === index ? " selected" : "");
      if (owned.shiny) decorateShiny(opt);
      opt.textContent = owned.name + perkXMultTag(owned);
      if (owned.shielded) decorateShielded(opt);
      opt.addEventListener("click", () => {
        selectedPerkPackReplaceIndex = index;
        confirmPerkPackPick(chosenPerk, index);
      });
      picker.appendChild(opt);
    });
    modalBox.appendChild(picker);
  }

  const skipBtnEl = document.createElement("button");
  skipBtnEl.className = "modal-btn pack-skip-btn";
  skipBtnEl.textContent = "Skip";
  skipBtnEl.addEventListener("click", skipPackOffer);

  const btnRow = document.createElement("div");
  btnRow.className = "modal-btn-row";
  btnRow.appendChild(skipBtnEl);
  modalBox.appendChild(btnRow);

  modalOverlay.classList.remove("hidden");
  modalBox.focus();
}

// Applies the chosen perk - either straight away (room available, or the
// card is exempt from needing room), or after scrapping replaceIndex's
// owned copy first (same refund as a trash-can delete, see
// perkDeleteRefund() - and the same Demolisher growth hook, since that
// refund routes through removePerkInstance() same as every other
// destruction path). Resolves back into the shop, unlike
// showLevelCompleteModal()'s applyAndAdvance() which advances the whole run
// forward - buying a Perk Pack never ends the current shop visit.
function confirmPerkPackPick(perk, replaceIndex) {
  if (replaceIndex != null) {
    const removed = removePerkInstance(replaceIndex);
    if (removed) state.money += perkDeleteRefund(removed);
  }
  const instance = { ...perk };
  perk.apply(state, instance);
  state.perksOwned.push(instance);
  state.pendingPackOffer = null;
  state.pendingPackKind = null;
  state.pendingPackShinyKeys = [];
  state.pendingPackIsMega = false;
  selectedPerkPackId = null;
  selectedPerkPackReplaceIndex = null;
  hideModal();
  flushPendingGoldenTouchCue();
  renderPackShop();
  renderAll();
  saveState();
}

function confirmRuleSelection() {
  if (!selectedRuleId || !state.pendingPackOffer || !state.pendingPackOffer.includes(selectedRuleId)) return;
  const rule = RULE_POOL.find((r) => r.id === selectedRuleId);
  if (!rule) return;

  let coinDieInstance = null;
  if (rule.persistent) {
    const instance = { ...rule };
    rule.apply(state, instance, selectedPerkToRemoveIndex);
    state.perksOwned.push(instance);
    // Suppressed here, before the renderAll() below - not inside
    // playCoinDieRevealAnimation() itself, which doesn't run until after
    // that render has already happened. Painted by hand once the reveal's
    // turn actually lands (see coinDieRevealPendingInstances).
    if (rule.id === "coinDie") {
      coinDieInstance = instance;
      coinDieRevealPendingInstances.add(instance);
    }
  } else {
    rule.apply(state, null, selectedPerkToRemoveIndex);
  }

  state.pendingPackOffer = null;
  state.pendingPackKind = null;
  selectedRuleId = null;
  selectedPerkToRemoveIndex = null;
  oooShinyRemovedPerks = [];
  hideModal();
  flushPendingGoldenTouchCue();
  renderAll();
  saveState();
  // Show the player where the coin landed now that the board (dimmed
  // behind the just-closed modal) is fully visible again - see
  // playCoinDieRevealAnimation().
  if (coinDieInstance) playCoinDieRevealAnimation(coinDieInstance);
}

// The bonus card slots serve double duty: plain white placeholders while a
// small game's "next round" prompt is up, or the 3 persistent Card Pack
// shop slots (each its own pack type, or empty once bought) once they're
// actually available - including while a pack offer is pending, so the 2
// untouched slots stay visible behind the popup modal instead of blanking
// out; only the one just opened is empty (it was already nulled out in
// state.shopSlots the instant it was bought, see openCardPack()).
// Bosses (main phase) never get an actual card-pack shop - there's no
// rollShopSlots()/showNextRoundPrompt() equivalent for it, target-reached-
// early just flips awaitingNextRound on in place (see commitScore()) while
// staying in phase "main". So main phase always renders a single slot, no
// Refresh button, whether or not the boss has been "finished" (target
// reached) yet - never the 3-slot/Refresh shop treatment small games get.
// That one slot offers state.bossUsableOffer (a random USABLE_POOL item,
// pre-rolled a full cycle ahead into nextBossUsableOffer and consumed the
// instant this boss level begins - see startNextLevel()'s small2 -> main
// branch and pickRandomUsableId()) - a plain decorative placeholder once
// it's been bought (state.bossUsableOffer nulled by buyBossUsable()).
function renderPackShop() {
  // Usables' activatable state (see usableActivatable()) depends on shop-
  // related state (phase/awaitingNextRound/pendingPackOffer) that's already
  // settled by the time this runs, never on anything renderPackShop() itself
  // computes - safe to refresh unconditionally right here, before any of
  // this function's several early returns below, rather than duplicating
  // this call at every one of its many call sites (shop open/refresh/buy/
  // resolve/skip) individually.
  renderUsableInventory();
  bonusSlots.innerHTML = "";
  // Consumed immediately (not left set) so only the render right after a
  // fresh shop is rolled (see showNextRoundPrompt()) flips its cards in -
  // any later re-render of this same shop (buying a slot, money changing,
  // a paid Refresh) must not replay the animation on cards that were
  // already sitting there.
  const flipIn = pendingShopFlipIn;
  pendingShopFlipIn = false;

  if (state.phase === "main") {
    refreshPackBtn.classList.add("refresh-pack-btn-hidden");
    const item = USABLE_POOL.find((u) => u.id === state.bossUsableOffer);
    if (!item) {
      const slot = document.createElement("div");
      slot.className = "perk-slot";
      bonusSlots.appendChild(slot);
      return;
    }

    const canAfford = state.money >= item.cost;
    const buyCard = document.createElement("div");
    buyCard.className = "pack-card buy usable" + (canAfford ? "" : " disabled");
    if (canAfford) attachCardTilt(buyCard);

    const name = document.createElement("div");
    name.className = "pack-card-name";
    name.textContent = item.name;

    const price = document.createElement("div");
    price.className = "pack-card-price";
    price.textContent = `$${item.cost}`;

    buyCard.appendChild(name);
    buyCard.appendChild(price);

    const tooltip = document.createElement("div");
    tooltip.className = "perk-tooltip";
    tooltip.textContent = item.desc;
    buyCard.appendChild(tooltip);
    attachClampedTooltip(buyCard, tooltip, bonusSlots);

    if (canAfford) buyCard.addEventListener("click", buyBossUsable);
    bonusSlots.appendChild(buyCard);
    return;
  }

  // Small games: an empty state.shopSlots means nothing's been rolled for
  // this round yet - plain placeholders, same as always. A non-empty one
  // means a shop genuinely exists, even if awaitingNextRound itself is
  // currently false (a Mulligan redo of the final hand mid-progress - see
  // useMulligan(), which deliberately preserves shopSlots across the
  // revert) - keep showing it rather than blanking it back out.
  if (state.shopSlots.length === 0) {
    refreshPackBtn.classList.add("refresh-pack-btn-hidden");
    for (let i = 0; i < effectiveShopSlotCount(); i++) {
      const slot = document.createElement("div");
      slot.className = "perk-slot";
      bonusSlots.appendChild(slot);
    }
    return;
  }

  // Refresh is hidden while a pack offer is pending (it's blocked anyway -
  // see refreshShopSlots()'s own guard) or while a Mulligan redo has left
  // awaitingNextRound false (also blocked - see refreshShopSlots()'s own
  // guard), but the shop slots themselves still render normally below
  // regardless of either.
  if (state.pendingPackOffer || !state.awaitingNextRound) {
    refreshPackBtn.classList.add("refresh-pack-btn-hidden");
  } else {
    refreshPackBtn.classList.remove("refresh-pack-btn-hidden");
  }
  // Free Reroll Token (see activateUsable()/refreshShopSlots()) makes this
  // one Refresh $0 without touching refreshCost itself - the button must
  // still show/charge $0 right now even though the real underlying price
  // (what the NEXT Refresh after this one will cost) hasn't moved.
  const displayedRefreshCost = state.freeRerollActive ? 0 : state.refreshCost;
  refreshPackBtn.textContent = `Refresh ($${displayedRefreshCost})`;
  refreshPackBtn.disabled = state.money < displayedRefreshCost;
  state.shopSlots.forEach((packName, slotIndex) => {
    if (!packName) {
      // Already bought from this slot - a plain empty slot (no white
      // placeholder-fill background), distinct from the "shop not open yet"
      // placeholder above.
      const slot = document.createElement("div");
      slot.className = "perk-slot";
      bonusSlots.appendChild(slot);
      return;
    }

    const packType = CARD_PACK_TYPES.find((t) => t.name === packName);
    const effectivePrice = effectiveCardPackPrice(packType);
    const canAfford = state.money >= effectivePrice;
    // Third Time's the Charm: using its free 2nd reroll locks purchases in
    // the shop right after it, regardless of affordability. A pending pack
    // offer (even minimized - see minimizePackOffer()) blocks the OTHER
    // slots too, not just Refresh above - openCardPack() already refuses a
    // second purchase while one's still unresolved, this just keeps the
    // card from looking clickable when it isn't.
    const purchasable = canAfford && !state.shopPurchasesLocked && !state.pendingPackOffer;
    const buyCard = document.createElement("div");
    buyCard.className = "pack-card buy"
      + (packType.kind === "rule" ? " rule" : "")
      + (packType.kind === "perk" ? " perk" : "")
      + (purchasable ? "" : " disabled")
      + (flipIn ? " pack-card-flip-in" : "");
    if (flipIn) clearFlipInOnAnimationEnd(buyCard);
    if (purchasable) attachCardTilt(buyCard);

    const name = document.createElement("div");
    name.className = "pack-card-name";
    name.textContent = packType.name;

    const price = document.createElement("div");
    price.className = "pack-card-price";
    // "(Sale!)" is reserved for Fire Sale specifically - a genuine temporary
    // markdown event. Bulk Discount is a permanent, always-on lower price
    // (the new normal, not a "sale"), so it lowers the number shown here
    // without ever earning the tag on its own, even though both feed into
    // the same effectivePrice.
    price.textContent = hasFireSale() ? `$${effectivePrice} (Sale!)` : `$${effectivePrice}`;

    buyCard.appendChild(name);
    buyCard.appendChild(price);
    if (state.shopPurchasesLocked) {
      const note = document.createElement("div");
      note.className = "pack-card-rule-note";
      note.textContent = "Shop locked";
      buyCard.appendChild(note);
    }
    if (purchasable) buyCard.addEventListener("click", () => openCardPack(packType, slotIndex));
    bonusSlots.appendChild(buyCard);
  });
}

// Buys the boss shop slot's current Usable offer - the boss-phase
// equivalent of openCardPack(), but far simpler: no reveal modal, no
// contents to pick from, just a straight money-for-item swap.
function buyBossUsable() {
  if (state.phase !== "main" || !state.bossUsableOffer) return;
  const item = USABLE_POOL.find((u) => u.id === state.bossUsableOffer);
  if (!item || state.money < item.cost) return;
  state.money -= item.cost;
  const instance = { id: item.id, instanceId: state.nextUsableInstanceId++ };
  // Multi-charge items (Free Reroll Token) seed their own remaining-uses
  // counter from the pool entry's starting value - see activateUsable().
  // Absent for one-shot items (Boss Skip Token) entirely, same as before.
  if (item.charges != null) instance.charges = item.charges;
  state.usablesOwned.push(instance);
  // Each usable can only ever be bought once per run - permanently excludes
  // this id from every future roll (see pickRandomUsableId()), regardless
  // of whether/when this particular instance later gets fully spent and
  // removed from usablesOwned.
  if (!state.usablesPurchasedIds.includes(item.id)) state.usablesPurchasedIds.push(item.id);
  state.bossUsableOffer = null;
  renderAll();
  saveState();
}

// Resolves however many Sabotage stacks are pending into actual blocked
// categories, one at a time (highest-multiplier first, random tiebreak,
// never repeating a category already picked this call) - using
// categoryBonus/diceCount as they stand at the moment this is called, not
// back when each Sabotage was picked, so buying more multiplier cards
// afterward can't dodge the block. Called right as the main game begins.
function resolveSabotageBlocks(state) {
  const stacks = state.sabotageStacks || 0;
  const blocked = [];
  for (let i = 0; i < stacks; i++) {
    let best = -Infinity;
    let candidates = [];
    ALL_CATS.forEach((cat) => {
      if (blocked.includes(cat.key)) return;
      // The 6-dice-only categories are worthless (and unselectable) below
      // 6 dice, so blocking one would waste the pick on a hand the player
      // couldn't use anyway.
      if (cat.minDice && state.diceCount < cat.minDice) return;
      const m = categoryCardMultiplier(cat.key);
      if (m > best) { best = m; candidates = [cat.key]; }
      else if (m === best) candidates.push(cat.key);
    });
    if (!candidates.length) break; // nothing eligible left to block
    blocked.push(candidates[Math.floor(Math.random() * candidates.length)]);
  }
  return blocked;
}

// Boss rotation: a "shuffle bag" no-repeat guarantee, not pure independent
// randomness (see startNextLevel()'s "main just finished" branch, called
// once a main level concludes) - every boss must be played once before any
// of them can come up again, rather than the same one potentially rolling
// several times in a row while another sits out for a whole run. Takes
// (and returns) plain values rather than reading/writing `state` directly
// so it's trivial to call in isolation, including from newRunState() itself
// (playedBossIds: [], justPlayedIndex: null - the very first roll, where
// nothing is excluded yet).
function advanceBossRotation(playedBossIds, justPlayedIndex) {
  const justPlayedId = justPlayedIndex != null ? MAIN_GAME_MODIFIERS[justPlayedIndex].id : null;
  let played = playedBossIds;
  if (justPlayedId != null && !played.includes(justPlayedId)) played = [...played, justPlayedId];

  let eligible = MAIN_GAME_MODIFIERS.filter((m) => !played.includes(m.id));
  if (eligible.length === 0) {
    // Every boss has now been played - start a fresh bag, but still exclude
    // the one that just concluded so it can never repeat back-to-back right
    // across the seam between one bag and the next.
    played = justPlayedId != null ? [justPlayedId] : [];
    eligible = MAIN_GAME_MODIFIERS.filter((m) => m.id !== justPlayedId);
  }
  const picked = eligible[Math.floor(Math.random() * eligible.length)];
  return { playedBossIds: played, nextIndex: MAIN_GAME_MODIFIERS.indexOf(picked) };
}

function startNextLevel() {
  // A Card Pack offer is still pending (picked or skipped neither happened
  // yet) - never let Next Round/Next Level advance out from under it, even
  // if the popup is currently minimized (see minimizePackOffer()) rather
  // than actually on screen. Every caller that can legitimately reach here
  // while one's open is a small-game "Next Round" trigger (the roll button
  // and its keyboard equivalent) - main-game callers (level-up perk picks,
  // Extra Life) never have a pack offer pending in the first place, so this
  // is a no-op for them. Bring the offer back into view instead of just
  // silently eating the click, so it's obvious why nothing advanced.
  if (state.pendingPackOffer) {
    resumePackOffer();
    return;
  }
  // Defense in depth alongside the loadSavedState() sanitization: self-heal
  // before these are used in arithmetic below, so a bad value can never
  // compound into a permanently NaN target for the rest of the run.
  sanitizeTargetProgression(state);
  // Mulligan: a snapshot from the level that just ended can never be a
  // valid revert target for the new one, even across small1 -> small2
  // (where mulliganUsedThisSmallPair itself carries forward, see below) - a
  // fresh commit in the new level will capture its own snapshot the moment
  // one becomes available again. This lives outside state entirely, so it
  // needs clearing here explicitly rather than resetting for free like
  // state's own fields do.
  mulliganSnapshot = null;
  // Category-lock crack: a fresh level's own already-blocked categories
  // (Sabotage/The Culler) must be captured as the baseline, not read as
  // newly blocked - see previouslyBlockedCategoryKeys' own comment.
  previouslyBlockedCategoryKeys = null;
  // Defense in depth for the same reason as mulliganSnapshot above: if a
  // pack offer somehow made it here still unresolved (pendingPackOffer is
  // about to be wiped by the fresh newRunState() below either way), any
  // Golden Touch refund banked for it must be dropped right here too -
  // otherwise it sits around and gets wrongly flushed alongside some
  // completely unrelated LATER purchase, showing a refund cue for money
  // that (from the player's perspective, at that later point) came from
  // nothing.
  pendingGoldenTouchRefund = null;

  let phase, level, target, nextMainLevel, nextMainTarget, blockedCategoryKeys, sabotageStacks, mainGameModifierIndex, nextMainGameModifierIndex, mulliganUsedThisSmallPair, playedBossIds, bossUsableOffer, nextBossUsableOffer;

  if (state.phase === "small1") {
    phase = "small2";
    level = state.level;
    target = SMALL_GAME_TARGETS.small2;
    nextMainLevel = state.nextMainLevel;
    nextMainTarget = state.nextMainTarget;
    blockedCategoryKeys = state.blockedCategoryKeys;
    sabotageStacks = state.sabotageStacks;
    mainGameModifierIndex = null;
    // Not resolved until the main level it's for actually starts (below) -
    // just carried forward unchanged so the "Next: [boss]" label keeps
    // showing the same boss all the way through both small games.
    nextMainGameModifierIndex = state.nextMainGameModifierIndex;
    // Mulligan: Small Game 1 and Small Game 2 share ONE use between them -
    // carried forward unchanged so using it in small1 actually blocks
    // small2 too, not just resetting fresh every level like every other
    // per-level boss field here.
    mulliganUsedThisSmallPair = state.mulliganUsedThisSmallPair;
    playedBossIds = state.playedBossIds;
    bossUsableOffer = null;
    // Same reasoning as nextMainGameModifierIndex just above - carried
    // forward unchanged so the "Next: [boss]" label's info badge keeps
    // showing the same item all the way through both small games too.
    nextBossUsableOffer = state.nextBossUsableOffer;
  } else if (state.phase === "small2") {
    // Resume wherever the main game's own progression left off - recomputed
    // fresh here (not just carried) so a Steady Nerves/High Stakes pick
    // from either small game still lands on this main level's target.
    phase = "main";
    level = state.nextMainLevel;
    target = computeMainTarget(state, level);
    nextMainLevel = state.nextMainLevel;
    nextMainTarget = target;
    // The main game is starting right now - resolve any pending Sabotage
    // stacks this instant, then the stacks are spent.
    blockedCategoryKeys = resolveSabotageBlocks(state);
    sabotageStacks = 0;
    // Consumes the boss pre-rolled a full cycle ago (see newRunState()/the
    // "main just finished" branch below) instead of rolling fresh here -
    // that's what let the "Next: [boss]" label know it in advance.
    mainGameModifierIndex = state.nextMainGameModifierIndex;
    nextMainGameModifierIndex = mainGameModifierIndex; // irrelevant during "main" itself - re-rolled for real once the next cycle's small1 begins
    mulliganUsedThisSmallPair = state.mulliganUsedThisSmallPair; // irrelevant during "main" itself (it has its own separate mulliganUsedThisBoss) - carried through harmlessly
    playedBossIds = state.playedBossIds; // not updated until the main game this boss belongs to actually concludes - see the "main just finished" branch below
    // Same consume-what-was-pre-rolled pattern as mainGameModifierIndex
    // just above.
    bossUsableOffer = state.nextBossUsableOffer;
    nextBossUsableOffer = bossUsableOffer; // irrelevant during "main" itself - re-rolled for real once the next cycle's small1 begins
  } else {
    // A main level just finished: loop back through both small games before
    // the next main level, remembering that next level/target for later.
    // Sabotage's block(s) only ever cover one main game, so it's spent here.
    phase = "small1";
    level = state.level;
    target = SMALL_GAME_TARGETS.small1;
    nextMainLevel = state.level + 1;
    nextMainTarget = computeMainTarget(state, nextMainLevel);
    blockedCategoryKeys = [];
    sabotageStacks = 0;
    mainGameModifierIndex = null;
    // Mulligan: a fresh Small Game 1/2 pair starting now gets its own new
    // shared use, regardless of whether the just-finished pair spent theirs.
    mulliganUsedThisSmallPair = false;
    // Roll the NEXT cycle's boss right away, a full two small games ahead
    // of when it'll actually matter - see the "Next: [boss]" label
    // (renderNextBossLabel()), which is the entire point of doing this
    // early instead of waiting for the small2 -> main transition like
    // mainGameModifierIndex itself still does. Folds the boss that just
    // concluded (state.mainGameModifierIndex, still the OLD state at this
    // point) into playedBossIds and excludes every already-played boss from
    // the roll - see advanceBossRotation()'s own comment for the shuffle-bag
    // guarantee this gives (every boss once before any repeat).
    const rotation = advanceBossRotation(state.playedBossIds, state.mainGameModifierIndex);
    playedBossIds = rotation.playedBossIds;
    nextMainGameModifierIndex = rotation.nextIndex;
    bossUsableOffer = null;
    // Same "pre-roll a cycle ahead" reasoning as nextMainGameModifierIndex
    // just above - see pickRandomUsableId()'s own comment. Excludes
    // whatever's been bought so far this run (state.usablesPurchasedIds),
    // including anything bought during the boss level that just concluded.
    nextBossUsableOffer = pickRandomUsableId(state.usablesPurchasedIds);

    // Savings Bond matures after SAVINGS_BOND_MATURITY_GAMES main games -
    // tick every owned bond's counter now (a main game just concluded) and
    // pay out + remove any that just hit that mark.
    state.perksOwned = state.perksOwned.filter((p) => {
      if (p.id !== "savingsBond") return true;
      p.mainGamesElapsed = (p.mainGamesElapsed || 0) + 1;
      if (p.mainGamesElapsed < SAVINGS_BOND_MATURITY_GAMES) return true;
      state.money += (p.lockedAmount || 0) * 2;
      return false; // matured - remove it
    });

    // The main game that just finished is one of Make it count's 3 games.
    tickMakeItCount();

    // Compound Interest pays out once every boss (main game) cleared, not
    // every shop - the balance it reads is whatever's left after Savings
    // Bond's own payout above has already landed.
    if (state.perksOwned.some((p) => p.id === "compoundInterest")) {
      state.money += Math.floor(state.money / COMPOUND_INTEREST_STEP) * COMPOUND_INTEREST_PER_STEP;
    }

    // Third Time's the Charm: the boss that just concluded is exactly the
    // "next Boss" its own desc refers to - if an earlier shop (this pair's,
    // or one even further back) reached the discount and armed this, queue
    // up 2 locked shop presentations (this fresh small1's own, then
    // small2's own) rather than locking anything during the run-up to the
    // boss itself. showNextRoundPrompt() is what actually drains this back
    // down, one shop at a time.
    if (state.thirdTimesCharmPendingBossLock) {
      state.thirdTimesCharmLocksRemaining = 2;
      state.thirdTimesCharmPendingBossLock = false;
    }
  }

  const carry = {
    phase,
    level,
    target,
    nextMainLevel,
    nextMainTarget,
    blockedCategoryKeys,
    sabotageStacks,
    mainGameModifierIndex,
    nextMainGameModifierIndex,
    mulliganUsedThisSmallPair,
    playedBossIds,
    bossUsableOffer,
    nextBossUsableOffer,
    bonusRerolls: state.bonusRerolls,
    wildIndices: state.wildIndices,
    scoreMultiplier: state.scoreMultiplier,
    bonusPoints: state.bonusPoints,
    smallGameTurnLimit: state.smallGameTurnLimit,
    perksOwned: state.perksOwned,
    perkSlotOrder: state.perkSlotOrder,
    nextPerkInstanceId: state.nextPerkInstanceId,
    usablesOwned: state.usablesOwned,
    nextUsableInstanceId: state.nextUsableInstanceId,
    usablesPurchasedIds: state.usablesPurchasedIds,
    money: state.money,
    categoryBonus: state.categoryBonus,
    // Lucky Skip's permanently-banked Shiny/Boosted/Mega bonus (see
    // LUCKY_SKIP_BONUS_PER_STACK) - a whole-run resource exactly like money/
    // categoryBonus above, not a per-level one, so it must survive this
    // rebuild too. Missing from here previously meant it silently reset to
    // 0 on every phase transition (small1->small2, small2->main, and
    // main->small1) even though Lucky Skip itself stayed owned the whole
    // time via perksOwned below - the bonus just kept getting wiped out from
    // under it.
    luckySkipBonus: state.luckySkipBonus,
    // Third Time's the Charm: both must survive every phase transition
    // undisturbed - a lock armed in one shop needs to still be pending once
    // the next boss concludes (see this function's own "main just finished"
    // branch above, the only place that touches pendingBossLock), and an
    // active countdown needs to keep draining across shop-to-shop
    // transitions too (showNextRoundPrompt() is what actually consumes it).
    thirdTimesCharmPendingBossLock: state.thirdTimesCharmPendingBossLock,
    thirdTimesCharmLocksRemaining: state.thirdTimesCharmLocksRemaining,
    // Bank the game/level that just finished now, at the transition point -
    // not in endLevel(), which runs while the old scorecard (and its score)
    // is still live, which would double-count it against completedLevelsTotal.
    // Only main games count toward it - small games are a resource-gathering
    // warmup with no target of their own (see endLevel()), so their score
    // doesn't feed the run's grand total either.
    completedLevelsTotal: state.phase === "main"
      ? state.completedLevelsTotal + currentTotalScore()
      : state.completedLevelsTotal,
  };
  // The Thief: steals exactly 1 die for the whole level it's active,
  // restored the instant it ends - checked here (not via a live-recomputed
  // helper like turnLimit()'s Hourglass check) because it has to change how
  // many dice newRunState() below actually builds, not just a number read
  // elsewhere. `mainGameModifierIndex` (still a local var - not yet on
  // `state`) is the boss the level about to start has; `state.mainGameModifierIndex`
  // (the OLD state, about to be discarded) is the boss whichever level just
  // ended had - only one of the two branches below can ever fire in a given
  // call, since a level can't simultaneously be starting and ending.
  let diceCountForNewLevel = state.diceCount;
  if (MAIN_GAME_MODIFIERS[state.mainGameModifierIndex]?.id === "theThief") {
    diceCountForNewLevel += 1; // The Thief's level just ended - give the die back
  }
  if (MAIN_GAME_MODIFIERS[mainGameModifierIndex]?.id === "theThief") {
    diceCountForNewLevel = Math.max(1, diceCountForNewLevel - 1); // a fresh level with The Thief - steal one
  }
  state = newRunState(diceCountForNewLevel);
  Object.assign(state, carry);
  // The Censor: a fresh main level with this boss always starts with
  // exactly one eligible perk already silenced, rather than waiting for
  // the first hand to be committed - done before renderAll() below so the
  // very first render already reflects it. Must run BEFORE
  // rerollDoubleTarget() right below, not after - state.bossBlockedPerkInstanceId
  // is still null at this point (a fresh per-level field, not carried
  // forward), so if a target got rerolled first, activePerksOwned() would
  // count a Hotline/All Luck copy that's about to be silenced as still
  // active, banking one extra doubleTargets entry that wouldn't self-correct
  // until the level's first hand was actually committed.
  if (activeBossModifier()?.id === "theCensor") pickNewCensorTarget();
  rerollDoubleTarget();
  // The Void: unlike the other per-level boss setup here, its blocked face
  // isn't rolled automatically - the player rolls it themselves via
  // renderVoidRollModal() below, alongside The Edict's forced choice.
  // The Culler: its removal + every-other-category boost only ever fires
  // once, right as the level begins - must run before refreshGatekeeperBlocks()
  // below so a freshly Culled category can never also get Gatekeeper-blocked
  // for turn 1 (its own blockedCategoryKeys entry already excludes it there).
  applyCullerEffect();
  // The Gatekeeper: picks its first turn's 3 blocked categories the same way
  // any later turn does (see commitScore()'s turn-advance block).
  refreshGatekeeperBlocks();
  // The Landlord: turn 1's rent is due the instant the level begins.
  chargeLandlordRent();
  hideModal();
  // Reset right before the render that could trigger a fresh sweep, then
  // check it right after - see situationalSweepStartedAt's own comment for
  // why this (not situationalSweepEl's "sweeping" class) is the reliable
  // way to tell "this render just kicked off a sweep" apart from an
  // earlier one's cleanup timer simply not having fired yet.
  situationalSweepStartedAt = null;
  renderAll();
  // A fresh boss level (not a small game) just began. If that same render
  // just kicked off a Situational sweep, the sweep-curtain is still mid-
  // flight right now - hold the shake/reveal (and The Void's roll popup,
  // below) off until the curtain has fully covered the screen (the sweep's
  // own midpoint), rather than firing them immediately underneath it while
  // it's still only partway across.
  const sweepCoverDelay = state.phase === "main" && situationalSweepStartedAt !== null
    ? SITUATIONAL_SWEEP_DURATION / 2
    : 0;
  if (state.phase === "main") {
    if (sweepCoverDelay > 0) {
      setTimeout(() => {
        triggerBossArrivalSlam(activeBossModifier()?.category);
        triggerScorecardReveal();
      }, sweepCoverDelay);
    } else {
      triggerBossArrivalSlam(activeBossModifier()?.category);
      triggerScorecardReveal();
    }
  }
  rollBtn.focus();
  saveState();

  // The Edict: a fresh main level with this boss active demands its
  // mandatory pre-throw choice before anything else can happen - shown
  // right after the normal render above so it appears on top of (and
  // blocks) the board it's about to partially lock out. A no-op if there's
  // nothing owned to destroy this level.
  if (activeBossModifier()?.id === "theEdict" && state.perksOwned.some(isEdictDestroyablePerk)) {
    renderEdictPicker();
  }
  // The Void: same forced-modal treatment as The Edict above, except also
  // held behind the same sweep-cover delay as the shake/reveal - popping
  // this up while the curtain is still sweeping across would show it, then
  // immediately cover it again a moment later.
  if (activeBossModifier()?.id === "theVoid" && state.voidBlockedFace == null) {
    if (sweepCoverDelay > 0) {
      setTimeout(renderVoidRollModal, sweepCoverDelay);
    } else {
      renderVoidRollModal();
    }
  }
}

function restartRun() {
  state = newRunState();
  // Same reasoning as startNextLevel()'s own reset - see there.
  pendingGoldenTouchRefund = null;
  hideModal();
  renderAll();
  rollBtn.focus();
  saveState();
}

// ---------- Modals ----------

function hideModal() {
  modalOverlay.classList.add("hidden");
  modalBox.innerHTML = "";
  modalBox.classList.remove("pack-modal");
  modalBox.classList.remove("danger-confirm");
  modalBox.classList.remove("perk-choice-modal");
  modalBox.classList.remove("perk-choice-morphing");
  modalBox.classList.remove("void-roll-modal");
  modalBox.classList.remove("modal-scrollable");
  // Defensive, not load-bearing for the normal minimize/resume flow (which
  // manages this itself) - covers any other path that closes the modal
  // (restartRun(), startNextLevel()'s own reset) while a pack offer happens
  // to be sitting minimized, so the banner never outlives what it points to.
  packOfferBanner.classList.add("hidden");
}

// Durations for the perk-pick flourish (see playChoicePickAnimation()
// inside showLevelCompleteModal()) - the chosen card's morph-into-slot
// clone animation, then the remaining cards' fade-and-swipe-up.
const PERK_CHOICE_MORPH_MS = 800;
const PERK_CHOICE_FADE_MS = 400;

function showLevelCompleteModal(total) {
  state.gameOver = true;
  renderControls();

  // When perk slots are full, Extra Perk is guaranteed to be one of the 3 -
  // it's the one pick that never requires trashing anything, so the player
  // always has a way to gain a perk without giving one up. Fullness is
  // fixed at modal-open time (nothing changes it mid-modal), so it's safe
  // to compute once and reuse for every reroll too.
  const visibleCountAtOpen = state.perksOwned.filter(isSlotOccupyingPerk).length;
  const isFullAtOpen = visibleCountAtOpen >= effectivePerkSlotCount();

  function rollOptions() {
    const sampled = samplePerks(state, 3);
    if (isFullAtOpen && !sampled.some((p) => p.id === "extraPerkSlot")) {
      sampled[Math.floor(Math.random() * sampled.length)] = PERK_POOL.find((p) => p.id === "extraPerkSlot");
    }
    // Each offered card independently has a small chance of being shiny.
    // Wrapped in a shallow copy (not mutating the canonical PERK_POOL
    // entry, which is shared/reused everywhere) - applyAndAdvance() spreads
    // this same object into the owned instance, so the flag carries through
    // automatically if picked.
    return sampled.map((perk) => (Math.random() < effectiveShinyChance() ? { ...perk, shiny: true } : perk));
  }

  // Not const - re-rolling (see renderChoiceStep) replaces this with a
  // fresh sample. Clicking "Back" out of the replace-a-perk step still
  // returns to whatever this currently holds, not a fresh reroll.
  let options = rollOptions();

  const currentStageName =
    state.phase === "small1" ? "Small Game 1" :
    state.phase === "small2" ? "Small Game 2" :
    `Level ${state.level}`;
  const nextStageName =
    state.phase === "small1" ? "Small Game 2" :
    state.phase === "small2" ? "the main game" :
    `level ${state.level + 1}`;

  // Each owned copy is its own instance (not a shared PERK_POOL reference)
  // so per-copy data like Head Start's appliedAmount can live on it -
  // needed to reverse exactly what this copy did if it's ever deleted,
  // regardless of what other perks are owned by then.
  function applyAndAdvance(perk) {
    const instance = { ...perk };
    perk.apply(state, instance);
    state.perksOwned.push(instance);
    startNextLevel();
  }

  // Picking a perk (not the "replace a full slot" flow) plays a short
  // 2-stage flourish before the level actually advances: the chosen card
  // morphs from its spot in the popup into its real perk-slot position via
  // a floating clone (the real card is about to be destroyed by the next
  // render, so it can't be animated directly), then the remaining cards
  // swipe up and fade before the level genuinely advances. Extra Perk never
  // gets its own visible perk-slot card (it only raises capacity - see
  // isSlotOccupyingPerk()), so there's nothing to morph into for it; it
  // skips straight to the fade-out stage.
  function playChoicePickAnimation(perk, cardEl, onDone) {
    const others = [...cardEl.parentElement.children].filter((el) => el !== cardEl);

    function fadeThenDone(cards) {
      cards.forEach((el) => el.classList.add("perk-choice-card-fade-out"));
      setTimeout(onDone, PERK_CHOICE_FADE_MS);
    }

    const targetEl = perk.id === "extraPerkSlot"
      ? null
      : [...perkSlots.children].find((el) => !el.classList.contains("perk-card")) || perkSlots.lastElementChild;

    if (!targetEl) {
      // Nothing to morph into - the chosen card fades out along with the
      // other two instead of just sitting there while they leave.
      fadeThenDone([cardEl, ...others]);
      return;
    }

    const fromRect = cardEl.getBoundingClientRect();
    const toRect = targetEl.getBoundingClientRect();
    cardEl.style.visibility = "hidden"; // the clone below takes over visually
    // Fade the rest of the popup out behind the morphing clone (which lives
    // outside modalBox, so this doesn't touch it) so the morph reads as the
    // clear focal point instead of competing with the other cards/buttons.
    modalBox.classList.add("perk-choice-morphing");

    const clone = document.createElement("div");
    clone.className = "perk-choice-morph-clone";
    clone.textContent = perk.name;
    clone.style.left = `${fromRect.left}px`;
    clone.style.top = `${fromRect.top}px`;
    clone.style.width = `${fromRect.width}px`;
    clone.style.height = `${fromRect.height}px`;
    document.body.appendChild(clone);

    requestAnimationFrame(() => {
      clone.classList.add("perk-choice-morph-clone-shrink");
      clone.style.left = `${toRect.left}px`;
      clone.style.top = `${toRect.top}px`;
      clone.style.width = `${toRect.width}px`;
      clone.style.height = `${toRect.height}px`;
    });

    setTimeout(() => {
      clone.remove();
      fadeThenDone(others);
    }, PERK_CHOICE_MORPH_MS);
  }

  function choosePerk(perk, cardEl) {
    const visibleCount = state.perksOwned.filter(isSlotOccupyingPerk).length;
    const full = visibleCount >= effectivePerkSlotCount();
    // Extra Perk always fits - it's what makes room for the next pick, so
    // it never needs to bump anything to be taken. A shiny pick always
    // fits too, for the same reason: it brings its own extra slot (see
    // effectivePerkSlotCount()'s shinyCopies) rather than occupying one of
    // the existing ones, so "slots full" can never actually be true for it.
    if (perk.id === "extraPerkSlot" || perk.shiny || !full) {
      // Block further picks/reroll/skip mid-animation - the cards
      // themselves get their own pointer-events:none once faded (see
      // .perk-choice-card-fade-out), this covers the still-visible ones.
      modalBox.querySelectorAll("button").forEach((btn) => { btn.disabled = true; });
      playChoicePickAnimation(perk, cardEl, () => applyAndAdvance(perk));
    } else {
      renderReplaceStep(perk);
    }
  }

  function renderChoiceStep() {
    modalBox.innerHTML = "";
    modalBox.classList.add("perk-choice-modal");
    modalBox.classList.remove("modal-scrollable"); // in case "Back" brought us here from renderReplaceStep()'s own scrollable list
    const h2 = document.createElement("h2");
    h2.textContent = `${currentStageName} Complete!`;
    const p = document.createElement("p");
    p.textContent = `You scored ${total} (target was ${state.target}). Choose a perk to carry into ${nextStageName}:`;

    const optWrap = document.createElement("div");
    optWrap.className = "perk-options perk-choice-options";

    options.forEach((perk) => {
      const card = document.createElement("div");
      card.className = "pack-card pack-card-large perk-choice-card pack-card-flip-in" + (perk.tint ? ` tint-${perk.tint}` : "");
      // Timed off the flip-in's own animationend, not fired right at
      // insertion - see the matching comment in showPackOfferModal().
      clearFlipInOnAnimationEnd(card, perk.shiny ? () => triggerChromaticSplit(card) : undefined);
      attachCardTilt(card);
      if (perk.shiny) decorateShiny(card);

      const name = document.createElement("div");
      name.className = "pack-card-name";
      name.textContent = perk.name;

      const desc = document.createElement("div");
      desc.className = "pack-card-rule-desc";
      desc.textContent = perk.desc;

      card.appendChild(name);
      card.appendChild(desc);
      card.addEventListener("click", () => choosePerk(perk, card));
      optWrap.appendChild(card);
    });

    const rerollBtnEl = document.createElement("button");
    rerollBtnEl.className = "refresh-pack-btn perk-reroll-btn";
    rerollBtnEl.textContent = `Reroll ($${PERK_REROLL_COST})`;
    rerollBtnEl.disabled = state.money < PERK_REROLL_COST;
    rerollBtnEl.addEventListener("click", () => {
      if (state.money < PERK_REROLL_COST) return;
      state.money -= PERK_REROLL_COST;
      options = rollOptions();
      renderStats();
      renderChoiceStep();
      saveState();
    });

    const skipBtnEl = document.createElement("button");
    skipBtnEl.className = "modal-btn pack-skip-btn";
    skipBtnEl.textContent = "Skip";
    skipBtnEl.addEventListener("click", () => startNextLevel());

    modalBox.appendChild(h2);
    modalBox.appendChild(p);
    const ownedSummary = buildOwnedPerksSummary();
    if (ownedSummary) modalBox.appendChild(ownedSummary);
    modalBox.appendChild(optWrap);
    modalBox.appendChild(rerollBtnEl);
    modalBox.appendChild(skipBtnEl);
  }

  // Perk slots are full and this pick isn't Extra Perk - let the player
  // scrap one of their current perks to make room, same refund ($3) as
  // dragging a card into the trash, before the new perk is applied. They
  // can also back out entirely from right here (Skip) instead of only
  // being able to back out via the choice step's own Skip button.
  function renderReplaceStep(perk) {
    modalBox.innerHTML = "";
    // Back on the narrow-list layout, not the wide 3-cards-in-a-row one.
    modalBox.classList.remove("perk-choice-modal");
    // This list is exactly as long as the player's whole owned-perk count -
    // caps the popup's height and scrolls internally once it runs past the
    // viewport, same as the wide offer step already does via its own
    // .perk-choice-modal (see .modal-scrollable for why this is a separate
    // class instead of reusing that one directly).
    modalBox.classList.add("modal-scrollable");
    const h2 = document.createElement("h2");
    h2.textContent = "Perk Slots Full";
    const p = document.createElement("p");
    p.textContent = `Choose a perk to remove and replace with ${perk.name}, or skip instead:`;

    const optWrap = document.createElement("div");
    optWrap.className = "perk-options";

    // Shiny copies are deliberately included here (isSlotOccupyingPerk, not
    // isNormalSlotPerk) - a shiny copy's extra slot only exempts it from
    // COUNTING toward "is the board full", not from being a valid trade-away
    // candidate once it already is. Excluding it entirely would hide it from
    // this decision altogether, with no other way to tell it apart from an
    // identical non-shiny copy sitting right next to it.
    state.perksOwned
      .filter(isSlotOccupyingPerk)
      .forEach((owned) => {
        const btn = document.createElement("button");
        btn.className = "perk-option" + (owned.tint ? ` tint-${owned.tint}` : "");
        // Shiny copies get the same glow-line shimmer as everywhere else
        // (.perk-option.shiny is already styled for exactly this - it just
        // wasn't being applied here), and every X-mult perk shows its own
        // current contribution right in the name - two copies of the same
        // growing card (Demolisher, Skipper, ...) can otherwise look like
        // identical picks despite having grown to very different amounts.
        if (owned.shiny) decorateShiny(btn);
        btn.innerHTML = `<strong>${owned.name}${perkXMultTag(owned)}</strong>${owned.desc}`;
        if (owned.shielded) decorateShielded(btn);
        btn.addEventListener("click", () => renderConfirmReplaceStep(perk, owned));
        optWrap.appendChild(btn);
      });

    const backBtn = document.createElement("button");
    backBtn.className = "modal-btn pack-skip-btn";
    backBtn.textContent = "Back";
    backBtn.addEventListener("click", renderChoiceStep);

    const skipBtnEl = document.createElement("button");
    skipBtnEl.className = "modal-btn pack-skip-btn";
    skipBtnEl.textContent = "Skip";
    skipBtnEl.addEventListener("click", () => startNextLevel());

    modalBox.appendChild(h2);
    modalBox.appendChild(p);
    modalBox.appendChild(optWrap);
    modalBox.appendChild(backBtn);
    modalBox.appendChild(skipBtnEl);
  }

  // One last "are you sure" before the swap actually happens - the modal
  // background flips red as a plain visual warning that this is destructive
  // (owned is gone for good, refunded like a trash-can deletion).
  function renderConfirmReplaceStep(perk, owned) {
    modalBox.innerHTML = "";
    modalBox.classList.add("danger-confirm");
    modalBox.classList.remove("modal-scrollable"); // a short one-line confirmation, never needs it
    const h2 = document.createElement("h2");
    h2.textContent = "Are You Sure?";
    const p = document.createElement("p");
    p.textContent = `Are you sure you want to replace "${owned.name}${perkXMultTag(owned)}" with "${perk.name}${perkXMultTag(perk)}"?`;

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "modal-btn danger-confirm-btn";
    confirmBtn.textContent = "Confirm";
    confirmBtn.addEventListener("click", () => {
      // Looked up by object reference, not instanceId - instanceId is only
      // backfilled lazily (in syncPerkSlotOrder, via renderPerks), so it
      // can't be relied on to already be set/unique here.
      const index = state.perksOwned.indexOf(owned);
      const removed = removePerkInstance(index);
      if (removed) state.money += perkDeleteRefund(removed);
      modalBox.classList.remove("danger-confirm");
      applyAndAdvance(perk);
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-btn pack-skip-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      modalBox.classList.remove("danger-confirm");
      renderReplaceStep(perk);
    });

    modalBox.appendChild(h2);
    modalBox.appendChild(p);
    modalBox.appendChild(confirmBtn);
    modalBox.appendChild(cancelBtn);
  }

  renderChoiceStep();
  modalOverlay.classList.remove("hidden");
  // Moves focus off whatever background control (rollBtn, a scorecard row,
  // ...) happened to hold it before this opened - modalBox has tabindex="-1"
  // specifically so it can take focus programmatically without joining the
  // normal tab order. Without this, a stray Enter/Space keypress could
  // natively activate that still-focused background element (native button
  // activation isn't stopped by the app's own "suspend shortcuts while a
  // modal is open" keydown guard below - that guard only skips ITS OWN
  // logic, it never calls preventDefault()), silently abandoning whatever
  // this modal was for - see the Golden Touch refund/pending pack offer
  // bug this was written to fix, where exactly that happened.
  modalBox.focus();
  // rollBtn typically still holds keyboard focus from just before this
  // modal opened (it's what got clicked/Entered to reach here), and gets
  // disabled right above (renderControls(), since state.gameOver is now
  // true) - but disabling a focused element doesn't reliably clear focus on
  // its own, so without this, native Enter/Space could still re-fire its
  // click handler. Since state.awaitingNextRound is still true, that calls
  // endLevel() again and rebuilds this whole modal from scratch with a
  // fresh perk sample - looks exactly like an unwanted reroll. Moving focus
  // onto the modal box itself (tabindex="-1" in the HTML - a plain div
  // isn't programmatically focusable without one) sidesteps the question
  // entirely: it's not a button, so Enter/Space on it does nothing. The
  // global keydown handler deliberately steps aside while a modal is open
  // (see its own comment) rather than fighting over this.
  modalBox.focus();
  saveState();
}

// The Edict's mandatory pre-throw choice - which eligible owned perk to
// silence for the entire level. No skip/cancel button and no backdrop
// close handler (modalOverlay has none of its own - see showPackOfferModal
// etc.), so the only way out is actually picking one.
function renderEdictPicker() {
  modalBox.innerHTML = "";
  modalBox.classList.add("perk-choice-modal");

  const h2 = document.createElement("h2");
  h2.textContent = "The Edict Demands a Sacrifice";
  const p = document.createElement("p");
  p.textContent = "Choose one owned perk to destroy - it's gone for the rest of the run:";

  const optWrap = document.createElement("div");
  optWrap.className = "perk-options perk-choice-options";

  // Any owned perk is eligible (unlike The Censor's silencing, which is
  // scoped to BOSS_BLOCKABLE_PERK_IDS to avoid reversing a permanent-stat
  // perk's effect just for a hand/level) - destroying one runs it through
  // removePerkInstance()'s own remove() reversal, the same safe path
  // already used for a voluntary trash, so nothing needs to be excluded on
  // that front. See isEdictDestroyablePerk() for the one thing that is
  // still left out (Extra Perk).
  state.perksOwned.filter(isEdictDestroyablePerk).forEach((perk) => {
    const card = document.createElement("div");
    card.className = "pack-card pack-card-large perk-choice-card" + (perk.tint ? ` tint-${perk.tint}` : "");
    attachCardTilt(card);
    // Same glow-line shimmer as every other owned-perk list (see
    // renderReplaceStep()) - without it, a shiny copy up for sacrifice here
    // looked identical to a normal one, with no way to tell which is which
    // before destroying it.
    if (perk.shiny) decorateShiny(card);
    // A shielded perk is still a fully valid (and, once picked, guaranteed)
    // sacrifice here - see isEdictDestroyablePerk()'s own comment - the
    // badge is purely informational, same as everywhere else it shows up.
    if (perk.shielded) decorateShielded(card);

    const name = document.createElement("div");
    name.className = "pack-card-name";
    name.textContent = perk.name;

    const desc = document.createElement("div");
    desc.className = "pack-card-rule-desc";
    desc.textContent = perk.desc;

    card.appendChild(name);
    card.appendChild(desc);
    // Same top-center badge as the perk slots (renderPerks()) - two copies
    // of a growing X-mult card (Demolisher/Skipper/...) otherwise look like
    // an identical choice despite having grown to very different amounts.
    // Always the real current value here (not gated by xMultBadgeIsActive
    // the way the live slot badge is) - this is a one-off destroy decision,
    // not an in-the-moment "is it contributing right now" readout.
    if (typeof perk.xMult !== "undefined") {
      const multBadge = document.createElement("div");
      multBadge.className = "perk-card-xmult-badge";
      multBadge.textContent = `+${resolveXMult(perk, state)}x`;
      card.appendChild(multBadge);
    }
    card.addEventListener("click", () => {
      const index = state.perksOwned.indexOf(perk);
      removePerkInstance(index, { animate: false });
      state.edictSacrificeResolved = true;
      hideModal();
      renderAll();
      rollBtn.focus();
      saveState();
    });
    optWrap.appendChild(card);
  });

  modalBox.appendChild(h2);
  modalBox.appendChild(p);
  modalBox.appendChild(optWrap);
  modalOverlay.classList.remove("hidden");
  // Moves focus off whatever background control (rollBtn, a scorecard row,
  // ...) happened to hold it before this opened - modalBox has tabindex="-1"
  // specifically so it can take focus programmatically without joining the
  // normal tab order. Without this, a stray Enter/Space keypress could
  // natively activate that still-focused background element (native button
  // activation isn't stopped by the app's own "suspend shortcuts while a
  // modal is open" keydown guard below - that guard only skips ITS OWN
  // logic, it never calls preventDefault()), silently abandoning whatever
  // this modal was for - see the Golden Touch refund/pending pack offer
  // bug this was written to fix, where exactly that happened.
  modalBox.focus();
}

// The Void: a fresh main level with this boss can't proceed to a real
// throw until the player rolls this one standalone die - whatever face it
// lands on becomes state.voidBlockedFace for the rest of the level. Reuses
// the same cube markup/geometry (die-scene/die-cube/die-face, FACE_ROTATION,
// computeTumbleAngle) as the real dice tray purely for the visual tumble,
// but is otherwise entirely disconnected from it - own DOM element, own
// rotation state, never touches state.dice/rollsUsedThisTurn/wildIndices,
// same as the old auto-rolled version this replaced. state.voidBlockedFace
// itself is set the instant Roll is clicked (so it's already correct for
// any logic that reads it), but the "Blocked face: N" reveal and the
// button's flip to Continue are both held back until the tumble animation
// actually finishes, via the same totalDuration the animation itself uses.
function renderVoidRollModal() {
  modalBox.innerHTML = "";
  modalBox.classList.add("void-roll-modal");

  const h2 = document.createElement("h2");
  h2.textContent = "The Void Awaits";
  const p = document.createElement("p");
  p.textContent = "Roll one die - whatever face it lands on comes up blank everywhere for the rest of the level.";

  const sceneWrap = document.createElement("div");
  sceneWrap.className = "void-roll-die-wrap";
  const scene = document.createElement("div");
  scene.className = "die-scene void-roll-die";
  const cube = document.createElement("div");
  cube.className = "die-cube";
  Object.entries(FACE_VALUE_BY_POSITION).forEach(([position, value]) => {
    cube.appendChild(createDieFace(position, value));
  });
  cube.style.transform = "rotateX(0deg) rotateY(0deg)";
  scene.appendChild(cube);
  sceneWrap.appendChild(scene);

  const resultLabel = document.createElement("div");
  resultLabel.className = "void-roll-result";

  const actionBtn = document.createElement("button");
  actionBtn.className = "modal-btn void-roll-btn";
  actionBtn.textContent = "Roll";
  actionBtn.addEventListener("click", () => {
    if (state.voidBlockedFace != null) {
      // Second click, now labeled Continue - the roll already happened.
      hideModal();
      renderAll();
      rollBtn.focus();
      saveState();
      return;
    }

    const value = 1 + Math.floor(Math.random() * 6);
    state.voidBlockedFace = value;
    // Disabled for the length of the tumble so a second click can't slip
    // through the "Continue" branch above (voidBlockedFace is already set
    // by this point) before the die has actually finished landing.
    actionBtn.disabled = true;

    const target = FACE_ROTATION[value];
    const totalDuration = 1.5 + Math.random() * 0.2;
    scene.classList.remove("bouncing");
    void scene.offsetWidth; // restart the bounce animation
    scene.style.animationDuration = totalDuration + "s";
    scene.classList.add("bouncing");
    const finalRotation = {
      x: computeTumbleAngle(0, target.x),
      y: computeTumbleAngle(0, target.y),
    };
    cube.style.transitionDuration = totalDuration + "s";
    cube.style.transform = `rotateX(${finalRotation.x}deg) rotateY(${finalRotation.y}deg)`;

    setTimeout(() => {
      resultLabel.textContent = `Blocked face: ${value}`;
      resultLabel.classList.add("revealed");
      actionBtn.textContent = "Continue";
      actionBtn.disabled = false;
    }, totalDuration * 1000);

    saveState();
  });

  modalBox.appendChild(h2);
  modalBox.appendChild(p);
  modalBox.appendChild(sceneWrap);
  modalBox.appendChild(resultLabel);
  modalBox.appendChild(actionBtn);
  modalOverlay.classList.remove("hidden");
  // Moves focus off whatever background control (rollBtn, a scorecard row,
  // ...) happened to hold it before this opened - modalBox has tabindex="-1"
  // specifically so it can take focus programmatically without joining the
  // normal tab order. Without this, a stray Enter/Space keypress could
  // natively activate that still-focused background element (native button
  // activation isn't stopped by the app's own "suspend shortcuts while a
  // modal is open" keydown guard below - that guard only skips ITS OWN
  // logic, it never calls preventDefault()), silently abandoning whatever
  // this modal was for - see the Golden Touch refund/pending pack offer
  // bug this was written to fix, where exactly that happened.
  modalBox.focus();
}

function showGameOverModal(total) {
  state.gameOver = true;
  renderControls();

  const reachedStageName =
    state.phase === "small1" ? "Small Game 1" :
    state.phase === "small2" ? "Small Game 2" :
    `level ${state.level}`;

  modalBox.innerHTML = "";
  const h2 = document.createElement("h2");
  h2.textContent = "Game Over";
  const p = document.createElement("p");
  p.textContent = `You reached ${reachedStageName} with a final score of ${total} (needed ${state.target}).`;

  const btn = document.createElement("button");
  btn.className = "modal-btn";
  btn.textContent = "Start New Run";
  btn.addEventListener("click", restartRun);

  modalBox.appendChild(h2);
  modalBox.appendChild(p);
  modalBox.appendChild(btn);
  modalOverlay.classList.remove("hidden");
  // Moves focus off whatever background control (rollBtn, a scorecard row,
  // ...) happened to hold it before this opened - modalBox has tabindex="-1"
  // specifically so it can take focus programmatically without joining the
  // normal tab order. Without this, a stray Enter/Space keypress could
  // natively activate that still-focused background element (native button
  // activation isn't stopped by the app's own "suspend shortcuts while a
  // modal is open" keydown guard below - that guard only skips ITS OWN
  // logic, it never calls preventDefault()), silently abandoning whatever
  // this modal was for - see the Golden Touch refund/pending pack offer
  // bug this was written to fix, where exactly that happened.
  modalBox.focus();
  saveState();
}

// ---------- Keyboard controls ----------

// Moves focus among the currently selectable scorecard rows (wrapping),
// mirroring what up/down would do in any keyboard list widget.
function navigateScorecard(direction) {
  const rows = [...document.querySelectorAll("#scoreBody tr.selectable")];
  if (rows.length === 0) return;

  const currentIndex = rows.indexOf(document.activeElement);
  let nextIndex;
  if (currentIndex === -1) {
    nextIndex = direction > 0 ? 0 : rows.length - 1;
  } else {
    nextIndex = (currentIndex + direction + rows.length) % rows.length;
  }
  rows[nextIndex].focus();
}

document.addEventListener("keydown", (e) => {
  // While a modal (level-up / game-over) or the card collection popup is
  // open, let its own buttons handle their own native Enter/Space
  // activation instead of the game shortcuts.
  if (!modalOverlay.classList.contains("hidden")) return;
  if (!collectionOverlay.classList.contains("hidden")) return;
  if (!bossesOverlay.classList.contains("hidden")) return;

  if (/^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    if (index < state.diceCount) {
      e.preventDefault();
      toggleHold(index);
    }
    return;
  }

  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    navigateScorecard(e.key === "ArrowDown" ? 1 : -1);
    return;
  }

  // Left/right switch which side has focus - right into the scorecard
  // (its first selectable row), left back to the Throw Dice button -
  // mirroring how up/down already navigate within the scorecard itself.
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    if (e.key === "ArrowRight") {
      const rows = [...document.querySelectorAll("#scoreBody tr.selectable")];
      if (rows.length > 0) rows[0].focus();
    } else {
      rollBtn.focus();
    }
    return;
  }

  if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
    const active = document.activeElement;
    if (active && active.classList.contains("selectable") && active.dataset && active.dataset.categoryKey) {
      // A scorecard row is focused (via arrow keys or a mouse click) -
      // space/enter locks the score in there instead of throwing again.
      e.preventDefault();
      commitScore(active.dataset.categoryKey);
      return;
    }
    if (active === rollBtn) return; // native button behavior already handles this
    // Nothing else meaningfully focused: default action is to throw dice,
    // or advance to the next round if one is waiting to start - mirrors
    // rollBtn's own click handler exactly (main-game completions still need
    // to go through endLevel() to open the perk-choice modal, not jump
    // straight to startNextLevel() like a small game does).
    e.preventDefault();
    if (state.awaitingNextRound) {
      if (state.phase === "main") {
        endLevel();
      } else {
        startNextLevel();
      }
    } else {
      rollDice();
    }
  }
});

// ---------- Init ----------

rollBtn.addEventListener("click", () => {
  // Redundant with rollBtn.disabled (see renderControls()) - kept explicit
  // the same way rollDice() re-checks its own blockers, in case a stray
  // Enter/Space keypress lands here before the disabled attribute reflects
  // a coinDieRevealActive flip that just happened this same tick.
  if (coinDieRevealActive) return;
  if (state.awaitingNextRound) {
    // Main game: target was already reached, but the perk-choice modal
    // (offering a card to pick) only actually shows once Next Level is
    // clicked - endLevel() re-checks total >= target (still true) and
    // routes to showLevelCompleteModal(). Small games skip perks entirely
    // and go straight to the next phase.
    if (state.phase === "main") {
      endLevel();
    } else {
      startNextLevel();
    }
  } else {
    rollDice();
  }
});
mulliganBtn.addEventListener("click", useMulligan);
refreshPackBtn.addEventListener("click", refreshShopSlots);

// dragenter/dragleave fire for the trash's child elements (the icon and gain
// text spans) too, bubbling through perkTrash on every crossing - a plain
// boolean toggled by dragleave flickers rapidly as the cursor passes over
// those children. A depth counter (incremented on every dragenter,
// decremented on every dragleave, both of which bubble the same way) only
// hits zero once the cursor has actually left the whole trash can.
let trashDragDepth = 0;

perkTrash.addEventListener("dragenter", (e) => {
  e.preventDefault();
  trashDragDepth++;
  perkTrash.classList.add("drag-over");
  const draggedPerk = draggedPerkInstanceId !== null
    ? state.perksOwned.find((p) => p.instanceId === draggedPerkInstanceId)
    : null;
  perkTrashIcon.textContent = draggedPerk ? `+$${perkDeleteRefund(draggedPerk)}` : PERK_TRASH_IDLE_ICON;
});
perkTrash.addEventListener("dragover", (e) => {
  e.preventDefault(); // still required on dragover for a drop to be allowed here
});
perkTrash.addEventListener("dragleave", () => {
  trashDragDepth = Math.max(0, trashDragDepth - 1);
  if (trashDragDepth > 0) return;
  perkTrash.classList.remove("drag-over");
  perkTrashIcon.textContent = PERK_TRASH_IDLE_ICON;
});
perkTrash.addEventListener("drop", (e) => {
  e.preventDefault();
  trashDragDepth = 0;
  perkTrash.classList.remove("drag-over");
  perkTrashIcon.textContent = PERK_TRASH_IDLE_ICON;
  if (draggedPerkInstanceId === null) return;
  const indexToDelete = state.perksOwned.findIndex((p) => p.instanceId === draggedPerkInstanceId);
  draggedPerkInstanceId = null;
  draggedFromSlot = null;
  if (indexToDelete !== -1) deletePerk(indexToDelete);
});

restartBtn.addEventListener("click", () => {
  if (!confirm("Restart your run? This will erase all current progress.")) return;
  restartRun();
});

// Debug-only: no gameplay purpose, just a quick way to test money-gated
// features (shop purchases, Golden Touch, Compound Interest...) without
// grinding for it.
debugMoneyBtn.addEventListener("click", () => {
  state.money += 100;
  renderStats();
  saveState();
});

// On/off switch for the ember/purple/rain/ash particle themes (see the
// four .boss-active:not(.particles-off)[...] visibility rules in
// style.css, which are what actually respond to this - the class here is
// the only thing driving them, this listener just toggles it and keeps
// the button's own label in sync). A separate localStorage key rather
// than folding into the main save blob (SAVE_KEY) - this is a display
// preference, not game progress, so it shouldn't reset on Restart or ride
// along with a save-file export/import if this project ever gets one.
const PARTICLES_ENABLED_KEY = "particlesEnabled";
function setParticlesEnabled(enabled) {
  document.body.classList.toggle("particles-off", !enabled);
  particlesToggleBtn.textContent = `Particles: ${enabled ? "ON" : "OFF"}`;
  particlesToggleBtn.setAttribute("aria-pressed", String(enabled));
  localStorage.setItem(PARTICLES_ENABLED_KEY, enabled ? "1" : "0");
}
setParticlesEnabled(localStorage.getItem(PARTICLES_ENABLED_KEY) !== "0"); // default on
particlesToggleBtn.addEventListener("click", () => {
  setParticlesEnabled(document.body.classList.contains("particles-off"));
});

// "Situational" background theme: tints the page background to match the
// active boss's category color (same categories as the boss banner/
// collection's category-* classes). Called every renderMainGameModifier()
// regardless of which theme is actually active - cheap, and means the
// data attribute is always correct the moment Situational gets picked.
// Small games (no active boss at all) get their own explicit "none"
// bucket (a distinct graphite, see style.css) so they never visually
// match the dark-gray "turns" boss family. Dice-category bosses are the
// only case that falls through to the plain :root default instead.
// A brief screen shake + an edge vignette punching in (in the boss's own
// category color) and easing back out, the instant a fresh boss level
// actually begins - see #app.boss-arrival-shake/.boss-arrival-vignette in
// style.css. Deliberately separate from the Situational background theme
// below (sweepSituationalBackground()) - that one only exists to hide a
// palette swap and is gated behind that optional theme, whereas this fires
// unconditionally on every boss arrival. Same category->color mapping as
// the boss banner/collection's category-* classes (dice bosses fall back
// to the plain --purple, same as everywhere else that maps categories).
const BOSS_ARRIVAL_CATEGORY_COLOR_VAR = {
  dice: "--purple",
  perk: "--orange",
  hand: "--danger",
  money: "--good",
  turns: "--slate",
};

// Must match #app.boss-arrival-shake's own animation duration in style.css
// (0.8s) - used to hold off the category-lock-crack animation (see
// renderScorecard()) so it doesn't visually compete with the shake if a
// category happens to become newly blocked in the same window a boss just
// arrived in.
const BOSS_ARRIVAL_SHAKE_DURATION_MS = 600;
let bossArrivalSlamStartedAt = null;

function triggerBossArrivalSlam(category) {
  bossArrivalSlamStartedAt = Date.now();
  const colorVar = BOSS_ARRIVAL_CATEGORY_COLOR_VAR[category] || "--purple";
  bossArrivalVignette.style.setProperty("--boss-arrival-color", `var(${colorVar})`);
  bossArrivalVignette.classList.remove("boss-arrival-pulse");
  void bossArrivalVignette.offsetWidth; // force reflow so the animation restarts even if it's already mid-play
  bossArrivalVignette.classList.add("boss-arrival-pulse");
  appEl.classList.remove("boss-arrival-shake");
  void appEl.offsetWidth;
  appEl.classList.add("boss-arrival-shake");
}

// A fresh boss level's scorecard wipes into view top-to-bottom instead of
// just appearing - see .scorecard-reveal/@keyframes scorecardReveal in
// style.css. Any row's own animation that could otherwise overlap it (e.g.
// category-lock-crack for a category blocked right at turn 1 - see
// renderScorecard()) is held off until this finishes, the same way those
// rows already wait out the boss-arrival shake above.
const SCORECARD_REVEAL_DURATION_MS = 500;
let scorecardRevealStartedAt = null;

function triggerScorecardReveal() {
  scorecardRevealStartedAt = Date.now();
  scoreTable.classList.remove("scorecard-reveal");
  void scoreTable.offsetWidth;
  scoreTable.classList.add("scorecard-reveal");
}

// A brief, deliberately mild burst from the screen's center the instant a
// boss level's target is actually reached - see .radial-flash/@keyframes
// radialFlashBurst in style.css. Fired from both places a main-game level
// can clear (finishCommitScore()'s early-target-reached branch, and
// endLevel()'s exact-on-the-final-turn branch), never on a small game
// round or a failed (game-over) level - those aren't "cleared."
function triggerRadialFlash() {
  radialFlash.classList.remove("flashing");
  void radialFlash.offsetWidth;
  radialFlash.classList.add("flashing");
}

function resolveSituationalCategory(modifier) {
  if (modifier && modifier.category && modifier.category !== "dice") return modifier.category;
  if (modifier && modifier.category === "dice") return "dice";
  return "none";
}

// Hand-category boss background warp - a <canvas> redrawn every animation
// frame, not a CSS filter (an SVG feDisplacementMap/filter:url() approach
// was tried first and verified working in isolated Playwright screenshots,
// but never actually animated for real in a live browser window - a canvas
// has no such ambiguity, every tick draws real new pixels, full stop).
//
// The technique: slice the background image into thin horizontal strips
// and draw each one shifted sideways by its own slowly-changing sine
// offset (a different phase per row, walking down the image over time) -
// hanging branch shapes sway/squirm side to side as that traveling wave
// passes through them.
function createBossWarpCanvas({ canvasId, imageSrc, isActive, layout, rowHeight, amplitude, wavelength, speed, coverHeadroom }) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas ? canvas.getContext("2d") : null;
  const warpState = { active: false }; // named to avoid shadowing the game's own top-level `state` object
  if (!canvas || !ctx) {
    return { updateActive() {}, isShowing: () => false };
  }
  const img = new Image();
  img.src = imageSrc;

  function updateActive() {
    warpState.active = isActive();
    canvas.style.display = warpState.active ? "block" : "none";
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resize);
  resize();

  function drawFrame(now) {
    if (warpState.active && img.complete && img.naturalWidth) {
      const cw = canvas.width;
      const ch = canvas.height;
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      // A few % of extra scale beyond an exact fit means each strip always
      // has real image data to draw from at its shifted position, instead
      // of exposing a blank sliver at an edge when a peak pushes it outward.
      let drawW, drawH, destX, destY;
      if (layout === "cover-top") {
        // background-size: cover; background-position: center top
        const scale = Math.max(cw / iw, ch / ih) * coverHeadroom;
        drawW = iw * scale;
        drawH = ih * scale;
        destX = (cw - drawW) / 2;
        destY = 0;
      } else {
        // "width-bottom": background-size: 100% auto; background-position: center bottom
        const scale = (cw / iw) * coverHeadroom;
        drawW = iw * scale;
        drawH = ih * scale;
        destX = (cw - drawW) / 2;
        destY = ch - drawH;
      }
      ctx.clearRect(0, 0, cw, ch);
      const yStart = Math.max(0, destY);
      const yEnd = Math.min(ch, destY + drawH);
      for (let y = yStart; y < yEnd; y += rowHeight) {
        const wave = Math.sin((y / wavelength) * Math.PI * 2 + now * speed);
        const xOffset = wave * amplitude;
        const sliceH = Math.min(rowHeight, yEnd - y);
        const sy = (y - destY) * (ih / drawH); // map this canvas-space strip back to source-image space
        const sh = sliceH * (ih / drawH);
        ctx.drawImage(img, 0, sy, iw, sh, destX + xOffset, y, drawW, sliceH);
      }
    }
    requestAnimationFrame(drawFrame);
  }
  requestAnimationFrame(drawFrame);

  return { updateActive, isShowing: () => warpState.active };
}

// Shared sway tuning - same as the money-category vine's own swing feels
// like a related, "alive" family of motion, not an unrelated rhythm.
const BOSS_WARP_TUNING = {
  rowHeight: 5, // CSS px per horizontal strip - fine enough to look continuous, coarse enough to stay cheap
  amplitude: 7.5, // CSS px of horizontal sway at a strip's peak
  wavelength: 260, // CSS px between wave crests going down the image - several gentle bends across a viewport's height
  speed: 0.00042, // radians/ms the wave crawls down over time, so it's not just a static wiggle
  coverHeadroom: 1.08,
};

// Red/hand: matches [data-boss-category="hand"] in style.css.
const redWarp = createBossWarpCanvas({
  canvasId: "redWarpCanvas",
  imageSrc: "assets/pictures/bg-red.png",
  isActive: () => document.body.getAttribute("data-boss-category") === "hand",
  layout: "width-bottom",
  ...BOSS_WARP_TUNING,
});
function updateRedWarpActive() {
  redWarp.updateActive();
}

// Purple: "boss-active, and neither a named category nor a tint override" -
// matches the plain-dice ::before selector in style.css exactly, so the
// canvas and that fallback background never disagree about when purple is
// actually showing.
const purpleWarp = createBossWarpCanvas({
  canvasId: "purpleWarpCanvas",
  imageSrc: "assets/pictures/bg-purple.png",
  isActive: () =>
    document.body.classList.contains("boss-active") &&
    !document.body.hasAttribute("data-boss-category") &&
    !document.body.classList.contains("boss-tinted"),
  layout: "cover-top",
  ...BOSS_WARP_TUNING,
});
function updatePurpleWarpActive() {
  purpleWarp.updateActive();
}

function applySituationalCategory(category) {
  if (category === "dice") delete document.body.dataset.bossCategory;
  else document.body.dataset.bossCategory = category;
  updateRedWarpActive();
  updatePurpleWarpActive();
  // Belt-and-suspenders against the static ::before background and its
  // canvas both being visible at once - rather than trust that a fixed-
  // position <canvas> sibling reliably paints over a fixed-position
  // ::before at the same z-index, just blank the ::before's background-
  // image outright whenever either canvas is showing (see the
  // boss-warp-showing rule in style.css, placed after every category's
  // own ::before rule so it always wins the cascade).
  document.body.classList.toggle("boss-warp-showing", redWarp.isShowing() || purpleWarp.isShowing());
}

const situationalSweepEl = document.getElementById("situationalSweep");
// Solid sweep-curtain colors, one per bucket - matches each bucket's own
// --bg-gradient-highlight in style.css (kept in sync by hand: the whole
// point of the curtain is to hide the swap, so JS can't just read the CSS
// variable it's about to change). "dice" reuses the plain :root default.
const SITUATIONAL_SWEEP_COLOR = {
  none: "#242428",
  perk: "#2e2318",
  hand: "#3a1720",
  money: "#1c332c",
  turns: "#262a40",
  dice: "#241f36",
};
const SITUATIONAL_SWEEP_DURATION = 700; // must match style.css's situationalSweep animation-duration
let situationalSweepSwapTimer = null;
let situationalSweepEndTimer = null;
let lastSituationalCategory; // undefined until the first resolve, so the very first paint never sweeps
// Set fresh every time a sweep genuinely starts - startNextLevel() resets
// this to null right before its own renderAll(), then checks it afterward
// to tell "this render just triggered a sweep" apart from ".sweeping" being
// stuck true because an EARLIER sweep's own cleanup timer (SITUATIONAL_
// SWEEP_DURATION out) simply hasn't fired yet, which the class alone can't
// distinguish (a real risk if two boss transitions ever land closer
// together than that - e.g. via Extra Life skipping straight to the next
// level - not just an artifact of synchronous tests).
let situationalSweepStartedAt = null;

// Wipes a solid curtain across the screen and swaps the underlying
// body[data-boss-category] at its midpoint, once it's fully covering the
// viewport - so the palette change itself is never visible mid-transition,
// only the curtain sweeping through.
function sweepSituationalBackground(category) {
  situationalSweepStartedAt = Date.now();
  clearTimeout(situationalSweepSwapTimer);
  clearTimeout(situationalSweepEndTimer);
  situationalSweepEl.classList.remove("sweeping");
  void situationalSweepEl.offsetWidth; // restart the animation cleanly if one was already mid-flight
  situationalSweepEl.style.background = SITUATIONAL_SWEEP_COLOR[category];
  situationalSweepEl.classList.add("sweeping");
  situationalSweepSwapTimer = setTimeout(() => {
    applySituationalCategory(category);
  }, SITUATIONAL_SWEEP_DURATION / 2);
  situationalSweepEndTimer = setTimeout(() => {
    situationalSweepEl.classList.remove("sweeping");
  }, SITUATIONAL_SWEEP_DURATION);
}

// Returns true when this call actually kicked off a sweep (so callers -
// see renderMainGameModifier()'s boss intro reveal - can hold off on
// anything that shouldn't start until the sweep-curtain has passed).
function updateSituationalBackground(modifier) {
  const category = resolveSituationalCategory(modifier);
  const changed = lastSituationalCategory !== undefined && category !== lastSituationalCategory;
  lastSituationalCategory = category;
  if (changed && document.body.dataset.theme === "situational") {
    sweepSituationalBackground(category);
    return true;
  }
  applySituationalCategory(category);
  return false;
}

// Situational (background tinted to match the active boss's category, see
// updateSituationalBackground()/sweepSituationalBackground() above) is the
// only background theme now - no more debug switcher to pick a different
// one, so this is just set once, unconditionally, rather than read back
// from a per-player preference.
document.body.dataset.theme = "situational";

// The Gatekeeper/The Culler/The Turnkey's drifting embers (see
// .ember-particle/.ember-particles(-back/-mid/-front) in style.css, which
// handle the actual boss-gated visibility and depth layering - CSS-only,
// nothing here needs to run again on a boss transition). Built once, here,
// rather than per boss-entry - each particle's own CSS custom properties
// give it a distinct horizontal start position, drift distance, speed,
// size, and angle. A NEGATIVE animation-delay on creation only (never
// touched again - changing animation-delay mid-flight can make a running
// animation jump) staggers each particle's FIRST lap so they don't all
// begin in lockstep at 0% the first time a hand-category boss appears.
// Every lap after that first one re-rolls the NON-timing properties (see
// the animationiteration listener below) - without it, a fixed small set
// of particles (the front layer especially, at only a handful) would
// repeat the exact same path/position forever, reading as "stuck" in one
// part of the screen rather than actually varying over time. --duration
// deliberately stays fixed for a particle's whole lifetime and is set
// once here, at creation, only - re-rolling animation-duration itself on
// every lap sounds equally safe but isn't: changing it mid-flight makes
// the browser recompute playback position from total elapsed time over
// the NEW duration, which almost never lands back on exactly 0% (only
// elapsed times that happen to already be a multiple of the fresh
// duration would), so the particle jumps to some random mid-cycle offset
// - visually appearing to start from the middle of the screen instead of
// off-screen - rather than restarting cleanly. --x/--drift/--angle/--size
// don't have that problem: they're keyframe VALUES, not timing, so
// changing them exactly at the boundary (where the animated transform is
// already sitting at its 0% translate(0,0)) just swaps which off-screen
// lane/path the next lap uses, invisibly.
function randomizeEmberParticle(ember) {
  ember.style.setProperty("--x", `${Math.random() * 100}%`);
  ember.style.setProperty("--size", `${2 + Math.random() * 3}px`);
  ember.style.setProperty("--drift", `${(Math.random() - 0.5) * 120}px`);
  ember.style.setProperty("--angle", `${(Math.random() - 0.5) * 6}deg`); // -3 to 3deg, tilts the rise off pure-vertical
}
function populateEmberLayer(container, count) {
  for (let i = 0; i < count; i++) {
    const ember = document.createElement("span");
    ember.className = "ember-particle";
    randomizeEmberParticle(ember);
    const duration = 7 + Math.random() * 6; // 7-13s per full rise - fixed for this particle's lifetime
    ember.style.setProperty("--duration", `${duration}s`);
    ember.style.setProperty("--delay", `${-Math.random() * duration}s`); // negative: starts already mid-flight
    ember.addEventListener("animationiteration", () => randomizeEmberParticle(ember));
    container.appendChild(ember);
  }
}
// Shared back/mid/front counts for BOTH the ember (red) and purple particle
// layers, so the two boss themes' three depth layers carry equal weight.
const PARTICLE_LAYER_COUNTS = { back: 18, mid: 22, front: 4 };
populateEmberLayer(emberParticlesBack, PARTICLE_LAYER_COUNTS.back);
populateEmberLayer(emberParticlesMid, PARTICLE_LAYER_COUNTS.mid);
populateEmberLayer(emberParticlesFront, PARTICLE_LAYER_COUNTS.front);

// Purple/dice-category bosses' drifting motes (see .purple-particle/
// .purple-particles(-back/-mid/-front) in style.css for the boss-gated
// visibility and the three depth layers) - small particles flying left to
// right across the screen. Same one-time-build, CSS-only-visibility, and
// re-roll-every-lap pattern as the embers above (see its own comment for
// why the re-roll exists, and why --duration is excluded from it) - just
// with a horizontal (--y start row, --driftY end wobble) motion instead
// of their vertical rise, and split across THREE layers instead of two:
// back (under the bg-purple.png picture), mid (over that picture, still
// under the game panels), and front (over literally everything, panels
// included) - see those classes' own z-index in style.css for how each
// actually lands at its layer.
function randomizePurpleParticle(particle) {
  particle.style.setProperty("--y", `${Math.random() * 100}%`);
  particle.style.setProperty("--size", `${1.5 + Math.random() * 2}px`);
  particle.style.setProperty("--driftY", `${(Math.random() - 0.5) * 60}px`);
  particle.style.setProperty("--angle", `${(Math.random() - 0.5) * 6}deg`); // -3 to 3deg, tilts the crossing off pure-horizontal
}
function populatePurpleParticleLayer(container, count) {
  for (let i = 0; i < count; i++) {
    const particle = document.createElement("span");
    particle.className = "purple-particle";
    randomizePurpleParticle(particle);
    const duration = 12.5 + Math.random() * 11; // 12.5-23.5s per full crossing (~72% of the original 9-17s speed) - fixed for this particle's lifetime
    particle.style.setProperty("--duration", `${duration}s`);
    particle.style.setProperty("--delay", `${-Math.random() * duration}s`); // negative: starts already mid-flight
    particle.addEventListener("animationiteration", () => randomizePurpleParticle(particle));
    container.appendChild(particle);
  }
}
// Same PARTICLE_LAYER_COUNTS as the embers above (see its own declaration).
populatePurpleParticleLayer(purpleParticlesBack, PARTICLE_LAYER_COUNTS.back);
populatePurpleParticleLayer(purpleParticlesMid, PARTICLE_LAYER_COUNTS.mid);
populatePurpleParticleLayer(purpleParticlesFront, PARTICLE_LAYER_COUNTS.front);

// Money-category bosses' rain (see .rain-particle/.rain-particles(-back/
// -mid/-front) in style.css for the boss-gated visibility and the three
// depth layers) - thin streaks falling top to bottom. Same one-time-build,
// CSS-only-visibility, and re-roll-every-lap pattern as the ember/purple
// particles above (see the embers' own comment for why the re-roll exists
// and why --duration is excluded from it) - just falling (--x start
// column, straight down) instead of rising or crossing sideways, and
// noticeably faster/shorter-lived per lap than either of those, to read
// as rain rather than drifting embers/motes.
function randomizeRainParticle(drop) {
  const scale = 0.7 + Math.random() * 0.6; // 0.7-1.3x - width/height scale TOGETHER so the teardrop's own proportions (see its clip-path in style.css) stay a drop at every size instead of stretching into a streak
  drop.style.setProperty("--x", `${Math.random() * 100}%`);
  drop.style.setProperty("--width", `${7 * scale}px`);
  drop.style.setProperty("--height", `${10 * scale}px`);
  drop.style.setProperty("--angle", `${(Math.random() - 0.5) * 6}deg`); // -3 to 3deg, tilts the fall off pure-vertical
}
function populateRainLayer(container, count) {
  for (let i = 0; i < count; i++) {
    const drop = document.createElement("span");
    drop.className = "rain-particle";
    randomizeRainParticle(drop);
    const duration = 4 + Math.random() * 3; // 4-7s per full fall - fixed for this particle's lifetime
    drop.style.setProperty("--duration", `${duration}s`);
    drop.style.setProperty("--delay", `${-Math.random() * duration}s`); // negative: starts already mid-flight
    drop.addEventListener("animationiteration", () => randomizeRainParticle(drop));
    container.appendChild(drop);
  }
}
// Same PARTICLE_LAYER_COUNTS as the embers/purple particles above.
populateRainLayer(rainParticlesBack, PARTICLE_LAYER_COUNTS.back);
populateRainLayer(rainParticlesMid, PARTICLE_LAYER_COUNTS.mid);
populateRainLayer(rainParticlesFront, PARTICLE_LAYER_COUNTS.front);

// Grey bosses' (The Hourglass/The Undertaker/The Thief - see .ash-particle/
// .ash-particles(-back/-mid/-front) in style.css for the boss-gated
// visibility, which covers both the "turns" category AND The Thief's own
// grey tint override) drifting ash - small grey flecks sifting slowly
// downward, with a sideways wobble as they fall rather than a straight
// drop. Same one-time-build, CSS-only-visibility, and re-roll-every-lap
// pattern as the other particle themes above (see the embers' own comment
// for why the re-roll exists and why --duration is excluded from it).
function randomizeAshParticle(fleck) {
  fleck.style.setProperty("--x", `${Math.random() * 100}%`);
  fleck.style.setProperty("--size", `${2 + Math.random() * 3}px`);
  fleck.style.setProperty("--drift", `${(Math.random() - 0.5) * 100}px`);
  fleck.style.setProperty("--angle", `${(Math.random() - 0.5) * 6}deg`); // -3 to 3deg, tilts the fall off pure-vertical
}
function populateAshLayer(container, count) {
  for (let i = 0; i < count; i++) {
    const fleck = document.createElement("span");
    fleck.className = "ash-particle";
    randomizeAshParticle(fleck);
    const duration = 10 + Math.random() * 6; // 10-16s per full fall - fixed for this particle's lifetime
    fleck.style.setProperty("--duration", `${duration}s`);
    fleck.style.setProperty("--delay", `${-Math.random() * duration}s`); // negative: starts already mid-flight
    fleck.addEventListener("animationiteration", () => randomizeAshParticle(fleck));
    container.appendChild(fleck);
  }
}
// Same PARTICLE_LAYER_COUNTS as the other particle themes above.
populateAshLayer(ashParticlesBack, PARTICLE_LAYER_COUNTS.back);
populateAshLayer(ashParticlesMid, PARTICLE_LAYER_COUNTS.mid);
populateAshLayer(ashParticlesFront, PARTICLE_LAYER_COUNTS.front);

// Perk-category bosses' (The Censor/The Edict) drifting orange leaves -
// small leaf shapes crossing the screen with a tumbling spin, same one-
// time-build, CSS-only-visibility, and re-roll-every-lap pattern as the
// other particle themes above (see the embers' own comment for why the
// re-roll exists and why --duration is excluded from it). --driftX
// spans much further than any other theme's horizontal drift (tens of
// vw, not px) since these are meant to travel ACROSS the screen, not
// just wobble in place - see .leaf-particle's own comment in style.css
// for how --spin layers a continuous tumble on top of that path.
function randomizeLeafParticle(leaf) {
  leaf.style.setProperty("--x", `${Math.random() * 100}%`);
  leaf.style.setProperty("--size", `${6 + Math.random() * 5}px`);
  leaf.style.setProperty("--driftX", `${(Math.random() - 0.5) * 100}vw`); // -50vw to 50vw
  leaf.style.setProperty("--spin", `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720)}deg`);
  leaf.style.setProperty("--angle", `${(Math.random() - 0.5) * 6}deg`); // -3 to 3deg, tilts the path off pure-vertical
}
function populateLeafLayer(container, count) {
  for (let i = 0; i < count; i++) {
    const leaf = document.createElement("span");
    leaf.className = "leaf-particle";
    randomizeLeafParticle(leaf);
    const duration = 10 + Math.random() * 6; // 10-16s per full crossing - fixed for this particle's lifetime
    leaf.style.setProperty("--duration", `${duration}s`);
    leaf.style.setProperty("--delay", `${-Math.random() * duration}s`); // negative: starts already mid-flight
    leaf.addEventListener("animationiteration", () => randomizeLeafParticle(leaf));
    container.appendChild(leaf);
  }
}
// Same PARTICLE_LAYER_COUNTS as the other particle themes above.
populateLeafLayer(leafParticlesBack, PARTICLE_LAYER_COUNTS.back);
populateLeafLayer(leafParticlesMid, PARTICLE_LAYER_COUNTS.mid);
populateLeafLayer(leafParticlesFront, PARTICLE_LAYER_COUNTS.front);

// ---------- Card Collection popup ----------

// One info card: name (colored per variant), a requirement line if it has
// one, and a hover tooltip with the full description. oneTime flags a rule
// card capped at a single, permanently-owned copy (UNIQUE_PERMANENT_RULE_IDS)
// - see renderCollection()'s own RULE_POOL loop, the only caller that ever
// passes it.
function buildCollectionCard(name, desc, requires, variantClass, stacks, icon, oneTime) {
  const card = document.createElement("div");
  card.className = "collection-card" + (variantClass ? ` ${variantClass}` : "");

  if (icon) {
    const iconEl = document.createElement("div");
    iconEl.className = "collection-card-icon";
    iconEl.textContent = icon;
    card.appendChild(iconEl);
  }

  const nameEl = document.createElement("div");
  nameEl.className = "collection-card-name";
  nameEl.textContent = name;
  card.appendChild(nameEl);

  if (oneTime) {
    const oneTimeEl = document.createElement("div");
    oneTimeEl.className = "collection-card-one-time";
    oneTimeEl.textContent = "(one time)";
    card.appendChild(oneTimeEl);
  }

  if (stacks) {
    // `stacks` is either `true` (uncapped) or a number (capped at that many
    // copies) - show the cap when there is one, so the limit isn't a
    // surprise. A separate block-level element (not appended inline after
    // the name) so it always starts on its own row, regardless of name length.
    const stacksEl = document.createElement("div");
    stacksEl.className = "collection-card-stacks";
    stacksEl.textContent = typeof stacks === "number" ? `(stacks ${stacks})` : "(stacks)";
    card.appendChild(stacksEl);
  }

  if (requires) {
    const reqEl = document.createElement("div");
    reqEl.className = "collection-card-requires";
    reqEl.textContent = `Requires: ${requires}`;
    card.appendChild(reqEl);
  }

  const tooltip = document.createElement("div");
  tooltip.className = "perk-tooltip";
  tooltip.textContent = desc;
  card.appendChild(tooltip);

  attachClampedTooltip(card, tooltip, collectionModalBody);
  attachCardTilt(card);

  return card;
}

// Tooltips default to centered on the card, which clips outside a narrow
// container for cards near its left/right edge (a perk-card row, or a
// popup grid that wraps many cards per row). Nudges the tooltip back
// inside boundsEl's bounds on hover.
//
// .perk-tooltip transitions its transform, so measuring right after just
// clearing an old inline transform can catch the *pre-change* rendered
// position (whatever was left over from the previous hover) instead of
// the settled one - alternating results on repeated hovers of the same
// card. Snapping to the resting position with transitions off, measuring,
// then re-enabling the transition (same pattern as the perk-reorder FLIP
// animation) avoids that race.
function attachClampedTooltip(card, tooltip, boundsEl) {
  card.addEventListener("mouseenter", () => {
    tooltip.style.transition = "none";
    tooltip.style.transform = "translate(-50%, 0)"; // matches the CSS :hover rule's resting transform
    const tooltipRect = tooltip.getBoundingClientRect();
    const boundsRect = boundsEl.getBoundingClientRect();
    const margin = 10;
    let shiftX = 0;
    if (tooltipRect.left < boundsRect.left + margin) {
      shiftX = (boundsRect.left + margin) - tooltipRect.left;
    } else if (tooltipRect.right > boundsRect.right - margin) {
      shiftX = (boundsRect.right - margin) - tooltipRect.right;
    }
    void tooltip.offsetWidth; // force reflow so the snap above is committed before re-enabling the transition
    tooltip.style.transition = "";
    tooltip.style.transform = shiftX !== 0 ? `translate(calc(-50% + ${shiftX}px), 0)` : "translate(-50%, 0)";
  });

  card.addEventListener("mouseleave", () => {
    tooltip.style.transition = "";
    tooltip.style.transform = "";
  });
}

// .rule-inventory-column clips overflow-x (needed so a tall rule list's
// scrollbar doesn't also grow a phantom horizontal one), which cuts the
// tooltip off since it's normally wider than that whole column. Switching
// it to position: fixed on hover escapes that clipping ancestor entirely -
// no ancestor here sets a transform/filter, so fixed positioning resolves
// against the viewport as expected. Coordinates are computed fresh each
// hover (rather than in CSS) since a fixed element can't be anchored to its
// trigger with percentages the way an absolutely-positioned one can.
function attachFixedTooltip(card, tooltip) {
  card.addEventListener("mouseenter", () => {
    const cardRect = card.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect(); // size while still in normal flow, before switching position
    const margin = 10;
    let left = cardRect.right - tooltipRect.width; // right-align to the card, matching the resting CSS (right: 0)
    left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin));
    let top = cardRect.top - tooltipRect.height - margin;
    top = Math.max(margin, top);
    tooltip.style.position = "fixed";
    tooltip.style.left = `${left}px`;
    tooltip.style.right = "auto";
    tooltip.style.top = `${top}px`;
    tooltip.style.bottom = "auto";
  });

  card.addEventListener("mouseleave", () => {
    tooltip.style.position = "";
    tooltip.style.left = "";
    tooltip.style.right = "";
    tooltip.style.top = "";
    tooltip.style.bottom = "";
  });
}

// Everything the game can ever offer, in one place - static content, so
// this only needs building once rather than re-rendering on every open.
function renderCollection() {
  perksChanceLabel.textContent = `${formatPercent(effectiveShinyChance())} Shiny`;
  collectionPerks.innerHTML = "";
  PERK_POOL.forEach((perk) => {
    const variant = perk.tint ? `tint-${perk.tint}` : undefined;
    // The "↑" corner glyph flags a permanently-growing X mult (Demolisher/
    // Skipper/Streaker) - reuses buildCollectionCard()'s existing icon slot
    // (already used for rule cards' color-group glyphs and the Mega Pack
    // tile), so no new CSS is needed here.
    const icon = perk.cumulative ? "↑" : undefined;
    // UNIQUE_PERMANENT_RULE_IDS started out rule-card-only (the name still
    // reflects that), but now also covers Bulk Discount/Lucky Die since
    // both moved to being perks - same "(one time)" orange label either way.
    collectionPerks.appendChild(buildCollectionCard(perk.name, perk.desc, perk.requires, variant, perk.stacks, icon, UNIQUE_PERMANENT_RULE_IDS.includes(perk.id)));
  });

  categoryChanceLabel.textContent = `${formatPercent(effectiveCategoryCardBoostChance())} Boosted`;
  megaChanceLabel.textContent = `${formatPercent(effectiveMegaChance())} Mega`;
  collectionCategoryCards.innerHTML = "";
  ALL_CATS.forEach((cat) => {
    const desc = `Card Pack bonus: +${formatMultiplier(1 + CARD_PACK_MULTIPLIER_STEP)} per copy, stacks additively.`;
    const requires = cat.minDice ? `Extra Dice (${cat.minDice}+ dice)` : null;
    collectionCategoryCards.appendChild(buildCollectionCard(cat.name, desc, requires, "category"));
  });
  // Not an actual category to score into - a mechanic tile describing the
  // Mega Pack roll itself (see openCardPack()/effectiveMegaChance()),
  // appended after the real categories so their own order stays untouched.
  // The chance shown here is live, same as megaChanceLabel above - both are
  // rebuilt fresh every time the Collection is opened.
  const megaPackDesc = `${formatPercent(effectiveMegaChance())}, to reveal every currently available category. Pick any one you like.`;
  collectionCategoryCards.appendChild(buildCollectionCard("Mega Pack", megaPackDesc, null, "category mega", null, "✦"));

  collectionRuleCards.innerHTML = "";
  RULE_POOL.forEach((rule) => {
    const variant = "rule"
      + (DESTRUCTIVE_RULE_IDS.includes(rule.id) ? " destructive" : "")
      + (rule.tint ? ` tint-${rule.tint}` : "");
    collectionRuleCards.appendChild(buildCollectionCard(rule.name, rule.desc, rule.requires, variant, rule.stacks, ruleCardIcon(rule), UNIQUE_PERMANENT_RULE_IDS.includes(rule.id)));
  });

  collectionUsables.innerHTML = "";
  USABLE_POOL.forEach((usable) => {
    const desc = `${usable.desc} Cost: $${usable.cost}. Bought from the boss shop slot.`;
    // Same "(one time)" tag as UNIQUE_PERMANENT_RULE_IDS cards above - every
    // usable can only ever be bought once per run (see pickRandomUsableId()/
    // buyBossUsable()'s usablesPurchasedIds tracking).
    collectionUsables.appendChild(buildCollectionCard(usable.name, desc, null, "usable", null, null, true));
  });
}

function openCollection() {
  // Re-rendered on every open, not just once at load - the Shiny/Boosted
  // labels are no longer static (Lucky Skip raises them over the run), so
  // they need to stay current with whatever's actually been earned so far.
  renderCollection();
  collectionOverlay.classList.remove("hidden");
}

function closeCollection() {
  collectionOverlay.classList.add("hidden");
}

collectionBtn.addEventListener("click", openCollection);
collectionBackBtn.addEventListener("click", closeCollection);
// Clicking the dark backdrop (not the modal content itself) closes it too.
collectionOverlay.addEventListener("click", (e) => {
  if (e.target === collectionOverlay) closeCollection();
});

// Every boss's name + full description, shown directly (not behind a hover
// tooltip like perk/rule cards) - there are only a handful of them, so
// there's no real need to hide the text behind an interaction.
function renderBosses() {
  bossesList.innerHTML = "";
  MAIN_GAME_MODIFIERS.forEach((boss) => {
    const categoryClass = boss.tint ? ` tint-${boss.tint}` : (boss.category !== "dice" ? ` category-${boss.category}` : "");
    const entry = document.createElement("div");
    entry.className = "boss-entry" + categoryClass;

    const name = document.createElement("div");
    name.className = "boss-entry-name" + categoryClass;
    name.textContent = boss.title;

    const desc = document.createElement("div");
    desc.className = "boss-entry-desc";
    desc.textContent = boss.desc;

    entry.appendChild(name);
    entry.appendChild(desc);
    bossesList.appendChild(entry);
  });
}

function openBosses() {
  renderBosses();
  bossesOverlay.classList.remove("hidden");
}

function closeBosses() {
  bossesOverlay.classList.add("hidden");
}

bossesBtn.addEventListener("click", openBosses);
bossesBackBtn.addEventListener("click", closeBosses);
bossesOverlay.addEventListener("click", (e) => {
  if (e.target === bossesOverlay) closeBosses();
});

renderCollection();

renderAll();
rollBtn.focus();

// If the page was reloaded while the level-complete/game-over modal was
// open, that modal itself isn't part of the saved state - reconstruct and
// reopen whichever one belongs, instead of leaving the roll button stuck
// disabled (gameOver: true) with nothing to interact with.
if (state.gameOver && !state.awaitingNextRound) {
  endLevel();
}

// Likewise, reopen an in-progress Card Pack choice if the page was reloaded
// while that popup was up - the offer itself is saved, just not the modal.
if (state.pendingPackOffer) {
  showPackOfferModal();
}

// And The Edict's mandatory pre-throw choice, if the page was reloaded
// before it got made.
if (activeBossModifier()?.id === "theEdict" && !state.edictSacrificeResolved
  && state.perksOwned.some(isEdictDestroyablePerk)) {
  renderEdictPicker();
}
