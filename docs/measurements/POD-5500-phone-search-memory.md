# Phone target search memory

This measurement compares the eager title/reference gram and sequence-prefix
postings with a compact scan and a search-scoped postings design. The acceptance
criteria are identical ordered results, lower startup heap at 1x/4x, measured
first-search and typing latency, and unchanged work for ordinary clicks.

The prerequisite is POD-5498's unused-revision removal. Product edits start only
after its issue tip is an ancestor of `integrate/4286-pilot`, followed by a rebase.
POD-5497's old-store deletion is outside this change's file scope.

All execution uses flatblock's isolated `~/podium-test-5500` checkout with a copied
`.toolchain` and checkout-local dependencies installed by `bun run setup:worktree`.
The unchanged pool-memory probe will capture three fresh contexts at each scale
before and after the change, holding `meter:flatblock` only during each run.

Results and the design decision will be filled in after measurement.
