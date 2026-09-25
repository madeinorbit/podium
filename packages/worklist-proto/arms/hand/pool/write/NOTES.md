# Hc2 hand receipts and remote updates (POD-4587) · 2026-09-25

Code: `edit.ts` (+`handleSuperseded`/`expire`/`bootstrap`/`pendingDisplay`),
`arm.ts` (receipt subscription, bootstrap on create, optimism-aware
`rebuildFromScratch`), `settle.test.tsx` (7). README: `arms/hand/README.md`
"Write path (phase c)". Shape mirrors Mc2 (POD-4574); no shared code built
(coordinator addendum: the gate adapter and reference oracle are Mc2's).

## Decisions

- **Receipt alone repaints nothing (W7).** `handleAccepted` records the
  receipt on the reference log; the entry stays until its echo confirms
  every field. Dropping on receipt alone would flicker (revert, then
  re-paint on the echo). The brief's "drop on accepted" is what the observer
  sees once receipt AND echo have arrived. `refreshOverlay` recomputes the
  display from the log and `commitFor` runs only when it changed, so the
  receipt step and the equal-echo step both commit zero rows (the echo row
  itself is applied by `pool.apply` as an ordinary update; the view cell's
  `sameData` absorbs it).
- **Remote keeps local, tracks truth (W5/W8).** `handleRemote` feeds the
  server values to `log.remote` (pending fields keep the local display;
  the server value becomes the rewind target) and commits only when the
  display moved — a remote on untouched fields costs the tables' own single
  commit, never a second overlay one.
- **Bootstrap passes `priorIdentity` (W6).** Like `edit`, each re-applied
  entry records the server row object, so the log's `restoreIdentity` is
  the borrowed row the tables already hold. The arm never re-sends: the
  kernel replays its own queue under the same mutation ids.
- **Echo equality isolates the stamp.** As in Mc2: a real server write bumps
  `updatedAt`, which moves the view's `foldAt` and redraws the row once —
  the server's change, not the settle's. The echo-equality steps preserve
  the stamp so they test the settle rule alone.
- **(b), (c), (d) proven red by mutation** (each planted alone in `edit.ts`,
  `settle.test.tsx -t <its test>` red, restored byte-identical via
  `git diff` against the aside copy):
  - (b) `handleRemote` skipping `log.remote`: the echo never confirms —
    echo test red (`log.size` 1, not 0).
  - (c) `handleRemote` rejecting all pending (Mc2's drop-pending shape):
    the pending stage is lost — remote test red (stage shows server).
  - (d) `handleAccepted` re-sending: `transport.sent` grows to 3 — dup test
    red on the no-resend assertion.
  - (a) `reject` skipping the overlay refresh (Hc1's plant) against the
    strengthened remote test: the stale pending stage stays painted —
    red (shows pending, not the remote third stage).
- **Rewind target proof.** The remote test moves the pending field itself
  to a THIRD stage value while pending, then rejects: the row shows the
  third value, not the edit-time one. A stale restore fails this step.

## Evidence

- `settle.test.tsx` 7/7: echo 0 commits (edit 1, receipt 0); remote 1 commit
  with stage kept local and title taken + third-stage rewind; dup receipt 0
  commits + `sent` stays 1 + late/unknown no-ops; supersede 0 commits with
  the successor carried; expiry keeps unreceipted and within-TTL receipted
  entries; rebuild equals snapshot with pending; bootstrap re-applies one
  queued entry with no re-send.
- `edit.test.tsx` 7/7 and `gate-with-edits.test.ts` 3/3 still green with the
  Hc2 layer (idle there): the receipt subscription and bootstrap change
  nothing while nothing is pending.
- Package eslint (`bun run lint` in `packages/worklist-proto`) exits 0;
  typecheck clean.

## Open

- L4b 20 × 300 with the full vocabulary BLOCKED on Mc2 (POD-4574): the
  shared arm-edit adapter (`shared/src/gen/arm-edits.ts`) and reference
  overlay oracle (`shared/src/gen/write-oracle.ts`) have not landed on
  `integrate/4545-round-three`. Then: a hand `gate-truth.test.ts` plugging
  this arm into them, plus the (a)/(c) fixed-sequence plants.
- TTL expiry has the `expire()` API but no TTL-drop exercise (no timer
  drives it; the kernel's awaiting-truth expiry runs on the wall clock,
  which the gate does not drive); reference-log level is covered by L1c.
- Cold-row edit materialisation is implemented (`ensureResident` requests and
  hydrates) but exercised only for residency, not for commit counts: a cold
  visible row would commit twice (load, then paint).

---

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

## Plants (coordinator addendum 2026-09-25)

- **Rewind to the current value instead of the kept prior** (the minimum
  write-specific plant). The cp-mutant is `reject()` skipping the overlay
  refresh (log entry removed, stale pending value stays painted with an empty
  log). Applied alone to the committed `edit.ts` and restored with `cp`, it
  fails exactly the 4 rewind cases of `edit.test.tsx` (rejection rewinds,
  stage consistency, mark-read rewind, stacked rejection) and passes the 2
  that never reject (rename paints, unknown throws) — the coordinator's own
  guard, reproduced.
- The guard lives in the repo two ways: `edit.test.tsx` "a plant that rewinds
  to the current value instead of the kept prior is caught" (the mutant's
  observable state — log empty, display stale — diverges from the pre-edit
  baseline where a true rewind converges), and `gate-with-edits.test.ts`
  "the rewind-to-current plant fails every seed" (per-seed arm-side edit +
  planted reject diverges at the first rebuild comparison; a clean edit +
  true reject on seed 1 converges first, so the check is not vacuous).
  `removal-deaf` alone never touches the write path.
- Gen sequences reload, and each reload re-creates the arm, so the gate's
  planted `create()` edits once per incarnation — no send count is asserted
  there (the edit tests pin one-edit-one-send exactly).

## Open (Hc1, closed by Hc2 above except the gate)

- ~~Hc2 (c2)~~: done — echo/settle, overtake, supersede, TTL `expire()`,
  bootstrap, optimism-aware rebuild. Remaining: the 20 × 300 gate, blocked
  on Mc2's shared adapter + oracle (see Hc2 Open above).
