# The settings pane took the whole harness registry into the browser

POD-2206, closing POD-2176 (crash) and POD-2192 (four red budgets). Measured on
the dev host, 2026-08-16, against integration `worktree-updater-spec`.

Both findings are one commit. `091f4f80b` (POD-833, 2026-08-14) added a single
import to `apps/web/src/features/settings/sections/shared.tsx`:

```ts
import { harnessSupportsNoTools } from '@podium/harness/metadata'
```

It was the only `@podium/harness` import in the whole web app, and it was there
for one boolean: the shipwright role offers only harnesses with a native
all-tools-off mechanism, which today means `claude-code` alone.

## What that one import cost

`./metadata` re-exports `./registry.js`, which holds `AGENT_MANIFESTS`, which
pulls all five manifests, `@podium/transcript`, and `@podium/runtime`'s sqlite
modules. Measured in the `SettingsView` chunk before the fix:

| in the chunk | source bytes | files |
| --- | ---: | ---: |
| `packages/harness` | 492,524 | 42 |
| `packages/transcript` | 139,679 | 14 |
| `packages/runtime/src/sqlite` | 19,882 | 5 |
| **from that one import** | **652,085** | **61** |
| the settings feature itself | 202,042 | 21 |
| chunk total | 867,740 | 84 |

75% of the chunk, for one boolean. And `packages/runtime/src/sqlite/{bun,node}.ts`
evaluate `createRequire(import.meta.url)` at **module scope**; the built chunk
contained the call verbatim. In a browser `node:module` is a stub, so
`createRequire` is not a function and the chunk throws while it is still being
evaluated — every route under `/settings` was gone in any built bundle.

## The ceilings were not stale

Worth stating because the brief offered raising them as an option. The settings
budgets were calibrated in `27fc12b70` (POD-848, "slim browser package
boundaries") on 2026-08-13 — **one day before** the import landed. They were
honest when set and correctly refused what came next, so none is raised here.

## Before / after

Both columns are `vite build` in this worktree at the same resolution; the
"before" is a real build of the pre-fix commit, not an estimate.

| budget | before | after | ceiling |
| --- | ---: | ---: | ---: |
| settings raw | 261,050 | 79,216 | 105,000 |
| settings gzip | 76,669 | 23,450 | 30,000 |
| settings Brotli | 63,401 | 20,320 | 26,000 |
| settings parsed source | 867,740 | 220,588 | 280,000 |
| host-only sources in any browser chunk | 61 | 0 | 0 |
| `createRequire` in any `dist` chunk | present | absent | — |

`bun scripts/web-bundle-budget.ts apps/web/dist --check` exits 0.

The four EAGER budgets are **not** part of this. They read red in the first
measurement I took, and that was an artifact: this worktree had no
`node_modules`, so `@podium/*` resolved six levels up into the main checkout
(POD-746), which lacks this branch's `c433c1383`. Rebuilt at the pre-fix commit
with correct resolution, the eager budgets are green and exactly four settings
budgets fail — matching the brief. Nothing to file.

## The fix

`@podium/harness/browser` is a new leaf that imports nothing at runtime (one
type import, erased). `./registry.ts` re-exports the predicate from it, so there
is one implementation and no call site changed. The manifests keep declaring
`headless.noTools` — that is where a person adding a harness writes it down —
and `browser.test.ts` asserts the table and the manifests agree per harness.

`packages/harness` moves from `node-only` to `neutral`. That is the fix, not a
relaxation: the package is genuinely two-halved, and `node-only` powers an
all-or-nothing rule, so the only way to give a bundle one static fact was to
refuse the package whole.

## Why nothing caught it for two days

Both gates that could see it did fire, in a currency nobody reads at the time:

- `lint:architecture` named the file **exactly** — `browser-safe apps/web imports
  node-only packages/harness via '@podium/harness/metadata' — a browser bundle
  would inline Node code` — and exits 1. It sits in a lane red for four unrelated
  pre-existing violations, and has been since before this import landed.
- The size budgets went red, in a set already red.

Neither said "the settings pane is gone in every real build". So the size ratchet
now carries a check that says that, in crashes rather than bytes.

## Every guard here was proven able to fail

A gate proven only to pass is not proven.

| guard | probe | result |
| --- | --- | --- |
| the new size-ratchet check | ran it against the pre-fix `dist` | 61 sources, exit 1 |
| `browser.test.ts` parity | flipped `codex` to `true` in the table | 2 assertions failed, naming codex |
| `manifest-browser-reach` (a) | restored the `./metadata` import | refused, and names `@podium/harness/browser` as the alternative |
| `manifest-browser-reach` (b) | added `node:fs` to `browser.ts` | refused: "the workspace is tagged NEUTRAL on the strength of this closure staying Node-free" |

## Gates

- `packages/harness` typecheck: 6/6 tasks green.
- `browser.test.ts` 4/4; `apps/web` `shared.test.tsx` 8/8 (covers the shipwright
  filter, so the behaviour is unchanged through the import swap).
- `apps/web` typecheck: 10 errors, none naming any file this change touches —
  the known-red lane (POD-2109).
- `lint:architecture`, A/B against the pre-fix commit: one violation **removed**
  (this one), zero added. The lane stays red on nine pre-existing violations.
