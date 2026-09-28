# Round three MobX pool: review against Linear and the round-three design (2026-09-28)

**Scope.** `packages/worklist-proto/arms/mobx/pool/` on `integrate/4545-round-three` @ `95ec37a7d`:
8,568 non-test lines, 9,713 test lines. All `file:line` references are at that SHA.

**Sources.**
- Linear, raw transcripts only: `~/Resources/LinearTalk/transcript_talk1.txt` (React Helsinki 2020) and
  `transcript_talk2.txt` ("Scaling the Linear Sync Engine").
- Design: round-two audit §5–7 (`docs/decisions/4441-round-two-audit.md`, the plan of record), L1a schema,
  L1b row view, L1c write contract, L3a per-row feed.
- Prior reviews and records: M3, M4 lessons, M5 review, N1a exercise, `docs/measurements/POD-4705-c3.md`,
  `docs/measurements/POD-4576-c4.md`, and for the hand pool `POD-4588-c3.md` and `POD-4707-c3.md`.
- Code read in full: `pool.ts`, `relations.ts`, `models.ts`, `tables.ts`, `views.ts`, `clock.ts`,
  `worklist/visible.ts`, `worklist/rollup.ts`, `worklist/groups.ts`, `write/edit.ts`, `react/list.tsx`,
  `react/row.tsx`. `residency.ts`: header and structure only.
- Two probes, both run in isolated checkouts of `95ec37a7d` (appendix): a count and behaviour probe on this
  box (counts only), and a bootstrap phase and micro-benchmark probe on flatblock (§5).

## Verdict

| # | Question | Answer |
|---|---|---|
| 1 | Is it correct? | **Yes, on the display path.** L4b gate 20 seeds × 300 steps, the whole-view gate, the Mc2 truth gate 20 × 300, and planted mistakes that fire. I found no display bug. I found **three contract gaps**: W10 expiry is not wired; the model's own field getters ignore pending edits; and the shared cold rule does not cover R3 (C1–C3). |
| 2 | Is it built the way Linear builds its client? | **The data layer is. The reactive layer is not.** Relations are declared once and maintained by the pool, lazy relations exist, and edits go through a transaction log. But once mounted at 1x, the pool holds **about 122 computeds and 11.5 reactions per visible row**: 89,637 declared computeds and 8,448 reactions for 732 visible rows. 2,112 per-issue nodes are built at bootstrap, 856 of them on cold issues. Talk 2 says construction plus MobX was Linear's scaling bottleneck. Linear fixed it by making objects observable only when they are accessed. Here that fix covers only the models. Measured: the same visibility work runs about 5× slower through MobX nodes than as plain code (§5). |
| 3 | Does it pass the plan's own gates? | **No: it fails G3 and G6, and so does the hand pool on G6.** MobX G6: cold bootstrap 669.9 ms vs control 190.1 ms (3.5×), retained heap 60.75 vs 22.55 MB (2.7×), principal switch 2.6×. MobX G3: excess slopes of 1.74, 3.00, 5.08 and 2.88 against a budget of 1.2. The hand pool after POD-4707: bootstrap 2.27×, heap **59.12 MB** (2.62×). The heaps are the same, so most of the heap is the **shared pool substrate**: an index and filing state for every known row, cold rows included. MobX's own extra shows in bootstrap build time (565 ms against the hand pool's 411 ms and the control's ~100–120 ms). As written, audit §6 ("an arm that fails a gate is out") eliminates both arms. M5's "ready for judgement" does not address this. |
| 4 | Is it simple and elegant? | **Some parts are; the whole is not.** It is 3.4× the size of round two's arm. A second, untracked evaluator decides which reactive nodes exist. Four derived indexes are kept by reactions. Plain structures are read inside derivations, each paired with an atom by hand. Much of this complexity came from the instruments (the reads fence and the slope gate), not from the problem. |
| 5 | What should change? | §4, by category. The central item is a real memory cutoff (§4.7), which is not planned today: the kernel holds every row in memory by spec. |

## 1. Linear compared with ours

### 1.1 Side by side

| Aspect | Linear (transcript) | Ours | Verdict | Change? |
|---|---|---|---|---|
| **Pool** | "one big array of all the objects"; one instance per entity (t1) | One `ObservableMap` per entity, holding the kernel's row object by reference (`observable.ref` per slot, `tables.ts:86-90`) | **Good.** One observable per row and no copy, which costs less at bootstrap than per-property observables. | Keep |
| **Change granularity** | Per property (`@Property` decorators); a sync action carries only the changed properties (t2) | Per row: any field change swaps the row object, and `computedStruct` parts restore field granularity downstream | **Acceptable**, but it pushes the design toward many small computeds per entity (§3.2) | Coarser parts (A1) |
| **Relations** | Decorator metadata (`@ManyToOne`, `@OneToMany`). A `teamId` resolves to the Team object and the pool maintains the inverse collection on insert, update and delete. A reassignment is a remove, then an add (t1). | Declared as data (`shared/src/schema.ts`), checked with negative controls, maintained by one generic engine (`relations.ts`). Inverses are ID buckets; detach then attach. | **Better than Linear:** validated, testable, one maintenance path. One exception is hard-coded (§2). | Keep; fix the exception (A5) |
| **Navigation** | `issue.team.name`: object references, typed | `relations.one('issue', id, 'repo')`, then `inputs.repo(repoId)`: string names and ID lookups. Models install field getters from the schema but no relation getters. | **Worse ergonomics and type safety**: every consumer does its own graph walk by hand | Typed relation getters (A5) |
| **Collections** | Their own `Collection` class "from the get-go" so they control access; `LazyCollection` subclass (t2) | `RelationReader` (`one` / `many` / `size`), plus `lazyMany` | **Equivalent** control point | Keep |
| **When observability is built** | "Now we actually do it only when we access those model objects… when we find them by ID… or when we access a collection" (t2) | Models: on first access (0 at bootstrap). **Visibility nodes: 2,112 at bootstrap** (856 on cold issues), each with 32 computeds and 4 reactions. Relation index: an observable map or set entry for every resident row's links. | **The key divergence.** Linear's lesson is applied to the thinnest layer only | A1–A3 |
| **Derived state** | The talks describe views as observers of the graph and no per-model reactions. The pool hears property writes through decorators. | Four reactions per `IssueNode` keep four derived indexes: the visible set, nest filing, formal filing and group placement (`visible.ts:1313-1353`) | **Worse**: two-phase propagation, 8,448 reactions at 1x, and derivation graphs kept alive for 43% of issues whatever is on screen | A2 |
| **Lists** | Sorted and grouped at render time over the collection, virtualised (audit §7) | The order is a view-time sort (`visible.ts:1257-1262`). Groups are filed by reactions (POD-4686) to pass the slope gate. The list is virtualised. | **Mixed.** The deviation was forced by G3 (§3.3) | Decide the scale target (I2) |
| **Row components** | Observer components read the models | The row receives a plain `RowView` and nothing else (L1b); the slot is the observer | **Good safety trade** (it closes round two's planted row scan), but it gives up MobX's per-component fine-grained reads | Keep |
| **Optimistic write** | Mutate the model, `save()` records a transaction holding the old values, roll back to the old values on rejection (t1, t2) | A pending log with receipt plus echo. An overlay map is applied where rows are read; rewind goes to the **latest server value** (L1c W5/W8). | **Better semantics than Linear**: Linear rolls back to a value captured at edit time. The placement is worse (§2, W-rows). | C1, C2, A4 |
| **Truth on disk** | The client writes nothing to disk until the server's broadcast confirms it (t2) | Unchanged kernel: outbox, persistence, delta sync, echo (audit §7) | Same family | — |
| **Lazy load mechanics** | IndexedDB, and later the network: a real async fetch, a batch loader with a 50 ms window and dedupe, Suspense, pre-hydration on hover (t2) | A 50 ms window, dedupe, `LOADING` markers and placeholders, **over the kernel's synchronous in-memory `replica.row`** (`facade.ts:537-544`) | **The right mechanism for a cold tier we have not built yet.** Today the kernel holds every row in memory (`docs/spec/thin-client-replica.md:16`, synchronous replica port), so the window protects no memory. The fix is to make the cold tier real (A3), not to remove the window. | A3 |
| **Type-level laziness** | `CachedPromise` with a `.value`; `hydrate()` returns `Hydrated<T>` (t2) | `Loaded<T>` / `LOADING`, `Residence`; Rule L (a relation is lazy iff its target can be non-resident), recomputed and checked | **Good**, and more formal than Linear's | Keep |

### 1.2 The MobX cost Linear hit, and ours

Talk 2: "you load them up from disk, which is relatively fast, but then you construct them into objects,
and you add MobX on top of that, and that is actually pretty slow". That was at 80–100k model objects.
They fixed it with partial bootstrap, lazy collections, and making objects observable on access.

| 1x unless noted | Count | Source |
|---|---|---|
| Entities known / resident | 4,867 issues + 4,304 sessions / 2,736 + 2,548 | probe; POD-4705-c3 |
| Visible rows | 732 | probe |
| `IssueNode`s built at bootstrap | **2,112** (43% of issues; **856 on cold issues**), 32 computeds + 4 reactions each | probes; `visible.ts:974-1011` |
| `SessionNode`s / `IssueModel`s / `SessionModel`s after a full draw | 2,367 / 796 / 666 | probe (happy-dom draws every row) |
| Declared computeds / maintenance reactions | **89,637 / 8,448** (122 and 11.5 per visible row) | probe |
| `ComputedValue` objects on the heap | 90,700 (7.96 MB); 362k (31.8 MB) at 4x | POD-4705-c3 §2; POD-4576-c4 §3 |
| MobX `spy` "add" events at bootstrap plus a 20-row first paint: computed annotations **and** map and set entries | 119,586. Of these, **`IssueNode` 67,584 and `SessionNode` 11,835 (66%)**. Substrate: table slots 5,284; read-state lane 4,867 (every known issue, cold ones included); relation forward entries about 8,200; seat lists 2,133. | flatblock probe (§5) |
| Retained heap, pool vs floor | 60 vs 22 MB; **211 vs 68 MB at 4x** | POD-4576-c4 §3 |
| Allocation during bootstrap at 4x | `trackDerivedFunction` 60 MB, `make_` 26 MB, `reaction` 11 MB | POD-4576-c4 §3 |
| Same page, hand pool after POD-4707 (no MobX) | bootstrap 536 ms (2.27×), heap 59.12 MB (2.62×) | POD-4707-c3 |

The per-change hot path is excellent: stage move 0.3 ms to apply, click 0.09 ms (POD-4705-c3 §3). The cost has
moved into construction and heap. Two layers carry it:

- **The substrate both arms share.** The pool indexes every known row, cold ones included, beside a kernel
  that already holds all the data. Both arms add about 38 MB over the floor at 1x. In the MobX arm only
  about 8 MB of that is `ComputedValue` objects, so the substrate is most of it. Linear keeps cold data out
  of memory entirely.
- **MobX's own construction and evaluation.** Nodes plus their first reactive run cost 166–201 ms at 1x,
  against 33 ms for the same logic as plain code (§5). This is exactly where Linear says MobX hurts.

## 2. Against the round-three design

| Clause | What it says | What was built | Verdict | Warranted? | Rework |
|---|---|---|---|---|---|
| L1a §1, §4, §7 | No per-relation code in an arm; everything from `schema.ts` | Generic engine, and a new relation needs zero engine code (N1a change D). **Exception:** the `issueless` index hard-codes `session` and `issueId` (`relations.ts:352`, `:563-575`, `:868`, `:979`, `:1007`), despite the header "NO RELATION IS NAMED HERE". | PASS with one exception | The need is real (the POD-4671 ruling); the hard-coding is not | A5 |
| L1a §4.1–4.3 | Insert, update and delete rules; detach, then attach | Implemented; the planted missing-inverse mistake (L6b probe P5) fails, and the gate checks relations every step | PASS | — | — |
| L1a §4.4 | No maintenance path scans a collection | Bounded exceptions only (collapse group, lane members) | PASS | — | — |
| L1a §5 | A cold row "stays on disk (IndexedDB)… the first read… triggers a load, batched" | A cold row stays in the **kernel's memory** (synchronous read). The arm adds a 50 ms async window (`residency.ts:84`), `LOADING`, placeholders and settle rounds. | The mechanism matches; its reason was never built. The kernel was frozen for round three and keeps every row in memory, so no memory is saved. | The mechanism is right; the missing cold tier is the gap | A3 |
| L1a §5 | MobX: "made observable on first access… must not happen for the ~2,600 closed issues at boot" | Models: yes. Nodes: 2,112 at bootstrap, 856 of them cold. The plain pass **reads all 2,131 cold issues at bootstrap** (3,112 feed reads, POD-4705-c3 §2; 24–26 ms at 1x, §5). | PARTIAL | Only because of the next row | C3, A1, A3 |
| L1a §5.1 | The cold rule is an upper bound on R-VIS, "except R3 and a clock rewind" | Because R3 is outside the bound, the arm must evaluate every cold row at bootstrap. That "no closed row is kept by R3 alone" is a property of the corpus, not a guarantee. | **Contract gap** | — | C3 |
| L1b | `RowView` only, and a capability rule | `react/row.tsx` takes `{ row }`; the slot is the observer | PASS | — | — |
| L1c W1–W9, W11, W12 | Paint, log, receipts, echo, overtake, supersede, reload | Implemented; Mc2 truth gate 20 × 300 green | PASS | — | — |
| **L1c W10** | "The arm calls `log.expire()` from a timer while it holds receipted edits" | **Not wired**: "No timer drives this yet" (`write/edit.ts:135`). | **FAIL** | No | C1 |
| **L1c §1** | "Round three moves optimism onto the model" | An overlay map beside the pool. At runtime it replaces five pool input functions (`write/edit.ts:222-267`). The model's schema getters read the raw table (`models.ts:67-68`). **Probe: during a pending rename `pool.issue(id).title` = "collapse rail 3" (server), while `view.title` = "Pending title".** | **PARTIAL (latent)**: no production reader uses the model getters today | The overlay: yes (the tables hold kernel rows). The patching: no. | C2, A4 |
| L3a | Truth mode for phase c | Used | PASS | — | — |
| Audit §7 | "Visible set sorted at view time, virtualised" | Order: view time. Groups: filed by reactions (POD-4686). `groups.keys` keeps the full `order` sort alive "and its sort counter honest" (`groups.ts:488-492`). | PARTIAL | Only under G3 | P1, I2 |
| Audit §7 | "Objects become observable on first access" | Models only | PARTIAL | — | A1–A3 |
| Audit §7 | Roll-ups "lazily and memoised for visible rows… never for the corpus" | Computed on read, composed from cached child results | PASS | — | — |
| Audit §6 G1, G2, G4, G5 | Correctness, fidelity, isolation, safety | Green (M5 §13 plus the gate records) | PASS | — | — |
| **Audit §6 G3** | Slope ≤ 1.2; p95 within the floor plus an allowance | Slopes 1.74 / 3.00 / 5.08 / 2.88. p95 over on heartbeat, visible heartbeat and stage move at 1x. | **FAIL** | — | Re-measure after A1–A3 on the two-axis corpus (I2) |
| **Audit §6 G6** | Lifecycle within the control multiples | Bootstrap 3.5×, heap 2.7×, switch 2.6×. The hand pool also fails: 2.27× / 2.62×. | **FAIL** | — | Restated as a growth test (I4); A3, A1 |
| Audit §6 G7 | Native lane on the real RN renderer | react-native-web under happy-dom only (M5, mobile note) | NOT MET | — | Out of scope here |

## 3. First principles

### 3.1 What is good; keep it

- **Schema as data**, with a validator and negative controls, and Rule L computed rather than typed in.
  This is better than decorators.
- **Kernel rows by reference in `observable.ref` slots**: one observable per row, no copies, and change
  detection by object identity.
- **`DeadlineClock`** (`clock.ts`): an atom per deadline, dropped when nothing observes it, so a tick wakes
  only the rows it crosses. This is idiomatic, minimal MobX.
- **Roll-up combines are pure** (`rollup.ts:321-335`, `:440-450`) and compose from cached child values.
  Each aggregate carries both root verdicts, so no root walk is needed.
- **One set of part functions** runs live and in the rebuild, which makes the gate meaningful. The same
  functions also make the plain bootstrap pass cheap: 33 ms for the closure at 1x, against 166–201 ms
  through MobX nodes (§5).
- **Write log shared with the oracle**, with rewind to the latest server value.
- **Strict MobX flags plus a trap that turns every warning into a test failure.**

### 3.2 What is not simple

| Item | Where | Why it matters |
|---|---|---|
| Two per-issue objects compute overlapping facts from the same row | `IssueModel` (12 computeds, `models.ts`) and `IssueNode` (32 computeds plus 4 reactions, `visible.ts:964-1154`). `own` vs `standing` / `rank` / `settledPlacement`. | Twice the construction cost, and one change touches two places |
| **A second, untracked evaluator decides which reactive nodes exist** | `plainScope` / `expandRoots` / `syncWorklist` (`pool.ts:711-1107`, about 400 lines) re-run the visibility parts outside MobX to predict which nodes the reactive graph will need | At bootstrap this is cheap and sound: the plain pass is about 5× cheaper than MobX (§5). **Per change**, correctness depends on the prediction matching the graph. That is the "sensitivity set" L1a §4.4 forbids, in a new form. Its fix history shows the risk: the seed-8 fix, rescope parity, reparented held rows, R3 lane evaluation. |
| Derived state is filed by reactions | 4 reactions per node (`visible.ts:1313-1353`) and the group filing (`groups.ts:423-441`) | MobX's guidance is to derive state with computeds and keep reactions for side effects. Here propagation has two phases: a computed changes, a reaction runs, an observable is written, and another computed re-runs. The visible-set reaction is justified at 4x (a filter costs 9–10 ms per flip, §5); the formal filing is not (it duplicates the engine's `children` bucket). |
| Untracked plain structures read inside derivations | Four, listed in `clock.ts:24-38` as the complete inventory. A fifth is not on the list: `groups.ts` reads the plain `filed` map inside `GroupNode.label` and `baseClosedIds` (`filedLabel`, `filedFoldMs`). | Works: each is paired with a tracked read. It is still the hazard class the round-two audit found in the previous winner, and the inventory is incomplete (H1). |
| Measurement scaffolding in the product path | `groups.keys` subscribes to the full sort only to keep it alive (`groups.ts:492`; 6.6–6.8 ms per membership flip at 4x, §5). Fenced `seats()` doors are kept for plants. `plainScope.seats` is vestigial. `childrenBy` duplicates the engine's `children` bucket because the fence charges for reading bucket IDs (`visible.ts:1178-1185`). | Production code shaped by the instrument |
| Duplicate rules | `LEGACY_CLOSE_REASONS` at `views.ts:222` and `rollup.ts:368`; `isClosedTopLevel` at `views.ts:249` and `closedTopLevel` at `visible.ts:230`; `closedOf` computed in the own part and again in placement | One rule change, two or three places |
| Comments carry history | 27% of non-test lines are comments, with 168 `POD-` references | It reads as an audit trail; a newcomer cannot see the design |

### 3.3 The instruments shaped the design

- **The reads fence** counts an ID yielded from a bucket, or a cached value read, the same as a row read.
  Re-listing children, or filtering cached flags, then costs as much as reading rows. That pushed the
  design toward a 32-way split of computeds and toward indexes kept by reactions.
- **G3's slope** (≤ 1.2 from 1x to 4x, with 2,928 visible rows at 4x) forbids any step whose cost grows
  with the visible set. At 1x such steps cost about 0.3 ms (a full order sort, a full filter over cached
  flags). At 4x they cost 6.6–9.9 ms (§5). So the slope gate is not wrong at 4x, but whether 4x is a real
  target decides how much incremental machinery is worth keeping (I2).
- **The result:** per-change counts became excellent, and the cost moved into construction and heap. No
  count instrument watched that; only G6's walls did, and G6 fails in both arms. The slope failures in G3
  plausibly come from the same heap, through GC pressure: the floor itself grows from 15 to 59 ms on
  heartbeat at 4x. That is a hypothesis to test by re-measuring after A1–A3, not a finding.

## 4. Findings by category

Five categories. The two you did not name are marked *(added)*. **Instruments, gates and decisions**
matters because the evaluation framework drove much of the design; fixing the arm without it rebuilds the
same shape. **Maintainability** holds changes with no behaviour effect. Per the "clean when we touch it"
rule, these ride inside the design items rather than becoming separate issues. Sizes: S ≤ half a day,
M ≤ 2 days, L > 2 days.

### 4.1 Correctness

**Fix**

| ID | Finding | Evidence | Fix | Size |
|---|---|---|---|---|
| **C1** | W10 not wired: a receipted edit whose echo is lost keeps showing the pending value until reload | `write/edit.ts:135` ("No timer drives this yet"); no caller of `expire()` outside tests | Run a timer while receipted edits exist, calling `expire()` (L1c W10). Or amend L1c if the kernel's own TTL is meant to cover it. | S |
| **C2** | The model's schema getters ignore pending edits: `pool.issue(id).title` shows the server value while the row view shows the edit | Probe (appendix); `models.ts:67-68` reads the raw table, and the overlay patches only the input functions | Route `EntityModel.row` for issues through the pool's overlaid reader. The structural fix is A4. | S |
| **C3** | The shared cold rule is not a complete bound: R3 (an issueless session in the issue's checkout) can keep a closed issue visible, so "no visible row is cold at bootstrap" is a corpus property, not a guarantee | Schema doc §5.1; the arm pays by evaluating every cold row at bootstrap. A violating row would paint as a placeholder for a load window. | Add R3 to `SCHEMA.issue.cold.keptBy` (issueless sessions under the issue's lane), for both arms, with a negative control. It makes the working-set rule complete, which A3 needs. | M |

**Harden** (no bug found; these close a hazard)

| ID | Finding | Fix | Size |
|---|---|---|---|
| **H1** | An untracked read missing from the inventory: `GroupNode.label` and `baseClosedIds` read the plain `filed` map. It is safe only because every re-file also toggles the lane set. | Read the member's tracked `node.placement` (label, fold stamp) instead of `filed`, and keep the `clock.ts:24-38` inventory complete | S |
| **H2** | The per-change closure prediction (which rows need a node) is guarded only by the gate's reachable shapes | A gate check every step: every known issue that the rebuild finds present, keeping, or under a held formal parent holds a node. Or remove the prediction (A2). | S |

### 4.2 Design and architecture

| ID | Change | Why | Size |
|---|---|---|---|
| **A1** | **One model per entity.** Merge `IssueNode` into `IssueModel`, with coarse computeds: standing (own-row facts, rank, placement), members (seat, lane, retained and roster IDs, unread), visibility (`flat` … `visible` as one struct), roll-up, view. | Two objects per issue compute overlapping facts. Construction scales with annotation count (§5), and MobX evaluation of the closure costs about 5× the same logic as plain code. Linear has one model per entity. | L |
| **A2** | **Fewer reactions, and derive where it is cheap.** Take formal children straight from the engine's `children` bucket (drop the filing). Compute nest children as a computed over formal children (a present child counts itself, else it contributes its own nest children). File placement in the same reaction as membership. That is **one reaction per node instead of four**. **Keep the maintained visible set**: a computed filter costs 9–10 ms per flip at 4x (§5). After A1, consider noding every resident issue (computeds only for cold ones) to drop the per-change closure prediction (H2). | The formal filing exists only because the fence charges for sibling IDs (I1). Nest filing is derivable. | M |
| **A3** | **A working set with a real cutoff, shared by kernel and pool (§4.7).** One row store per principal: the working set in memory, everything else on disk only, loaded on demand in batched windows; history beyond the disk window is fetched from the server on demand. The pool holds no second copy: it is the working set's observable layer, built on first read. The relation index covers the working set; collections over cold members are lazy. **Applies to both arms and to the kernel.** | Memory today grows with every issue the principal can see, forever: the kernel holds the whole replica in memory by spec, and both pools add about 38 MB of index beside it at 1x. *Corrected:* the first version of this review said to drop the load window and read the in-memory kernel synchronously. That would have made the no-cutoff design permanent. | L; design + spike (§4.7) |
| **A4** | **Optimism inside the one reader.** The overlay lives where `row()` reads, so models, views and nodes see one value; no replaced input functions. | Fixes C2 structurally, and removes runtime monkey-patching (`write/edit.ts:222-267`) | M (with A3) |
| **A5** | **Schema completeness and navigation.** Declare the `issueless` index in the schema (remove the hard-coded `session` / `issueId`). Install typed relation getters on models from the schema (`issue.parent`, `issue.children`, …) and remove string relation names from derivation code. | L1a's "no per-relation code"; Linear-style typed navigation | M |
| — | **Keep:** schema and validator, generic relation engine, deadline clock, roll-up combines, write log and oracle, `RowView` capability rule, gates. | | |

### 4.3 Performance and memory

Numbers are from the flatblock probe (§5): 1x / 4x, Bun, production MobX. Walls are relative; heap ratios
come from JSC, so the browser (V8) heaps in §1.2 remain the absolute reference.

This is a prototype whose job is to find the right design (operator, 2026-09-28). So a patch that the right
design replaces anyway is not worth doing first. That is why P2 and P3 are marked superseded below, not
"now".

**Do** (the right code either way)

| ID | Change | Measured benefit |
|---|---|---|
| **P1** | Remove `groups.keys`' subscription to the full `order` sort (`groups.ts:492`). It exists only to keep a counter "honest"; the keys already follow membership and head ranks. | One full sort saved per membership or visible-rank change: **0.3 ms at 1x, 6.6–6.8 ms at 4x** |
| **P4** | Drop the formal-children filing reaction and its `childrenBy` index, and read the engine's `children` bucket (A2's first step). Now possible under I1. | 2,112 / 8,432 reactions and one observable index gone; reaction creation costs about 1.6 µs each |

**Superseded by the right design** (measured, and not worth doing as patches)

| ID | Patch | Replaced by |
|---|---|---|
| P2 | Skip cold issues in the bootstrap plain pass (saves 24–26 ms at 1x, 101–114 ms at 4x) | A3: cold issues are not in memory at all, so there is nothing to skip. C3 is still needed, to make the cutoff rule complete. |
| P3 | Coarsen `IssueNode` to about 10 computeds without merging classes (construction 15.6 → about 5 µs per node) | A1, which coarsens while merging the two per-issue objects |
| P5–P7 | Relation index, table slots, read-state lane and cold nodes built on first read | A3 and A1: once cold rows leave memory, the index, slots and nodes cover only the working set |

**Don't do**

| ID | Idea | Why not |
|---|---|---|
| **P8** | Group membership recomputed at view time instead of filed per issue | Per-change cost would grow with the list (§4.8) |
| **P9** | The visible set recomputed as a filter over every issue's cached `visible` | 0.3 ms per change at 1x but **9.2–9.9 ms at 4x**, growing with the list. I proposed it in the first version of this review; the measurement reverses it. |

### 4.4 Instruments, gates and decisions *(added)*

| ID | Item | Status (operator, 2026-09-28) |
|---|---|---|
| **I1** | **The reads fence tests one property: work per change does not grow with the amount of data.** It counts all real work: rows read, derivations re-run, and list elements walked. It runs the same change at 1x and 4x and requires equal counts, or counts bounded by the changed item's own family, lane or group. The fixed per-scenario micro-budgets go (for example 3 reads for a phase change). Those budgets forced the `childrenBy` duplicate, the 32-way computed split and the indexes kept by reactions (§3.3), and they could fail correct code while passing a scan of 3 siblings. The copy and scan detectors stay: they catch real O(corpus) work. | **Decided** (the operator delegated it: tests only verify or measure). Both arms are re-baselined once. |
| **I2** | The scale target | **Decided: tens of thousands of issues.** Two growth axes follow, and the corpus scales both together today. **History** (closed and archived issues and their sessions) grows forever, so memory and startup must be bounded by the working set (A3, §4.7). **Active work** (open issues, live sessions, visible rows) grows with usage, so per-change cost must not depend on it (incremental bookkeeping, §4.8). The corpus needs the two axes separately: history ×10 at constant active work, and active ×4. |
| **I3** | Add construction count gates: derivation objects and reactions per visible row (today 122 / 11.5), nodes on cold rows (856), and the bootstrap phase split (§5). Counts are stable where walls are not. | Recommended |
| **I4** | G6 as written (startup and heap within 1.1× of today's store) | **Decided:** more memory and startup than today are acceptable if the store is faster in use (it is: 7–270× per change at 1x). No ratio budgets (they are arbitrary). **G6 becomes a growth test:** grow history ×10 at constant active work, and require retained heap and cold start to stay flat, bounded by the working set. Grow active work ×4, and require them to grow at most linearly with it. Today both grow linearly with history. |
| **I5** | Correction: `spy` "add" events count computed annotations as well as map entries. POD-4705-c3 already states this; the first version of this review did not. | Done |

### 4.5 Maintainability *(added)*

No behaviour change; ride inside A1/A2 when those files are touched.

| ID | Item |
|---|---|
| **M1** | One copy of each rule: `LEGACY_CLOSE_REASONS`, closed-top-level, `closedOf` |
| **M2** | Remove plant and measurement doors from product code: fenced `seats()` doors, `plainScope.seats`. (The dead `rebuildOrder` export is already gone: POD-4709, `037ac79e9`.) |
| **M3** | Move history out of comments (27% of lines, 168 `POD-` references) into NOTES; keep design comments |
| **M4** | Delete the frozen round-two MobX arm (`store.ts`, `rules.ts`, `models/`, `worklist.ts`, `react/`, `native/` and their tests) once the decision is taken |

### 4.6 Order (revised 2026-09-28: growth target, prototype principle)

The first version made the architecture conditional on a gate still failing after quick patches. That was
the wrong frame for a prototype, whose job is to find the right design. The architecture items are the
work.

1. **Correctness:** C1, C2, H1, and C3 (a complete working-set rule; A3 depends on it).
2. **Instruments:** I1's fence and the two-axis corpus with I4's growth test (I2), so everything below is
   measured against the right questions.
3. **The cutoff:** A3's design and spike (§4.7), because every other structure should be sized to the
   working set it defines.
4. **MobX arm on top of it:** A1 (one model per entity), A2 with P4 (one reaction per issue, derived nest
   children), A4 (one reader with optimism), A5 (schema navigation), P1. M1–M3 ride along.
5. Re-measure: per change at active ×1 and ×4; memory and cold start at history ×1 and ×10.

### 4.7 The cutoff: is it planned, and is it the right approach?

**Not planned today.** The client spec says "The client holds everything in memory"
(`docs/spec/thin-client-replica.md:16`). The replica storage port reads synchronously (`readEntities`,
`read`), so the kernel keeps the whole scoped replica in memory. The feed's scope and `evict` (ADR 2 A1
D12–D15) are about **rights**: what a principal may see, not what is old. Round three's cold rule keeps
closed issues out of the **pool's** observable layer only. The kernel still holds them, and the pool still
indexes their IDs. So memory grows with every issue the principal can see, forever. The design intent
("stays on disk, loaded on first read", L1a §5) was never built, because the kernel was frozen for round
three.

**The right approach** (Linear's, adapted to our model): three tiers, with the working set declared once.

| Tier | Holds | Bounded by |
|---|---|---|
| Memory (the working set) | Rows that can be shown now: the cold rule `unlessShown`, completed with R3 (C3). Structural rows: repos and worktrees. A small recently-touched set, so going back to an issue is instant. | Active work, not history |
| Local disk (IndexedDB / SQLite) | Everything synced for the principal | The disk window |
| Server only | Old history outside the disk window | — |

- **Memory ↔ disk:** a cold row is on disk only. Reading it is asynchronous: the batched 50 ms window,
  `LOADING` and the placeholder are right here, because the wait is real. The pool's observable layer and
  relation index cover the working set, not every known ID.
- **Disk ↔ server:** bootstrap sends the working set, not all history (Linear's partial bootstrap). A cold
  collection is fetched on demand, and the client records what it has loaded ("all children of X"), so a
  collection knows whether it is complete.
- **Aggregates over cold members:** progress over closed children needs the children's facts. Two options:
  load the family on demand when the parent is drawn (bounded by family size; the roll-up already handles
  `loading`), or store the counts on the parent at the authority (instant, but a second write path). Lean:
  on-demand family load, because it keeps one source of truth.
- **Test:** the I4 growth test. History ×10 at constant active work must leave heap and cold start flat.

This changes the kernel, the sync protocol's bootstrap, and the spec. The kernel is out of round three's
frozen scope, so it needs its own design issue under the epic. Both arms then run on the same tiered
store.

### 4.8 Incremental bookkeeping: the two options

For each list the worklist shows (which issues are visible, which group each goes in, the order inside a
group), there are two ways to keep it current:

1. **Recompute at view time.** When something relevant changes, rebuild the list from each issue's cached
   answers: filter every issue on "visible", group, sort. It is a few lines, but each rebuild walks the
   whole list.
2. **Incremental bookkeeping.** Keep each list as a stored set. When one issue's answer changes, move only
   that issue. It needs a watcher per issue to file it, but each change costs the same however long the
   list is.

The MobX arm uses option 2 for visibility and group membership (four watchers per issue today, one after
A2), and option 1 for the order inside each group. P8 and P9 would have switched membership to option 1,
saving the watchers. Measured, option 1 costs 0.3 ms per change at 1x and 9–10 ms at 4x, and it grows with
the active list. At tens of thousands of issues that is a visible stutter, so option 2 is the right design
and P8 and P9 are "don't do". The same argument applies to the order inside a large group: the right design
keeps each group sorted by moving one item (a binary-search insert, as the seat lists already do), not by
re-sorting the group. That is part of A2.

## 5. Measurements (flatblock, 2026-09-28)

**Method.** `review-bench.ts` (attached to POD-4286), run on flatblock in an isolated checkout of
`95ec37a7d`: Bun 1.4.2 (`.toolchain`), `NODE_ENV=production`, MobX enforcement off (as in the production
pages), reads fence disabled, the pool created as `mobxPoolArm.create` does. Each round is a fresh pool;
one warm-up round is discarded. There were 7 rounds at 1x and 5 at 4x, and a second run of 3 rounds each.
Ranges below span the two runs.

The bench lease `bench:flatblock` was held by another session on this issue, which was running a vitest job
on one core. Load average was 3.0–4.8 on 8 cores for every round. There was no Chromium matrix and no other
timing run. This is node-side and relative. The browser walls in §1.2 remain the gate numbers.

**Bootstrap phases** (median ms; `apply(replace)` plus a UI-like first paint that observes the group lanes
and 20 row views)

| Phase | 1x | 4x |
|---|---|---|
| Ingest + reseed (tables, residency, relation upkeep) | 74 | 313 |
| Relation flush | 13 | 63 |
| Plain pass over every known issue | 48–57 | 223–228 |
| Closure expansion | 5 | 23 |
| Node construction (2,112 / 8,432 nodes: `makeObservable` × 32, 4 reactions) | 50–68 | 190–204 |
| Reactions' first run (evaluates the closure's `visible`, `nestParent`, `formalParent`, `placement`) | 116–133 | 468–475 |
| **`apply` total** | **303** | **1,328** |
| First paint (lanes + 20 views) | 15 | 61 |

**Micro-benchmarks**

| Measurement | 1x | 4x |
|---|---|---|
| Same closure work as plain code (the part functions, memoized per ID, no MobX) | **33** ms | **130** ms |
| Same work through MobX nodes (construction + first run) | 166–201 ms | 658–679 ms |
| Plain pass, hot issues only (2,736 / 10,977) | 27 ms | 115 ms |
| Plain pass, cold issues only (2,131 / 8,491) | 24–26 ms | 101–114 ms |
| Full order sort, cached ranks (732 / 2,928 visible) | 0.29–0.32 ms | 6.6–6.8 ms |
| Filter over held nodes' cached `visible` (1,256 / 5,021 resident nodes) | 0.31–0.35 ms | 9.2–9.9 ms |
| Construct N synthetic nodes with 32 / 8 / 1 computed annotations (N = 1,256 / 5,021) | 19.6 / 5.3 / 1.2 ms | 66.5 / 25.8 / 6.0 ms |
| Heap of those nodes, JSC, 32 / 8 / 1 annotations (ratios only) | 17.4 / 4.9 / 1.1 MB | 69.3 / 19.5 / 4.4 MB |
| Construct `IssueNode`s directly (N as above) | 18.2 ms | 80.1 ms |
| Create 4 × N reactions in one batch | 7.9 ms | 34.7 ms |

## Appendix: probes

**Behaviour and count probe** (this box; counts only, load about 20). File:
`arms/mobx/pool/write/review-probe.test.tsx` in an isolated detached checkout of `95ec37a7d` (never
committed). It uses the `writableMobxPoolArm` on the 1x scenario engine with a truth feed, mounted in the
count harness, where happy-dom draws every row. `bun run test:file`: 1 passed.

- Composition after mount: `issueNodes 2112, sessionNodes 2367, issueModels 796, sessionModels 666,
  visible 732, groups 8, residentIssues 2736, coldIssues 2131, coldSessions 1756`.
- Declared computeds = 2,112 × 32 + 796 × 12 + 2,367 × 5 + 666 × 1 = **89,637**. Maintenance reactions =
  2,112 × 4 = **8,448**.
- Pending rename on `visibleRootId`: `serverTitle "collapse rail 3"`, `modelTitle "collapse rail 3"`,
  `viewTitle "Pending title"`, `inputTitle "Pending title"`. The assertion `modelTitle === serverTitle`
  passed.

**Bootstrap and micro probe** (flatblock, §5). File: `review-bench.ts`, placed at
`packages/worklist-proto/arms/mobx/pool/review-bench.ts` in the checkout. Run:
`NODE_ENV=production bun --conditions=@podium/source <file> <scale> <rounds>`; the `spy` argument with
`NODE_ENV` unset gives the counts in §1.2.
