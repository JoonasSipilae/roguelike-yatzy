# Change Log

Notes on what Claude Code changed in this repo, session by session, for context on *why* something looks the way it does.

## 2026-09-05 — Shiny/perk-slot separation, store-lock cascade fix, and a long playtest pass

This log continues from the original `roguelike-yatzy` repo (see "Earlier work"
below) — the project was renamed/evolved into this `Dice-Game-v.1.0.9` folder
partway through, and this repo now tracks that newer version going forward.

### Perk slots: Shiny perks now live in a fully separate space
- Previously a Shiny perk grew the normal perk-slot cap by 1 to make room for
  itself (`effectivePerkSlotCount()`'s old `shinyCopies`), so it was still
  entangled with the normal 4(+Extra Perk) cap in every "is the board full"
  check.
- Redesigned so Shiny perks don't count toward that cap at all, in either
  direction: 4 normal perks + 1 Shiny now reads **4/4**, not 5/5. A Shiny
  perk's own slot is created and removed in lockstep with the card itself,
  with no independent "empty Shiny slot" ever existing.
- Knock-on fixes from this: the "perk slots full, choose one to replace"
  picker (both the shop's Perk Pack offer and the level-up choice) no longer
  offers a Shiny perk as a trade-away target — trading one away never
  actually freed a normal slot to begin with. Minimalist's "score per empty
  slot" xMult was updated to match the new (Shiny-free) capacity math.
- Extra Perk can no longer itself be rolled Shiny (it never renders its own
  card, so Shiny had nothing to decorate or affect).
- Blessing of The Censor's and Blessing of The Edict's own perk duplicates
  were deliberately left on the *old* mechanic (their own bonus slot still
  counts toward the cap) — this was a scoped decision, not an oversight.

### Bug fix: perk-slot count could silently exceed capacity
- Reported: 6 normal perks + 1 Shiny owned, and picking "Extra Perk" from a
  pack didn't visibly add a new empty slot.
- Root cause: Blessing of The Edict's perk-duplication picker pushed its new
  copy straight into `perksOwned` with **no slot-capacity check at all** — it
  correctly bypassed the per-perk *stack* cap ("no stack limit", the card's
  own wording) but was also silently bypassing the *slot* cap, which was
  never the intent.
- Fixed properly (not just capped) per a later request: Blessing of The
  Edict's duplicate now always succeeds and always brings its own new,
  permanent perk slot with it (tagged `blessingEdictDuplicate`), matching how
  Blessing of The Censor's duplicate already worked, except permanent rather
  than round-scoped. It also now stamps a real `instanceId` on the new copy —
  the original code never did, leaving it as the only perk instance in the
  game with no unique id.

### Bug fix: Blue Die stacks could silently collide on one die
- Reported: a "Blue Die ×3" card owned, but only 2 dice visibly painted blue,
  and a score tooltip listing 3 separate Blue Die contributions.
- Root cause: each new Blue Die copy picked a purely random die index with no
  check against dice an earlier copy already claimed — a 2nd/3rd stack could
  land on the same die as an existing one, silently "wasting" that copy (its
  score contribution was still real and counted, but the die-painting logic
  only marks a die blue by presence of *any* matching instance, so two
  stacks sharing one index only ever looked like one blue die).
- Fixed: each new copy now excludes dice already claimed by an owned Blue Die
  before picking, so every stack always lands on a distinct die.

### Bug fix: shop stores getting randomly locked mid-run
- Reported: shops locking "way after they should," first right after a card
  (Fire Sale) disappeared rather than at the *next* shop, then randomly
  re-locking for the rest of the game afterward.
- Root cause: Third Time's the Charm's "arm the next lock cycle" trigger had
  no guard against re-arming while a cycle was already pending/active — and
  Refresh (which isn't itself blocked by a locked shop) let the player
  refresh repeatedly *during* an already-locked shop, each refresh stacking
  a brand new 2-shop lock on top of the one still being served out.
- Fixed with a one-line guard. Fire Sale's own "lock the next shops after
  the card vanishes" mechanic was implemented on the same
  arm/consume/drain cycle architecture, kept as an independent lock source
  from Third Time's the Charm so both can be in flight at once correctly
  (the shop stays locked until *both* drain).

### Bug fix: wild die silently zeroing out Streak Die's contribution
- Reported: a hand needing the wild die to complete, that also contained a
  Streak Die, didn't add the Streak Die's points to the score.
- Root cause: `usedFacesForCategory()` (which Streak Die/Blue Die/Coin Die
  all use to check "did my die actually contribute to this hand") excluded
  wild dice entirely instead of resolving what face they were actually
  standing in for — a known, explicitly-flagged simplification in the old
  code. Fixed by reusing `bestScoreForCategory()`'s own brute-force wild
  substitution search instead of the cruder exclude-it-outright approach.

### Bug fix: scorecard row height changing on throw (font-metric dependent)
- Reported: rows grew slightly the instant dice were thrown and shrank back
  on commit — on the reporter's laptop, but not on a PC, despite an existing
  fixed-height CSS rule that should have prevented it on both.
- Root cause: `.cat-score-base`/`.cat-score-bonus`/`.cat-score-blue-bonus`
  were `display: inline-block; vertical-align: middle` wrapping plain text
  with no icon needing centering — that combination computes its line-box
  height from font-metric ascent/descent, which differs slightly by
  OS/browser font rendering. The existing fixed-height rule happened to
  match one machine's version of that quirk, not eliminate it.
- Fixed at the root: those three spans are now plain `display: inline`, so
  they share the exact same line-box height as the plain "-" placeholder
  text they replace, with nothing font-metric-dependent left to drift.

### Balance/description changes
- High Stakes: growth-rate increase per stack lowered from 2% to 1%, and its
  description now explicitly explains it compounds the per-level *growth
  rate* rather than adding a flat bonus to any one target.
- Straight Shot: mult-per-Straight lowered from +0.3x to +0.15x; fixed to
  only grow on an actually-committed Straight (not a scratch) and only in
  Bosses (not small games); its perk-card badge now correctly updates live
  on hover/keyboard-focus of a Straight row (a "lightweight" refresh path
  had been skipping it).
- Point values changed: Base Points +5 → +10, Quads +4 → +5, Six-Seven bonus
  +10 → +15 and penalty -15 → -20, hand-pattern Straights +10 → +15.
- Make It Count: now lasts 2 Bosses (small games in between don't count
  against it), description updated accordingly; confirmed multiple owned
  copies of it/Fire Sale each tick down independently, not all-or-nothing.
- Third Time's the Charm / Fire Sale descriptions rewritten to clearly state
  they lock the next Small 1 and Small 2 shops after the following Boss.
- Minimalist now starts at +0.4x (was +0x with 0 empty slots) via a new
  base-multiplier constant, on top of its existing +0.4x per empty slot.
- Extra Perk: when perk slots are full, it now only has a 50% chance of
  being force-included in a level-up offer (was a guaranteed 100%).
- Lucky Die description now states it works on both Bosses and Small Games.
- Fire Sale/Make It Count/Base Points' live per-instance status text in the
  rule inventory panel extended ("This shop + N shops left", "N Bosses
  left").
- Perk cards' red X-mult badge no longer shows a flat "-x" placeholder
  during small games — reverted back to always showing the real (possibly
  gated-inactive) value, matching Bosses.
- Red destructive rule cards (Clean Slate, Selective Cut, Ooo Shiny) can no
  longer target a Shiny perk at all, random or deliberate pick alike —
  descriptions updated to say "non-Shiny".

### Other fixes
- Blessing of The Edict can now be activated during Small Games, not just
  Bosses — its effect (duplicating a perk) is fully and permanently resolved
  the instant it's picked, unlike every other Blessing, so the "only makes
  sense mid-Boss" gate never actually applied to it.
- Blessing of The Censor duplicating Mulligan now correctly grants a second
  use of Mulligan for the round; Streak Die was added to the shared
  boss-blockable/duplicable perk list so it can be silenced by a real "perk"
  boss and duplicated by the Censor's Blessing, consistent with every other
  eligible perk.
- Fixed: skipping the level-up ("end of Boss") perk offer — both its main
  "Skip" button and its "Perk Slots Full" replace step's own Skip — didn't
  grow Skipper or bank Lucky Skip's bonus, unlike every other way of
  skipping a card offer. All four skip paths now share one
  `grantSkipGrowth()` function so a future one can't quietly miss it again.
- Added a minimize button to The Edict's mandatory sacrifice picker and to
  the level-up "Choose a Perk" step, generalizing the existing Card/Rule/
  Perk/Blessing Pack minimize-banner mechanic to cover both. (Along the way,
  fixed `.perk-choice-modal` missing `position: relative`, which had been
  silently pinning the new minimize buttons to the corner of the whole
  screen instead of their own modal.)
- Win-on-the-last-turn now always shows the "Next Level" confirmation step
  instead of occasionally cutting straight to the perk-choice modal.
- Changing a perk via a full-slots replace now correctly grows Demolisher.
- Streak Die's live badge and its actual banked score now agree (was
  showing one value higher than what actually got committed).
- Tooltip clipping/positioning: scoreboard tooltips now flip below their
  row when there's no room above, with the little chevron staying aligned
  to the element it points at; every tooltip's font size raised slightly.

## Earlier work (roguelike-yatzy repo, before the pivot to this folder)

### 2026-08-31 — Perk Shield Token, Golden Touch fix, Ooo Shiny fix, misc.

#### New feature: Perk Shield Token
- New usable item ($30): pick one owned perk to shield it.
- A shielded perk is immune to **random** destruction (Clean Slate, Ooo Shiny)
  but **not** to deliberate, player-chosen removal — The Edict, Selective
  Cut, trashing it, or replacing it with another perk all still work at
  100%. The design principle: the shield protects against RNG, not against
  a choice the player (or a boss's forced choice) actually made.
- It does **not** protect against The Censor's temporary per-turn/level
  silencing either — that's not destruction, nothing is removed from
  `perksOwned`.
- A small shield badge (🛡️) renders on the card everywhere an owned perk
  instance is shown (perk slots, the reroll/shield pickers, the "replace a
  full slot" flows, The Edict's picker, Ooo Shiny's survivor-pick list).

#### Bug fix: phantom "Golden Touch activated" cue
- Root cause: `showNextRoundPrompt()` cleared `state.pendingPackOffer`
  unconditionally, with no flush of a pending Golden Touch refund — the one
  place among several that touch this state that skipped it. A refund
  banked from an earlier, abandoned/minimized pack purchase could sit
  around and later surface its cue completely out of context, with no
  accompanying money change (the money was already granted at purchase
  time).
- Fixed by dropping the stale refund at that same point, matching how
  `startNextLevel()`/`restartRun()` already handle the same kind of
  abandonment.

#### Bug fix: Ooo Shiny could be rerolled for free
- Reported: select Ooo Shiny, see which perks it would destroy, minimize the
  pack-offer popup, reopen it, and get a fresh random roll — repeatable
  indefinitely.
- Root cause: `showPackOfferModal()` (also the function `resumePackOffer()`
  calls to bring a minimized offer back) reset the rule-picker's selection
  state on every call, and the click handler re-rolled Ooo Shiny's targets
  on every reselect.
- Fixed: the roll now happens exactly **once per offer** — the first time
  Ooo Shiny is selected — and is never touched again for the rest of that
  offer, regardless of minimizing/reopening, switching to a different card
  and back, or redundant re-clicks.

#### Bug fix: Extra Perk copies wrongly counted by Clean Slate / Selective Cut / Ooo Shiny
- Reported: 5 visible perks + 1 empty slot, but Ooo Shiny destroyed 3
  instead of the expected 2.
- Root cause: an owned "Extra Perk" copy never renders its own visible card
  (it only raises slot capacity), and The Edict already excluded it from
  being a valid sacrifice for exactly that reason — but Clean Slate,
  Selective Cut, and Ooo Shiny all scoped their target pool with a bare
  `!p.persistent` check instead of `isSlotOccupyingPerk()`, so an owned
  Extra Perk copy was silently counted (and could even be "destroyed"
  invisibly).
- Fixed consistently across all three mechanics' eligibility counts,
  destroy pools, and picker option lists.

#### Bug fix: Collection modal tooltip clipping
- Leftmost/rightmost cards' tooltips were partly cut off.
- Root cause: tooltips were clamped against the outer `#collectionModal`
  box, but the actual overflow-clipping ancestor is the inner
  `.collection-modal-body` (which scrolls and has `overflow-x: hidden`) — a
  narrower box, inset by padding, than the outer modal. Fixed by clamping
  against the real clipping container instead.

### Earlier work (before this log existed)

Everything from earlier sessions — the boss category system, the usables
system (Boss Skip/Free Reroll/Double Down/Perk Reroll Tokens), boss
category background shadows, the red/purple background warp effect,
Third Time's the Charm, and general balance/animation tuning — predates
this change log and isn't individually documented here.
