# Change Log

Notes on what Claude Code changed in this repo, session by session, for context on *why* something looks the way it does.

## 2026-08-31 — Perk Shield Token, Golden Touch fix, Ooo Shiny fix, misc.

### New feature: Perk Shield Token
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

### Bug fix: phantom "Golden Touch activated" cue
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

### Bug fix: Ooo Shiny could be rerolled for free
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

### Bug fix: Extra Perk copies wrongly counted by Clean Slate / Selective Cut / Ooo Shiny
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

### Bug fix: Collection modal tooltip clipping
- Leftmost/rightmost cards' tooltips were partly cut off.
- Root cause: tooltips were clamped against the outer `#collectionModal`
  box, but the actual overflow-clipping ancestor is the inner
  `.collection-modal-body` (which scrolls and has `overflow-x: hidden`) — a
  narrower box, inset by padding, than the outer modal. Fixed by clamping
  against the real clipping container instead.

## Earlier work (before this log existed)

Everything from earlier sessions — the boss category system, the usables
system (Boss Skip/Free Reroll/Double Down/Perk Reroll Tokens), boss
category background shadows, the red/purple background warp effect,
Third Time's the Charm, and general balance/animation tuning — predates
this change log and isn't individually documented here.
