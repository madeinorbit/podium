# shared/ — prototype contracts and checks

The product schema, row views, row/local channels, slice types, typed relations
and write contracts live in `@podium/client-graph/shared`. Their tests remain here.
This folder keeps the arm and measurement contracts, RowShell instrumentation,
scenarios, generators, probes and the schema-source validator. Its barrel re-exports
the product contracts for prototype consumers.

See `docs/plans/pod-4441-round-two-slice.md`; every contract cites its spec section.

The three narrow compatibility doors (`row-source.ts`, `locals-source.ts`,
`slice-types.ts`) preserve the app development harness's original imports. They
only forward product exports; no implementation lives here.
