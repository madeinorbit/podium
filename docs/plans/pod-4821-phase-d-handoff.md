# Phase D (POD-4821) — handed over from the Phase B design, 2026-09-29

Phase B (POD-4819, `docs/plans/pod-4819-harness-receipt-proof.md`) decides whether a message
reached the agent. It must give the right answer however well or badly a message is typed.
Phase D controls what we write into a terminal agent, so that Phase B can say yes or no more
often instead of `unknown`. The line between them: *does it change what bytes reach the terminal,
or when?* If yes, it is Phase D.

Facts are marked *run* (observed on the real CLI, evidence committed) or *read* (code, binary,
docs: a candidate).

## What we found

- **Every write passes through the daemon** on podium-host sessions: only the daemon holds the
  writer lease (`packages/pty/vendor/podium-host/host.c:405-408, 486-491`; a takeover steals it,
  `host.c:602-616`), and a person's keystrokes from the web, mobile and desktop terminals are
  relayed by the daemon (`apps/daemon/src/control/native-terminal-input.ts:33-36`). Sessions on
  the abduco fallback can be typed into by anyone running `abduco -a`
  (`packages/pty/src/durable-process.ts:198-215`). *Read.*
- **Writers that go around the message delivery queue:** Draft Sync
  (`apps/daemon/src/composer-sync.ts:275-279`; its "someone is typing" signal, `:252`, is fed only
  by input frames, never by the driver's own writes, so it can type while a message is being
  pasted), menu answers (`apps/daemon/src/runtime/terminal-driver.ts:2209`), interrupt keys, the
  Ctrl-U clear after an interrupt (`apps/daemon/src/session-observers.ts:607-615`), the Ctrl-L
  redraw, and a person's keystrokes. Only the server keeps a timestamp of a person's input
  (`apps/server/src/modules/sessions/terminal.ts:659-722`). *Read.*
- **Nothing on the send path reads, clears or refuses a draft.** The terminal send refuses only
  `not_running`, `lease_held`, `busy` and `needs_user`; `packages/harness/src/driver/families/terminal/injection.ts`
  has no input-box logic. A paste is always followed by its Enter (POD-4776,
  `injection.ts:510-517`). Input-box readers exist only for Claude (`packages/harness/src/adapters/claude-code/composer.ts:31-95`,
  clear with Ctrl-U per line) and Codex (clear with Ctrl-C), used only by Draft Sync; the Codex
  one is broken for multi-line text (`docs/superpowers/specs/2026-07-17-draft-sync-v2-design.md`). *Read.*
- **Seen live:** three messages ended "typed but never confirmed" with `draft=yes`; the text sat in
  Claude Code's input box, unsubmitted, for an hour or more (msg_c29773d0, msg_9eca38c6, and one of
  POD-4764's; comments on POD-4777 and POD-4775).
- **Claude Code's own queue** (2.1.284, *run*, `docs/measurements/pod-4834-receipt-proof/`): a
  prompt entered while Claude is busy waits in Claude's queue; it is taken into the running turn
  at the next tool boundary, or runs as a new turn when the turn ends. *Read* (binary): Escape can
  pull queued prompts back into the input box (some paths flag-gated); "send now"
  (`ctrl+x ctrl+s`, `ctrl+enter`). Upstream: quickly queued inputs were merged into one message in
  Claude Desktop ([#53670](https://github.com/anthropics/claude-code/issues/53670)); the queue
  record is written even for a prompt a hook then blocks
  ([#96891](https://github.com/anthropics/claude-code/issues/96891)).

## Designs handed over

1. **Only type into an empty input box.** Read the box before typing (the existing readers; a
   reader per program is needed). If it is not empty, do not type: someone's half-typed words
   would be submitted with ours. What to do then (wait, tell the person, give up after a time) is
   Phase D's decision.
2. **Text left in the box after the submit retries: clear it and prove the clear.** Clear with the
   program's clear keys, then prove it with an **input fence**: write a probe after our text, see
   it drawn after our text in the same editable box, then remove it. A screen reading alone is
   never proof (the screen can lag; Claude also draws queued prompts). Report the proven clear to
   Phase B as `not-submitted`, which Phase B turns into `failed`, safe to resend. If the clear
   cannot be proven, the message stays open and the user sees "left in the agent's input box".
   Never clear a box holding our text plus other text: that is someone else's draft.
3. **What the program itself puts into the box.** Escape restoring queued prompts (our interrupt
   path presses the interrupt key, so check the box after it), arrow-up history, accepted
   autocomplete suggestions. Measure per program before relying on any of it.
4. **Draft Sync unsupported** — POD-4851 (filed under this phase): it stops writing into the input
   box; the readers stay, because items 1 and 2 need them.
5. **Typing lock (optional optimization, never at the core).** The daemon may hold foreign writes
   to a session while one message is pasted and submitted, so a person's keystrokes cannot land
   inside it. Constraints from the operator: it can never block everything. A lease released at
   whichever comes first: the typing finished plus a short settle, or a hard expiry of about
   1–2 s on its own timer (so a typing step that never finishes still releases it). Held writes
   buffered with a size cap and flushed in order. A switch to turn it off. A test pins the release
   when the typing step never settles. Build it only after Phase B's foreign-write counter works.
6. **Keep Phase B's foreign-write counter correct.** Phase B counts, under the terminal write call,
   every write that is not part of the message being typed (its paste, Enter and retries). Any
   new writer Phase D adds must go through the same call, and a message's own writes must stay
   distinguishable from foreign ones.

## Measurements for this phase

Per terminal program: paste → Enter timing; does the box clear on submit; can a leftover be seen
on screen; what Escape, arrow-up and autocomplete put into the box; do quickly queued inputs merge.
Use the method in `docs/measurements/pod-4834-receipt-proof/README.md` (fake model server, scratch
config, never real credentials).

## Interface with Phase B

Phase D reports `not-submitted` with its proven clear (Phase B §6.1). Phase D keeps a message's own
writes distinguishable from foreign writes (Phase B §5.3).

## Measured since (POD-4834 lanes, 2026-09-29, `docs/measurements/pod-4834-receipt-proof/grid.md`)

- **Codex terminal:** Ctrl-C quitting puts held and Tab-queued messages back into the input box
  joined by `\n`; submitted again they would be one entry holding several messages. Its
  `history.jsonl` is written for box text that Ctrl-C cleared and that was never submitted.
- **Cursor terminal:** after a failed run the TUI restores the failed prompt into the input box, and
  the next typed text is appended to it.
- **Claude terminal:** Escape with a prompt queued ran the queued prompt as the next turn at once
  (2.1.284); no queued prompt was seen pulled back into the box in these runs. Tab typed into the
  box becomes 4 spaces; a U+200B is removed and its Enter swallowed.
- **Grok terminal:** a tab becomes 4 spaces in the input box; its queue ("Queued · Enter to send
  now") is shown on screen only and lost on exit.
- **OpenCode terminal:** a paste gains a trailing space (a final newline becomes it).
