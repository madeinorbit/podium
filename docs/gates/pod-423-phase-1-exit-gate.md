# POD-423 — Phase 1 exit gate: model foundation verified

**VERDICT: CLOSED.** Phase 1 exits. This supersedes the HELD OPEN verdict recorded at
`36ad0bb7`; all three of its blockers are answered and were re-measured here rather than
read off the reports that answered them.

**Measured at `1c192dcc`** (branch `issue/423-1-7-phase-1-exit-gate-model-foundation-v`,
**0 ahead / 0 behind `issue/279-integration`**). One file changed by this gate:
`scripts/install-sh.test.sh`, the harness defect the prior verdict left unowned (§4).

**Base check, done before trusting any number.** `podium issue start` branched this worktree
from main; the coordinator reset it to integration HEAD. Verified independently:
`git rev-list --left-right --count HEAD...issue/279-integration` → `0 0`. `bun install` re-run
here; the resulting `node_modules` carries no `@podium` scope, which is the documented
posture for these worktrees (ledger, wave 6) — cross-package resolution runs through source
conditions, not a local install.

---

## The method, because the verdict depends on it more than on the counts

This run's dominant defect is **instruments that cannot say NO**, and an exit gate is an
instrument. A zero is worth nothing until the thing that reports it has been made to report
a one. So every audit item named in this gate's AC was **mutated on the real tree** — not on
a planted fixture inside the detector's own test — with the match count and file hash
checked before the result was believed, and reverted atomically afterwards. A detector that
only fires on its own fixture proves the fixture, not the tree.

| Mutation planted on the real tree | Instrument | Said NO? |
|---|---|---|
| `byIssueId = z.object({ id: IssueIdField })` → `z.string()` in `packages/commands/src/issues/contracts.ts:111` (spelling 3: entity named by DIRECTORY only) | `raw-string-entity-ids` | **YES** — `baseline 0 → now 1`, named `contracts.ts:111` |
| `export const AgentKind = z.enum([...])` in a new protocol file | `agent-kind-enums` | **YES** — named the file:line |
| `export function stateDir()` in a new protocol file | `state-dir-defs` | **YES** — named the file:line |
| A 9-key hand-restated session shape in a new protocol file | `session-shapes` | **YES** — named the 4 session keys it restates |
| `instance_id` DDL **column** on a new `sqliteTable` | `instance-partitions` | **YES** — `probe_sessions.instance_id (column)` |
| A new `sqliteTable` with no matrix row | `audit-durable-classes` §1 | **YES** — `drizzle-table-undeclared` |
| A new module calling `writeFileSync`, on no schema | `audit-durable-classes` §3 | **YES** — `write-site-unaccounted` |
| `row: 'settings-audit-trail'` → `'settings-audit-trale'` (a misspelling `visibilityClassOf` answers `personal` for) | `audit-durable-classes` §2 | **YES** — `store-names-a-row-that-does-not-exist` |
| Original `bash -i` PATH probe, with `install.sh` no longer writing `.bashrc` | `install-sh.test.sh` (after §4 fix) | **YES** — only the `bash -i` arm failed; `sh -l`/`bash -l` still passed |

All nine reverted; tree verified clean and audits re-run green after each.

---

## The three prior blockers, re-measured

### B1 — Raw-string entity ids: ANSWERED

`raw-string-entity-ids` is now a real key in `scripts/rearch-audit-baseline.json` at **0**,
phased to POD-301, and the detector reads a derived brand vocabulary rather than a hand list.
The prior verdict's sharper form was the right one: POD-301 *had* built a detector, sound for
the two spellings that read a NAME (the field key, the declaration) and blind to a third,
where the entity is named by neither and only the directory says `Issue`. POD-1212 added that
spelling. **Re-measured here, not quoted:** flipping a branded id back at
`contracts.ts:111` — a `byIssueId` shape whose key is the bare word `id` — drives the ratchet
RED naming the exact site. The same mutation was GREEN before POD-1212.

`unbranded-by-decision-ids` is **17**, up from 13: the three sites POD-1212 excluded by rule
(`subscriptionRemove`/`subscriptionSetEnabled`, a subscription id; `pinSet`, polymorphic over
`panel|worktree|repo`) each carry a marker, so the excuse is counted and ratcheted rather than
invisible. That is the correct shape for an exclusion.

### B2 — The unmatrixed durable classes: ANSWERED

`scripts/audit-durable-classes.ts` exists, runs as a **test in the unit lane** (not only as a
CLI with a `--probe` mode nobody invokes), and reports **87 durable stores, every one on the
matrix or explained**. It asserts MEMBERSHIP in `OWNERSHIP_MATRIX_INDEX` and never calls
`visibilityClassOf`, which is total and answers `personal` for an unclassified class and a
misspelled row id alike — the exact failure that let fourteen classes through.

It is **not keyed on the SQLite schema alone**, which was the half that would have let `pspec`
through again. Verified by mutation, not by reading: a module that writes durable bytes and
appears on no schema at all is caught by §3, and a misspelled matrix row is caught by §2.
POD-1211's own report of it going red on first contact with integration — catching
`settings_audit_events`, which POD-421 landed after POD-1211 branched — is consistent with
what I measured: three independent populations, three independent refusals.

### B3 — "All Phase-1 children closed": ANSWERED, with one item of BOOKKEEPING named as such

`done`: POD-299, 300, 301, 302, 303, 304, 360–368, 643, 1075, **1076**, 1141, 1151, 1153,
1162, 1211, 1212. POD-301 and POD-1076 — the two the prior verdict found at `backlog` — are
both `done` and merged.

**POD-288 is `backlog`, and it is the Phase 1 umbrella itself, not a child.** Saying so
explicitly, as instructed: I am **not** letting the AC's literal sentence hold this gate shut
on an empty umbrella, and I am **not** passing over it silently. POD-288 carries no
deliverable of its own; every deliverable it names is closed. Closing POD-288 is the
coordinator's bookkeeping act at Phase 1 exit, and this gate is the evidence for it.

---

## §4 — The harness defect the prior verdict left unowned: FIXED

The prior verdict found the multi-instance oracle lane failing inside `install`, where
`bash -i` "resolved `podium` to this host's sudo lecture text", and called it an environment
artifact of this box. **It is not an artifact of this box. It is a defect in the probe, and it
fails on any stock Debian/Ubuntu host** where the invoking user is in the `sudo` or `admin`
group.

Root cause, read off `/etc/bash.bashrc:43-49`: the sudo hint prints **to stdout** at
interactive-shell startup whenever `$HOME/.sudo_as_admin_successful` and `$HOME/.hushlogin`
are both absent. `scripts/install-sh.test.sh` deliberately runs under a **fresh temp `$HOME`**
(line 6), so that file can never exist, so the hint fires on every run — and the probe
captured the **whole stdout stream** as its answer, which can then never equal a path.
Deterministic repro, independent of Podium:

```
$ T=$(mktemp -d); env -i HOME=$T PATH=/usr/bin:/bin TERM=dumb bash -i -c 'command -v ls'
To run a command as administrator (user "root"), use "sudo <command>".
See "man sudo_root" for details.

/usr/bin/ls
```

My real `$HOME` has `.sudo_as_admin_successful`, which is why the same probe is clean there —
the failure is invisible to exactly the developer most likely to run it by hand.

**Fix:** the probe's answer is now **marker-delimited** (`printf "podium-probe:%s\n"`) and
extracted with `sed`, so ANY startup chatter is discarded — not just the one banner this host
happens to print. Special-casing the sudo hint would have left the next distro's banner to
rediscover.

**It still refuses.** An empty or missing answer fails as before, and the counterfactual was
run rather than assumed: with `install.sh` mutated to stop appending to `.bashrc`, `sh -l` and
`bash -l` still pass and **only** `bash -i` fails, reporting `<nothing>`. A/B on this host:

| `scripts/install-sh.test.sh` | Result |
|---|---|
| Before fix | `FAIL: 'bash -i' resolved podium to 'To run a command as administrator…'` (exit 1) |
| After fix | `ALL OK` (exit 0) |

This is why the multi-instance lane is GREEN below and was RED for the prior session.

---

## Verification lanes — all re-measured on this tree

| Lane | Result |
|---|---|
| **`bun scripts/oracle.ts`** | **GREEN — 5 lanes**: typecheck GREEN, unit GREEN (456s), integration GREEN (103s), e2e GREEN (33s), **multi-instance GREEN** (22s). Exit 0. |
| Workspace typecheck, `--force` | exit 0 — `23 successful, 23 total` / **`Cached: 0 cached, 23 total`** / 1m17s (the oracle's own typecheck lane was a full cache hit; this is the uncached evidence) |
| `scripts/rearch-audit.ts` (deletion audit) | exit 0 — **29 items, 178 sites, baseline exact** |
| `scripts/audit-durable-classes.ts` (+`--probe`) | exit 0 — **87 durable stores**, every one on the matrix or explained |
| `entity-id-audit.test.ts` + `audit-durable-classes.test.ts` | exit 0 — 57 tests |
| `representation-audit` / `change-row-audit` | exit 0 / exit 0 |
| `check-boundaries` / `check-no-nul-bytes` | exit 0 / exit 0 |
| `audit:{issues,sessions,superagent,workflows,fleet,mail}` | **6/6 exit 0** (each runs `--probe` first) |
| Wire goldens (3 suites) | exit 0 — **182 tests** |

**The deletion audit ratcheted DOWN again**: 186 sites at the prior verdict → **178** here,
baseline exact. No rebaseline was performed by this gate.

**The four AC audit items, with their baseline keys:**

| AC item | Key(s) | Count |
|---|---|---|
| hand-restated definitions | `session-shapes`, `issue-shapes`, `representation-registry-rot` | **0, 0, 0** |
| raw-string ids | `raw-string-entity-ids` | **0** |
| agent-kind / capability tables | `agent-kind-enums` | **0** (`capability-tables: 5` is phased POD-325 / Phase 5.3 — outside Phase 1) |
| stateDir | `state-dir-defs` | **0** |

### Wire fixtures unchanged — re-derived here, not consumed as given

The prior gate consumed POD-1162's attribution. I re-derived it. `wire-golden.json` has five
commits in its whole history; none since the prior verdict. Comparing every case captured
**before** the entity-schema move — which is the move Phase 1 exists to make — against today:

- vs `330173f8` (fixtures captured *before* POD-300 moved the schemas): **80 of 80 byte-identical, 0 changed, 0 missing**
- vs `b45dc177` (after the automation captures): **85 of 85 byte-identical, 0 changed, 0 missing**
- 89 cases today; the 4 added are the handoff family (POD-643 format-2 pinning, POD-1153)

Phase 1 moved every replicated entity schema out of `packages/protocol` and did not move one
byte of the wire.

---

## Recorded deviation — does NOT hold this gate, but must not be silent

**`per-user-singletons` is 2, and POD-1076 — which owns it — is `done`.** The recorded rule in
`docs/rearch-deletion-audit.md` §"The phase-close rule" is unconditional: *a phase issue may
not be closed while any of its mapped items count > 0*. `bun run audit:rearch --phase POD-1076`
exits 1 today and says so:

```
POD-1076 may NOT be closed — 1 of its items still exist:
    2  per-user-singletons
      packages/protocol/src/maintenance.ts:141  IssueAutoArchiveObservation.readAt
      packages/protocol/src/maintenance.ts:151  SessionAutoArchiveObservation.readAt
```

The residual is honest, not hidden: both sites carry an in-code note that `readAt` is per-user
state and that "archive it because it was read" needs a *read by whom?* answer, filed as
**POD-1136** (`proposed`, not ready). The ratchet went **8 → 2**.

Why this does not hold Phase 1 shut: `per-user-singletons` is not one of the four audit items
this gate's AC names, POD-368 declared it a **ratchet, not a zero**, and the remaining question
is a semantic decision Phase 1's own contract forbids making (answering it moves the wire).

Why it is nevertheless a finding: the codebase has a recorded, legitimate mechanism for this —
**re-phasing**, used once already to move `change-row-typings` from POD-302 to POD-308 with the
reason written down. It was not used here. POD-1076 was simply closed while its instrument was
refusing. **I did not re-phase it myself**: doing so would be the gate laundering a red in order
to close itself, which is the exact defect class this run is about. The coordinator should
either re-phase the item to POD-1136 with a recorded reason, or reopen POD-1076.

**Also settled, so it need not be re-derived:** POD-1166 ("an `instance_id` DDL column passes
every check") is **superseded** — POD-1168's widened detector fires on a real-tree DDL column,
verified above. It can be closed.

---

## Limits — what a green run here does NOT mean

1. **`agent-kind-enums` and `state-dir-defs` are anchored on a symbol NAME.** Verified in both
   directions: `export const AgentKind = z.enum(` and `export function stateDir` fire;
   `AgentKindSchema` and `stateDirectory` do **not**. Both items declare this in their own
   `unit` text and both are regression guards on a canonical name, so a renamed duplicate would
   still have to be imported by consumers to matter — but it is a blind spot, not a proof.
2. **`session-shapes` / `issue-shapes` enumerate RESTATEMENTS and can never enumerate
   REPRESENTATIONS** — a composed shape (`Pick<IssueWire, …>`) leaves no key list to count.
   POD-368's stated limit, unchanged. `representations/registry.ts` is the enumeration, and is
   deliberately not derived from these detectors.
3. **The durable-class gate asserts membership, not correctness.** A store mapped to a
   plausible-but-wrong matrix row passes (POD-1211's Limit 1, POD-385's Limit 3). Six
   coordination-shaped classes are classified `personal`-with-no-owner rather than deployment
   substrate, deliberately: moving anything INTO substrate is an ADR 1 Amendment 1 D9.3
   amendment, which no agent may take unilaterally. **If Phase 1 exit were held to require those
   six settled AS substrate, that is an ADR 1 amendment and a separate human decision** — this
   gate does not claim it.
4. **`raw-string-entity-ids: 0` is 0 of what the vocabulary can name.** ~227 zod string id
   fields name neither a brand nor a tenant; most name entities with no brand in
   `packages/model`, so there is nothing to flip them to. Two are genuinely unreachable and
   named rather than hidden: `duplicateInput.canonicalId` and `causationId`. Minting the missing
   brands is separate work.
5. **POD-1165 is open** — the per-user detector cannot tell a singleton from a row keyed
   `(userId, entityId)`. It sits adjacent to the deviation above and is `proposed`.
6. **The two known repo-wide reds did not reproduce.** `scripts/loop-split-load.integration` and
   `scripts/rearch-audit.test.ts` both passed inside a green oracle on this run. I am not
   claiming they are fixed; I am recording that they did not fire here.

---

## What this gate now GUARANTEES

Anyone can check the following without trusting this document. On `1c192dcc`, every
replicated entity in this repo is declared once in `packages/model` and nowhere restated: the
detectors that assert it (`session-shapes`, `issue-shapes`, `raw-string-entity-ids`,
`agent-kind-enums`, `state-dir-defs`, `representation-registry-rot`) all read **0** with a
ratcheted baseline that can only fall, and each was **shown to report a 1** when the violation
it names was planted in real source — including the spelling where the entity is identified by
its directory alone, which was green as recently as POD-1212's branch point. Every one of the
87 durable stores in the repo — drizzle tables, tables created by raw DDL, and every module
that writes durable bytes to a file or a database, the population that contains `pspec` — is
either on ADR 1's ownership matrix or carries a written reason it is not an entity class, and
that is asserted as MEMBERSHIP in the unit lane, so a misspelled row id fails instead of
quietly resolving to `personal`. That vocabulary moved without moving the wire: all 80 golden
cases captured before the schema move are byte-identical today, and the only 4 cases added
since are the handoff family. `bun scripts/oracle.ts` is green on all five lanes, including
the multi-instance lane, which is green because the `bash -i` PATH probe was actually repaired
and A/B-proven — not because it was excused. The one thing this gate does **not** guarantee is
that any given classification is *right*, that a duplicate spelled under a different symbol
name would be seen, or that `per-user-singletons` reached zero — it stands at 2, named above,
with both sites cited.

To re-run everything behind this verdict:

```bash
bun install
bun run typecheck --force
bun run audit:rearch                       # 29 items / 178 sites, baseline exact
bun run audit:durable-classes              # --probe then live; 87 stores
bun run audit:rearch --sites               # every count with its file:line sites
bun run audit:rearch --phase POD-1076      # the one recorded deviation, exit 1
bun scripts/oracle.ts                      # 5 lanes
bash scripts/install-sh.test.sh            # ALL OK
```
