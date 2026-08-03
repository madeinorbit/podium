# POD-332 — mobile on the shared slices, and the Phase-6 exit gate

**Measured at:** `HEAD` of `issue/332-6-5-mobile-on-the-same-slices-delete-mob`, rebased onto
`origin/issue/279-integration` at **`cab24060`**. Every number below carries that base; a count
measured on a moving tree reads as settled long after it stops being true.

---

## 1. What was deleted, and what replaced it

`MobileClientValue` was a 55-field interface rebuilt inside one `useMemo` with a **27-entry
dependency array**, re-exporting store fields under mobile-local names and re-deriving on the phone
what the web read from a published slice. It is gone, with `LiveBridge`, `useMobileClient`, the
demo-mode twin of the same object, and the two mobile-local superagent row types.

| audit item | before | after |
|---|---|---|
| `mobile-client-value` | 1 | **0** |
| `superagent-shadow-types` | 2 | **0** |

`bun run audit:rearch` → `deletion audit OK — 32 items, 152 sites remaining (baseline exact)`.

### The seam that replaced it

`apps/mobile/src/client/hooks.ts` — typing and naming only. It derives **nothing**: a derivation
with two or more consumers belongs in a published slice, and one with a single consumer belongs in
its screen. What it holds is the instantiation of the shared hooks at `MobileTrpc`, plus
`useConnected` (stream-plane, read off the hub) and one shared transcript-paging call shape.

`apps/mobile/src/client/shell.tsx` — the three facts the composition root owns and no store
snapshot can answer: the fatal error handed to `onFatalError`, the storage-degradation notice
produced while the replica is being **assembled**, and this principal's local erase. The module
says why each one cannot come from a snapshot, so a fourth field is an argued change.

## 2. Which derivations were consumed, which were left local, and the consumer count that decided it

| derivation | decision | consumers |
|---|---|---|
| `worklistSlice` (sections / rows / pinned / groups / now) | **consumed** — `WorkScreen`, `NewWorkButton`, `NewSessionScreen` | web ×3 (SidebarUnified, CommandPalette, rail) + mobile ×3 |
| `superagentSlice` | **consumed** — `SuperagentScreen` | web SuperagentView + mobile |
| `machineViewsFromWire` / `resolveSpawnTargetMachine` / `usableMachines` | **consumed** — both spawn surfaces | 4 web + 2 mobile |
| `resolveReferent` (F2) | **consumed** — `SessionScreen`'s absent-session states | web issue-edges + mobile |
| `groupSessions` / `withoutShells` triage order (`focusSessionIds`) | **left local** to `SessionScreen` | **1** — publishing it would be the god object growing back under a nicer name (POD-409's rule 1, in the direction that says no) |
| screening queue, tray items, `boardIssues` | **left local** | 1 each, already shared *functions* rather than slices |

**Three screens the coordinator named as still deriving locally — all three now read the slice.**
`WorkScreen` no longer calls `sidebarSections → unifiedWorkList → splitPinnedWork →
groupUnifiedWorkRows` itself, and `hooks/useNow.ts` is deleted: with the worklist on
`store.coarseNow` it had no callers left. That is the second, quieter half of the fix — the phone
and the desk can no longer disagree about whether a snooze has lapsed.

## 3. The multi-user obligations, per acceptance line

- **Per-principal local state.** The SQLite replica and the AsyncStorage side-cache are namespaced
  by user. A user switch **inside a live process** (background → foreground, the case a
  reload-based test cannot reach) adopts neither the previous principal's rows nor its **cursor** —
  the silent one, because a cursor is what makes an empty slice look permanently caught up. Covered
  by three cases in `mobile-replica.test.ts`, with the same-principal re-open as the failure proof.
- **No second UI-persistence path.** No screen touches AsyncStorage; the only importer is the
  composition root, for the side-cache bridge and the legacy migration. Per-user state (readAt,
  snooze, pins, tuck) goes through store commands, as on web.
- **Partial-world rendering.** An absent session now names *why*: evicted → "you do not have
  access" (never a deletion), removed → deleted, no exit record → not-here-yet, and never a
  spinner. Before this, all three read as "it may have been removed on the server".
- **Placement fails closed.** Both spawn surfaces resolve through `resolveSpawnTargetMachine`, so an
  unauthorized machine is never a candidate; an `unauthorized` refusal **stops** the spawn rather
  than falling through to the repo's primary checkout. The pickers render `no access` and `offline`
  as different words, neither pressable. Single-user parity holds: a machine list carrying no `use`
  decision at all is unscoped and fully usable — asserted, and a mutant reading `use` per machine
  reddens exactly that case.
- **Presence.** No mobile surface shows presence, and none was built. If one is added it consumes
  POD-1078 rooms through the shared registry.
- **Attention routing.** Mobile has no OS push and no durable badge: the tab-bar count derives from
  the store's sessions, so it is per-principal by construction — a new principal is a new runtime,
  a new snapshot and a new slice publisher holding nothing. Nothing has to be told a switch
  happened.
- **No client payload carries actor / owner / origin.** The one `actor` / `onBehalfOf` pair in the
  tree is the local outbox's own attribution bookkeeping, identical to web's; nothing is sent.

## 4. Demo mode

`?demo=1` was a second hand-written value object implementing the same 55 fields with fixtures and
no-ops — the shape that lets the design surface and the product surface diverge silently. The
fixtures are **rows** now, in a memory replica under the ordinary `StoreProvider`, so every screen
exercises the same slices and the same actions it does in the product. Asserted directly: the
published worklist slice derives over the fixtures.

## 5. Mutation pass

One mutant at a time, reverted by copying back a byte-verified snapshot (md5 + a grep for the
mutant string returning rc=1), each asserted APPLIED before the run.

| mutant | result |
|---|---|
| `worklistSlice` derives rows from `[]` instead of `unifiedWorkList` | **2 named tests red**, across both new files |
| `worklistSlice` feeds `sidebarSections` an empty repo list | **SILENT** → throw probe on the same line reddened 6 → **assertion gap**, closed, now **1 red** |
| `openMobileReplica` ignores the injected principal | **3 named tests red** |
| `machineViewsFromWire` reads `use` per machine instead of per list | **1 red** — the single-user parity case |
| absent-session mapping renders `not-visible` as `removed` | **1 red** |
| (gate fix) rename `RepoScanFlow` in `spawn-row.tsx` | **1 red** — the repaired structure grep can still say no |

The silent one is the finding worth keeping: with a repo whose only worktree was its own path,
`reposToViews` dropped it as a standalone duplicate, so the repo half of the slice contributed
nothing and every row assertion stayed green. The fixture now carries a second checkout and asserts
`allWorktreePaths`.

## 6. Two gates that were red before this issue touched them

- `apps/web/test/shell.structure.test.ts` asserted that `SidebarUnified.tsx` still contained
  `sidebarSections` and `RepoScanFlow`. POD-331/POD-407 decomposed that file, so both went red while
  the contract they guard was intact — and, worse, would have gone green again on a file that kept
  the word and lost the behaviour. **A source-scan whose subject is one file measures where code
  lives.** They now read the worklist *feature*; the negative invariant stays scoped to the
  component.
- `scripts/rearch-audit.test.ts` requires every detector to still match something, so a working
  detector is distinguishable from a broken one. Zeroing the two POD-332 items made both match
  nothing. They join `ZERO_BY_DESIGN` on the same terms as every other entry — a new suite runs
  both patterns over planted controls (the exact declarations that were deleted) and asserts they
  **fire**, plus the negative over a clean tree.

## 7. What this issue did NOT do

- **POD-1528 (mobile outbox partitioning) is not absorbed.** Mobile still has no `createOutboxFn`,
  so it reaches the legacy engine outbox rather than `KernelEngineOutbox`, and
  `sqlite-outbox.ts` still hard-codes `CLIENT_PARTITION`. This port neither helps nor hinders that
  fix, except that the composition root is smaller: the wiring has one obvious home now, in
  `LiveProvider`'s `StoreProvider` props.
- **No mobile attribution UI.** POD-1516 landed `SessionMeta.createdBy`; rendering the pair is
  POD-1526's, and synthesising one from `author` is exactly what ADR 9 forbids.
- **No new slice was published.** Rule 1 cuts both ways, and nothing here had two consumers that
  was not already published.

---

## 8. The Phase-6 exit gate, as measured

All lanes run individually on the rebased tip (base `cab24060`), exit codes captured without a
pipe. The oracle's five lanes were run one at a time rather than through `bun run oracle`, which
would have re-run the same work; the lane names below are its lane names.

| lane | result |
|---|---|
| `typecheck` | **22/22 successful, rc=0** (0 cached — the changes invalidated it; not forced) |
| `test:unit` | **694 files / 9944 tests passed, 3 files + 20 tests skipped, rc=0** |
| `test:web` (apps/web only) | **205 files / 1632 tests, rc=0** |
| `test:mobile` | **7 files / 58 tests, rc=0** |
| `test:bun:unit` | 14 pass / 0 fail, rc=0 |
| `test:integration` | 294 passed / 6 skipped, rc=0 |
| `test:e2e` | 10 files / 36 tests, rc=0 |
| `test:multi-instance` | 1 file / 3 tests, rc=0 |
| `audit:rearch` | rc=0 — 32 items, **152 sites, baseline exact** |
| `audit:phase2-client` | rc=0 — **all 6 items at zero** |
| `audit:god-objects`, `audit:router-mutations`, `audit:scoped-feed`, `audit:ambient-principals` | rc=0 |
| `lint:boundaries`, `lint:architecture`, `lint:no-nul` | rc=0 |
| bundle / PWA precache | **pass** — 52 entries (5476 KiB), largest asset 2.56 MiB against a 5 MiB per-file ceiling, **0 eligible files excluded** from the manifest |
| Expo web export (`@podium/mobile build:web`) | rc=0 |

**Scope note on the test-count numbers, because two different scopes are in circulation:**
`test:web` above is `apps/web` under its own config. The coordinator's 267-files/2276-tests figure
is `apps/web/src` + `packages/client-core/src` under the DEFAULT vitest config. The numbers are not
comparable and neither is wrong.

### Not green, and not this issue's doing

- **The Playwright browser lane.** 13 passed / 164 failed / 303 skipped, and **143 of the 164
  failures are "cannot reach the server"** rather than assertions: the relay `webServer` dies
  partway through the run and everything after it is `ERR_CONNECTION_REFUSED` in under two seconds.
  Reproduced twice, including once with no other lane of mine running. Filed as **POD-1532**.
- **Three suites call `settings.set`**, a procedure POD-1213 replaced with
  `settings.updatePersonal`. Filed as **POD-1531**.
- `lint:shadowing` reports one shadowed declaration in `packages/harness/src/registry.ts`
  (`harnessResumeKind` declared three times). Untouched by this issue; pre-existing on the base.
- `audit:declared-consumers` reports 5 declarations in `packages/commands/src/contract.ts` with no
  consumer. Untouched by this issue; pre-existing on the base.

**Therefore POD-427 cannot be certified on the "Playwright suites green" criterion tonight**, and
POD-293 must not close on it. Everything else the gate names is green and measured above.

### The human gate

The real-device half of the mobile e2e is a HUMAN GATE (section 6 of the brief): cold-start offline
paint from the SQLite replica, reconnect drain, and terminal-pane parity on a physical phone. The
Expo web build is green and the replica behaviour is covered by the mobile lane, but a device pass
is not something an agent can sign.
