# Eager bundle budget repair (POD-2190)

What the epic did to the web app's first paint, measured rather than guessed, and
what was done about it.

## The breach

At the integration tip `4b9932884`, `scripts/web-bundle-budget.ts --check` failed
two budgets that pass on `main`:

| Budget | Main | Tip | Ceiling | Over by |
| --- | --- | --- | --- | --- |
| eager gzip bytes | green | 655,572 | 655,000 | **572** |
| eager parsed source bytes | green | 7,459,319 | 7,400,000 | **59,319** |

Both builds are production `vite build` at the same SHA-pair on the same host,
maps emitted, dist deleted after each.

The four **settings** budgets are also red at the tip — and they are red on `main`
too (raw 254,195 against a 105,000 ceiling). They are pre-existing and are not
this issue's.

## Attribution

The eager graph is whatever `index.html` references. Diffing per-source parsed
bytes across that graph, tip against main:

| Bytes | Module |
| --- | --- |
| +33,314 | `apps/web/src/features/updates/operation-view.ts` (new) |
| +8,965 | `packages/protocol/src/operation/operation.ts` (new) |
| +8,636 | `apps/web/src/features/updates/UpdatePanel.tsx` (new) |
| +6,854 | `apps/web/src/features/updates/updates-context.tsx` (new) |
| +5,772 | `apps/web/src/features/updates/operations-client.ts` (new) |
| +5,345 | `apps/web/src/features/updates/use-update-state.ts` |
| +4,349 | `apps/web/src/lib/nativeDesktop.ts` |
| −11,196 | `apps/web/src/features/updates/UpdateDialog.tsx` (deleted) |
| −2,714 | `apps/web/src/app/UpdatePrompt.tsx` (deleted) |
| **+73,268** | **net** |

So it is the panel work (POD-2102), as suspected — but the suspicion was worth
checking rather than acting on, because POD-2103's Settings contribution appears
nowhere in this list, exactly as POD-2103 said when it measured its own eager cost
at 26 bytes.

`operation-view.ts` alone is 45% of the growth, and the protocol's operation
parser is dragged in behind `operations-client.ts`'s `parseOperation`.

**One door causes all of it.** `AppShell` mounts `UpdatesProvider`, and the
provider statically imported the poller, the view model and the renderer. Nothing
else eager reaches them: `StatusStrip` and `WireSkewBanner` touch only
type-only imports and the module-level opener channel, and the Settings
sections that use `operation-view` are in a lazy chunk.

## The repair

None of that machinery can do anything until a poll has come back saying there is
something to show, and a poll cannot come back before the app has painted.

- `UpdatesProvider` is now a **loader**. Its entire previous body is
  `UpdatesEngine`, in a chunk fetched on mount.
- **On mount, not on demand.** Waiting for a click would mean fetching a hashed
  chunk at the moment an update replaces the dist that serves it — a 404 exactly
  when the update needs a UI. Fetching at mount puts the request in the same
  window as every other boot request.
- **`children` sit outside the Suspense boundary**, so the shell's store, replica
  and socket neither wait for the chunk nor remount when it lands.
- The strip↔engine seam is a **module-level store**, not a context. A context
  needs an ancestor, and needing an ancestor is precisely what forced the engine
  to be eager. Before the engine publishes, the store answers "no update" — not a
  placeholder, the truth, since no poll has returned.
- `IndicatorState` moves to its own leaf module. It was reached through
  `import type`, which costs nothing today but is one dropped keyword from
  dragging 33 KB back onto the first paint.

`open-panel.ts` needed no change: it already exposes `hasUpdatePanel` and
`subscribeUpdatePanel` so an outside caller can relabel itself when the opener
appears, which is exactly the window a deferred engine creates.

## The guard

A byte ceiling alone would not hold this. The overage was 572 bytes of gzip, so
the next person to nudge the eager graph would re-fire a number that names no
cause and suggests no fix.

So `web-bundle-budget.ts` now also fails when any of six engine modules —
`operation-view`, `update-view`, `use-update-state`, `operations-client`,
`UpdatePanel`, `UpdatesEngine` — appears in the eager graph, in the same shape as
the existing ownership-matrix and command-source guards.

**Proven armed**, by replaying its matcher over the real pre-fix eager source
list: it fires on the tip naming five of its six modules. It also fires on
`main`, where `update-view` and `use-update-state` were already eager through the
old `UpdatePrompt` — so this is a genuine tightening rather than a restoration of
main's state.

## Gates

- `apps/web` suites, run with the working directory set to `apps/web`:
  `src/features/updates` + `src/app` + `src/features/settings/sections/updates`.
- The surface's ten behavioural tests move with the engine, unchanged, so what
  they proved about hide/indicator/reopen they still prove.
- Three new tests cover the seam through the **real** lazy boundary: the engine
  loads on mount and reaches both halves; children render on the first paint and
  are not remounted when the chunk lands; the store answers "no update" with no
  engine mounted.
- Shared red lanes are gated on the comparison, not a bare green: the `apps/web`
  typecheck failure set is byte-identical to the fork point's (10 errors, six
  files, none of them this change's), and the three failing `src/app` tests
  (type-floor ×2, replica private-mode) reproduce identically at `4b9932884`.

## Result

Rebuilt at `bcb1e05c1`, same host, same production build:

| Budget | Tip | After | Ceiling | Headroom |
| --- | --- | --- | --- | --- |
| eager gzip bytes | 655,572 ✗ | **645,579** | 655,000 | 9,421 |
| eager parsed source bytes | 7,459,319 ✗ | **7,362,687** | 7,400,000 | 37,313 |
| eager raw bytes | 2,199,140 | **2,169,000** | 2,200,000 | 31,000 |
| eager Brotli bytes | 543,448 | **535,885** | 545,000 | 9,115 |

96,632 bytes of parsed source and 9,993 bytes of gzip off the first paint, and
`updateEngineSources` is empty.

The four settings budgets still fail, unchanged, exactly as they do on `main`.

The guard was then re-armed live: reverting the provider to a static import and
rebuilding put both eager budgets back over and printed

```
[web-bundle-budget] update engine is eager, so the panel is back on the first
paint: operation-view.ts, update-view.ts, use-update-state.ts,
operations-client.ts, UpdatePanel.tsx, UpdatesEngine.tsx
```

so the check fails for a reason that names its own cause. The edit was reverted
and the lease released.
