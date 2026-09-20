# arms/tanstack/ — owned by the TanStack DB arm (POD-4448)

Everything is a query (methodology §5.4): one collection per entity type fed
through the sync interface, relational derivations as chained live queries,
one custom derived collection for the recursive closure only, per-row keyed
subscriptions, explicit GC times.

No imports from legacy view-model / slice / mission / presentation /
replica-view code (H4 shape review gate, methodology §6.1).
