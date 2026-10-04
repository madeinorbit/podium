# POD-5506 chat composer latency

The composer had three proven keystroke amplifiers: `ConversationController.patch()` rebuilt and published the conversation, the deferred pool draft mirror made React restore the previous controlled value and then write the new one, and the autosize effect reset height before reading `scrollHeight`. Their combined ablation reduced complete-frame main-thread p95 from **68.23 to 31.89 ms** in the same frozen live view. These are overlapping causes; their marginal savings must not be added.

The candidate removes those paths. It also isolates the mission root with `contain: layout paint`, after a separate matched experiment proved that unchanged mission DOM participated in native paint. The **16 ms p95 target remains unmet**: the last production observation was **18.35 ms input-to-paint / 39.41 ms complete-frame work**. The residual is page-size layerization and layout, with ongoing `PhaseTimer` updates, and goes to the render epic through POD-4286. No claim of invisible lag follows from a render-count test alone.

## Reproduction and privacy

The original runtime source is **`1aa0ec71f6` (dev.246)**. The measured final latency candidate is `1140016cea`, rebased onto POD-5497 (`e22a8b6bd9`), POD-5443 (`9f9be4d761`) and the lazy status menus (`6009e5acaa`). The later caret candidate is documented separately below; latency measurements were not repeated for it. Production React **19.2.7**, Bun **1.4.2**, headless Chromium **148.0.7778.96**, viewport **1600 × 1000**, reduced-motion preference, and blocked service workers were used on **ludovico**. An owned loopback production preview on `55606` proxies the existing local backend on `18787`. The operator’s server, daemon and installed dist were untouched.

This follows [POD-4286’s reproduction prerequisites](POD-4286-baseline.md#evidence-and-reproduction): production bundles, checkout-local dependencies, real live hydration followed by settling, and an isolated browser with an in-memory session cookie. `podium auth mint-session --print-only --ttl 30m` is consumed through a pipe in the collector; the token is never printed or saved. Live records, draft strings, cookie data, DOM dumps and screenshots are excluded from evidence. Only numerical measurements, source function names and build provenance are exported. Original drafts are restored and the completed captures verify the ledger is acknowledged after reconnect.

The busy agent stays fixed through a private, local-only pointer that is excluded from source copies and artifacts. The mission’s Full spine view is selected deliberately, so the page-size stress case is explicit. The matched original-source comparison had **38,866 DOM elements, 403 session rows, 6,181 chat-surface elements, 6,187 issue projections and 5,217 sessions**. Later production observations are separate samples of changing live data, not matched before/after replicas. Early surface counts used the first resident chat surface; final counts scope the visible panel.

Each arm types 60 synthetic characters. The matched capture schedules single-character keyboard events against 100 ms deadlines; earlier `keyboard.type(..., {delay:100})` runs added dispatch cost to that interval and are not the principal timing comparison. The collector marks `keydown`, `input` and the following animation frame, then finds the first corresponding main-thread Paint. Input-to-paint ends at the last Paint in that rendering task. Main-thread work includes the complete rendering task, including layerization, rather than stopping at its first Paint. It is elapsed task time and includes host preemption. Later captures retain Chromium thread-clock durations separately.

CPU samples at 1 ms are mapped through the exact bundle’s source maps. Store/derive and React render/commit values are approximate sampled stack attribution; style/layout and paint use timeline durations. Unattributed samples include native `(program)` work and are not all JavaScript. The full-tree React commit observer is expensive, so **render/reaction census and latency are separate captures**. Observer-instrumented latencies are excluded; subtracting observer time alone cannot remove its layout/GC effects.

The controlled ablations freeze only this preview’s network input: its sockets are closed and its fetches aborted after hydration. Connected captures remain separate because unrelated live publications can legitimately render the page while typing. The collector and analyzer are retained as source-only issue artifacts; local raw recordings remain on ludovico.

## Matched original-source ablations

These switches run in a throwaway production preview of the original source, in one browser and one frozen page. Earlier separately compiled controller-only and autosize-only builds independently established the render and measurement counts. The matched preview changes only the indicated seam; it is discarded afterward.

| Arm, 60 keys | Input-to-paint median / p95 / max, ms | Complete-frame main-thread median / p95 / max, ms | Layout median, ms | Value rewrites |
| --- | ---: | ---: | ---: | ---: |
| Original | 44.21 / 53.91 / 61.23 | 53.83 / 68.23 / 71.16 | 18.51 | 120 |
| Conversation draft projection off | 30.11 / 55.35 / 60.44 | 40.85 / 68.63 / 75.95 | 19.46 | 120 |
| Autosize height resets off | 35.68 / 43.37 / 46.76 | 44.49 / 59.18 / 103.42 | 11.25 | 120 |
| Draft mirror made synchronous | 35.44 / 59.15 / 69.62 | 45.92 / 75.20 / 95.72 | 11.08 | 0 |
| All three switches | 14.65 / 19.94 / 21.55 | 22.15 / 31.89 / 43.32 | 3.75 | 0 |

Marginal median main-thread reductions are **24.1%** for conversation projection, **17.4%** for height resets and **14.7%** for the delayed mirror. Individual p95 values are noisy and do not all improve. The combined arm improves median **58.9%** and p95 **53.3%**; this is the principal matched latency proof.

Across the original arm’s 60 key windows, complete-frame task time totals **3,336.58 ms**. Exact style/layout accounts for **1,155.68 ms (34.6%)**, paint/prepaint **403.37 ms (12.1%)**, and layerization **202.03 ms (6.1%)**. Approximate sampled React rendering is **610.93 ms (18.3%)**, React commit **294.53 ms (8.8%)**, and store/derive **87.61 ms (2.6%)**. The remaining time includes native work, other callbacks, sampling error and preemption. These are cost buckets, not independent causal savings.

Per-key sampled store/derive median / p95 / max is **1.32 / 3.42 / 3.64 ms**; React rendering **9.88 / 15.28 / 23.57 ms**; React commit **4.47 / 8.36 / 10.59 ms**. The combined arm lowers sampled React render+commit total from **905.46 to 39.96 ms**. The original runtime’s draft apply still executes; suppressing the controller alone removes **95%** of sampled React rendering while preserving draft saving.

## Work counts and implementation

The original render census recorded `ChatView` and `TranscriptFeed` **62 times** over 60 keys plus two background updates, `ToolBatchView` **1,240**, `ScopedChatComposer` and `ChatComposer` **121**, and `SessionDraftRef` **60**. Disabling controller draft projection reduces the shell/transcript to the two unrelated updates. The delayed controlled-value restoration writes twice per key: **120 writes for 60 native edits**. Switching the composer to its synchronous addressed runtime draft removes both writes; the per-key pool reaction also disappears. The final live census is separate from timing.

Changes:

- `ConversationController.updateDraft()` updates only draft state and full-state draft consumers. The transcript shell subscribes to a stable draft-free surface snapshot; edits do not read records, re-project bubbles or notify surface subscribers. Existing full-state consumers preserve their draft notifications.
- `ScopedChatComposer` reads the addressed draft through `useRuntimeDraft`, synchronously with the runtime’s writer. Voice, quotes, clear/retry and submit continue to use the latest shared draft.
- `useRuntimeDraftRef` updates the native bridge imperatively on the addressed draft event. `AgentPanel` no longer mounts a renderless draft reader on every key.
- Modern main composers use native `field-sizing: content`, fixed sizing for an empty placeholder, and the existing cap. The forced height reset/read effect remains only for older browsers; compact prompts retain their separate sizing policy.
- The root `FlightDeck` owns layout and paint. Its unchanged rows previously repainted with native textarea edits. Its existing scroller already clips children, and the issue/session context menus use portals. Fixed-panel strict containment was rejected because it could clip lifted content.

Draft ledger and runtime persistence code are unchanged. Local edits and addressed draft publishes remain synchronous; saving was already coalesced and is verified rather than newly claimed as a fix. Typical 60-key captures have **60 local edits / 60 addressed publishes, 10–11 device saves**, no outbox publishes, and no issue/session collection scans. In the rebased native-sizing capture, `ClientRuntime.applyDraftToStore` is **0.4 ms p95**, `DraftLedger.localEdit` **0.1 ms p95**, and a scheduled save **1.9 ms p95**. Outbox pending reads still occur, but are below timer resolution and are not publishes. Network draft edits remain debounced, dirty until acknowledged, and re-offered on reconnect. Teardown flush and offline/reload arbitration are preserved.

## Residual native page work

A same-context, network-frozen capture with **37,570 DOM elements** separates native page cost from conversation renders. Hiding only the mission in a throwaway arm lowers median complete-frame time **37.05 → 13.09 ms** and paint/prepaint **9.89 → 1.01 ms**; input-to-paint p95 lowers **70.31 → 20.39 ms**. Hiding the transcript does not help. Panel containment alone lowers layout **5.53 → 1.90 ms** but leaves paint large.

A visibility-preserving comparison with **36,637 DOM elements** proves the selected root-scroller fix: mission `contain: layout paint` lowers median paint/prepaint **10.53 → 1.06 ms** and complete-frame work **39.48 → 23.82 ms**. Removing it restores paint to **8.66 ms**. Whole-frame p95 remains high/variable; no 16 ms claim is made from medians. The shared host had load averages around **10–13 on seven available CPUs** in later runs. Thread-clock measurements confirm native work as well as scheduling effects.

Rejected latency probes: suppressing React `defaultValue` writes, fixing textarea height, absolutely containing the field, pausing all CSS animations, and native offscreen visibility on agent rows did not establish the target. The changed default-text mirror was subsequently removed for caret correctness, as documented below; the other probe rules are not shipped. A compositor layer alone lowers median mission paint but produces unstable tails; root containment is the smaller verified rule. POD-5508 independently owns Safari/WebKit sprite-mask compositing work; its measurements are not substituted for live Chromium results here.

## Focused validation

All tests, typechecks and lint run **foreground on flatblock** in `~/podium-test-5506`, with a copied `.toolchain` and a checkout-local frozen dependency install. No global Bun is modified and no full suite runs. The source mirror excludes live captures and is reconciled against the tracked source inventory, including obsolete rename sources.

The new real-composer regression types **60 characters** and checks on every key: **zero shell/transcript renders, zero programmatic value restores, unchanged outbox/order-scan counters**, and the final authoritative saved draft. Restoring the old `patch({draft})` behavior in a throwaway negative control fails on **key 1**, with **shell=1 / transcript=1**. The source is restored in `finally`.

The focused files cover controller draft isolation, ledger revision arbitration, keyed native-ref updates and session switches, native/fallback autosize, send/IME/Escape behavior, draft retry/clear, native warm-toggle injection and drop handling. They execute **134 cases in eight named files**. The runtime’s `offline-first composer drafts` group adds **12 cases** (38 unrelated cases skipped). Failed fixture files were corrected and rerun individually; the final native/fallback composer run is **34/34 green**. After rebasing onto the observer change, the pool regression and drop files execute **16/16 green**. The scoped web/client-core typecheck finishes **15/15 tasks, eight cached**, and scoped lint is green. These are focused results, not a suite result.

## Final production observation

The committed candidate’s frozen production capture records **45,880 DOM elements, 407 session buttons and 6,884 elements in the visible chat surface**. Native field sizing and mission paint containment are both verified active. This live view has grown since the original matched ablation; the following is an acceptance observation, not another matched causal comparison.

| Metric, 60 keys | Median / p95 / max, ms |
| --- | ---: |
| Input-to-paint | **8.03 / 18.35 / 22.45** |
| Complete-frame main-thread elapsed work | **20.53 / 39.41 / 60.27** |
| Whole-task thread-clock CPU upper bound | **19.45 / 35.91 / 44.95** |
| Style/layout | **4.19 / 10.09 / 14.49** |
| Paint/prepaint | **1.18 / 9.80 / 10.63** |
| Layerization | **5.86 / 9.42 / 16.74** |

There are **zero controlled-value restores, autosize reads, MobX reactions/derivations, issue/session collection scans, issue-chip liveness queries, or outbox publishes**. There are **60 local ledger edits and addressed draft publishes, ten device saves and one debounced draft offer**. The original draft is restored and its acknowledgement verified. Thread-clock CPU excludes host preemption but conservatively includes complete boundary tasks, including the start of the task before the input event.

The **16 ms p95 acceptance fails** in this observation. The residual is chiefly native page layout/layerization, with sampled React render and commit together below 1 ms per key on average.

The separate final render census has **79 commits**, with **60 `ScopedChatComposer` and 60 `ChatComposer` renders**, **19 `PhaseTimer` renders**, three connection-indicator renders, and one coincident session-shell refresh (`ChatView`, `TranscriptFeed`, 37 `ToolBatchView` instances). That refresh overlaps key 19; its cause is not established by temporal overlap. This is not a claim that every live commit outside the composer is zero. The focused negative-control regression establishes zero outside-composer renders caused by each edit, and the timing capture has zero per-key MobX work. Background timer and connection work must be separated from input-induced work when measuring the next candidate.

A matched **42,181-element** live view rejects additional local rules: normal complete-frame median/p95 **21.36 / 41.32 ms**, composer-well layout/style containment **21.76 / 48.25**, feed plus well containment **21.87 / 67.04**, and removal **22.04 / 51.55**. Neither rule is shipped. Two later optional compositor probes failed before typing because of proxy/hydration timeouts; they are excluded from evidence and made no draft edits. Further probes stopped at the POD-4286 coordinator's request to keep the project to six lanes.

The proven fixes fast-forwarded onto **`integrate/4286-pilot` at `51f59c6f34eab263c14625e451ffcba92d5c0c08`** under its merge mutex, with issue-tip ancestry verified. The branch was unoccupied; a compare-and-swap ref update followed an explicit ancestor check. No fetch, push, cherry-pick, stash, or `main`/`dev/mw` mutation was performed here. The release CLI initially failed to infer the repository during a transient backend interruption; the short lease expired, and an explicit repository-scoped check confirmed the mutex was free.

**The 16 ms target is not met.** The remaining page-size layerization and layout work, plus background `PhaseTimer` updates, goes to the render epic **POD-5440** through POD-4286. At the coordinator's request there is no blocking child and no further compositing investigation here; the operator decides whether to accept this result. The issue artifacts include the collector, analyzer and a privacy-checked JSON file with all **360 keystrokes** from the five matched original-source arms and the final timing capture, plus the separate render census and rejected local-rule summaries.

## Urgent caret follow-up

The controlled textarea mirrors each edit into its `defaultValue`, even when its native `value` already matches the synchronous draft. The defensive fix seeds the default once and uses `SyncComposerDraft` to adopt only a genuinely different authoritative draft. Matching native edits perform no value assignment or changed-default-text write. An external update preserves a focused selection and its direction, clamping on clear; a session switch adopts its own draft. Sync runs after the textarea ref attaches and before compact sizing and the mention caret effect. `useRuntimeDraft`, the draft ledger, persistence and offline semantics remain unchanged.

Chrome 148 ordinary trusted mid-text typing did **not** reproduce the operator's reported jump: valid old-source arms kept caret 5→6 while changing the default text once. Switching off that mirror kept the same Chrome caret. Native Chrome does prove the external-sync selection problem: an old controlled field moved caret **5→29** on an updated draft; the defensive candidate kept it at **5**. A live arm whose prepared text changed before the click is excluded. These findings do not establish a native Safari reproduction.

The final production caret source **`d6ff76e4fb`** passes all four native Chrome checks on the owned live-data preview: insertion **5→6**, backward range replacement **[5,8]→[6,6]**, external caret sync **5→5**, and external backward selection sync **[5,8]→[5,8]** with direction retained. Native edits have **zero value assignments and zero changed-default writes**; each actual external text update makes one value assignment and no changed-default write. Captures use the operator's corpus only on ludovico and publish only counts and function names.

The focused Happy DOM regression explicitly models the WebKit event order in which a changed default-text write follows native input and moves the caret to the end. Restoring the old composer fails **four of six** selection cases: mid-text caret **4→7**, and backward selection **[2,5]→[15,15]**, in both skins. The final candidate passes **65 tests in exactly three files** (`ChatComposer`, real-runtime chat-context pool, and mention hooks), web typecheck (**15 successful tasks**) and scoped Biome checks. The real-runtime 60-key guard also checks mid-text range replacement, unchanged default text, zero value assignments, zero outside-composer renders and zero additional outbox/order scans. A compact sizing regression verifies growth on an external draft and shrink on clear.

POD-5508 subsequently completed all four native Safari caret checks using synthetic data on the shared Mac runner. Insertion, backward replacement and both external-selection checks pass, as detailed below. This is acceptance of the defensive fix; the old-source Safari caret failure was not measured here.


## Urgent stale-draft follow-up

The caret bridge is identical in the old/fixed policy comparison. `ClientRuntime.batch()` publishes the addressed draft synchronously, and `ChatComposer` focus only changes focus state. The replay defects are in ledger lifecycle and acknowledgement handling:

- `DraftLedger.snapshot()` omitted empty drafts and `restore()` skipped them. An offline deletion therefore disappeared on reload, allowing the old server text back into the composer. Empty edits now persist and hydrate, including their revision.
- The snapshot omitted acknowledgement state, and `restore()` marked every cached draft dirty. Reload could re-offer a previously confirmed old message over a newer server draft or deletion. The snapshot now retains `dirty`; known confirmed caches hydrate without re-offering, while unsent edits and legacy snapshots still retain offline protection.
- `DraftLedger.adoptRemote()` accepted conflicting older/same-revision documents once the local edit was clean. Those documents now retain the local text and mark it for resend using the server's supplied base. Lower revisions still update the resend base, preserving POD-1204 recovery. An older matching empty document also cannot acknowledge a newer deletion.
- The runtime persisted accepted text but skipped acknowledgement-only changes. It now schedules the existing coalesced save when revision or acknowledgement state changes. `SessionStateService.commitVersionedEdit()` also acknowledges identical offers to their sender; it does not increase the revision, broadcast, or write persistence for that no-op. This lets a retried clear settle when the server already has an empty document.

Focused validation on flatblock with the private Bun 1.4.2 toolchain passed **104 tests in five files**: ledger **23**, offline-first runtime **17** (38 unrelated cases skipped), composer **43**, chat-context pool **13**, and server draft replay/ACK **8**. The 60-input guard still records **zero outside-composer renders, zero additional outbox/order scans, zero native value rewrites, and unchanged default text**. Both composer skins additionally exercise deletion, acknowledgement, two older echoes, repeated focus, and switching away/back. Their setter spy installs before React captures it and checks every intervening write. The two affected cases passed again after that instrumentation correction. Web dependency typecheck passed **15 tasks**, server dependency typecheck **13**, focused Biome reported no errors (existing warnings remain), and the production web build passed. No full suite ran.

Restoring the old **d57f72dbf3** ledger/runtime/server sources in the throwaway flatblock checkout fails **all 13 targeted regression cases**: **9** ledger/runtime, **2** composer skins, and **2** unchanged-offer ACK cases. These failures come from collected tests, not an empty lane. The candidate sources were restored byte-for-byte afterward.

The final native Chrome **148.0.7778.96** comparison uses **44,633 elements, 56 issue rows, 412 agent buttons and 7,195 transcript elements**. It uses the production client content at **35bdefb48f** (the later **4e7b0aff55** change affects only the regression spy).

| Native interaction | Old ledger policy | Fixed ledger policy |
|---|---:|---:|
| Deletion stays empty after each of two older echoes and focus | 0/2 | 2/2 |
| Stale textarea writes during deletion/replay | 2 | 0 |
| Current draft survives each of two older echoes and focus | 0/2 | 2/2 |
| Stale textarea writes during current-draft/focus check | 2 | 0 |

The stale-write observer installs before React captures its prototype setter. An earlier run established final-value failures but installed that counter too late; those counter values are excluded. The final run blocks **9 draft offers** through both policies and never forwards a draft edit to the backend. Both native deletions initially succeeded, so the old policy's failure occurs on later sync, not keyboard routing. Native Chrome evidence and pending Safari acceptance are recorded in the attached draft replay evidence. The production preview contains the repaired client source, with only the original ledger policy swapped into the first comparison arm. All outgoing `draftEdit` and `setSessionDraft` frames are blocked before any draft input; incoming real draft frames are frozen during the synthetic comparison. Synthetic documents enter the existing `SocketHub` event/runtime ledger path. This keeps the operator backend unchanged and all live data on ludovico. A separate old full-bundle attempt timed out before hydration and is excluded. Source/bundle provenance is checked by matching the production files with the validated flatblock copy; that mirror's build stamp names its own checkout rather than this issue SHA.

Native Safari typing and caret checks are complete in the existing POD-5508 acceptance lane. Its stale-wire replay check remains pending: a fixture HTTP-response decoder failure stopped the first attempt before the native clear/replay sequence, so that attempt supplies no product failure or acceptance result. The lane fixed its decoder and is arranging a short serial window after POD-5517. No new Chrome live-data captures or compositing probes ran here: **18.35 / 39.41 ms** remains the last measured Chrome p95, and the **16 ms target is not met**.

## Native Safari acceptance supplied by POD-5508

POD-5508 supplied these results at **19:41 UTC on 2026-10-04**, using production client source **35bdefb48f**, whose composer/caret/replay behavior matches the landed **f9da51c7df** repair and includes its static working marks. Its [WebKit report](POD-4286-webkit-typing.md) and issue artifacts own the raw native evidence. This is an independent synthetic acceptance lane; no operator records or drafts were copied to the Mac runner.

All three 1× runs contain **60 trusted inputs**, with the intact final text, a foreground/focused Safari window, an **800 × 600** viewport and **DPR 2**. The strict loaded replica contains **4,868 issues / 4,306 sessions**; the selected transcript mounts **200 rows**, **2,558 transcript elements** and **4,516 total DOM elements**. The collector measures **input event timestamp → the zero-delay timer after the next animation frame**, a paint proxy. It does not measure Chrome's trace-derived input-to-Paint or complete-frame main-thread work, so these results cannot replace the live Chrome measurements above.

| Synthetic Safari run | Input → post-frame timer median / p95 / max, ms | Actual input interval median / p95, ms |
| --- | ---: | ---: |
| 1× repeat 1 | 7 / **20** / 44 | 107 / 244 |
| 1× repeat 2 | 7 / **25** / 131 | 107 / 245 |
| 1× repeat 3 | 9 / **17** / 95 | 123 / 238 |

These runs meet POD-5508's **p95 < 50 ms** synthetic 1× criterion. They do not establish this issue's **16 ms main-thread** target or a 4× guarantee.

All four separate native Safari caret boundaries pass: insertion at **5→6**, backward replacement to collapsed **6**, an external append retaining collapsed **5**, and an external append retaining backward range **[5,8]** and its direction. Native stale-draft replay and matched final Chrome fixture checks remain pending in that lane. POD-5508 reports that its owned Mac browser, driver and preview were stopped and verified at **19:33 UTC**; this issue started no runner processes.
