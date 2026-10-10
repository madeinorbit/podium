# Pool bootstrap and tracking counts

The investigation starts from pilot `497d299906`, with the failures reported by
POD-5593 at `aeef0c4625`. Validation runs only on flatblock in
`~/podium-test-5886`, with a copied Bun 1.4.2 toolchain and a checkout-local
`node` link to that Bun.

The first focused reproduction executes all six tracking cells and reproduces
the empty-window assertion in every cell. The bootstrap worker exceeds the
ordinary 3 GB limit and is stopped at 3,007,127,552 bytes RSS; that interrupted
bootstrap is not a test result. Historical bootstrap probes use the 1x corpus to
locate the reported signal without exceeding that limit.

Bootstrap currently infers model identities from `Class@id.field` debug names in
MobX's dependency graph. Shared models and worklist companions now use lazy
getters whose names do not all encode object identity. A missing attribution
alone does not establish a missing model.

## Landings and classification

- Bootstrap: `2fbce6d1ff` (Shared worklist view model, POD-5767).
  Its adjacent parent `e9bed9cfd` passes the 1x bootstrap assertion; the
  landing reproduces exactly `1381 < 2389`. Filing now observes worklist
  companions. Each companion holds a real shared issue model, but an issue
  can own no observed computed of its own. Walking only model debug names
  undercounts those identities. Walking MobX's measured owner objects and
  their constructor-owned shared records gives **2,633 actual issue models
  behind 2,389 filing reactions** on the current 1x replay. This is test
  attribution, not a loss of product models.
- Tracking window: first-parent bisection from `147bdd51c8` to `aeef0c4625`
  finds `d37328a3f3` (Duplicate live frame removal, POD-5796); its adjacent
  parent `6db97fbb33` fills the window. Historical baseline mismatches are
  classified separately from the empty-window assertion. The paint fixture
  traverses an array that its list autorun refills while child observers
  mount. Capturing the items before mounting those observers preserves the
  first-paint window. All six cells then paint 20 rows.

The independent product-window probe uses the same scenario feed, enabled read
fence and disabled load scheduler. It fills the window both without a census
and with the census, phase wrappers and per-phase read sampling. Both reported
signals are test regressions; no product code changes are needed.

## Baseline and resource evidence

The prior tracking baseline names POD-5677 and still attributes filing work to
IssueModel. The refreshed baseline records the shared WorklistIssue and
WorklistSession owners, their lazy scalar fields, and the current collections
and phases. No growth allowance is added: subsequent runs still require exact
equality in all six cells. Updating now also requires all six cells to complete,
so a partial paint cannot silently replace the baseline.

The six-cell refresh executes seven tests, including the writer, with peak
process RSS **2,511,155,200 bytes**. The bounded bootstrap and product-window
controls execute five tests with peak RSS **1,552,756,736 bytes**. These are
focused test results, not full-suite results. The final landing checks are
recorded below after validating the complete candidate.
