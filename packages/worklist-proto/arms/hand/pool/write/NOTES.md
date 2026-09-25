# Hc1 hand edits on the model (POD-4586) · 2026-09-25

Write layer at `arms/hand/pool/write/` (the brief's `arms/hand/write` is the
frozen round-two layout; coordinator addendum 2026-09-24, as Mc1).

## Decisions

- **Reference pending log, not an arm-owned one.** `pending.ts` re-exports
  `createPendingLog` from `shared/src/write-contract.ts`. An arm-owned log
  would have to join that file's `LOGS` list and pass the same 23 sequences;
  using the reference keeps one executable form of W4–W10.
- **Optimism as an overlay at the row-reader boundary, not as table writes.**
  The pool's tables hold BORROWED server rows (the reads fence refuses a copy
  on first read; borrowed proxies refuse `set`). So `edit.ts` never writes row
  objects into the tables. It mirrors the log's display (newest pending value
  per editable field) in a plain map and overlays it in `pool.inputs.issue`
  and `pool.visibleInputs.issueRow` (every part — row views, standing,
  roll-up facts, placements — reads through one of those two doors). Each
  wrapper tracks its overlay entry in a `DepIndex`, so a pending change
  dirties exactly the cells that read that row. With no pending edit the
  server object is returned unchanged (identity-preserving, idle layer
  invisible); with one a transient `{...server, ...pending}` is returned
  (never stored, so the sweep never sees it). The overlay holds at most
  title/stage/readAt — never a full row copy.
- **One pool commit per write.** `edit` captures `prior` from the current
  display (older pending or server, W1.3) with the server row as
  `priorIdentity` (W6), then one `pool.commitOverlay` paints (W1.5);
  `transport.send` fires after, unawaited (W1.6). `reject` rewinds via the log
  in one `commitOverlay`, then fires `onRejected` (W5). The tables never held
  a copy, so the server row object is already the pre-edit one: the log's
  `restoreIdentity` is that same object, and no reinstatement writes.
- **Truth feed for edit tests.** The kernel's array fold still runs for the
  legacy app; with an `overlaid` feed the same patch would arrive twice (once
  via the overlay, once via the ledger). Edit tests open `truth` feeds (W12);
  the L4b regression run stays `overlaid` with the layer idle.
- **No table walks in `pool/write/`.** The lint's `no-table-walk` allows walks
  only in `pool/enumerate.ts`. `reject` uses the log outcome's own kind/id;
  nothing here enumerates a table.

## Open

- Hc2 (c2): echo/settle (W7), overtake after receipt (W8), supersede (W9),
  TTL expiry (W10), bootstrap re-apply (W11), and the optimism-aware rebuild
  for a gate with pending edits outstanding.
- Cold-row edit materialisation is implemented (`ensureResident` requests and
  hydrates) but exercised only for residency, not for commit counts: a cold
  visible row would commit twice (load, then paint).
