# POD-396 — packages/pty extraction: seam and harness-branching evidence

Evidence record for the POD-279 fan-out (human gates suspended; the protocol asks for the
gate's evidence to be recorded as an issue artifact instead). Written for the three issues
that live with this seam: **POD-397** (packages/harness), **POD-398** (capability tables +
transcript mappers), **POD-399** (delete agent-bridge, flip the harness axiom to error).

## 1. Is packages/pty harness-agnostic?

**Yes, and no branch site was relocated to get there.**

Verified with the gate's own detector — `findHarnessBranching` from
`scripts/architecture-manifest.ts`, the function `check-boundaries.ts` calls — run directly
over both workspaces, because the axiom's `HARNESS_ADAPTER_HOME` exemption hides them from
the normal gate output:

```
harness literals the detector uses: claude-code, codex, grok, opencode, cursor

=== packages/pty — 0 harness-branching site(s) in 28 files
=== packages/agent-bridge — 0 harness-branching site(s) in 88 files
```

Two consequences worth stating plainly:

- **packages/pty:** zero. The extraction did not have to move, rewrite or allowlist a single
  `if harness is X`. The seam was already in the right place; the split just makes it
  enforceable. Because `HARNESS_ADAPTER_HOME` stays `packages/agent-bridge`, the axiom now
  *applies* to `packages/pty` — a harness comparison added there is a violation from today.
- **packages/agent-bridge:** also zero, which is the more useful finding for POD-399. The
  adapters dispatch through the `harnessAdapterFor` registry (a `Record` lookup, which the
  rule correctly does not count as a comparison) rather than through `case` on a literal. So
  **flipping the axiom to error will not newly break either package.** POD-399's remaining
  work is entirely outside them — see §2.

### What is NOT a branch, and stays

Two prose comments inside the moved code name Claude Code as an *example*, and are
deliberately kept as scar tissue:

| Site | Text | Why it stays |
|---|---|---|
| `packages/pty/src/session.ts` (spawn env) | "…without it agents like Claude Code degrade to a 256-color approximation" | Records *why* `COLORTERM=truecolor` is asserted. Deleting it invites someone to drop the env var. |
| `packages/pty/src/abduco.ts` (redraw) | "…node-based TUIs (Claude Code included) repaint only when the dimensions actually change" | Records *why* redraw shrinks-and-restores instead of nudging. This is the reasoning behind the repaint mechanism. |

Both are documentation of a general terminal-behavior fact, illustrated with a concrete
agent. Neither reads harness identity at runtime. The detector agrees (0 sites).

`osc-title.ts` similarly mentions Claude Code's `/rename` and Codex's thread name in its
header comment, describing what OSC titles are used for in the wild.

## 2. Harness branching NOT relocated — the complete list for POD-399

None of these were touched by POD-396; the extraction moved none of them and cleared none of
them. Counts are from `bun scripts/check-boundaries.ts`, and are **identical before and
after** the extraction (46 allowlisted-warn + 18 hard = 64 sites).

| File | Sites |
|---|---|
| `packages/client-core/src/viewmodels/derive.ts` | 10 |
| `apps/server/src/modules/sessions/service.ts` | 9 |
| `apps/daemon/src/session-observers.ts` | 6 |
| `apps/web/src/features/settings/sections/shared.tsx` | 5 |
| `apps/daemon/src/durable-headless.ts` | 5 |
| `apps/web/src/features/terminal/AgentPanel.tsx` | 4 |
| `packages/runtime/src/settings.ts` | 2 |
| `packages/domain/src/machine-selection.ts` | 2 |
| `packages/composer/src/driver.ts` | 2 |
| `apps/web/src/lib/WorkerLabel.tsx` | 2 |
| `apps/web/src/features/worklist/SidebarUnified.tsx` | 2 |
| `apps/web/src/features/issues/issue-context-menu.ts` | 2 |
| `apps/server/src/modules/superagent/service.ts` | 2 |
| `apps/daemon/src/headless-drivers.ts` | 2 |
| `apps/daemon/src/handoff-package.ts` | 2 |
| `apps/daemon/src/control/handoff.ts` | 2 |
| `apps/daemon/src/control/credentials.ts` | 2 |
| `apps/web/src/features/worklist/SidebarRail.tsx` | 1 |
| `apps/daemon/src/control/session.ts` | 1 |
| `apps/daemon/src/control/exec.ts` | 1 |
| **total** | **64** |

Of those, the **18 currently hard-failing** (not in `boundary-allowlist.ts`, or over count) —
the set POD-399 has to clear before the axiom can go to error at all:

```
apps/server/src/modules/sessions/service.ts:2947, :4921, :4926, :5031
apps/daemon/src/control/credentials.ts:20, :23
apps/daemon/src/control/session.ts:225
apps/daemon/src/session-observers.ts:1018, :1313, :1342, :1356
apps/web/src/lib/WorkerLabel.tsx:110
apps/web/src/features/terminal/AgentPanel.tsx:1048
apps/web/src/features/issues/issue-context-menu.ts:47 (x2)
apps/web/src/features/worklist/SidebarUnified.tsx:451
packages/composer/src/driver.ts:106, :107
```

`apps/daemon/src/control/session.ts` moved from line 226 to **225** purely because the
import block above it got one line shorter. Same site, not a new one.

**Why none were relocated:** every one is in an *app* or a downstream package (`client-core`,
`composer`, `runtime`, `domain`), i.e. a consumer deciding presentation, settings or
orchestration from a harness identifier. Relocating them means giving each harness adapter a
descriptor the consumer can read instead — that is POD-398's capability-table fold, then
POD-399's flip. Moving PTY code neither creates nor removes any of them, and pulling any of
them into this diff would have made the extraction unreviewable.

## 3. Constraints the extraction had to preserve

| Constraint | How it was verified (not assumed) |
|---|---|
| abduco backend + keyboard fidelity | `packages/pty/src/abduco.test.ts` 23/23 and the two-backend behavior matrix, green. `test/pty-behavior/spec.ts` is one spec run against **both** backends so neither can drift. |
| Feature-detect `spawn({terminal})` | `defaultPtyBackend()` moved byte-identical; it still probes for a *working* terminal API and still fails loud rather than falling back to a node-pty a compiled daemon does not have. `bun-terminal-detect.bun.test.ts` green. |
| Sync/async twins not entrenched | Exactly 4, unchanged, and still *counted*: see §4. |
| PTY-size ops gated on `viewState` | Caller-side (daemon); untouched by this diff. Recorded in `packages/pty/README.md` as the caller's obligation so the next reader does not assume pty owns it. |
| Tests must not leak PTYs | Every targeted run was followed by an `abduco` session check: my runs left **zero** `reaptest` sessions. Reaping done by explicit PID only — never `pkill -f`. |

## 4. The phantom zero this move would have created

`scripts/rearch-audit.ts`'s `durable-host-sync-async-twins` detector was hard-scoped to
`packages/agent-bridge/src/`. Moving `abduco.ts` and `tmux.ts` out of that prefix would have
dropped the count from 4 to 0 — which the ratchet reads as *"twins deleted, POD-324 clear to
close"*. A package move masquerading as progress, in the exact shape this audit exists to
catch.

The detector now spans both durable-host homes. Verified against its real output, not the
total:

```
   4  durable-host-sync-async-twins (POD-324) — Sync/async abduco+tmux twins
        packages/pty/src/abduco.ts:226  export function abducoHasSession(...)
        packages/pty/src/abduco.ts:267  export function killAbducoSession(...)
        packages/pty/src/tmux.ts:65     export function tmuxHasSession(...)
        packages/pty/src/tmux.ts:83     export function killTmuxServer(...)
```

POD-324 still has four functions to delete. **POD-397: if any durable-host twin lands in
`packages/harness`, add that root to this detector too.**

## 5. Gate results — before vs after

Base is `201dd989` (tip of `issue/279-integration` when this work started).

| Gate | Base | After | Verdict |
|---|---|---|---|
| `check-boundaries.ts` | exit 1 — 69 violation lines (48 manifest warn, 18 manifest hard, 2 legacy warn, 1 legacy hard) | exit 1 — **69**, same set | No regression. Red on base independently of this work. |
| `rearch-audit.ts` | exit 0 — 21 items, 264 sites, baseline exact | exit 0 — 21 items, **264** sites, baseline exact | Held, including the twins item. |
| `check-no-nul-bytes.ts` | — | exit 0 | Clean. |
| `bun run typecheck` | — | 21/21 successful, **0 cached** (7m21s), `@podium/pty` compiled as its own workspace | Genuine cache miss, not FULL TURBO. |

The only textual diffs in the boundary output are the rule-2 message now enumerating its
allowed set programmatically, and the one line-number shift noted in §2.

## 6. Test evidence

Targeted lanes only, by coordinator instruction (the host was swap-thrashing and the full
lane was declared unreliable; the coordinator explicitly agreed no full-lane run and no
`typecheck --force`).

| Lane | Result |
|---|---|
| node-pty backend — `abduco`, `abduco-bin`, `tmux`, `session`, behavior matrix, `node-pty-backend` | **62/62 pass**, 6 files |
| Bun.Terminal backend — `abduco.bun`, `pty-behavior.bun`, `bun-terminal-detect.bun` | **15/15 pass**, 3 files |
| `@podium/pty` alone — scoped typecheck + tsup build | exit 0; `dist/index.js` 27.68 KB, `dist/index.d.ts` 20.86 KB |
| `@podium/agent-bridge` build (after losing node-pty) | exit 0 |
| `scripts/architecture-manifest.test.ts` | 97/97 |
| `scripts/rearch-audit.test.ts` | 51/51 |
| `scripts/check-boundaries.test.ts`, `agent-bridge/src/index.test.ts`, `daemon/src/session-observers.test.ts`, pty unit tests | pass |
| `apps/daemon/src/durable-headless.test.ts` | pass |
| `apps/daemon/src/daemon.test.ts` | 62/63 — see below |

**Every import verified to resolve**, including the files no typecheck lane covers
(`scripts/`, `tests/e2e`): all 9 symbols imported from `@podium/pty` across the repo checked
against the built `dist/index.d.ts`, and all 4 deep-source imports from `scripts/` checked
for file existence plus the named export.

### Failures diagnosed, each to its actual cause

1. **`scripts/architecture-manifest.test.ts` — REAL AND MINE.** Registering `packages/pty` in
   `MANIFEST` without a row in the `docs/rearchitecture-v3.md` POD-296 tag table is drift, and
   that test enforces the parity. Fixed: ledger row added, `pty → runtime` added to the
   declared same-layer list, `pty-port` removed from the agent-bridge row to match. 97/97.
2. **`scripts/rearch-audit.test.ts` — load artifact.** Two 20-second *timeouts*, not assertion
   failures. In isolation: 51/51, file duration 74s.
3. **`packages/pty/src/abduco.test.ts` — cross-worktree contention, not mine.** `create-session:
   Address already in use` on the fixed label `podium-reaptest-1`. `ps` showed the socket owned
   by PID 67630, whose argv pointed at
   `.worktrees/issue-299-1-1-scaffold…/packages/agent-bridge/test/fixtures/` — another fan-out
   agent's leaked pre-move run, with no live vitest behind it. Reaped that one PID (the 67
   `podium-<uuid>` agent sessions were left untouched); 62/62 after.
   **This is a real test-isolation bug:** the test hardcodes machine-global abduco labels
   (`podium-reaptest-1` for the "live foreign spawner" case), so two checkouts running it
   concurrently collide. Pre-existing; not fixed here (out of scope).
4. **`apps/daemon/test/managed-account-env.bun.test.ts` — RED ON BASE.** `ctx.durableLabelFor is
   not a function`: the test's hand-rolled fake `DaemonContext` lacks a field
   `sessionHandlers.spawn` calls, the error is routed to a no-op `ctx.send` stub and swallowed,
   surfacing as the misleading "spawn failed". The call site is
   `apps/daemon/src/control/session.ts:181`, added **2026-07-16 in 91f5e1b4**, an ancestor of
   base `201dd989`. My only edits to that file are a comment path and moving the
   `hasBunTerminal` import. Filed as **POD-1121**, `discovered-from` POD-396.
5. **`apps/daemon/src/daemon.test.ts` — load artifact.** One failure in
   `createReattachGates`, a pure in-memory concurrency-gate test that paces with fixed
   `setTimeout(5)`/`setTimeout(10)` and touches no PTY, no fixture and nothing this diff
   changed. Passes in isolation.

## 7. Deliberately not done

- **`jsonl-stream.ts` (`LineDecoder`) left in agent-bridge**, per coordinator ruling and for the
  same reason I had reached independently: its only importers are `agent-state/codex.ts` and
  `agent-state/cursor.ts`. It decodes an agent CLI's output — harness territory. Pulling it
  into pty would hand pty a reason to care which agent it is talking to.
- **No `boundary-allowlist.ts` edits.** The extraction neither needs nor grants an exemption.
  (POD-1105 owns that file concurrently.)
- **No harness-branching sites cleared** — §2.
- **The two test bugs found (POD-1121, the abduco label collision) not fixed** — both are
  pre-existing and outside this diff.
- **Historical `docs/internal/**` plans still cite the old paths.** They are archival records
  of what was true when written; rewriting them would bury the real diff.
