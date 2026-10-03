# Conversation context pool readers

Conversation context, issue mentions, saved drafts, questions, held sends and reference-miniview context now have a declared pool path. The existing runtime, replica, outbox and mutation actions remain their owners. Transcript controllers, conversation-controller internals, workers and stream stores retain their existing lifecycles.

## Scope and startup switch

POD-4286 allocated this scope before implementation. POD-5092 owns the chat header and session panes; POD-5121 owns the web chip pool/fallback branch. This change touches only RefMiniview's session, machine and repository context tails. Chat-local forwarding hooks use the existing `pool.sessionPanes` reader when chat is enabled, independently of the session-pane switch. Their disabled path calls the original pane hooks.

`mobxChatContext=1` selects the pool path and `mobxChatContext=0` selects the legacy path. Both override the shared device pilot setting. The default is OFF and the choice is latched once at startup, including before the pool attaches. `mobxChatContextCheck=1` installs the opt-in `window.__chatContextCheck()` comparison. No operator default changed in this issue.

The baseline is [POD-5082's legacy-reader inventory](POD-5082-legacy-reader-inventory.md), including its expanded imperative and conversation-adapter evidence.

| Baseline reader | Pool input |
| --- | --- |
| `ChatComposer.tsx:330`, issue mention derivation | Declared issue summary fields and repo prefix relation, preserving mention order and ties |
| `ChatView.tsx`, draft and pending-interaction selectors | Addressed `chatDraft` and notice interaction membership; the unused full issue-model call is removed |
| `OfferArtifactStrip.tsx`, issue ownership and artifact metadata | Addressed issue plus raw session/page-issue relation; existing HTTP and open actions retained |
| `use-chat-surface.ts:271`, imperative issue-projection lookup | Declared issue summary through the pool reader |
| `use-chat-surface.ts:559`, imperative draft seed | Addressed draft restoration through conversation ports |
| `use-chat-surface.ts`, question, attached session, reveal and thread tails | Existing notice, session-pane and shared super-thread sources plus `chatWindow` |
| `use-chat-send.ts:325–326`, record and outbox adapters | Addressed pool record and held-send ports feeding the existing conversation controller |
| `RefMiniview.tsx:81/143/573`, session/machine/repo tails | Declared session summaries and existing header machine/repository rows |
| `use-chat-surface.ts`, session exit metadata | Shared addressed `sessionExit` source; no direct replica row read from the enabled hook |

## Read and load contract

[The chat schema](../../packages/client-graph/src/chat-context-schema.ts) declares seven source entities, cold issue/session summaries and context relations before reading. Notice and Superagent source declarations compose before ingest. Every row value is read through `pool.row`; relation membership uses the existing pool relations. No peek caller or synchronous cold-row lookup is added.

[ChatContextSource](../../packages/client-graph/src/chat-context-source.ts) borrows device drafts/window state and the canonical outbox. Requested draft and held-send rows return LOADING before a microtask load batch. One pending/dead-letter snapshot serves each dirty batch. Ordered ID catalogs preserve replica insertion order for records, mention ties and reference-session selection. They retain IDs only: collection order is collected at initial demand or scope replacement, then amended by addressed updates. Payload indexes remain resident-only; cold values use explicitly declared summary fields.

[The session-exit source](../../packages/client-graph/src/session-exit-source.ts) owns the fixed `SESSION_EXIT_SOURCE_KEY`. Chat registers it unconditionally through `PoolSources.ensure`, so other screens can share one source later. It borrows the existing replica's canonical exit evidence in a microtask batch, refreshes demanded addresses on session updates or rescope, and releases its subscription on disposal. Unknown, removed and evicted remain distinct. The OFF hook is unchanged. Notice and Superagent registration also use their source-owned keys through `ensure`.

[The web hooks](../../apps/web/src/features/chat/use-chat-context.ts) choose their branch from the startup latch, never pool availability. During attachment they expose loading-safe values without legacy derivations. Conversation ports keep listener ownership stable per session. Initial restoration can recreate the controller once; later cold record demand preserves its active draft, optimistic turns and interruption state. Writes still use the original action owner. Parked session resume twins follow the canonical deduplication policy; active identities and headless rows remain separate.

## Focused validation

Candidate `4d957c9e57` passed 215 collected tests across 16 named files on flatblock in `~/podium-test-5173`, using the checkout's `.toolchain` Bun 1.4.2 and checkout-local dependency links. The files cover the new reader/switch, composer, artifact strip, optimistic send hook, ChatView variants, RefMiniview and pool-screen registry. This is a focused result, not a whole-suite or lean-gate result. No full test lane ran.

The final cached typecheck command selected `@podium/web` and `@podium/client-graph`; all 15 required tasks succeeded. Focused Biome lint checked 15 new files without errors. Graph boundary/MobX lint passed for the five new graph files, and the declaration-shadowing check passed for the 23 changed TypeScript files. Tests, typecheck, lint and fault plants ran sequentially on committed candidates, after checking flatblock's one-minute load was at most eight. No timed benchmark or latency claim is made.

The rendered input check fences legacy context collections and the original exit hook. Chat ON with session panes OFF records zero legacy chat/session-pane derivations. The late-attachment check mounts the real send hook in StrictMode, restores its saved draft and held turns after a null pool, then proves a later cold record does not reset the controller. Actual composer and artifact-strip output matches the legacy control, and artifact dispatch retains the same action owner.

All 35 distinct planted checks turned red at their intended assertion, across 41 captures. The attached report records each candidate. The original 28 plants cover each comparison section, ordering, cold summaries, addressed changes, removal, rescope/disposal, ownership, switch latching, legacy fences, late attachment and controller readiness. Six session-exit plants cover batching, canonical entity spelling, addressed refresh, rescope, disposal and the legacy-hook fence; six existing fences/comparison checks were also refreshed after adding exits. The final browser plant disables the omission control and makes the selector-attribution assertion fail. Every plant is committed before its focused check, and original bytes are restored afterwards. A load-admission stop interrupted the final batch before two cases; those cases resumed below the ceiling and both went red.

## Browser and private replay evidence

The real-Chromium capture at `7adf6360ea` uses the actual StoreProvider, kernel replica, runtime, outbox, composer, artifact strip and conversation controller. It compares two independent startup modes with 5,600 synthetic issues and 5,600 sessions, over 12 addressed message/session/draft updates, with session panes OFF. Counts and screenshots are attached to the issue. Saved controller inputs and rendered values match across 37 comparison positions, with zero pending rows; both modes observed the initial null pool.

| Count over the 12 updates | Legacy | Pool |
| --- | ---: | ---: |
| Legacy context derivations | 720 | 0 |
| Issue-view row builds | 12 | 0 |
| Store selector executions | 1,008 | 96 |
| Runtime publishes | 24 | 24 |
| React commits | 12 | 12 |

The remaining 96 browser selector executions are stable handles: `useFileMentions` in `apps/web/src/lib/at-mention/useFileMentions.ts:39` reads only `s.trpc` (48 calls); `OfferArtifactStrip.tsx:36` selects only `httpOrigin`, `openArtifact` and `openFileInWorktree` (48 calls). An artifact-strip omission probe leaves exactly 48 calls and attributes the other 48 by its delta. These are the permitted stable RPC/action boundaries. Transcript/stream stores, send-time focus and the chip fallback do not contribute to these fixture selector counts: the fixture feeds transcript blocks directly and does not mount the miniview chip branch.

The final private ludovico replay at `7adf6360ea` reads operator bootstrap data into a read-only in-memory replica and exports counts and comparison positions only. It covered 5,153 sessions, 6,025 issues, 174 messages and 19 interactions over 70 addressed sessions, with zero differences/pending across 453 positions. The source performed one batch, one outbox snapshot and three initial ID-order reads. Device-local drafts/held sends and principal-scoped thread state are covered synthetically; the bootstrap replay does not contain that device ledger or historical session-exit evidence. Repository paths in the replay come from feed repo metadata rather than the operator's local discovery catalog. The operator server and daemon were neither restarted nor reconfigured.

## Pinned brief fixture and remaining boundaries

The existing pinned-brief assertion first failed at first-parent commit `1d2ff316c7` (transcript-scroll changes, POD-4994/POD-4999). Its parent passed that assertion and the commit failed it. The product correctly skips scroll reconciliation for a zero-height viewport; the happy-dom fixture had provided no viewport or prompt geometry. The fixture now supplies a visible viewport and a prompt above it, dispatches the existing scroll event, and asserts shelf text and DOM order. Removing the production shelf with a plant makes the assertion fail. No transcript-scroll product code changed. Proposed POD-5343 is covered by this repair.

The remaining permitted `use-chat-surface` selector reads stable RPC, hub, replica and action handles only. `getUserFocus` remains the coordinator-approved action port: the engine still reads legacy session/workspace context when sending, and that boundary belongs to the future engine focus migration. RefMiniview's issue-chip fallback remains POD-5121's scope. The enabled conversation hooks do not use either as a data fallback.

POD-5344 tracks legacy conversation-path retirement. After the operator defaults this screen ON, record that date and retire its disabled readers, startup branch and comparison-only legacy derivation in about a week, after checking the rollout comparisons. Preserve the controller/stream and sibling chip/pane ownership boundaries. Until then the legacy path remains available and this screen defaults OFF.
