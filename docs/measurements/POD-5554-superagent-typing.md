# Superagent composer typing latency

The compact composer still reset its height and forced layout on every key after the shared draft/transcript fixes landed. Native content sizing removes those reads and writes. In a matched production comparison, input-to-first-paint p95 improves **24.1 → 18.8 ms at 1×** and **36.3 → 17.0 ms at 4×**.

## Cause and causal check

`ChatComposer` mounts `PromptAutoGrow` for compact prompts. Its `usePromptAutoGrow.apply()` set `height:auto`, read computed style, `scrollHeight` and the pane height, restored the pixel height, read `offsetHeight` to pin a transition, then wrote the final height. It did all of this even when the target height stayed unchanged. The ordinary chat's native-sizing fix deliberately excluded this compact path.

A separate work census records **60 scrollHeight reads, 60 offsetHeight reads, 60 computed-style reads and 180 height writes for 60 keys**. The old-bundle CPU profile's largest named source frame is the sizing callback: 336.3 ms of self samples across the capture. The exact retained source map resolves `ChatView-BN_2c9NI.js:2:14775` to `src/lib/use-prompt-auto-grow.ts:100:5`. This includes synchronous native work charged to the JavaScript layout-reading site; it is not a measurement of pure JavaScript execution. Unnamed native/background samples remain outside that attribution.

A throwaway browser ablation freezes only the compact field's sizing getters/writes on the unchanged bundle. It reduces 1× median input-to-paint **16.7 → 11.2 ms**, p95 **24.1 → 19.5 ms**, and median layout/style work **6.2 → 3.5 ms**. This ablation intentionally disables growth and supplies causal evidence, not a shipping implementation. Profiled and work-wrapper captures do not enter the acceptance table.

## Change

On browsers supporting `field-sizing:content`, CSS owns content growth and scrolling. The hook publishes the existing eight-line / 42%-of-pane cap on mount and pane resize. Empty fields remain one line even when the placeholder wraps. External drafts are still adopted before layout; draft ownership, persistence and send behavior use the existing shared path.

Older webviews retain animated pixel sizing. When the measured fit has not changed, they restore the previous height without the second transition-pinning reflow. No store, pool, transcript or superagent question reader changes are included.

## Matched production comparison

Each row contains 60 trusted single-character insertions paced at approximately 100 ms. Latency ends at the first actual Chromium main-thread `Paint` following the marked `beforeinput` event, not a timer or an assumed animation frame. The collector also retains the post-frame timer separately. Percentiles use nearest rank; median averages the middle pair.

| Scale | Before median / p95 / max, ms | After median / p95 / max, ms | p95 change |
| --- | ---: | ---: | ---: |
| 1× | 16.65 / 24.06 / 51.59 | 7.98 / 18.78 / 32.95 | −22.0% |
| 4× | 20.18 / 36.30 / 85.50 | 13.79 / 16.96 / 60.09 | −53.3% |

Per-key trace windows extend to the next input and include intervening background/render work. Layout/style and FunctionCall durations overlap and must not be added.

| Scale | Layout/style median / p95 before → after, ms | FunctionCall median / p95 before → after, ms |
| --- | ---: | ---: |
| 1× | 6.19 / 13.09 → 3.41 / 6.06 | 10.99 / 19.20 → 3.21 / 6.98 |
| 4× | 15.07 / 21.13 → 7.79 / 11.44 | 14.70 / 26.79 → 2.96 / 6.03 |

The final separate work census records **zero scrollHeight reads, offsetHeight reads, computed-style reads or height writes during all 60 keys**. Its runtime sizing probes observe: empty height 24 px; eight-line cap 150 px with scrolling; resized-pane cap 118 px for a 117.6 px target; clear after resize returns to 24 px.

## Provenance and limits

- Before product source: `5ee6a6f9b8` (production build `0084a118e7`, whose only additional file is the collector). After product source/build: `8d65ed2fda`. Subsequent collector/report commits do not change the tested product bytes.
- Chromium 151.0.0.0, production React, 1600 × 1000 viewport, unthrottled CPU, default motion preference, fresh browser contexts and blocked service workers. The synthetic-only loopback previews use ports 19554–19557; the operator backend is untouched.
- POD-5501's validated seed-4443 corpus: 4,867 issues / 4,304 sessions at 1×; 19,468 / 17,216 at 4×. Semantic SHA-256: `2458ea73e0e6182b8f67ae7b0aa618e882fcb60bc9dd9eaf5778e42e1261363e` and `b6ad3a359fa48bd74c113577bd43484507e2acc0ce08cb81843a8296a94cf82a`. The preview adds control rows and a 4,400-item synthetic transcript; the superagent displays its bounded transcript tail. The full corpus is verified through the production decoder and a separate durable-storage census.
- Matched DOM cardinality: 8,253 elements at 1× and 22,698 at 4× in both arms. The 1× durable census contains 4,868 issue projections and 4,307 sessions including fixture controls.
- Captures run sequentially on ludovico under `bench:ludovico`. Full-repository transfer to flatblock was rejected by automatic approval review, so no repository export was performed. Only the existing synthetic corpus was retrieved. One-minute load averages before/after are 5.34/5.16 at 1× and 6.14/8.25 at 4×; all three load averages remain in raw evidence.
- These are one matched pair per scale on the current integration code, including the earlier shared composer fixes. They do not reproduce or replace POD-5501's historical 20.2 → 58.5 ms comparison on flatblock, which used only 16 unprofiled samples and a different revision/method. Scheduling and background work still produce occasional slow frames; this is not a universal latency bound or a Safari measurement.
- Blocking service workers produces existing Workbox registration errors in both arms, retained in raw evidence. The trusted inputs, final text and actual paint count are checked. Early captures interrupted by a recorder bug or an incorrect panel-open assumption are excluded; the corrected captures complete all 60 keys.

## Validation and reproduction

The focused regression uses the real compact composer with addressed runtime draft events and rejects sizing reads/writes on every one of 60 keys. Additional cases cover the pane cap, one-line floor and unchanged-height fallback. The existing composer suite covers external draft adoption, caret selection, send, IME and Escape.

- `bun run test:file -- apps/web/src/features/chat/ChatComposer.test.tsx apps/web/src/lib/use-prompt-auto-grow.test.ts`: **55 passed across two files** (46 composer, nine sizing arithmetic). This is focused evidence, not a suite result.
- Restoring the original sizing hook in a protected negative control fails the new compact regression on **key 1**: `get scrollHeight` was called once. The fixed source bytes are restored in `finally` and match the measured product commit.
- `bun run test`: workspace typecheck **28/28 green**; span-effect lint green (162 bodies, zero unclassified effects). The **lean gate is red**, with 153 passed and one failure across its four files. The failure is the existing POD-2807 cache-coverage assertion: `packages/terminal-client/test/session-mount.query-replies.test.ts` imports three server files absent from the terminal-client typecheck cache key. The test, imported files and `turbo.json` are byte-unchanged from this issue's base. This independent defect is filed as **Proposed POD-5578**, linked with `discovered-from`; no cache bypass or adjacent product change is made.
- Both production client builds succeed. The owned preview and harness PIDs are stopped and the timing lease released. There is no full-suite, additional browser-suite or multi-instance run.

Reproduce with a checkout-local frozen install and `bun run build:clients`. Run `apps/web/harness/webkit-typing-server.mjs` with the existing corpus, `--scale=1` or `--scale=4`, and private backend/preview ports. Under a host timing lease, run `bun --conditions=@podium/source apps/web/harness/superagent-typing.mjs --origin=<preview> --mode=timing --out=<owned-path> --chromium=<installed-Chromium>`. Use `--mode=work --check-sizing` for the separate work/sizing census, `--mode=profile` for source attribution, and `--ablate` only on the original bundle for the sizing ablation. The collector closes its browser; stop only the preview PIDs recorded in each fixture's manifest.
