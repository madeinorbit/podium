# POD-1134 — safe in-chat permission answering: proposal

Whether the chat can show a harness permission ask and take the answer, with the
constraint that governs everything here: **a button must never mean something
other than what it says.** Judged throughout against the POD-609 failure class —
a keystroke that silently no-ops or lands on the wrong row
([pod-609-ask-menu-drive.md](./pod-609-ask-menu-drive.md)).

Prior evidence: [pod-707-permission-menu.md](./pod-707-permission-menu.md)
(bundle 2.1.226). New bundle reads in this doc are against **2.1.233**
(`~/.local/share/claude/versions/2.1.233`, the newest installed); the schemas
quoted were re-verified there.

## Verdict up front

1. **The read-only card should ship now, alone.** It needs no keystroke driving,
   it is blocked on nothing, and the data is already harvested and being dropped.
2. **The keystroke answer path still should not ship** — and the reason is
   sharper than POD-707 §3's variable ordinals: even the one "structurally
   stable" affirmative key (`1`) can *cancel* instead of approve, and Podium's
   own delivery machinery is built to follow keys with blind CRs, which is
   exactly the input that triggers that cancel.
3. **There is a channel where a button cannot mean the wrong thing, and it is
   not a keystroke at all.** The `PermissionRequest` hook's *response* schema
   accepts a decision by name — `{behavior:"allow"}` / `{behavior:"deny",
   message?}` — and the hook runs before the dialog renders. Podium already
   receives this hook; it just answers `200 {}` unconditionally. The answer
   path worth building holds that response open (only while nobody is looking
   at the terminal) and resolves it from the chat button. This is a proposal to
   validate in a PTY, not to ship from this reading.

---

## 1. The read-only card: ship it first, on its own

POD-707 §1 landed the subject: `AgentNeed.ask = { toolName, detail?,
canAlwaysAllow? }` (packages/model/src/entities/session.ts:133-147), populated
faithfully at packages/harness/src/agent-state/claude-code.ts:216-245. No web or
mobile surface reads it — the only consumer anywhere is
packages/client-core/src/focus.ts:69, and it takes `need.summary`. Today the
user sees an amber chip, "Waiting for your approval", and a grey "Ran a tool"
row indistinguishable from a file read.

A card that renders

> **Claude wants to run** `git push origin main` — answer in the terminal

with a button that opens the session's terminal pane is pure display of state
Podium already holds. It types nothing, so nothing in POD-609's or POD-707 §3's
failure space applies to it. Shape:

- **Anchor.** The ask is runtime state, not a transcript event — nothing to
  hang a transcript block on. Render it where the waiting line already lives
  (apps/web/src/features/chat/TranscriptTail.tsx:46), as a tail card that
  exists exactly while `{ kind:'needs_user', need:'permission' }` holds, and
  resolves when the state clears (any subsequent hook — PostToolUse activity,
  Stop — clears it; that machinery exists).
- **Content.** `ask.toolName` as the headline, `ask.detail` in a code span
  (already one-lined and capped at 300 chars upstream, claude-code.ts:147-174),
  and when `ask.canAlwaysAllow` is set, a footnote that the terminal offers a
  "don't ask again" the chat deliberately does not.
- **Degrade.** When only the `Notification` channel fired there is no `ask`,
  only a rendered message string (claude-code.ts:240-245). The card shows the
  summary string and the open-terminal button — never a fabricated subject.

This is a small, self-contained deliverable and should be its own issue rather
than waiting on any answer-path decision.

## 2. The answer path: the design space, judged

### 2a. Digits by ordinal — dead (established)

"No" is index 2, 3, 4 or 5 depending on the tool and matched rule; a digit that
denies one prompt approves-and-persists another (POD-707 §3). Not revisited.

### 2b. Addressing by value slug — not an input surface

The `value` slugs (`yes`, `yes-exact`, `no`, …) exist in the option objects,
but the dialog's keyboard surface is digits, arrows, Enter, Esc. There is no
typeahead or slug-addressable input to the Ink select — a slug is a label in
code, not something the PTY can be asked for. Slugs matter only as the *parse
target* for 2d below; as a direct channel this idea is dead.

### 2c. Restrict to the two stable keys — the "stable" yes is not safe

Esc→reject is genuinely structural: the dialogs wire `onCancel: () => _t("no")`
(POD-707 §4). But the affirmative half fails the constraint this issue is named
for:

- Under `yesInputMode` the first entry is a text field with
  `allowEmptySubmitToCancel`, and the mode is passed a live variable at every
  call site — it cannot be ruled out statically (POD-707 §4).
- Podium's driver DNA makes this worse, not better. The inbox's habit of
  following input with blind CRs — `SUBMIT_CR_DELAY_MS` after every text send,
  then up to `SUBMIT_MAX_RETRIES` verify-CRs
  (apps/server/src/modules/sessions/inbox.ts:895-926) — is precisely the
  keystroke that turns "1 landed in a field" into a **cancel**. An "Allow"
  button that sometimes cancels is the exact forbidden class, with POD-609's
  signature: it looks obviously fine and does something else.

A deny-only card (Esc is safe) is coherent but not worth a button surface on
its own: the common case for answering from chat is "yes, run it".
Conclusion: do not ship 2c blind. If the PTY experiment (§3) proves
`yesInputMode` never occurs for tool asks *and* `1` needs no trailing CR, 2c
becomes shippable as a fallback — but 2e is better on every axis if it survives
its own experiment.

### 2d. Verify the rendered menu before sending — correct but heavy, and racy

Parse the live screen, find the row whose label matches what the card promised,
send that digit, abort on mismatch. Honest assessment:

- **Machinery does not exist.** The server keeps raw output bytes
  (`outputLog`, a 256KB replay window — apps/server/src/modules/sessions/
  terminal.ts:89-90) and harness-transcript items; there is no ANSI screen
  model. Sessions do run under per-session tmux servers
  (packages/pty/src/tmux.ts), so `tmux capture-pane` through the daemon is a
  plausible read path — but it is new daemon protocol surface either way.
- **TOCTOU remains.** A human at the terminal pane can move focus or answer
  between capture and keypress. The window can be narrowed, not closed, and
  Podium deliberately lets terminal and chat coexist.
- It inherits all the pacing fragility (one key per write, settle delays) that
  POD-609 exists to document.

Verdict: this is the *right shape* for a keystroke path if one is ever needed,
and its cheap half — **witness the postcondition** (the `needs_user` state
clearing, or the `PermissionDenied` hook event, which exists in 2.1.233's
event list) and surface "not confirmed" on the card when it doesn't — should be
part of any answer path. But as the primary design it is the most machinery for
the least semantic safety: it *infers* meaning from pixels that 2e gets by
name.

### 2e. Answer through the hook response — the button IS the wire value

The finding that reframes the issue. The `PermissionRequest` hook output schema
in bundle 2.1.233:

```js
be({ hookEventName: Tt("PermissionRequest"),
     decision: $s([
       be({ behavior: Tt("allow"),
            updatedInput: oo(B(), no()).optional(),
            updatedPermissions: ht(MDt()).optional() }),
       be({ behavior: Tt("deny"),
            message: B().optional(),
            interrupt: Gt().optional() })]) })
```

Supporting strings in the same bundle: `"Permission denied by PermissionRequest
hook"`, `decisionReason:{type:"hook",hookName:"PermissionRequest"},
decideLocation:"ask-path"` (the deny routes through the same path as a menu
"No"), a rule-override warning (`PermissionRequest hook allowed ${t} with
updatedInput, but ${e.behavior} rule overrides`), and the docs table row
`PermissionRequest | Tool name | Run before permission prompt` — the hook
completes before the dialog renders.

Podium already registers this hook (claude-code.ts:66); the daemon's ingest
server answers every hook `200 {}` immediately, by design — "observation only…
can never block or steer the agent" (claude-code.ts:41-45). The proposal is to
relax that contract for exactly this one event, deliberately:

- **Hold the response only while no terminal client is attached.** The server
  knows (`SessionTerminal.clientCount`, controller state). If someone has the
  terminal pane open, answer `200 {}` immediately as today — the native dialog
  appears, the chat shows the §1 read-only card. No dual-surface race exists,
  because while held there IS no menu to race with.
- **While held**, the chat card offers exactly two actions, each a literal wire
  value: **Allow once** → `{decision:{behavior:"allow"}}` (no
  `updatedPermissions`, so nothing persists — to be confirmed in §3), **Deny**
  → `{decision:{behavior:"deny", message}}` with the user's optional
  tell-Claude-why text riding as `message`, matching the native reject row's
  feedback semantics. Every "don't ask again" variant is deliberately absent,
  same policy as the card.
- **Release paths.** Terminal client attaches mid-hold → respond `200 {}`
  undecided; the native dialog appears; the card downgrades to read-only.
  Hold approaching the hook timeout → same. Timeout length and
  timeout-expiry behavior are empirical questions (§3); the hold ceiling must
  sit safely inside whatever the real timeout is.

Judged against POD-609's failure class: there are no ordinals, no pacing, no
screen state, no focused-field ambiguity — the failure mode "the keystroke did
something else" is structurally impossible because there is no keystroke. The
channel's own risks are different and must be tested, not assumed: what the
TUI displays during a held hook (a spinner is acceptable; a blank hang is
not); what happens at hook timeout (dialog-as-fallback is acceptable;
auto-deny is not); whether `behavior:"allow"` with no extras is truly
allow-*once*; how multiple registered hooks and rule overrides compose; and
that a held hook does not block unrelated session activity.

**Recommendation: build the answer path on 2e**, gated on the §3 experiment,
with 2d's postcondition-witness as the card's confirmation step. Do not extend
the keystroke driver to permission menus.

## 3. What must be verified in a real PTY

POD-609's standard: the bundle read is necessary and not sufficient. One rig
answers everything — the POD-609 harness (python `pty.openpty` + ANSI screen
model, assertions against the SCREEN), pointed at the exact build Podium
launches (note: the evidence doc's 2.1.226 is no longer installed here; pin
whatever `claude --version` resolves to at experiment time, and record it).
A scripted HTTP hook server plays Podium's part.

Ordered so the recommended path settles first:

| # | case | settles |
|---|------|---------|
| C1 | Register an http `PermissionRequest` hook whose server delays 10s/30s/90s before `200 {}`. Prompt a Bash ask. | What the TUI shows while held; the real hook timeout; whether timeout falls back to the dialog (required) or does anything else (disqualifying). |
| C2 | Hook responds `{decision:{behavior:"allow"}}` after 5s. | Tool runs once; dialog never renders; **no rule persisted** (re-ask the same command — it must prompt again). |
| C3 | Hook responds `{decision:{behavior:"deny", message:"use --dry-run"}}`. | Agent receives the message as rejection feedback; whether `PermissionDenied` fires (card-resolution signal); what `interrupt` adds. |
| C4 | While held, type into the PTY. | Where keystrokes land with no dialog present (composer hazard to document for the release-on-attach design). |
| C5 | Two `PermissionRequest` hooks registered; second one Podium's. | Composition order — whether another hook's decision preempts the held one. |
| A1 | No hook decision (immediate `200 {}`), dialog up: press `1` on an ordinary Bash ask. | POD-707 §5 Q1 — approve, or `yesInputMode` field? Repeat across ask shapes (Bash, file edit, network/domain, skill) hunting for any live `yesInputMode`. |
| A2 | Dialog up: press Esc. | §5 Q2 — clean reject, and the exact rejection text the agent receives. |
| A3 | Esc, then immediate next input vs. `MENU_CONFIRM_DELAY_MS`-paced input. | §5 Q3 — whether the reject path needs a settle delay. |

C1–C5 decide whether 2e ships. A1–A3 are still owed to close POD-707 §5's
record and to qualify 2c as a fallback — they are worth running in the same
sitting, but nothing in the recommended path depends on their answers.

## 4. Sequencing

1. **Read-only ask card** (§1) — own issue, no dependencies, ship now.
2. **PTY experiment** (§3) — own issue; produces a sibling evidence doc; no UI.
3. **Hook-decision answer path** (§2e) — daemon holds `PermissionRequest` for
   unattached-terminal sessions, server resolves from the card, card witnesses
   the postcondition; blocked on 2 and scoped by its results.

If C1/C2 disqualify the hook channel, the honest fallback ordering is: keep the
read-only card, run A1–A3, and revisit 2c (Esc-deny plus `1`-allow **only** if
`yesInputMode` proved absent and no trailing CR is ever sent) — otherwise the
answer path stays unshipped, and the card keeps saying, truthfully, "answer in
the terminal".
