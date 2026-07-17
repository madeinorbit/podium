# ADR 8: Package topology + build orchestration

| Field | Value |
|---|---|
| **Status** | Proposed (human gate: POD-359) |
| **Date** | 2026-07-17 |
| **Issue** | POD-754 (leaf of POD-359) |
| **File** | `docs/adr/0008-package-topology.md` (this leaf owns **only** this file) |
| **Related** | ADR 1–7 (forward refs); [spec:SP-3b58]; [spec:SP-3fe2]; [spec:SP-15aa]; POD-296, POD-299, POD-311, POD-325, POD-293/POD-331, POD-356, POD-712, POD-715, POD-746 |

## Context

The rewrite (POD-279) requires a **target package/app layout decided up front** so Phases 1–6 build toward one topology. POD-356 **verifies** the shipped result against this ADR; it does not invent names.

Build orchestration has already landed on the integrated tree ([spec:SP-3b58]): **tsgo** as the typecheck compiler (`tsc` kept as `typecheck:tsc` where present), **Turborepo** as the `typecheck` scheduler/cache (`turbo run typecheck` at repo root; `turbo.json` `daemon: false`). SP-3b58 recorded an **interim** resolve-from-source decision and deferred project references (POD-712), flagging that **ADR 8 must ratify or overturn** that choice because rewrite packages bake it in.

### Binding inputs (drift refreshes on POD-359)

1. **Item 8 (description):** wire extraction; store/runtime split; terminal-ui; client-core→engine; node/host naming; neutral transcript-core placement (done / renamed / declined with rationale). POD-356 verifies.
2. **DRIFT 1:** instance identity ([spec:SP-15aa], `packages/runtime/src/instance.ts`) — place in package topology (brand vs runtime concern is shared with ADR 1 / POD-645).
3. **DRIFT 2 (build orchestration):** DECIDE source-conditions vs project-references (mutually exclusive); mandate typecheck + `@podium/source` export + turbo membership for new packages; record that turbo does **not** fix worktree→MAIN `@podium/*` resolution and pin mitigation.
4. **UPDATE:** turbo+tsgo fully landed (`25fe48d7..2f7b7620`); SP-3b58 interim = resolve-from-source stays; ADR 8 must ratify/overturn explicitly. Cold turbo ~30s, cached <1s (SP-3b58).

### Layer vocabulary (already adopted; not re-opened here)

From POD-279 disposition + POD-296 architecture manifest (landed on integration tip as `scripts/architecture-manifest.ts` + ledger table in `docs/rearchitecture-v3.md`):

| Layer | Meaning |
|---|---|
| L0 | model / semantic vocabulary |
| L1 | wire frames + command **contracts** |
| L2 | kernels/ports (sync, store, harness, pty, transcript, runtime, terminal port, telemetry) |
| L3 | features/adapters/engine |
| L4 | app composition roots |
| L5 | `scripts/` compose tier |

Imports point **down**. Same-layer edges are **explicit allowlist**, never implicit.

### Verified present-day workspace inventory (integrated tip `ca361327`)

**Packages (11):** `agent-bridge`, `client-core`, `domain`, `issue-client`, `protocol`, `runtime`, `sync`, `telemetry`, `terminal-client`, `terminal-client-react`, `transcript`.

**Apps (6):** `cli`, `daemon`, `desktop`, `mobile`, `server`, `web`.

**Typecheck scripts (re-derived from each `package.json` `scripts.typecheck`):**

| Workspace | `typecheck` value |
|---|---|
| 10 of 11 packages (all except telemetry) | `tsgo --noEmit` |
| `packages/telemetry` | `tsc --noEmit` (no `typecheck:tsc` twin) |
| `apps/{cli,daemon,server,web}` | `tsgo --noEmit` |
| `apps/mobile` | `tsc --noEmit` (SP-3b58 expo/`moduleSuffixes` exception) |
| `apps/desktop` | **no `typecheck` script** (Tauri/Rust surface; JS is thin) |

**`@podium/source` export condition present under `exports` (re-derived):** present on `agent-bridge`, `client-core`, `domain`, `protocol`, `sync`, `terminal-client`, `terminal-client-react`, `transcript`. **Absent today** on `issue-client`, `runtime`, `telemetry` (they export source paths via `types`/`import` pointing at `./src/…` but lack the named `@podium/source` condition key).

**Base tsconfig:** `tooling/tsconfig/base.json` line 15: `"customConditions": ["@podium/source"]`; line 22: `"incremental": true`.

**Turbo:** root `"typecheck": "turbo run typecheck"`; `turbo.json` task `typecheck` with `dependsOn: ["^typecheck"]`, `daemon: false`, `globalDependencies` includes `package.json` + `bun.lock`.

**Worktree resolution guard (POD-746):** `vitest.config.ts` anchors `@podium/runtime` with array-form RegExp aliases (not string prefix); `scripts/runtime-resolution.integration.test.ts` exists.

---

## Decisions

### D1 — Typecheck resolution topology: **RATIFY source-conditions**

**DECISION:** Resolve-from-source via `@podium/source` is the **permanent** typecheck resolution topology for the rewrite horizon.

- Keep `customConditions: ["@podium/source"]` in `tooling/tsconfig/base.json`.
- Every **new** package (and every package this rewrite creates or renames) ships an `@podium/source` export on each public `exports` entry pointing at TypeScript source.
- **Project references** (`tsc -b`, POD-712) are **DECLINED** for the rewrite horizon.

**Rationale**

1. Load-bearing today: base tsconfig and most package exports already use the condition; Bun/host/test paths pass `--conditions=@podium/source`.
2. Speed goal is already met by tsgo + turbo (~30s cold / <1s cached per SP-3b58) without forcing `.d.ts` consume.
3. `tsc -b` project references and `@podium/source` resolve-from-source are **mutually exclusive** (SP-3b58 / POD-712); dual-running both is not viable.
4. Rewrite packages (`model`, `commands`, `wire`, `store`, `harness`, `pty`, `engine`, …) must not each re-litigate.

**Rejected alternative — project references now**

| Rejected | Why |
|---|---|
| Adopt `tsc -b` / POD-712 before Phase 1 | Requires retiring `@podium/source` across the monorepo in the same change; conflicts with live tooling; no measured need given tsgo+turbo timings. |

**Overturn threshold:** only if (a) cold typecheck regresses past a human-accepted budget with tsgo+turbo correctly configured, **and** (b) a single coherent migration retires `@podium/source` everywhere. No dual topology.

**Drift clauses addressed:** POD-359 DRIFT 2(i) + UPDATE (ratify/overturn SP-3b58 interim) → **ratify**.

---

### D2 — New-package scaffolding mandate

**DECISION:** Every new workspace package’s scaffolding commit **must** include:

1. **`typecheck` script** — `tsgo --noEmit`, plus `typecheck:tsc` fallback unless an SP-recorded exception applies (today: `apps/mobile` stays on tsc).
2. **`@podium/source` export** on every public `exports` entry.
3. **Turbo graph membership** via correct `package.json` workspace dependency edges so `dependsOn: ["^typecheck"]` invalidates consumers.
4. **Architecture-manifest tags** (layer / platform / features; role tier if applicable) in the same commit as the package appears (`scripts/architecture-manifest.ts` + ledger transition note — ledger edits are **not** this leaf’s job; scaffolding issues own them).

**Rejected alternative — “document later, scaffold bare”**

| Rejected | Why |
|---|---|
| Create package without typecheck/source/turbo edges | Turbo silently skips orphans; typecheck inventory drifts; exactly the half-landed failure mode Phase 0 guardrails exist to prevent. |

**Existing gaps (not blocked by this ADR, not silently blessed):** `issue-client` / `runtime` / `telemetry` lack the named `@podium/source` key; `telemetry` still on `tsc`; `apps/desktop` has no typecheck. Close as ordinary hygiene or when those packages are next touched — **new** packages may not copy the gaps.

**Drift clauses addressed:** POD-359 DRIFT 2(ii) → **mandated**.

---

### D3 — Turbo does **not** fix the worktree→MAIN resolution hazard

**DECISION:** Record as standing fact + pin mitigations.

**Hazard (verified via POD-746 on this tree):**

- Non-workspace roots (notably `scripts/`) own no `node_modules/@podium/*` symlink and resolve by walking **up** the filesystem into a parent/sibling install.
- A worktree without a local `bun install` can typecheck/test against **MAIN’s** package sources while editing the worktree copy.
- Module-scoped singletons (e.g. WeakMaps in `@podium/runtime/sqlite`) duplicate across two absolute paths → false “wrong runtime” failures.
- **Turbo content-hashes task inputs; it does not prove `@podium/*` resolved inside this checkout.** A cache hit is not isolation proof and can even look green against the wrong resolution graph.

**Pinned mitigations**

| # | Mitigation |
|---|---|
| M1 | **Worktree-local `bun install`** after create/enter so workspace `@podium/*` links point into **this** checkout |
| M2 | **Subpath-safe resolver anchors** for packages with module-scoped singleton state (POD-746 pattern in `vitest.config.ts`: array-form RegExp, not string prefix) |
| M3 | **Resolution guard tests** (e.g. `scripts/runtime-resolution.integration.test.ts`) stay green |
| M4 | **Never treat `FULL TURBO` as proof of worktree isolation** |
| M5 | Prefer putting shared importable code in a **workspace package** (owns its own links) rather than root-only `scripts/` when it must import `@podium/*` |

**Rejected alternative — “turbo config will fix it”**

| Rejected | Why |
|---|---|
| Widen `globalDependencies` / disable turbo cache / add turbo-only guards | Cache keys do not control Node/Bun module resolution. Treating turbo as the fix hides the real bug class POD-746 named. |

**Drift clauses addressed:** POD-359 DRIFT 2(iii) → **recorded + mitigations pinned**.

---

### D4 — Target package / app topology

**DECISION:** The end-state layout is the table below. Names are **targets**; phase issues implement moves; POD-356 fails if dual names remain without an ADR amendment.

#### End-state layer map

```
L0  packages/model
L1  packages/wire · packages/commands
L2  packages/sync · packages/store · packages/runtime · packages/transcript
    packages/harness · packages/pty · packages/terminal-ui · packages/telemetry
L3  packages/engine · packages/terminal-ui-react
L4  apps/node · apps/host · apps/web · apps/mobile · apps/desktop · apps/cli
L5  scripts/
```

#### Today → target

| Today | Target | Decision | Owner (approx.) |
|---|---|---|---|
| `packages/domain` | `packages/model` | **Rename + absorb** | Phase 1 POD-299 |
| `packages/protocol` (schemas + frames) | schemas → `model`; frames → **`packages/wire`** | **Extract, then rename protocol→wire** | POD-300 then rename |
| `packages/issue-client` | folded into `packages/commands` (+ CLI render) | **Absorb** | Phase 3 POD-311 |
| — | `packages/commands` | **Create** (contracts only; no handlers) | POD-311 |
| `packages/sync` | `packages/sync` (Authority/Replica/Outbox) | **Reshape in place** | Phase 2 POD-305/306 |
| `packages/runtime` (mixed) | `packages/runtime` + **`packages/store`** | **Split** (§D4.1) | Phase 2 with kernel adapters |
| `packages/transcript` | `packages/transcript` | **Done — keep** (§D4.2) | — |
| `packages/agent-bridge` | `packages/harness` + `packages/pty` | **Split; delete agent-bridge** | Phase 5 POD-325 |
| `packages/terminal-client` | **`packages/terminal-ui`** | **Rename** | with Phase 6 or opportunistic |
| `packages/terminal-client-react` | **`packages/terminal-ui-react`** | **Rename** | with terminal-ui |
| `packages/client-core` | **`packages/engine`** | **Rename + module split** (§D4.3) | Phase 6 POD-293/331 |
| `packages/telemetry` | `packages/telemetry` | **Keep** | — |
| `apps/server` / `@podium/server` | **`apps/node` / `@podium/node`** | **Rename** (§D4.4) | Phase 4 close or POD-356 cut |
| `apps/daemon` / `@podium/daemon` | **`apps/host` / `@podium/host`** | **Rename** (§D4.4) | Phase 5 close or POD-356 cut |
| `apps/{web,mobile,desktop,cli}` | same | **Keep** | — |
| `scripts/` | `scripts/` | **Keep** (L5) | — |

Same-layer allowlist migrates with renames (today’s declared set from the manifest: `issue-client→protocol`, `sync→runtime`, `telemetry→runtime`, `agent-bridge→runtime`, `agent-bridge→transcript`).

#### D4.1 Wire extraction

**DECISION:**

1. Move entity field schemas to `packages/model` (POD-300); protocol/wire keeps frames, codec, handshake, versioning, plane taxonomy (ADR 7).
2. After byte-identical wire fixtures: **rename** `@podium/protocol` → `@podium/wire`.
3. Any transitional `@podium/protocol` re-export is a **deletion-audit** item with Phase ≤7 expiry — dual names must not survive POD-356.

**Rejected:** keep the name `protocol` forever (fights L1 vocabulary “wire”); extract a parallel `packages/wire` while `protocol` still holds frames (two homes).

#### D4.2 Store / runtime split

**DECISION:** Split persistence ports from process plumbing.

| Package | Owns |
|---|---|
| **`packages/runtime`** (L2, platform **neutral**) | Process/environment: instance resolution ([spec:SP-15aa] module stays here), config, boot, join/setup, hermetic env, connectivity, process-safety, sd-notify, run-registry, loop metrics/stall; isomorphic non-IO helpers |
| **`packages/store`** (L2) | Persistence ports/adapters: SQLite open/transaction shims (today `runtime/sqlite`), generic sync-table adapters for the kernel, durable local stores that are not process identity (e.g. auth-store). Server-side adapters feed the **one** drizzle journal (SP-4428 / ADR 2); clients are **not** drizzle-managed (ADR 6) |

**Rule of thumb:** durable file/DB handle or storage port for Authority/Replica/Outbox → **store**. How this process is configured/supervised → **runtime**.

**Timing:** create `packages/store` when Phase 2 needs infrastructure-neutral kernel ports (POD-305/306). Until then `runtime/sqlite` is the transitional home (manifest transition note owned by that phase).

**Rejected:** leave sqlite permanently in runtime (kernel would import process boot); put store inside `sync` (couples every non-sync durable store to the kernel package).

#### D4.3 Transcript-core placement

**DECISION: done as `packages/transcript` — decline rename to `transcript-core`; decline a further package split.**

- Package already owns the neutral slice/page core (`slice`, cursor codec, `TranscriptSource`) and pure record→item mappers.
- Harness-specific **location/resolution** already lives outside it (`transcriptSourceFor` in agent-bridge → `packages/harness` after split). POD-398 registers mappers via manifests; it does not re-home the slice/page core.
- Renaming to `transcript-core` is pure churn with no second package to disambiguate.

**Rejected:** rename to `transcript-core`; move slice core into `model` (not a vocabulary entity); move pure mappers into `harness` (would force harness deps on browser-safe consumers of pure parse).

**Drift / item 8:** “done, renamed, or declined” → **done (keep name) + declined rename**.

#### D4.4 Terminal-ui naming

**DECISION:** Rename `@podium/terminal-client` → `@podium/terminal-ui` (L2 browser-safe port) and `@podium/terminal-client-react` → `@podium/terminal-ui-react` (L3 React binding). Keep two packages so the React peerDependency boundary stays explicit (optional later merge to subpath is not required).

**Rejected:** keep `terminal-client` forever (name does not match “terminal-ui” target called out in POD-359); fold React into L2 (peerDep/platform confusion).

#### D4.5 Client-core → engine

**DECISION:** Rename `@podium/client-core` → `@podium/engine` as part of Phase 6 (POD-293), with module seams:

| Module | Responsibility |
|---|---|
| `transport` | socket lifecycle, reconnect, plane demux, epoch/seq |
| `replica-binding` | Replica role + persistence adapter (ADR 6) |
| `actions` | command dispatch + outbox + optimistic overlay |
| `router` / `ui-state` | sole UI persistence owner |
| `viewmodels/*` | per-feature memoized slices |

React stays a thin binding (`engine/react` subpath or sibling). Today’s `packages/client-core/src/engine/*` is the pre-rename home of part of this surface.

**Rejected:** keep name `client-core` (POD-293 already targets `packages/engine`); pure rename without module split (leaves god files).

#### D4.6 Node / host app naming

**DECISION:**

| Today | Target path | Target npm name | Role |
|---|---|---|---|
| `apps/server` | `apps/node` | `@podium/node` | Authority composition root (“node” in offline-sync vocabulary); role tiers core/hub/cloud remain **inside** the app |
| `apps/daemon` | `apps/host` | `@podium/host` | Machine host (PTY/harness, pairing client, control) |

**When:** after the internal decomposition of each app is stable enough that a path rename is not fighting a god-file split — default **Phase 4 close (node)** / **Phase 5 close (host)**, or a single POD-356 cut with a redirect map. Until rename, docs may say **node (`apps/server`)** / **host (`apps/daemon`)** on first mention. Naming note (reconciliation): `apps/node` here is the LOCAL Authority composition root in the offline-sync vocabulary; it is distinct from ADR 5’s reserved H2 peer ROLE `node` (a future federation peer) — the collision is acknowledged and intentional, disambiguated by context (package path vs peer-hello role field).

**Rejected:** rename on day one of Phase 1 (max churn, min value); keep `server`/`daemon` forever (permanent translation tax against L4 vocabulary).

#### D4.7 Instance identity placement (drift)

**DECISION (package topology only):**

- **Module home:** `packages/runtime` (process-scoped instance resolution) — already `packages/runtime/src/instance.ts`.
- **Not** wire, engine, or harness.
- Whether `InstanceId` is a **model-branded** id is **ADR 1** + POD-645; this ADR only forbids parking the runtime module in the wrong package.

**Drift clauses addressed:** POD-359 DRIFT 1 (instance identity place in topology) → **runtime module; brand = ADR 1**.

---

## Consequences

### Positive

- Phases scaffold toward one name table; POD-356 is verification, not design.
- Typecheck topology stable for all rewrite packages.
- Worktree hazard named with mitigations so turbo green is not mistaken for isolation.

### Costs

- App renames and `protocol`→`wire` are high-churn; deliberately late or batched.
- Store/runtime split has a transitional window (`runtime/sqlite`).
- Existing `@podium/source` gaps on three packages remain until hygiene touches them.

### Enforcement (pointers; not implemented by this leaf)

- Architecture manifest + boundary lint (POD-296 warn → POD-335 error).
- Deletion audit for dual names / re-export shims.
- POD-356 shipped-topology table must map every row above to done or deviation+rationale.
- New-package PR expectations: typecheck · `@podium/source` · workspace deps · manifest tags.

### Explicit non-decisions

| Topic | Owner |
|---|---|
| Field ownership / conflict / secrets | ADR 1 |
| Sync protocol; wire version vs drizzle journal | ADR 2 |
| Command contract fields & lifecycle | ADR 3 |
| Representation / narrow ports | ADR 4 |
| Peer roles & federation seam | ADR 5 |
| Replica storage engines | ADR 6 |
| Full plane/message inventory | ADR 7 |
| drizzle-kit for daemon binding / mobile SQLite | ADR 6 + POD-415/POD-375 |
| Closing POD-712 in the tracker | hygiene after pack accept |

---

## Drift-refresh coverage checklist

| Clause | Where decided |
|---|---|
| Wire extraction | D4.1 |
| Store/runtime split | D4.2 |
| Terminal-ui | D4.4 |
| Client-core→engine | D4.5 |
| Node/host naming | D4.6 |
| Transcript-core placement | D4.3 (**keep `packages/transcript`**) |
| Instance identity package place | D4.7 |
| Source-conditions vs project-references | D1 **ratify source-conditions** |
| New package typecheck + `@podium/source` + turbo | D2 |
| Turbo ≠ worktree isolation; pin mitigation | D3 |

---

## Changelog

| Date | Change |
|---|---|
| 2026-07-17 | Initial proposal on `docs/adr/0008-package-topology.md` (POD-754), rebased to integration tip `ca361327`. |
