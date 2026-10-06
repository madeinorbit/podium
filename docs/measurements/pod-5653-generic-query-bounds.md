# Generic query and comparison bounds

The directly demanded query primitives keep row callbacks and collection visits
flat across 128 and 512 unrelated issues. A title-only source update previously
shifted both mention ranking arrays; retaining unchanged ranking positions makes
that update exactly flat too. Persistent query trees take logarithmic ordering
work when the demanded membership itself grows. Structural and shallow equality
can still walk every compared array element, so a screen inherits the query bound
only when its own projection and equality inputs are also bounded or shared.

## Direct change measurements

Measured on flatblock on 2026-10-06, starting from pilot `020b6881fe`.
Each cell is **visits / keyed lookups / reads**, identical at 1× and 4× unless an
arrow is shown. Visits include repeated native iteration, callbacks, object-key
enumeration, array copying, and slots moved by native `splice`. Source/index reads
are row property reads; query/cache reads are projection callbacks.

The row action changes one title. Membership changes one priority facet or formal
parent, or removes one demanded query entry. The irrelevant action changes a
private field on a nonmatching row. Bootstrap and output parity checks run outside
measurement; observers consume snapshots and bounded witnesses without walking
the full result. ReaderQueries publication is isolated from source ingestion.

| Primitive | Row update | Membership change | Irrelevant change | Bound established |
| --- | --- | --- | --- | --- |
| Declared source query, default reader index | 196 / 96 / 22 | 159 / 49 / 22 | 124 / 56 / 22 | Exactly flat for these actions |
| Relation index, formal parent and inverse bucket | 12 / 40 / 21 | 42 / 58 / 21 | 12 / 40 / 21 | Exactly flat across unrelated buckets |
| createQueryResult, two demanded rows | 14 / 8 / 1 | 7 / 5 / 0 | 0 / 5 / 0 | Exactly flat |
| createQueryResult, 130 → 514 demanded rows | 14 / 7 / 1 | 7 / 5 / 0 | 10 / 7 / 1 | Reads and visits flat; tree comparisons logarithmic |
| ReaderQueries.ids | 28 / 29 / 0 | 46 / 33 / 0 | 28 / 25 / 0 | Exactly flat |
| ReaderQueries.project | 17 / 22 / 1 | 26 / 21 / 0 | 5 / 15 / 0 | Exactly flat |
| cachedKey through keyedComputed, 128 → 512 observed keys | 4 / 5 / 1 | 5 / 5 / 1 | 0 / 2 / 0 | Exactly one addressed derivation, or zero for the unobserved key |

For the growing query result, actual ordering-scalar comparisons are **22 → 26**
on the row update, **16 → 20** on membership removal, and **0 → 0** on the
irrelevant field update. Updates replace at most two persistent AVL paths.
The guard bounds comparisons by the tree-height contract; it does not grant a
whole-membership scan a ratio allowance. Previous snapshots retain their values,
and unchanged projections retain snapshot identity.

## Comparison work

Here 1× and 4× mean **128 and 512 elements in the compared value**, rather than
unrelated rows elsewhere. Element reads count accesses on both sides. A row
difference is placed at index zero because MobX traverses arrays backwards; this
forces the difference to be reached last. The irrelevant case rebuilds an equal
array. Membership adds an element, so length inequality short-circuits.

| Actual comparator | Row difference reached last | Membership length differs | Equal rebuilt value | Shared reference |
| --- | --- | --- | --- | --- |
| compareStructural | 256 → 1,024 | 0 → 0 | 256 → 1,024 | 0 |
| compareShallow | 256 → 1,024 | 0 → 0 | 256 → 1,024 | 0 |
| sameAttention, aggregate.sessionIds rebuilt | 256 → 1,024 | 0 → 0 | 256 → 1,024 | 0 for shared arrays and a scalar-only change |
| sameVerdict, fixed scalar facts with 1×/4× unrelated data | 10 → 10 property reads | 0 → 0 for absence | 11 → 11 property reads | Identity short-circuit |
| compareIdentity and compareDefault | Identity comparison | Identity comparison | Identity comparison | 0 element reads |

The model comparator probes capture the exact functions passed to cachedGroup
while preserving its behavior. No private comparator is exported for testing.
Structural comparison recursively walks rebuilt nested values. Shallow comparison
still walks a flat array of identities; its depth limit does not bound the number
of array slots. sameAttention delegates both attention parts to structural
comparison. These helpers do **not** walk whole structures on every publication:
shared identities, length differences, earlier differences and undemanded
computeds avoid that work. Rebuilding equal large arrays defeats those shortcuts.

## Proven repair and remaining limits

Before the repair, a title update in createReaderIndex visited **716 → 2,252**
elements/slots and made **226 → 258** keyed lookups. Four native array shifts
account for the extra 1,536 slots when 384 unrelated rows are added. The title
does not change either the mention recency key or its repository sequence key.
The repair keeps those existing positions unless their own ordering or presence
inputs change. The same probe now measures **196 → 196** visits and **96 → 96**
lookups. Ranking regressions cover title postings, timestamp order, sequence
order, repository moves, native-reference transitions, archival, deletion and
removal/reintroduction.

Real catalog insertion/deletion and genuine ordering-key changes still move
native sorted-array tails in the source mention/target indexes, with O(n) slot
movement. This report establishes no universal source-ingestion bound for those
actions. POD-4286 approved the narrow repair and placed a representation change
in the operator's design discussion under POD-5708.

Explicit whole-catalog enumeration remains output-sized: residentIds visits
**130 → 514** identities; knownIds visits **780 → 3,084** across its identity
collections. A caller asking for every identity owns that work. Bootstrap,
replacement, demand release, caller-supplied projection/comparison bodies and
relation fan-out within the affected owner/collapse/prefix neighborhood also have
their own cardinality. Generic helpers cannot promise a fixed bound for arbitrary
callbacks or clear unproven downstream census entries.

The test counter observes the named native operations and counted fixture values.
An arbitrary plain indexed loop requires counted values or review; the comparison
probes explicitly count indexed array reads, and native splice movement is counted
separately from iterator work. These are direct primitive guards, independent of
the screen structural census and its meter lease.

## Permanent guards

Run only these focused files through the repository lane:

```bash
bun run test:file -- packages/client-graph/src/primitive-query-bounds.test.ts packages/client-graph/src/primitive-comparison-bounds.test.ts packages/client-graph/src/shared/issue-mention-question.test.ts
```

The post-fix run at `98df968e8b` executed **45 passing tests in three files**.
Peak individual RSS was **272.3 MiB**; minimum MemAvailable was **11,232.2 MiB**.
Runs used the issue's flatblock checkout and its copied Bun 1.4.2 toolchain,
with the checkout-local node link pointing to that Bun. No meter lease or merge
lock was held during measurement. The before-edit table and confirmed native-slot
growth were mailed to POD-4286 before the product change.
