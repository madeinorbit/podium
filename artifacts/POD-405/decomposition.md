# POD-405 — ChatView onto the chat slice

**What changed:** the 1,442-line `ChatView.tsx` is now a **186-line shell**. Everything it
used to do itself lives in a part with one job.

## The parts

| Part | Lines (code) | Owns |
|---|---|---|
| `ChatView.tsx` | 186 (142) | layout only: header, feed, minimap, jump-to-bottom, composer |
| `viewmodels/slices/chat.ts` | 636 (331) | every view-model question, as pure functions |
| `use-chat-surface.ts` | 478 (384) | the source: store + transcript window + slice, assembled once |
| `use-transcript-scroll.ts` | 268 (175) | scroll anchoring + the sticky-prompt hand-off |
| `use-chat-send.ts` | 315 (240) | sending, optimistic bubbles, reconciliation, the ledger queue |
| `use-headless-turn.ts` | 171 (110) | headless superagent-thread routing |
| `use-attachments.ts` | 171 (119) | image paste / drop / attach and upload |
| `TranscriptFeed.tsx` | 301 (277) | the scrollable body and everything below it |
| `ChatComposer.tsx` | 289 (230) | the composer box and its four notice lines |
| `TranscriptSearchBar` · `VoiceButton` · `AttachmentStrip` · `AttributionMark` · `ImageLightbox` | 46–86 each | one affordance each |
| `Minimap.tsx` | unchanged | already extracted |

`13 useState / 15 useEffect` in one component → each remaining state and effect sits with
the lifecycle it belongs to. **No view-model derivation is left in a component**: every
`useMemo` in the source hook is a call *into* the slice — delete the memo and the answers
are identical.

The slice is 636 lines but **331 lines of code**; the balance is the reasoning that had
nowhere to live before. It is not a `SliceDefinition` for the same reason
`slices/workflows.ts` is not: its dominant input is a tRPC-read transcript window held by
the mounting view, not the replica snapshot the entity publisher memoizes on.

## Behaviour parity

Scroll anchoring and pending-message reconciliation moved with their ordering, their
dependency lists and their `biome-ignore` suppressions intact. The parity guard is the
**existing** `ChatView.test.tsx` / `.headless.` / `.offline.` suites, which pass untouched —
they drive the real component against a fake hub.

## Multi-user behaviour this adds

- **Superagent threads are per-user.** The send route is decided as *data* before any
  mutation is composed; a thread id that is not the principal's is unaddressable. A foreign
  id and a nonexistent one produce the **same refusal with the same wording** — the send
  path cannot be used as an existence oracle (doc §3.1.5).
- **Eviction is not deletion.** An evicted session leaves the view quietly: no toast, no
  tombstone, no removal animation, no re-request of the vanished id. A *deleted* session
  takes the identical exit, deliberately.
- **No spinner without a read.** An invisible referent renders as neither loading-forever
  nor deleted; the spinner is bounded by the initial read, not by the referent.
- **Attribution is a pair, read not asserted.** Rows carry actor + on-behalf-of from server
  fields. The on-behalf-of half is not on this wire yet (POD-1075) and **unknown renders as
  nothing** rather than as "no human" — a different, and false, claim.
- **No payload carries attribution.** `sendText` sends `{sessionId, text, mutationId}`;
  answering a question sends `{sessionId, choices}`. Held by test.

## The composer draft — classified, and the op-stream path left open

Personal class (doc §3.1.1); **not** the per-user state family (§3.3 excludes the draft
body); reserved future conflict class **`op-stream`** (§4), not built here. The view holds
no merge logic at all — one action call per keystroke through the POD-402 seam — so
replacing the mechanism later touches no component. Recorded in
`CHAT_DRAFT_CLASSIFICATION` and in `ChatComposer`'s header.

## Evidence

| Gate | Result |
|---|---|
| `bun run typecheck` | 22/22 green |
| `lint:boundaries` | OK, **0 new** (6 pre-existing allowlisted) |
| Root unit lane | green |
| Web unit lane | **188 files / 1510 tests** green |
| Mobile lane | 4 files / 40 tests green |
| Browser lane (real clicks) | `chat-slice-consumers.browser.e2e.ts` — **send, transcript search, minimap, voice, image-paste — passed** |

The eviction gate was **mutation-checked**: inverting the slice's eviction arm fails 3 of
the partial-world cases, so its pass is evidence rather than decoration.

**Not verified here:** four pre-existing cases in `transcript-loading.browser.e2e.ts` fail
on this branch, all on `newSession` timing out while waiting for the test API to attach.
That is harness capacity, not chat — a **full browser lane was running concurrently in the
POD-406 worktree** on the same box for the duration of these runs. Its case (a), *"a RUNNING
claude session renders its on-disk transcript in the chat view"*, **passes** against the
refactored component, and the new chat-flow suite passes in the same conditions.
