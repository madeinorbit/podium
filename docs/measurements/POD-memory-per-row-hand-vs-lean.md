# Resident row memory: hand versus lean MobX

Measurement and prototype only, on flatblock, 2026-10-02 UTC. Product files
are unchanged. This follows [the pool memory breakdown](POD-pool-memory-breakdown.md)
and supplies evidence for the operator's next decision.

## Findings

- **The existing hand pool does not meet the budget.** Its machinery costs
  **6,765 / 6,402 / 27,585 bytes per resident row** at 1× / 4× / 10× history.
  It keeps 31,391 / 124,006 / 99,375 live derivation cells even with only 20
  mounted views. Replacing MobX with that implementation would preserve the
  basic memory problem and make history retention worse.
- **Lean MobX can meet the ~1 KB pool budget at 1× and 4×:**
  **867 / 661 bytes per resident row**, including plain indexes, residency and
  the matched pool code. At 10× history it is **3,436 bytes**, of which 2,918
  are residency. The resident reactive layer is small; cold history remains
  a separate allocation. The MobX-only removal cut is about **17 KiB total**
  at every cell, with no per-row reactive state outside the mounted window.
- **The input adapter is additional.** Pool plus canonical feed/local adapter
  costs **1,280 / 1,039 / 5,334 bytes per resident row**. Shared normalized input
  memoization also remains outside that cut. Whole-browser lean coexistence
  is still **+38.1% / +36.2% / +41.7%** above legacy; this prototype does not
  establish the product's ≤10% end-state target.
- **The memory saving has a large work cost.** One lean rename reads
  **3,798 / 15,472 / 3,798 resident data rows**, runs 27,875 / 109,881 / 27,875
  plain rule bodies, and makes 18,203 / 71,964 / 180,914 summary accesses.
  Hand rename reads one row and runs three cells. The small MobX census must
  not be read as a small amount of work.

**Operator decision:** the measurements support a lean reactive layer as a
memory direction, but this coarse filing implementation needs incremental
invalidation before it can be judged for interactive use. Choosing that next
prototype, the existing hand design, or a different pool strategy remains the
operator's decision. No product change follows automatically from this report.

## Memory results

KB means 1,000 bytes; MiB means 1,048,576 bytes. Each V8 value is the median
of five fresh contexts. Every arm/cell's full sample range is less than
0.13 MiB. Flatblock's one-minute load averages were 0.73–4.15 for controls and
0.95–4.50 for prototypes; the benchmark lease covered each entire capture.

### Retained V8 used heap after two GCs, MiB

| Cell | Legacy | Product pool | Hand | Lean | Lean minus legacy | Lean regression |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1× | 31.4 | 67.6 | 67.5 | 43.4 | 12.0 | +38.1% |
| 4× | 97.3 | 229.8 | 227.9 | 132.6 | 35.2 | +36.2% |
| 10× history | 110.4 | 196.9 | 255.5 | 156.4 | 46.0 | +41.7% |

The refreshed product machinery reproduces POD-5133's 6.4–7.2 KB basic cost
and 13.3 KB history cost. Its whole-browser totals have changed on the newer
product tree, so the table uses refreshed controls rather than mixing today's
prototypes with the older report's legacy baseline.

### Pool removal cut divided by resident rows, bytes

| Cell | Product resident rows | Hand/lean resident rows | Product pool | Hand pool | Lean pool | Hand with feed | Lean with feed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1× | 4,746 | 4,306 | 7,157 | 6,765 | 867 | 7,179 | 1,280 |
| 4× | 18,801 | 17,432 | 6,398 | 6,402 | 661 | 6,780 | 1,039 |
| 10× history | 5,066 | 4,306 | 13,346 | 27,585 | 3,436 | 29,484 | 5,334 |

These are amortized costs at each corpus/window, not the marginal allocation
of loading one more row. They include fixed pool code and cold metadata in
the numerator. The 1×→4× pool-cut growth divided by resident-row growth is
**6,283 bytes for hand and 594 for lean**; this scale slope also grows history,
so it is not an independent marginal-row measurement.

| Resident entity | Product 1× | Hand/lean 1× | Product 4× | Hand/lean 4× | Product history | Hand/lean history |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Issue | 2,805 | 2,393 | 10,916 | 9,620 | 2,964 | 2,393 |
| Session | 1,445 | 1,417 | 5,985 | 5,912 | 1,606 | 1,417 |
| Worktree | 485 | 485 | 1,889 | 1,889 | 485 | 485 |
| Repo | 11 | 11 | 11 | 11 | 11 | 11 |

### Removal counterfactuals, MiB

Each row is cut alone; rows overlap. “All pool” blocks named pool handles,
every MobX object and closures from the pool's own scripts. “Pool and feed”
additionally blocks the canonical feed/local handles and their own scripts.
The [group definitions](../../apps/web/harness/per-row-memory-groups.json)
exclude shared React/runtime modules from those script cuts.

| Cut | Hand 1× | Hand 4× | Hand history | Lean 1× | Lean 4× | Lean history |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| All pool machinery | 27.781 | 106.425 | 113.279 | 3.559 | 10.997 | 14.109 |
| Residency | 1.391 | 5.502 | 11.469 | 1.438 | 5.687 | 11.982 |
| Maintained relation engine | 2.415 | 9.591 | 15.589 | 0.939 | 3.785 | 0.939 |
| Plain tables | 0.089 | 0.356 | 0.089 | 0.089 | 0.356 | 0.089 |
| MobX bookkeeping | 0.001 | 0.001 | 0.001 | 0.017 | 0.017 | 0.017 |
| Feed/local adapter | 1.673 | 6.191 | 7.773 | 1.672 | 6.187 | 7.772 |
| Pool and feed together | 29.480 | 112.711 | 121.077 | 5.257 | 17.278 | 21.906 |

Lean's maintained relations stay flat from 1× to 10× history. Residency grows
from 1.438 to 11.982 MiB and accounts for 85% of its history pool cut. The
hand arm also retains cold relation and filing state; its live cell count
nearly triples with history. This is the existing hand arm as measured,
not a claim about every possible hand implementation.

The browser snapshot has 21 ComputedValues, 22 window Reactions and 25 Atoms
in lean at every cell. The pool itself creates 24 atoms; the cut also catches
one global atom present in hand. React adds an order subscription beyond the
census's 21 observers. Hand has no per-row MobX state, but each plain cell
holds closures, dependency entries and listener/index tables. Those account
for most of its cost; removing MobX alone is not sufficient.

### Snapshot cross-checks, MiB

The post-release columns are V8 used heap after dropping fixture inputs and
two further GCs. The live columns are the analyzer's snapshot totals, including
native objects; neither replaces the five-context statistic above. All six
prototype analyses resolve their named owners with zero missing/non-live owners.

| Cell | Legacy released V8 / snapshot live | Product released V8 / snapshot live | Hand released V8 / snapshot live | Lean released V8 / snapshot live |
| --- | ---: | ---: | ---: | ---: |
| 1× | 30.0 / 45.7 | 66.0 / 82.9 | 66.0 / 82.4 | 41.8 / 58.2 |
| 4× | 91.4 / 128.3 | 223.7 / 261.8 | 221.9 / 259.4 | 126.5 / 164.1 |
| 10× history | 101.5 / 117.3 | 188.0 / 204.9 | 246.6 / 263.0 | 147.5 / 163.9 |

### Shared input memory remains

The pool/feed removal cut does not fully explain the prototype's extra
whole-browser heap. There are shared compiled/runtime structures and warmed
input caches that survive removing those owners. In particular, snapshots
show **42 WeakMaps in legacy**, **29,244 / 116,850 / 165,648 in product**, and
**29,247 / 116,853 / 165,651 in both prototypes**. The difference is six maps
per issue over the full history, plus three extra maps in prototypes.

Code inspection of
[issue-input.ts](../../packages/client-graph/src/shared/issue-input.ts)
identifies a global composition memo with six nested WeakMap keys, warmed by
the canonical source's full issue snapshot. Its participation in the residual
is an inference from that code and the object counts; **its total retained cost
has not been attributed here**. The maps' shallow bytes omit their tables,
memo nodes and composed values. POD-5155 records that separate attribution
as an unclaimed proposal, with a
`discovered-from` link to this measurement. It requires no product edit here.

## Method and comparison limits

The collector and analyzer are the unchanged
[pool-memory.ts](../../apps/web/harness/pool-memory.ts) and
[heap-owners.ts](../../apps/web/harness/heap-owners.ts) from POD-5133. A refreshed
legacy/product control uses the original fixture and build configuration.
The [new fixture](../../apps/web/harness/per-row-memory.browser.ts) imports that
fixture with the product switch off, attaches either the existing hand pool or
the new lean pool to the same canonical row/local feeds, and mounts the
[same 20-row React window](../../packages/worklist-proto/arms/lean/src/window.tsx).
The renderer reads every field of each mounted RowView. The hand constructor,
seed, load callback and subscriptions match `handPoolArm.create`.

| Property | Capture |
| --- | --- |
| Product base | `integrate/4286-pilot`, `a904aa62764c5e51d00c0508794b68870f371461` |
| Control capture commit | `d38fa2152ff2d6df37727d2bfa26c4b05a9318f1` |
| Prototype capture commit | `3bf065d8ed` |
| Host/browser | flatblock; headless Chromium 153.0.8010.12, Playwright build 1243; private `.toolchain/lib` |
| Corpus | Synthetic seed 4443; anchored clock 2026-09-20 noon; 1×, 4×, 10× history with active work at 1× |
| Runtime | Original StoreProvider, kernel replica, IndexedDB adapter, outbox, production sidebar and command palette; no operator data or second runtime |
| Build | Production Vite, ordinary React, no minification or source maps; no counting proxies in heap runs |
| Sampling | Five fresh contexts per arm/cell, interleaved with alternating first arm; wait 500 ms, then two GCs 150 ms apart; median `Runtime.getHeapUsage().usedSize` |
| Attribution | Last context per arm/cell releases fixture inputs, runs two more GCs and takes one heap snapshot; removal counterfactuals use the same V8 graph traversal |
| Ownership | Named pool/feed handles; only prototype modules in named ownership chunks, with shared React/runtime dependencies excluded |
| Isolation | Own `~/podium-test-5153` checkout and toolchain; `bench:flatblock` held throughout each reported capture |

After capture, the issue rebased onto integration `5e8bfd77ac7e104d15f0d16c560d653e33a8e364`,
which includes later session-feed and UI changes. That product tree was not
heap-measured here. All four-arm numbers above come from the common captured
`a904aa6276` base; focused prototype validation also checks the landing tree.

In prototype raw records the original collector's **`legacy` slot means hand**
and **`pool` slot means lean**; `state.prototype` records the actual arm.
The control records retain their original meanings. This mapping reuses the
collector rather than introducing a different memory statistic.

The prototypes add a static window to the legacy control. The product control
mounts its existing full sidebar and command palette instead. Resident counts
therefore differ between the product and the two prototypes. Both prototypes
have identical resident counts and mounted views. Removal bytes divided by
each arm's own resident issue/session/worktree/repo count are the per-row
measure; whole-browser deltas also contain compiled code, feed adapters and
the additional window. A snapshot's live total includes native DOM memory and
is not the V8 used-heap statistic. Counterfactual cuts overlap and must not be
added together.

## Prototype design

The [lean pool](../../packages/worklist-proto/arms/lean/src/pool.ts) uses the
hand arm's plain Map tables, schema-driven ingest, plain relation engine and
Residency. Rows borrow the canonical feed objects. There are four table atoms,
18 relation atoms, one local atom and one mounted-window atom: **24 atoms**,
independent of row count. There is **one filing computed and 20 mounted row
computeds**, no observable map/set entries or boxes, and no identifier-based
MobX debug names. Row slots are released on unmount. The census has 21
observer reactions for its window, not one reaction per issue.

The filing derivation runs the hand arm's plain rule tables, retains the full
visible order and only the mounted window's RowViews. Its temporary getter
memos and cold-summary folds disappear after a run. Resident relation indexes
exclude cold source rows. Unloaded facts come through declared summaries;
cold progress folds are transient, not a second persistent relation index.
The sole row reader returns LOADING for absent rows and requests a coalesced
50 ms load. This prototype tests a static window, not scrolling, changing
window membership, optimistic writes, mobile integration or a product switch.

## Work per change

[per-row-census.ts](../../packages/worklist-proto/harness/src/per-row-census.ts)
uses the existing read fence and hand/MobX censuses over the same kernel-fed
corpus. It additionally counts plain rule bodies and summary accesses, because
one filing computed can hide a whole-corpus scan. Counting instrumentation is
absent from the browser heap capture. These are work counts, not wall times.

All three cells agree on resident counts, the complete visible order and every
field of the 20 mounted RowViews before the changes. At 1× and 10× history both
arms have 4,306 resident rows; at 4× they have 17,432. The scenarios run in order:
heartbeat, phase change, title rename and one burst of 50 title changes.

| Cell/change | Hand data rows read | Lean data rows read | Hand cell runs | Lean computed runs | Hand plain rule runs | Lean plain rule runs | Lean summary accesses |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1× heartbeat | 2 | 3,800 | 4 | 21 | 2 | 27,875 | 18,203 |
| 1× phase | 2 | 3,798 | 4 | 21 | 3 | 27,875 | 18,203 |
| 1× rename | 1 | 3,798 | 3 | 21 | 2 | 27,875 | 18,203 |
| 1× burst 50 | 115 | 3,848 | 380 | 21 | 320 | 27,928 | 18,203 |
| 4× heartbeat | 2 | 15,474 | 4 | 21 | 2 | 109,881 | 71,964 |
| 4× phase | 2 | 15,472 | 4 | 21 | 3 | 109,881 | 71,964 |
| 4× rename | 1 | 15,472 | 3 | 21 | 2 | 109,881 | 71,964 |
| 4× burst 50 | 107 | 15,522 | 377 | 21 | 318 | 109,934 | 71,964 |
| 10× history heartbeat | 2 | 3,800 | 4 | 21 | 2 | 27,875 | 180,914 |
| 10× history phase | 2 | 3,798 | 4 | 21 | 3 | 27,875 | 180,914 |
| 10× history rename | 1 | 3,798 | 3 | 21 | 2 | 27,875 | 180,914 |
| 10× history burst 50 | 115 | 3,848 | 380 | 21 | 320 | 27,928 | 180,914 |

“Data rows” is the read fence's distinct borrowed rows whose fields were read;
it excludes membership-only probes and declared summary objects. Summary
accesses are separate and include repeated reads, not distinct cold rows.
For a lean rename the fence touches 9,384 / 37,533 / 58,425 distinct row keys
including presence/relation probes, and records 30,465 / 119,058 / 193,176
raw table gets. Hand rename touches one row key and makes six table gets.
Hand summary accesses are zero on phase/rename; heartbeat uses two, and the
4× burst uses two. Lean runs one observer reaction on a single change and two
on the burst, despite recomputing all 20 row slots.

The coarse filing has O(resident issues + declared history summaries) work on
every invalidation. The tenfold history cell keeps the same resident data reads
as 1×, but multiplies summary work. Structural equality limits notifications;
it does not avoid the scan. This version therefore trades retained derivation
state for repeated work, and its memory result cannot establish acceptable
interactive speed.

The plain-rule column counts `VISIBLE_RULES`, `SESSION_RULES` and `PART_RULES`,
not every arithmetic/helper operation or allocation. Counts establish the
scaling cost; they do not estimate milliseconds or transient allocation peaks.

## Verification

On flatblock with the pinned Bun 1.4.2 and checkout-local dependencies:

- `bun run test:file -- packages/worklist-proto/arms/lean/src/pool.test.ts`:
  three focused checks green, covering mounted-only reactive state and release,
  full-view agreement/borrowed identity/invalidation, and resident-only
  relations/declared summaries/LOADING/batched known and absent loads.
- `bun run typecheck -- --filter @podium/worklist-proto`: ten successful tasks,
  nine cache hits on the captured tree. After the integration rebase and
  checkout-local dependency repair, the same three focused checks were green
  and the same typecheck had ten successful tasks, zero cache hits because
  its dependency inputs changed. No whole suite or lane was run.
- Thirteen planted faults turned the focused checks red, with sources copied
  aside and restored: eager per-row computeds, boxed state, retained unmounted
  slots, reversed ordering, copied resident rows, suppressed invalidation,
  indexed cold rows, missing summaries, missing LOADING, missing absent queue,
  missing known hydration, missing cold progress and missing unknown fetch.
  The restored checks were green.
- The original collector's planted mode mismatch stopped before capture:
  `Mode guard RED: expected legacy, got pool`.
- Scoped Biome formatting/checking reported no errors in the eight new code
  and configuration files; non-null assertion warnings remain as in the
  original harness. The final browser fixture is additionally exercised in
  every accepted capture; its Vite build does not typecheck it.

No files in `packages/client-graph`, `packages/client-core` or `apps/web/src`
were changed. The existing hand arm, corpus, collector and analyzer are
unchanged. No product memory fix is made here.

## Reproduction and evidence

In the isolated flatblock checkout, with its private toolchain on PATH, the
memory commands are below. Acquire `bench:flatblock` from the issue session
before capture and hold it until both captures finish; renew as needed. Follow
the issue's WIP checkpoint rule before each edit batch and run. Analyze after
capture; analysis does not launch the browser.

```bash
export PATH="$PWD/.toolchain:$PATH"
timeout 240s bun apps/web/harness/pool-memory.ts --phase=build
timeout 1200s bun apps/web/harness/pool-memory.ts --phase=capture --out=controls --samples=5 --lease-confirmed
timeout 240s bun apps/web/node_modules/vite/bin/vite.js build --config apps/web/harness/per-row-memory.vite.ts
mkdir -p .artifacts/pool-memory/prototypes
cp apps/web/harness/per-row-memory-groups.json .artifacts/pool-memory/prototypes/groups.json
timeout 1200s bun apps/web/harness/pool-memory.ts --phase=capture --out=prototypes --samples=5 --lease-confirmed
timeout 2400s bun apps/web/harness/pool-memory.ts --phase=analyze --out=controls
timeout 2400s bun apps/web/harness/pool-memory.ts --phase=analyze --out=prototypes
timeout 300s bun --conditions=@podium/source packages/worklist-proto/harness/src/per-row-census.ts
```

Use fresh output folders when reproducing: the unchanged collector appends
usage records. The prototype build relocates only its emitted HTML to the
collector's existing URL. Its named chunk module inventory is retained with
the evidence; no shared dependencies occur in the ownership scripts.

Issue artifacts on POD-5153 contain this report and
`.artifacts/pool-memory/per-row-memory-evidence.tar.gz`: control/prototype
records, provenance, twelve analyses and meta files, snapshot SHA-256 hashes,
group definitions, module inventories, the full census and compact count
summaries, and focused validation/planted-fault evidence. The six control and
six prototype raw snapshots were deleted after successful analysis to recover
flatblock disk space; their hashes remain. No operator data was collected.
