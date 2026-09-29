# Phase C (POD-4820) — handed over from the Phase B design, 2026-09-29

Phase B (POD-4819, `docs/plans/pod-4819-harness-receipt-proof.md`) decides whether a message
reached the agent; Phase C decides *how* a message is sent (interrupt, steer, when idle) and the
timing rules for each. Facts are marked *run* (observed on the real CLI, evidence committed) or
*read* (code, binary, docs: a candidate).

## What Phase B settled that Phase C builds on

- **One meaning of delivered for every mode:** the message is in the agent's conversation
  history. Modes add their own facts as details, not statuses: whether an interrupt stopped the
  running turn; whether a steer joined the running turn or became the next one.
- **`accepted` is a step, not delivery.** An agent program that took a message may still lose it:
  an acknowledged Codex steer that is interrupted before Codex's next model call is dropped
  (*run*, POD-4835; the status bug is POD-4849, kept in Phase B). A steer is `accepted` on its
  acknowledgement and `confirmed` only when it appears in the history.

## Steer, per program

- **Claude Code terminal — native.** *Run* (2.1.284, `docs/measurements/pod-4834-receipt-proof/`):
  a prompt entered while Claude is busy waits in Claude's own queue. At the next tool boundary it
  is taken into the running turn, inside the tool result the model receives next ("The user sent
  a new message while you were working: …"); if the turn ends without another tool call, it runs
  as a new turn. The submit hook fires at Enter with the running turn's `prompt_id`; a queued
  prompt run after the turn gets a new `promptId` and no hook. *Read* (binary): "send now"
  (`ctrl+x ctrl+s`, `ctrl+enter`) moves running tools to the background and delivers without
  stopping the turn when the flag `tengu_velvet_panda` is on (its default), otherwise interrupts;
  Escape can pull queued prompts back into the input box. Today our daemon only types into Claude
  when it is idle, so none of this is used yet. POD-4862 measures the rest.
- **Codex app-server — native** (`turn/steer`, *run*, POD-4835): takes our id
  (`clientUserMessageId`); recorded at Codex's next model call; dropped if interrupted before it.
  *Read*: `TurnStartParams` notes "Ignored when this request steers an already-active turn",
  so `turn/start` may also steer an active turn.
- **OpenCode v2 — offered** (*read*, `packages/harness/src/driver/families/opencode2/client.ts:128-150`):
  the driver sends `delivery: 'queue'` on purpose; `steer` would hand our words to a running turn
  a person opened in an attached terminal; how steer enters a multi-step turn was not measured.
  POD-4864 measures OpenCode.
- **Grok ACP** (*read*, 1.0.44 binary): a `sendNow` key may exist in `session/prompt`'s `_meta`.
  POD-4837 measures Grok ACP.
- **Claude SDK, Codex terminal, Grok terminal, OpenCode v1, Cursor:** not measured for steer;
  POD-4862 to POD-4865 record what they see.

## Interrupt

Our interrupt path presses the program's interrupt key and then types when the turn has ended
(`packages/harness/src/driver/delivery-queue.ts`, POD-4795). In Claude, the interrupt key can
pull queued prompts back into the input box (*read*): the box must be checked before typing
(Phase D handoff, `docs/plans/pod-4821-phase-d-handoff.md`).

## Open for Phase C

Which mode each program offers natively and how a degraded mode is reported (`deliveredAs`); the
decided timeouts (POD-4822); how a steer that arrives after the turn ended is handled on each
program; whether to use Claude's own queue as steer, and "send now" as interrupt-without-stopping.

## Measured since (POD-4834 lanes, 2026-09-29, `docs/measurements/pod-4834-receipt-proof/grid.md` §2)

- **Claude SDK:** a line sent while busy joins the running turn at the next tool boundary (our uuid
  as `source_uuid`) or becomes the next turn after streamed text; `priority: "now"` cuts streamed
  text at once and a tool at its end, and marks the preempted line `cancelled` although it stays in
  the conversation.
- **Codex app-server:** a `turn/start` sent while busy is silently a steer (it returns the running
  turn's id); `thread/queue/add` (experimental) holds a message **durably** under our id, survives
  SIGTERM and SIGKILL and runs on its own at `thread/resume` after a SIGKILL — a candidate for
  "when idle" sends; no transport deduplicates a repeat.
- **Codex terminal:** Enter while busy joins the running turn after the tool or text; Tab queues it
  as the next turn; Escape re-submits held messages as a new turn (nothing lost), unlike the
  app-server's dropped steer.
- **Grok ACP:** a prompt sent while busy is listed in `_x.ai/queue/changed` and runs after the
  running one. **Grok terminal:** send-now cancels the running turn and wraps the text.
- **OpenCode:** v1 and terminal store a busy message at once and it reaches the model at the next
  step of the running turn; after an interrupt it stays stored and **unanswered until another prompt
  starts a turn**. v2 `delivery: queue` runs at turn end, `steer` at the end of the running step;
  after an interrupt or restart a pending input runs only when another prompt arrives or its id is
  resent. Whether and how Podium then starts that turn is this phase's decision.
