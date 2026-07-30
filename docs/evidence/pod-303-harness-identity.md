# POD-303 — harness identity: open `HarnessId`, closed `BuiltinHarnessKind`

Evidence for the acceptance criteria of POD-303 (Phase 1 / POD-288 child), gathered on
`issue/279-integration` at branch point `7b20c9e0`, 2026-07-30.

Much of the vocabulary landed earlier in the fan-out: **POD-397** shipped `HarnessId`,
`BuiltinHarnessKind`, `Declared<T>` and the `Record<BuiltinHarnessKind, AgentManifest>` registry, and
**POD-300** moved the entity schemas into `packages/model`. This issue's remaining delta is the two
items below plus the criteria those earlier issues already satisfy, re-verified here rather than
assumed.

---

## 1. Where the vocabulary lives now

`packages/model/src/entities/agent.ts` — L0, zero workspace dependencies — is the single definition
site for all four names:

| Name | Shape | Job |
|---|---|---|
| `AgentKind` | `z.enum([… , 'shell'])` | every spawnable kind |
| `HarnessAgent` | `z.enum([…])`, five members | `AgentKind` minus `'shell'` |
| `HarnessId` | `z.string().min(1).brand<'HarnessId'>()` | **OPEN** — the canonical cross-layer and wire identity |
| `BuiltinHarnessKind` | alias of `HarnessAgent` | **CLOSED** — compile-time totality of the manifest registry |

`packages/protocol/src/messages/harness.ts` now *re-exports* these bindings instead of declaring
them (a re-export, not a new `export const` — `scripts/check-boundaries.ts` rule 7 flags the latter
shape). Every existing import site is unchanged.

## 2. The naming disambiguation, stated at the definition

`HarnessId` answers **"what software is this"**. It is *not* the ADR 9 D5 agent **principal** —
`(agentIdentity, onBehalfOf: UserId, scope)`, whose effective rights are its scope intersected with
its human's *current* rights resolved live at every apply, and whose lifecycle is `SessionBinding`
(POD-323, Phase 5). The doc comment says so explicitly, and neither `HarnessId` nor `AgentManifest`
carries an owner, a delegation reference, a visibility class or any other authorization concept.

Asserted mechanically in `packages/model/src/entities/agent.test.ts`: the parsed value is a
primitive string, strictly equal to the bare name, serializing to it — there is no wrapper object
with room for an `owner` or an `onBehalfOf` to be added to.

## 3. Unknown harness ids DEGRADE — they do not throw and do not guess

Three independent seams, each tested with an id outside the builtin set
(`'some-harness-from-2027'`):

| Seam | Behaviour on an unknown id |
|---|---|
| `isBuiltinHarnessKind` (model) | `false` — a predicate, not a throwing parser |
| `manifestFor` (harness registry) | `undefined` — no fallback entry, so nothing behaves like claude-code |
| `agentCapabilityRejection` (model) | `'harness-missing'` — compared by value against the machine's inventory, never dispatched through a closed `switch` |

`HarnessId.safeParse('some-harness-from-2027')` succeeds: the frame parses. Rejecting an unknown name
would take a live session offline over a word.

## 4. `'shell'` stays out of the closed set

`AgentKind` contains `'shell'`; `BUILTIN_HARNESS_KINDS` does not, and `manifestFor('shell')` is
`undefined`. The tempting "tidy-up" — giving shell an all-unsupported manifest — is wrong, because it
admits a non-harness to every registry totality check. Pinned by a test that asserts both halves in
one body, so the counterfactual is visible.

## 5. Incremental completeness (POD-397, re-verified)

`Declared<T> = {supported: true, value} | {supported: false, reason}`. The compiler forces every
manifest field to be **declared**; it never forces one to be **implemented**. Proven by a fictional
sixth harness in `packages/harness/src/registry.test.ts` whose launch-plus-discovery-only manifest
typechecks with every other axis explicitly `unsupported('…')`. `bun --bun vitest run
packages/harness/src/registry.test.ts` → green.

## 6. Static manifest vs per-machine availability — two things, not one

| | Static declaration | Resolved per-machine fact |
|---|---|---|
| Type | `AgentManifest`, keyed by `BuiltinHarnessKind` | `AgentInventory` / `Inventory` in `MachineWire`; `MachineHarnessInventory` |
| Home | `packages/harness/src/manifest.ts` | `packages/model/src/entities/machine.ts`, `packages/harness/src/inventory/build-inventory.ts` |
| Scope | tenant-wide, unscoped, principal-free | **owned compute** — inherits its machine's scoping (readiness §3.1.1/§3.1.4, ADR 1 Amendment 1 D13.5) |
| Projection | — | `packages/model/src/predicates/machine-selection.ts` |

Recorded in the model documentation at all three sites. `MachineHarnessInventory` carries its
`machineId` on the value, so a server-side cache cannot become an instance-global singleton by
accident.

## 7. UNAUTHORIZED is distinct from UNREACHABLE

This was the substantive gap. `AgentCapabilityRejection` was
`'offline' | 'harness-missing' | 'logged-out'`, so a machine a principal may not `use` could only be
reported as *unavailable* — exactly the collapse ADR 9 D6 M5 forbids:

> an unreachable-vs-unauthorized distinction must be visible, since "denied" and "offline" produce
> the same empty list otherwise

Now:

```ts
type MachineUseDecision = 'granted' | 'denied'
interface HandoffMachine { …; use?: MachineUseDecision }   // ABSENT = not evaluated
type AgentCapabilityRejection = 'unauthorized' | 'offline' | 'harness-missing' | 'logged-out'
```

Design points, each resolved from the ADR pack rather than taste:

- **No `'unknown'` member.** A third state reads as "probably fine" at every call site and the gate
  fails open. The un-evaluated case is the *absence* of the field — greppable, and visible in a diff.
- **The denial is checked FIRST**, before liveness and before any inventory read. Readiness §3.1.4 M2
  (`use` is a code-execution boundary and inventory is `use`-gated detail per the see/use partition)
  and §3.1.5 (an unauthorized answer must not vary with the hidden state, or the reason becomes an
  oracle for it). Liveness sits inside `see`, so reporting the denial loses nothing.
- **The `'shell'` shortcut does not bypass it** — spawning a shell is `use` too (§3.1.4 M1).
- **No authorization is implemented here.** POD-1079 supplies the decision at the server projection
  boundary; `packages/model` stays principal-free.

`AgentChoice` (`packages/runtime`) is documented as the *stored preference* and deliberately did NOT
gain availability members: whether a harness can run depends on which machine and which principal,
and a config file must not persist a momentary fact.

### Two fail-open holes the new union exposed

Adding the member turned up two consumers that would have silently accepted a machine refused for a
reason they did not know about. Both are now exhaustive switches with a `never` arm, so the next
reason is a compile error rather than a permission hole.

| Site | Before | Now |
|---|---|---|
| `apps/server` `machines/service.ts` `requireAgent` | chain of `if`s — an unhandled reason threw **nothing** and the work was routed | exhaustive; `'unauthorized'` throws about access |
| `apps/web` `NewPanelMenu.tsx` `capabilityReason` | returned `undefined`, which **enables** the row | exhaustive; the row is disabled with a reason |
| `apps/web` `SessionContextMenu.tsx` `handoffRejectionText` | already exhaustive — its `never` is what caught this | gained `'no access'` |

---

## Verification

Run in the worktree at `e73c724b` + the consumer tests, with the `test-lane` lease held for the full
lanes.

| Lane | Command | Result |
|---|---|---|
| typecheck (uncached) | `bun run typecheck --force` | **GREEN** — 22/22 tasks, 0 cached, 24.96s |
| unit | `bun run test:unit` | 452 files, **6036 pass / 1 fail** — the single failure pre-existing, see below |
| web | `bun run test:web` | **GREEN** — 172 files, 1355 tests |
| bun unit | `bun run test:bun:unit` | **GREEN** — 14 pass, 0 fail |
| integration | `bun run test:integration` | **GREEN** |
| boundaries | `bun scripts/check-boundaries.ts` | **GREEN** — 58 allowlisted, **0 new** |
| deletion audit | `bun scripts/rearch-audit.ts` | **GREEN** — 21 items, 261 sites, baseline exact |
| NUL bytes | `bun scripts/check-no-nul-bytes.ts` | **GREEN** |
| wire golden | `bun --bun vitest run packages/protocol/src/wire-golden.test.ts` | **GREEN** — 90 tests |

### The wire is byte-identical

`bun run fixtures:wire:update` produced **18 insertions, 0 deletions** in
`packages/protocol/src/__fixtures__/golden/model.json`, every one a `HarnessId` case whose `wire` and
`encoded` are the same bare string (`"x"` → `"\"x\""`). No committed line was modified — a modified
line in place would have signalled a shape change, which is the finding that suite exists to
surface. `packages/protocol/src/messages/wire-golden.json` regenerates with an **empty diff**, so
POD-300's relocation pins are untouched.

### Audit counts, verified PER-SITE and not by total

| Item | Count | Sites |
|---|---|---|
| `agent-kind-enums` | **0** (must stay 0) | — |
| `capability-tables` | **5**, unchanged | `superagent/harness-error.ts:36`, `superagent/service.ts:70`, `harness/registry.ts:26`, `protocol/messages/terminal.ts:56`, `runtime/settings.ts:38` |
| `state-dir-defs` | **0** | — |

Same five files at the same five lines as on the base — not a silent drop. **Instrument verified**
rather than trusted: planting `export const HarnessAgent = z.enum(['x'])` in
`packages/protocol/src/messages/harness.ts` made `agent-kind-enums` fire on it; reverting returned
the audit to `baseline exact`.

### Mutation testing — 7 mutants, 7 kills, 0 survivors

One mutant per invocation, mutate/run/revert as one unit, `git diff --stat` after each revert to
prove the tree is clean.

| # | Mutation | Killed by |
|---|---|---|
| 1 | delete the `use === 'denied'` gate | 4 tests |
| 2 | move the gate after the liveness check | 1 test (the order claim) |
| 3 | let the `'shell'` shortcut run before the gate | 1 test |
| 4 | `isBuiltinHarnessKind` returns true for any non-empty id | 2 tests |
| 5 | drop `.min(1)` from `HarnessId` | 1 test |
| 6 | server `requireAgent` returns instead of throwing on `'unauthorized'` | 2 tests |
| 7 | web copy renders `'unauthorized'` as `'offline'` | 1 test |

### Pre-existing failures, not caused by this change

1. **`scripts/architecture-manifest.test.ts > gives every workspace at least one feature`** — asserts
   no workspace has `features: []`, and `packages/agent-bridge` has exactly that, *deliberately*:
   POD-396/397 moved both halves out and the manifest's own comment says it is "an empty shell
   awaiting deletion by POD-399". The test reads only the `MANIFEST` literal in
   `scripts/architecture-manifest.ts`; this branch touches neither that file nor
   `packages/agent-bridge`, so its result cannot differ from the base. Resolved by POD-399.
2. **`apps/server/src/upstream-e2e.test.ts` P7b** — failed inside the full oracle run, passes 9/9 in
   isolation. Load, not a regression.
3. **`test:multi-instance` / `scripts/install-sh.test.sh:123`** — the `bash -i` probe captures this
   host's interactive-shell sudo banner as the resolved `podium` path. Environmental, unrelated to
   the code under test; filed as **POD-1132** with a `discovered-from` edge.

### Also fixed, disclosed rather than folded in silently

`packages/harness/package.json` declared no dependency on `@podium/model` while importing it from ten
source files, so `bun run --filter @podium/harness typecheck` could not resolve the module. One line.

---

## Deliberately NOT done

**The three legacy capability tables** (`AGENT_CAPABILITIES`, `HARNESS_MCP_SUPPORT`,
`RECORD_MAPPERS`) are still in place. POD-303's own criteria list their deletion, but **POD-398
(5.3c) owns that fold** — its acceptance criteria name it verbatim — and the `rearch-audit`
`capability-tables` detector is phased **POD-325, not POD-303**. Two issues claiming one deletion is
a brief overlap, and the fold reaches into `apps/server/superagent`, `apps/daemon`, `apps/web`,
`packages/transcript` and `packages/composer` plus the ADR 8 placement question for the transcript
mapper core — all squarely inside the 5.3 harness split rather than this Phase-1 model issue. The
count was verified per-site as unchanged instead.

**Relocating the 66 harness-branching sites** across 20 files (POD-399's list). Out of scope by
instruction; the seam they relocate *through* exists and is not a closed dispatch, which is what this
issue owed.

**No `instance_id` was introduced.** ADR 1 D5 stands — multi-user is not multi-tenancy.
