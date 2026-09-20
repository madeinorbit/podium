# arms/hand/ — owned by the hand-rolled arm (POD-4446)

Incremental view maintenance with typed deltas (methodology §5.2): normalised
entity tables keyed by id, one `apply(delta)` per derived structure, exhaustive
switch over the closed delta union, per-key subscriptions, one notification
pass per publication.

No imports from legacy view-model / slice / mission / presentation /
replica-view code (H4 shape review gate, methodology §6.1).
