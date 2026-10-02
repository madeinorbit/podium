# Lean memory prototype

Measurement only for POD-5153. This arm is never imported by a product entry.
It follows the same kernel row and local feeds as the hand pool and borrows
their rows. The shared schema decides residency and relations.

`src/pool.ts` holds plain tables and resident relation indexes. There is one
bare MobX atom per table/relation, plus local and mounted-window signals.
One filing computed runs the hand arm's plain rule tables. Its temporary
getter memos and cold-summary folds disappear after each run; only the
visible order and the mounted window's plain views survive. Each mounted
row gets one structural computed, released on unmount. No identifiers are
used in MobX debug names. Residency's existing declared summaries, keeper
metadata and 50 ms batch loader are retained; there is no replica or outbox
in the arm.

`src/window.tsx` mounts the same 20-row React window for hand and lean.
`harness/src/per-row-census.ts` counts both arms through the existing read
fence and MobX/hand census, with additional external counts of plain rule
bodies and summary accesses. The full visible order, full mounted views and
resident counts match at all three corpus cells before the measured changes.
The fixture is static: it does not exercise scrolling, a changing window,
optimistic writes, or mobile integration.

The coarse signals intentionally expose the tradeoff: one table update
re-runs filing over resident issues and declared history summaries. This
prototype is not an incremental replacement for the product pool. See
`docs/measurements/POD-memory-per-row-hand-vs-lean.md` for the measurements and
the operator's decision, and `apps/web/harness/per-row-memory.vite.ts` for
the entry that reuses the original memory collector.
