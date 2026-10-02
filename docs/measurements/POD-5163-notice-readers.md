# Message, question and recovery readers

2026-10-02. The coordinator allocated the three web notice components, their tests, new notice schema/source/view/diagnostic modules and, after POD-5167 lands, one registration entry in `app/pool-screens.ts`. Mobile work in this landing is limited to stable action handles. The coordinator confirmed that mobile data readers belong to **POD-5247**, blocked on the mobile pool attachment in POD-4976. The mobile root's always-mounted `MessageNoticeBanner` is included in that separate reader migration.

The startup switch remains **OFF by default**. Final source validation, browser measurements and operator replay are pending the shared registration and summary-reader seam. The independent action and switch checks below are complete; this document will record the final evidence before landing.

## Reader contract

Enable the web readers with `?mobxNotices=1` at page startup. Add `mobxNoticesCheck=1` to install the on-demand `window.__noticeCheck()` differential. The choice is latched once and survives navigation and runtime replacement. Reload without the override to return to the fallback. Ordinary enabled reads never invoke the differential's legacy reference functions.

`notice-schema.ts` declares `messageRecord`, `pendingInteraction`, `outboxDeadLetter`, their resident catalog and the session membership projection before reads. Message and pending-interaction records declare their session relations and inverse membership. Dead letters intentionally declare no target relation: recovery uses the existing outbox's parked author input and normalized refusal, without looking up an inaccessible target. Continuity reuses the existing declared `window.outboxSize`.

The first source demand returns `LOADING` and batches the two existing replica collections and existing outbox snapshot in one microtask. Ordinary replica changes read only addressed message/interaction rows. Replacement and rescope batch a refresh. Catalogs and inverse indexes contain only resident projection IDs. Loaded absence returns `undefined`. Disposal releases both borrowed subscriptions and cancels queued loads.

All view reads pass through `pool.row`. Message labels declare only `sessionId`, `name`, `title`, `cwd` and `agentKind` as session summary fields. Cold session payloads remain unloaded; a missing summary returns `LOADING` and joins the normal batched loads. Pending cards preserve the protocol's answerability and transcript ownership predicates, question variants, ordering and payloads. Parked entries retain the outbox's ordering across unrelated replica changes.

The screen registration attaches the read-side source to the provider's existing pool, runtime, replica and outbox. Dismiss, answer, open-chat, retry, edited-send, discard and confirmation commands keep the existing mutation owner. Web action handles use `useStoreHandle`; mobile pending actions use the existing `useTrpc`, and mobile recovery uses a stable store handle. `MessageNoticeBanner` already used that stable API handle, while `WorkspaceContinuityNotice` has no action selector to replace.

Baseline file-and-line evidence is the seven-module [parent inventory](POD-5082-legacy-reader-inventory.md#message-interaction-and-recovery-banners-7-modules), recorded at lines 203–213: web messages `:34/:80`, pending questions `:48`, recovery `:69/:242`; mobile messages `:24/:28`, pending `:42/:45`, recovery `:28/:184`, continuity `:18/:19`. These are baseline positions rather than current line numbers.

## Flatblock correctness

Validation uses the private `~/podium-test-5163` checkout, its copied checkout-local `.toolchain`, pinned Bun 1.4.2 and a frozen checkout-local dependency graph. Commands run sequentially and select exact files. No whole suite runs, and operator records never move to flatblock.

The independent UI selection is green: **18 tests** across six files (nine web, nine mobile). Enabled UI tests verify dismiss, answer, discard, retry and edited-send payloads using the same owner; legacy selectors throw on the enabled arm. A positive fallback check establishes that the selector and derivation counters detect real legacy work. The startup check covers default OFF, the explicit override, diagnostic opt-in and the once-only latch.

Three planted UI controls each exit nonzero: remove the startup latch, force the legacy message arm, and drop the legacy counter write. Every planted edit is restored, with clean tracked files afterward. Logs are attached to the issue as `ui-evidence`.

The remaining source checks, their planted controls and filtered typecheck will be recorded after POD-5167's seam lands. They cover initial demand/parity, resident relation updates, declared cold summaries, missing-summary batching, outbox ordering/no target reads, rescope/disposal and wrong-value detection in each differential section.

## Chromium and local replay

The browser proof runs the production web components over synthetic operator-sized rows in an isolated Vite child and Chromium, without a backend or daemon. It records activity and notice-update selector/derivation counts, same-owner UI actions and differential positions. Counts-only runs need no timing lease; millisecond samples take `bench:flatblock`. The script owns and stops only its recorded child processes.

The local replay refuses any host except ludovico. It opens the local database read-only with a bounded busy timeout, retains message, interaction and label values only in memory, and exports counts and numeric comparison positions. It does not open credentials, call an RPC or mutate operator data. Device-local recovery is covered by synthetic parked entries rather than pretending the operator database contains the browser outbox.

Results and planted browser/replay controls are pending the shared seam.

## Rollout and retirement

No operator default-ON date is recorded. **POD-5174** already owns deletion of accepted screen fallbacks after the operator's roughly one-week rollback window, including this switch and its legacy reader branches. Mobile data readers continue in POD-5247 after POD-4976. This landing does not claim that either rollout or mobile reactive migration has occurred.
