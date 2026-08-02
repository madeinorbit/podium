# POD-397 — packages/harness extraction, per-CLI manifests

Reviewer/handoff notes for the 5.3b leaf of POD-325. Branch:
`issue/397-5-3b-extract-packages-harness-with-per-c`, based on
`issue/396-5-3a-extract-packages-pty-backends-durab`.

## What the split actually cut

`@podium/agent-bridge` held two unrelated things. They are now separated along the
seam that already existed in the import graph:

| Went to `packages/harness` | Stayed in `packages/agent-bridge` (→ `packages/pty`) |
|---|---|
| `manifest.ts` (was `harness/adapter.ts`) | `abduco.ts`, `abduco-bin.ts` |
| `manifests/*` (was `harness/adapters/*`) | `tmux.ts` |
| `registry.ts`, `instructions.ts`, `issue-system-pointer.ts`, `transcript-source.ts` | `osc-title.ts` |
| `agent-state/`, `discovery/`, `inventory/`, `opencode/`, `cursor/` | `session.ts`, `pty/` |
| `launch.ts`, `jsonl-stream.ts` | |

**The harness cluster imported nothing from the pty half.** That is why this could
land without waiting on POD-396, which had 0 commits when this work started.

`jsonl-stream.ts` (`LineDecoder`) came here rather than to pty. POD-396's brief says
"framing", but that means PTY framing (abduco protocol, OSC scan), not decoding a
JSONL stream an agent CLI emits. Its only importers are `agent-state/codex.ts` and
`agent-state/cursor.ts` — zero pty consumers. The decisive argument is the axiom:
`packages/pty` must come out harness-agnostic, and moving a codex/cursor-only decoder
into it would create a pty→harness edge and give pty a reason to learn which agent it
is talking to. Ruling confirmed by the POD-279 coordinator.

## The identity model (POD-303)

```
HarnessId            OPEN, branded string, the wire identity. ANY name parses,
                     because a newer peer may name a harness this build never
                     heard of and the frame must not be rejected over a name.
BuiltinHarnessKind   CLOSED. Exists for ONE reason: compile-time totality of
                     Record<BuiltinHarnessKind, AgentManifest>.
isBuiltinHarnessKind The narrowing gate between them.
```

Both live in `packages/protocol/src/messages/harness.ts` beside `HarnessAgent`.
That placement is a deliberate fork resolution, not a default: `packages/model`
does not exist yet (POD-299 scaffolds it, POD-303 re-homes these names), `HarnessId`
is a wire type and protocol is L1, and — decisively —
`scripts/architecture-manifest.ts` **live-reads** `export const HarnessAgent =
z.enum([` from exactly that file as the harness axiom's source of truth. A second
enum elsewhere would fork that source or silently disable the lint.

`HarnessId` is documented as a harness **KIND**, explicitly **not** the ADR 9 D5
agent **principal** `(agentIdentity, onBehalfOf, scope)`. POD-303's brief calls that
the main multi-user obligation here: without it the two things share the phrase
"agent identity" and get wired together by someone who read only one of them.

## Incremental completeness: `Declared<T>`

```ts
type Declared<T> =
  | { supported: true;  value: T }
  | { supported: false; reason: string }
```

Not `T | undefined`, and not an optional field. **An optional field cannot
distinguish "this CLI genuinely has no headless mode" from "somebody added a harness
and forgot the line"** — both get the same silent treatment at every call site.
Requiring a `reason` makes the gap self-documenting and forgetting it a type error.

| Field | Status |
|---|---|
| `launch`, `discovery`, `inventory`, `capabilities`, `resumeKind` | always required — the irreducible minimum for a harness Podium can spawn and find conversations for |
| `exec`, `headless`, `state`, `observer`, `transcript`, `classifyBrowserOpen` | `Declared<…>` — may land later |
| `headless.buildExec`, `transcript.chainPaths` | `Declared<…>` — and tests assert the declaration AGREES with the sibling `driver` / `storage` |

So a new harness can land with **launch + discovery only**. A test builds a
fictional sixth harness's minimal manifest; the fact that the object literal
typechecks against `AgentManifest` *is* the assertion.

### No fallback entry, on purpose

`manifestFor()` returns `undefined` for unknown and non-harness kinds. There is
deliberately no default manifest: one would make an unknown harness silently behave
like whichever CLI was chosen as the default — e.g. spawn `claude` for a harness that
is not Claude. Every call site degrades honestly instead:

| Site | Degradation when unsupported |
|---|---|
| `daemon.ts` browser-open | falls through to the **generic** `redirect_uri` heuristic, not another harness's domain list |
| `harness-exec.ts` | throws, with a message distinguishing "declares exec unsupported" from "unknown kind" — two different bugs that used to be one |
| `headless-drivers.ts` | throws rather than dispatching through `DRIVER_IMPLS`; a missing driver must never become `claude-sdk` |
| `session-observers.ts` | registers **no** observation; phase stays `unknown`, transcript stays unbound. A borrowed observer would report another harness's conventions as this session's status |
| `transcript-source.ts` | empty file-chain source; the session runs, it just has no readable history |

## The multi-user seam

Two halves kept separable, per `docs/multi-user-readiness.md` §3.1.1:

**1. The manifest is principal-free.** `packages/harness` imports no principal,
user, grant or visibility type. Enforced by a new `harness-principal-free` lint
(`scripts/check-boundaries.ts`), currently **0 violations across 86 files**. The rule
deliberately excludes `AgentCapabilities`/`AGENT_CAPABILITIES`: that is the harness
capability **descriptor**, and the two senses of "capability" collide exactly here.
Six unit tests pin that it fires on real principal imports and stays silent on the
descriptor — because "zero violations" is worthless evidence from a rule that cannot
fire.

**2. The resolved inventory is machine-keyed.**

```ts
interface MachineHarnessInventory {
  readonly machineId: string   // the scoping key, not decoration
  readonly inventory: Inventory
}
```

`buildMachineInventory({ machineId, … })` requires the id; there is no "current
machine" default, because an implicit one is how an instance-global singleton gets
born. An inventory that does not name its machine can be cached as a singleton with
nothing looking wrong, and POD-1079 would then have to re-cut this seam to scope it.
The daemon caches per `(machineId, homeDir)` and takes the frame's `machineId` off the
probed value rather than from `ctx` a second time.

**Visibility class — declared, not left unclassified.** ADR 1 Amendment 1 (POD-1071)
**D13.5** already classifies harness *and model* inventory as a per-machine fact:
class `owned-compute`, owner `inherits Machine`, verbs `see`/`use`/`manage`, and
explicitly *not* tenant-visible infrastructure. That was **cited, not edited** —
POD-1071 owns that file under stated file discipline and needed no change.

## Deliberately NOT done

- **The harness axiom stays at WARN.** POD-399 flips it to error; doing it early
  turns every other branch red.
- **66 harness-branching sites across 15 files were not relocated** (full list in the
  completion mail). They are behavior in `apps/*`, `packages/client-core`,
  `packages/composer`, `packages/domain`, `packages/runtime` — relocating them is
  POD-292/POD-326/POD-398's work, and doing it here would have produced exactly the
  large surprise diff the fan-out protocol warns against. POD-399 needs that list
  complete before it can flip the axiom.
- **`apps/server` `ModelCatalog` was an instance-global singleton** holding
  per-machine facts (which models each harness offers). Same class of bug as the
  inventory seam, but in `apps/server` and outside this extraction. Filed as
  **POD-1123 (Machine-keyed model catalog)** with a `discovered-from` edge — that
  issue keys the catalog by `machineId`.
- **Pre-existing biome formatting backlog was reverted, not absorbed.** `biome check
  --write` fixed 151 files; ~127 were unrelated debt in `apps/server`/`apps/daemon`,
  plus 10 `packages/harness` files that were only *moved* verbatim. All reverted, so
  the relocation stays reviewable as a relocation.

## Two self-inflicted bugs worth knowing about

Both were found by acting on the coordinator's standing-rule broadcast rather than by
trusting a green summary line.

**A phantom deletion that would have corrupted POD-325's guardrail.** The
`capability-tables` detector in `scripts/rearch-audit.ts` is scoped by PATH PREFIX and
patterns on the TYPE NAME. This move tripped both independently — the file left
`packages/agent-bridge`, *and* `Record<HarnessAgent, HarnessAdapter>` became
`Record<BuiltinHarnessKind, AgentManifest>`. The audit reported `capability-tables:
5 -> 4` and offered `--update-baseline` to "lock the win in". Nothing had been
deleted; the table sits at `packages/harness/src/registry.ts:30` and POD-398 still has
to fold it in. Fixed by making the detector **span both homes** and both key-type
names, then verified **per-site**: the site reappears at its new path, count back to 5,
POD-325 correctly still cannot close. The top-line total read 264 before *and* after —
it never moved, exactly as the broadcast warned.

The other path-prefix detector, `durable-host-sync-async-twins`, is hard-scoped to
`packages/agent-bridge/src/`. Its four sites are in `abduco.ts`/`tmux.ts`, which
stayed, so its per-site output is byte-identical to the base. Widening it belongs to
POD-396 when it moves those files; deliberately not touched here.

**A literal NUL byte in this diff.** The `(machineId, homeDir)` cache key used a raw
NUL separator. `git diff --stat` printed `Bin 2766 -> 3499 bytes` and `grep` for a
visible line returned nothing and exited 1. Rewritten as a `\u0000` escape — same
runtime value, diff reads as text, and the collision-proof property is retained.
(The first attempt at that fix's own commit message was rejected for the same reason:
the byte got pasted into the prose describing the fix.)

## Verification

Scoped and targeted; the host was swap-thrashing throughout (load 58–173 on 8 cores,
~0 GB free of 23 GB) under the coordinator's serialized-lane rule.

| Gate | Result |
|---|---|
| `--filter @podium/harness build` | exit 0 — ESM 316.77 KB, DTS 74.62 KB → **builds standalone at L2** |
| `--filter @podium/{harness,daemon,server} typecheck` | exit 0 each, per-package (**not** a FULL TURBO run) |
| `packages/harness` unit | 460 passed, 3 skipped (35 files) |
| `apps/daemon` + `packages/agent-bridge` unit | 421 passed, 1 skipped |
| `scripts/{check-boundaries,architecture-manifest}.test.ts` | 180 passed |
| agent-smoke, the two moved real-binary skips | both collect from new paths; cursor passes, opencode skips (binary absent) |
| `bun scripts/check-boundaries.ts` | **byte-identical to the unmodified base**: 69 violations each |
| `bun scripts/rearch-audit.ts` | `OK — 21 items, 264 sites remaining (baseline exact)` |
| `bun scripts/check-no-nul-bytes.ts` | ok; and no `Bin` marker anywhere in the diff |
| **full lane** under the test-lane lease | **5278 passed**, 19 skipped, 411 files; the 1 failure was the audit baseline gate catching the phantom zero above, now fixed (audit exits 0, suite re-runs 51/51) |

**Base-redness proven, not assumed.** The boundaries gate was already red on
`201dd989` (the fan-out branch point). That commit was extracted with `git archive`
into a scratch tree and the gate run there — `git stash` is repo-wide and forbidden.
Normalizing line numbers and the agent-bridge/harness split name, the two violation
sets diff clean at 69 lines each: this change adds and removes nothing.

Two failures appeared only in wide runs (`session-observers`, `connectivity-state`)
and **both pass in isolation**; `connectivity-state.test.ts` contains zero references
to harness or agent-bridge, so it cannot be this diff. Load artifacts per the
coordinator's broadcast, not reported as findings.
