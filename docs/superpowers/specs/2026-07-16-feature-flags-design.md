# Feature flags + Experimental settings page — design (POD-677, [spec:SP-f4b9])

Date: 2026-07-16. Author: coordinator session on POD-677.

## Goal

A pre-release feature-flag system that hides unfinished features. Each flag has a
user-facing **name** and **description** and a **visibility level** that controls where it
appears on a new Settings page called **Experimental**:

- `hidden` — never listed in Experimental; enableable ONLY via the config file
  (`~/.podium/config.json`) — EXCEPT in development mode, where it IS listed.
- `edge` — listed in Experimental only on installs whose update channel is `edge`.
- `stable` — listed in Experimental on every install (stable and edge).

Development mode lists **all** flags regardless of visibility.

## What exists (verified in repo)

- Update channel `'stable' | 'edge'`: `resolveUpdateChannel()` in
  `packages/runtime/src/config.ts:255-261` (env → config.json → 'stable').
- Dev-mode sentinel: `appVersion === 'dev'` — `process.env.PODIUM_APP_VERSION ?? 'dev'`
  (`apps/server/src/server.ts:97-106`); real versions are injected only by
  `scripts/build-bun.ts` at build time. A source/bun run is dev mode.
- Operator config: `PodiumConfig` zod schema + layered resolvers in
  `packages/runtime/src/config.ts` (precedence doctrine: env → config.json → default).
- User settings: `PodiumSettings` zod blob in `packages/runtime/src/settings.ts:234-311`,
  persisted whole as one JSON row in the SQLite `meta` table
  (`apps/server/src/store/settings.ts`), served via tRPC `settings.get` / `settings.set`
  (`apps/server/src/router.ts:796-807`). **No DB migration needed** for new blob fields.
- Settings UI: `apps/web/src/features/settings/` — sections registered in
  `SettingsView.tsx` in three spots (`SettingsTab` union ~line 26, `SETTINGS_TABS` ~43,
  `SECTION_VIEWS` ~78). Blob-editing sections receive `{ settings, patch }` and the shared
  `Section`/`Row` primitives from `sections/shared.tsx`; toggles are the shadcn/Base-UI
  `Switch` (see `sections/hibernation.tsx` for the canonical pattern). Changes commit via
  the page's Save button (`trpc.settings.set` with the whole blob).

## Design

### 1. Flag registry — `packages/protocol/src/features.ts` (new file)

Shared, pure data + pure logic (protocol is imported by both server and web):

```ts
export type FeatureVisibility = 'hidden' | 'edge' | 'stable'

export interface FeatureDefinition {
  /** Stable kebab-case id — the key used in config.json and settings. Never renamed. */
  id: string
  /** User-facing name shown in Settings → Experimental. */
  name: string
  /** User-facing description shown under the name. */
  description: string
  /** Where the flag appears in Experimental (see doc header). */
  visibility: FeatureVisibility
}

export const FEATURES = [
  {
    id: 'sample-experiment',
    name: 'Sample experiment',
    description:
      'Demonstrates the experimental-features system. Does nothing; remove when the first real flag lands.',
    visibility: 'hidden',
  },
] as const satisfies readonly FeatureDefinition[]

export type FeatureId = (typeof FEATURES)[number]['id']
```

`sample-experiment` is `hidden`, so released builds show an empty Experimental page until
real flags register, while dev mode (and Playwright verification) has a row to exercise.

Pure resolver (unit-testable, no IO), same file:

```ts
export interface FeatureResolveInput {
  configValue?: boolean          // config.json features[id]
  userValue?: boolean            // settings.experimental[id]
  channel: 'stable' | 'edge'
  devMode: boolean
}
export interface FeatureState {
  listed: boolean                // appears in Experimental
  enabled: boolean
  source: 'config' | 'user' | 'default'
  locked: boolean                // config override present → UI toggle disabled
}
export function resolveFeatureState(def: FeatureDefinition, input: FeatureResolveInput): FeatureState
```

Rules (in order):
- `listed = input.devMode || def.visibility === 'stable' || (def.visibility === 'edge' && input.channel === 'edge')`
- If `configValue !== undefined`: `enabled = configValue`, `source = 'config'`, `locked = true`.
  The config file both force-enables and force-disables, regardless of visibility.
- Else if `listed && userValue !== undefined`: `enabled = userValue`, `source = 'user'`.
  A user toggle is honored ONLY while the flag is listed for this install — switching
  channel from edge to stable un-enables edge-only experiments rather than leaving them
  stuck on invisibly.
- Else `enabled = false`, `source = 'default'`. Experimental features always default off.

Export everything from the protocol package index.

### 2. Operator override — `packages/runtime/src/config.ts`

- Add to `PodiumConfig`: `features: z.record(z.string(), z.boolean()).optional()` with a
  doc comment referencing [spec:SP-f4b9].
- Add accessor `resolveFeatureOverrides(config = loadConfig()): Record<string, boolean>`
  returning `config.features ?? {}`. Deliberately **no env layer** (`PODIUM_FEATURES`):
  the spec decision is config-file-only for hidden flags; note that in the accessor
  doc comment so the inventory table stays truthful.

### 3. User toggles — `packages/runtime/src/settings.ts`

- Add to `PodiumSettings`: `experimental: z.record(z.string(), z.boolean()).default({})`.
- `DEFAULT_SETTINGS` gets `experimental: {}`; make sure `normalizeSettings` carries it
  (follow how other keys are normalized). Unknown ids are kept as-is (a flag may exist in
  a newer/older build); they are harmless.

### 4. Server — resolved state + gate

New `apps/server/src/features.ts` (plain module, no service class needed):

```ts
export interface FeatureStateWire extends FeatureState {
  id: string
  name: string
  description: string
  visibility: FeatureVisibility
}
export function getFeatureStates(settings: PodiumSettings, config?: PodiumConfig, env?: EnvSource): { devMode: boolean; channel: 'stable' | 'edge'; flags: FeatureStateWire[] }
export function isFeatureEnabled(id: FeatureId, settings: PodiumSettings, config?: PodiumConfig, env?: EnvSource): boolean
```

- `devMode = (env.PODIUM_APP_VERSION ?? 'dev') === 'dev'` (same sentinel as `/version`).
- `channel = resolveUpdateChannel(config, env)`.
- tRPC: add a `features.state` query next to the `settings` procedures in
  `apps/server/src/router.ts` (same auth level as `settings.get`), returning
  `getFeatureStates(...)` over the current settings row. `isFeatureEnabled` is the seam
  server-side code uses to gate behavior later.

### 5. Web — Experimental page + `useFeature`

- `apps/web/src/features/settings/sections/experimental.tsx`: blob-editing section
  `ExperimentalSection({ settings, patch })` that ALSO queries `trpc.features.state` once
  on mount for the listing (names, descriptions, listed/locked/source). Render:
  - Only flags with `listed: true`.
  - Each row: name, description underneath (muted), `Switch` on the right — follow the
    `Section`/`Row` + `Switch` pattern from `sections/hibernation.tsx`.
  - Toggle patches `patch({ experimental: { ...settings.experimental, [id]: checked } })`;
    persistence rides the existing Save button like every other blob section.
  - `locked` (config-forced) rows: Switch disabled, checked = server-resolved `enabled`,
    plus a small "Set by config file" note.
  - In dev mode, flags that are only listed because of dev mode get a small "Dev"
    badge (`Badge` component) so it's obvious they're invisible in release builds.
  - Empty state: a short muted line, e.g. "No experimental features are available on this
    install." Also surface the current channel in the section hint.
- Register the tab in `SettingsView.tsx`: `'experimental'` in the `SettingsTab` union,
  `{ key: 'experimental', label: 'Experimental' }` in `SETTINGS_TABS`, entry in
  `SECTION_VIEWS`. Place it near the bottom of the nav (before/after "Updates").
- `apps/web/src/lib/use-feature.ts`: `useFeature(id: FeatureId): boolean`
  for gating unfinished UI. Fetch `features.state` once per app load (module-level
  promise/SWR cache like the model catalog does), re-fetch after `settings.set` resolves
  (the settings save path in `SettingsView.tsx` is the only writer). Components gate with
  `if (!useFeature('x')) return null`.

### 6. Tests

- `packages/protocol/src/features.test.ts`: full matrix over `resolveFeatureState` —
  hidden/edge/stable × dev/prod × channel stable/edge × config on/off/absent × user
  on/off/absent. This is the core correctness surface; be exhaustive (table-driven).
- `packages/runtime/src/config.test.ts` + `settings` tests: new fields parse, defaults,
  `resolveFeatureOverrides` precedence.
- `apps/server`: a focused test for `getFeatureStates`/`isFeatureEnabled` wiring
  (inject settings/config/env; no live server needed).
- Run tests with `bun --bun vitest run <paths>` (vitest must run under Bun in this repo).

### 7. Out of scope (explicitly)

- No env-var layer for flags; no per-flag DB table; no remote/percentage rollout; no
  mobile-app settings page (separate minimal UI); no CLI subcommand. The desktop app uses
  the same web UI and needs nothing extra.

## Commit plan (coherent chunks, on the issue branch)

1. protocol registry + resolver + tests
2. runtime config/settings fields + accessor + tests
3. server features module + tRPC `features.state` + tests
4. web: Experimental section + tab registration + `useFeature`
5. design doc: `docs/superpowers/specs/2026-07-16-feature-flags-design.md`

Code comments at the implementing sites reference `[spec:SP-f4b9]`.
