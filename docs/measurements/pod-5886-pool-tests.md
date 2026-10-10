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
