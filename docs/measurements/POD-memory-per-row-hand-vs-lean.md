# Resident row memory: hand versus lean MobX

Measurement and prototype only, on flatblock, 2026-10-02 UTC. Product files
are unchanged. This follows [the pool memory breakdown](POD-pool-memory-breakdown.md)
and supplies evidence for the operator's next decision.

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

## Verification

On flatblock with the pinned Bun 1.4.2 and checkout-local dependencies:

- `bun run test:file -- packages/worklist-proto/arms/lean/src/pool.test.ts`:
  three focused checks green, covering mounted-only reactive state and release,
  full-view agreement/borrowed identity/invalidation, and resident-only
  relations/declared summaries/LOADING/batched known and absent loads.
- `bun run typecheck -- --filter @podium/worklist-proto`: ten successful tasks,
  nine cache hits. No whole suite or lane was run.
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
