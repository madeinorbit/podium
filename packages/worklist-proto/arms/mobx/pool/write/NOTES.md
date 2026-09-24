# Mc1 MobX edits on the model (POD-4573) · 2026-09-24

Write layer at `arms/mobx/pool/write/` (the brief's `arms/mobx/write` is the
frozen round-two layout; coordinator addendum 2026-09-24).

## Decisions

- **Reference pending log, not an arm-owned one.** `pending.ts` re-exports
  `createPendingLog` from `shared/src/write-contract.ts`. An arm-owned log
  would have to join that file's `LOGS` list and pass the same 23 sequences;
  using the reference keeps one executable form of W4–W10.
- **Optimism as an overlay at the row-reader boundary, not as table writes.**
  The pool's tables hold BORROWED server rows (the reads fence refuses a copy
  on first read; the copy sweep fails on one held outside the wrapped tables;
  borrowed proxies refuse `set`). So `edit.ts` never writes row objects into
  the tables. It mirrors the log's display (newest pending value per editable
  field) in an observable map and overlays it in `pool.inputs.issue`,
  `pool.visibleInputs.issueRow` / `progressFacts` / `loadedIssue`. With no
  pending edit the server object is returned unchanged (identity-preserving,
  idle layer invisible); with one a transient `{...server, ...pending}` is
  returned (never stored, so the sweep never sees it). The overlay holds at
  most title/stage/readAt — never a full row copy.
- **One action per write.** `edit` captures `prior` from the current display
  (older pending or server, W1.3), then one `runInAction` appends to the log
  and refreshes the overlay; `transport.send` fires after, unawaited (W1.6).
  `reject` rewinds via the log in one action, then fires `onRejected` (W5).
  A MobX arm mutates in place and omits `priorIdentity` (W6).
- **Truth feed for edit tests.** The kernel's array fold still runs for the
  legacy app; with an `overlaid` feed the same patch would arrive twice (once
  via the overlay, once via the ledger). Edit tests open `truth` feeds (W12);
  the L4b regression run stays `overlaid` with the layer idle.
- **No table walks in `pool/write/`.** The lint's `no-table-walk` allows walks
  only in `pool/enumerate.ts`. `reject` uses the log outcome's own kind/id;
  nothing here enumerates a table.

## Open

- Mc2 (c2): echo/settle (W7), overtake after receipt (W8), supersede (W9),
  TTL expiry (W10), bootstrap re-apply (W11), and the optimism-aware rebuild
  for a gate with pending edits outstanding.
- Cold-row edit materialisation is implemented (`ensureResident` requests and
  hydrates) but exercised only for residency, not for commit counts: a cold
  visible row would commit twice (load, then paint).
