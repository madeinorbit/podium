# Message, question and recovery readers

2026-10-02. Branch base: `integrate/4286-pilot`, rebased onto the landed source/summary seam and its repair at `1f4c442abb`. The coordinator allocated the three web notice components, their tests, new notice schema/source/view/diagnostic modules and one registration entry/import in `app/pool-screens.ts`. Mobile work in this landing is limited to stable action handles. The coordinator confirmed that mobile data readers belong to **POD-5247**, blocked on the mobile pool attachment in POD-4976. The mobile root's always-mounted `MessageNoticeBanner` is included in that separate reader migration.

The startup switch remains **OFF by default**. Enabled web notice readers execute zero legacy selectors or collection derivations in real Chromium, including their dialog actions. The synthetic differential and the ludovico-only operator replay have zero differences and pending loads. Opening a chat still builds one session index in the existing command runtime; the coordinator explicitly classified that as separate **POD-5089** work. This is notice-reader correctness evidence, not a claim that the entire runtime or mobile app has retired its legacy path.

## Reader contract

Enable the web readers with `?mobxNotices=1` at page startup. Add `mobxNoticesCheck=1` to install the on-demand `window.__noticeCheck()` differential. The choice is latched once and survives navigation and runtime replacement. Reload without the override to return to the fallback. Ordinary enabled reads never invoke the differential's legacy reference functions.

`notice-schema.ts` declares `messageRecord`, `pendingInteraction`, `outboxDeadLetter`, their resident catalog and the session membership projection before reads. Message and pending-interaction records declare their session relations and inverse membership. Dead letters intentionally declare no target relation: recovery uses the existing outbox's parked author input and normalized refusal, without looking up an inaccessible target. Continuity reuses the existing declared `window.outboxSize`.

The first source demand returns `LOADING` and batches the two existing replica collections and existing outbox snapshot in one microtask. Ordinary replica changes read only addressed message/interaction rows. Replacement and rescope batch a refresh. Catalogs and inverse indexes contain only resident projection IDs. Loaded absence returns `undefined`. Disposal releases both borrowed subscriptions and cancels queued loads.

All view reads pass through `pool.row`. Message labels declare only `sessionId`, `name`, `title`, `cwd` and `agentKind` as session summary fields. Cold session payloads remain unloaded; a missing summary returns `LOADING` and joins the normal batched loads. Pending cards preserve the protocol's answerability and transcript ownership predicates, question variants, ordering and payloads. Parked entries retain the outbox's ordering across unrelated replica changes.

The internal source accepts its declared entity union, matching the repaired registration contract. Public `pool.row` calls retain their entity-specific return types. No shared engine, replica, viewmodel, pool implementation or mobile client-wiring file is changed by this issue.

The screen registration attaches the read-side source to the provider's existing pool, runtime, replica and outbox. Dismiss, answer, open-chat, retry, edited-send, discard and confirmation commands keep the existing mutation owner. Web action handles use `useStoreHandle`; mobile pending actions use the existing `useTrpc`, and mobile recovery uses a stable store handle. `MessageNoticeBanner` already used that stable API handle, while `WorkspaceContinuityNotice` has no action selector to replace.

Baseline file-and-line evidence is the seven-module [parent inventory](POD-5082-legacy-reader-inventory.md#message-interaction-and-recovery-banners-7-modules), recorded at lines 203–213: web messages `:34/:80`, pending questions `:48`, recovery `:69/:242`; mobile messages `:24/:28`, pending `:42/:45`, recovery `:28/:184`, continuity `:18/:19`. These are baseline positions rather than current line numbers.

## Flatblock correctness

Validation uses the private `~/podium-test-5163` checkout, its copied checkout-local `.toolchain`, pinned Bun 1.4.2 and a frozen checkout-local dependency graph. Commands run sequentially and select exact files. No whole suite runs, and operator records never move to flatblock.

The independent UI selection is green: **18 tests** across five files (nine web, nine mobile). Enabled UI tests verify dismiss, answer, discard, retry and edited-send payloads using the same owner; legacy selectors throw on the enabled arm. A positive fallback check establishes that the selector and derivation counters detect real legacy work. The startup check covers default OFF, the explicit override, diagnostic opt-in and the once-only latch.

Three planted UI controls each exit nonzero: remove the startup latch, force the legacy message arm, and drop the legacy counter write. Every planted edit is restored, with clean tracked files afterward. Logs are attached to the issue as `ui-evidence`.

The exact `notice-source.test.ts` selection is green: **seven tests**, making **25 tests across six focused files** with the UI selection. It covers initial demand/parity, resident relation updates, declared cold summaries without payload hydration, missing-summary batching, outbox ordering/no target reads, rescope/disposal and wrong-value detection in each differential section. Initial demand performs one batch, two replica collection reads and one outbox read; ordinary addressed deltas do not repeat those collection scans. The synthetic comparison covers three attention notices, twelve pending-card variants and five parked records: **20 positions, zero differences, zero pending**.

All nine source controls fail at their intended assertions: lose batching, alter an excerpt, lose inverse membership, omit declared label fields, lose the pending signal, sort parked entries incorrectly, look up a recovery target, leak subscriptions and suppress reported differences. A preliminary regular-row-read plant stayed green in the missing-label check because it also returned `LOADING` and batched the missing load; it was replaced with the pending-signal plant. Every edit is restored and the complete seven-test file is green afterward.

Filtered typechecks are green for client-graph, web and mobile. After the shared seam repair, the owned source signature was aligned to its entity-union contract; no settings-source edit was necessary. The final web-filtered run also checked its graph/dependency projects: **16 successful tasks, 14 cache hits**. Mobile's filtered task was green in the preceding combined run. Cache hits are trusted; no bypass or whole-suite command is used.

## Chromium and local replay

The browser proof runs the production web components over 5,600 synthetic tasks, about 5,000 sessions and the notice corpus in an isolated Vite child and Chromium, without a backend or daemon. The before arm uses fallback data readers with the same stable action handles as the enabled arm. Both renders use the app's Podium theme. The script owns and stops only its recorded Vite/browser children.

| Workload | Legacy selectors, before → after | Notice collection derivations, before → after | React commits, before → after |
| --- | ---: | ---: | ---: |
| 200 session activity changes | 800 → **0** | 200 → **0** | 200 → **0** |
| 30 message/interaction update frames | 240 → **0** | 60 → **0** | 30 → **30** |
| Dismiss, open chat, answer, discard | 18 → **0** | 2 → **0** | Not measured |

The global published-slice counter is zero in both activity/update phases. The action phase records `sessionById: 1` in both arms, from the preserved engine focus/mark-read reaction (`engine/reactions.ts:403/428`; the shared index records at `session-index.ts:18`). The coordinator assigned its retirement to POD-5089 and confirmed it does not block this scope. The proof allows at most that one named owner index and still rejects every selector, notice derivation and other global slice. The separately filed POD-5259 remains an unclaimed Proposed discovery pointing to this finding; marking a Proposed duplicate is operator-only.

Chromium observes dismiss/answer through the same API owner, opening `cold-notice-session`, and discard through the existing outbox with five parked entries becoming four. The enabled differential checks **20 positions before actions** and **17 afterward**, with **zero differences and zero pending** in both. Comparison calls occur outside measured reader/action windows. There are no provider or browser errors.

Four browser controls each exit nonzero at their named assertions: force the legacy message reader during activity; alter its excerpt before comparison; plant an action selector inside the recovery dialog; and report a post-action comparison error. All are restored before the final normal proof.

The coordinator accepts count measurements for this lane. The final run is counts-only; no millisecond or heap result is claimed, and no benchmark lease is held. The optional timing queue was canceled while POD-5250 held `bench:flatblock`.

The local replay refuses any host except ludovico. It opens the local database read-only with a bounded busy timeout, retains message, interaction and label values only in memory, and exports counts and numeric comparison positions. It does not open credentials, call an RPC or mutate operator data. Device-local recovery is covered by synthetic parked entries rather than pretending the operator database contains the browser outbox.

The replay is green on **five current pending questions: five positions, zero differences, zero pending**. It has 5,278 local session rows available, but no undismissed failed/expired/unknown message records in that operator snapshot. Real message-label parity and device-local recovery are therefore not exercised by this replay; their behavior is covered by the synthetic source/UI/browser corpus. Planting an incorrect window outbox size produces **one difference, zero pending** at the `outboxSize` field. The edit is restored, with no operator data written or exported.

The issue's attached evidence includes the count-only browser JSON and surface/recovery screenshots, six-file focused-test results, filtered typecheck logs, all **17 successful red controls** (three UI, nine source, four browser, one replay), and numeric operator reports. Screenshots and scratch logs are not committed.

## Rollout and retirement

No operator default-ON date is recorded. **POD-5174** already owns deletion of accepted screen fallbacks after the operator's roughly one-week rollback window, including this switch and its legacy reader branches. Mobile data readers continue in POD-5247 after POD-4976. This landing does not claim that either rollout or mobile reactive migration has occurred.
