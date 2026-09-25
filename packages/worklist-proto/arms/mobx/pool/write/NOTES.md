# Mc1 MobX edits on the model (POD-4573) · 2026-09-24
# Mc2 MobX receipts and remote updates (POD-4574) · 2026-09-24

Code: `arms/mobx/pool/write/edit.ts` (+`handleAccepted`/`handleSuperseded`/
`expire`/`bootstrap`/`pendingDisplay`), `arm.ts` (receipt subscription,
bootstrap on create, optimism-aware `rebuildFromScratch`), `shared/src/gen/
arm-edits.ts` (the gate adapter, shared with Hc2), `shared/src/gen/run.ts`
(`editViaArm`: edit + supersede branches), `shared/src/gen/check.ts`
(`editViaArm`/`onStep` forwarding), `shared/src/receipts.ts` (`baseOf`
exported). Tests: `settle.test.tsx` (5), `gate-truth.test.ts` (clean gate +
(a)/(c) plants). README: `arms/mobx/README.md` "Write path (phase c)".

## Decisions

- **Whole-snapshot shared oracle (coordinator ruling, option b).**
  `WriteOracle.expectedSnapshot` runs the shared slice oracle
  (`snapshotFromStore`) over the store's rows — replica and projections
  intact, so view models resolve exactly as in `oracleSnapshot` — with the
  reference display overlaid per pending row and the chained-hold repair
  against feed truth kept. Proven construction: store rows + intact
  replica/projections reproduces `oracleSnapshot` exactly; feed rows do NOT
  (raw rows lack view-model fields, feed sessions carry parked twins). The
  gate threads it through the gap base and the oracle compare; kernel stays
  a counted finding with its first example recorded. Complete-or-fail: all
  seeds run, per-seed rows in the result file, one error at the end.
- **Pending readAt is overlaid onto `visibleInputs.issueRead` (POD-4574,
  2026-09-25).** Seed-1/step-6 diverged from the rebuild: a mark-read edit hid
  nothing, but the live pool dropped `i1380` from its visible set while the
  rebuild kept it. Cause: the visibility parts read the cursor through
  `issueRead`, which the pool serves from its read-state lane (server truth
  only, POD-4686), while the rebuild reads it from its tables — which the
  optimism-aware rebuild fills with overlaid rows (pending cursor). A pending
  mark-read reopens the row's decay window in the rebuild but not in live.
  Fix (own file `edit.ts` only): wrap `issueRead` so a pending `readAt`
  (explicit null included) wins, else the lane answers — bit-parity with the
  rebuild's `readAtOf(overlaidRow.readAt)` in every case, and title-only edits
  change nothing. Proven: the shrunk 1-edit replay goes live+rebuild present,
  `DIFF=null`; 1x50 smoke green.
- **Reference log as-is, no fork (coordinator ruling).** `handleAccepted`
  records the receipt; the entry stays until the echo confirms every field
  (W7). Dropping on receipt alone would flicker (revert, then re-paint on
  the echo). The brief's "drop on accepted" is what the observer sees once
  receipt AND echo have arrived.
- **Echo equality isolates the stamp.** A real server write bumps
  `updatedAt`, which moves the view's `foldAt` and redraws the row once —
  that is the server's change, not the settle's. The echo-equality step
  preserves the stamp so it tests the settle rule alone (editable values
  equal → zero commits). Debug trace that found it: echo step committed
  `i214` with moved view field `foldAt` only.
- **Gateway edits go through the arm (coordinator ruling, mode b).** The
  adapter's transport invokes the SAME runtime action, so the kernel mints
  the mutation id and the runner claims it from the outbox as today; the
  arm logs under its own txId and the adapter pairs them per step
  (`detail.armTxId` + `detail.mutationId` via `onStep`). Outcomes and
  `pending()` entries are translated kernel↔arm for receipts, rejections
  and bootstrap across reloads. The gate compares the truth-feed arm with
  the overlaid oracle. One adapter for MobX now, Hc2 later.
- **No kernel-retirement mirroring (F4 consequence).** First built: watch
  `outbox.retireAwaiting` in the adapter, mirror into `expireOne`. It made
  things worse — the retire path fires for TTL/cover prunes the reference
  oracle never takes, so the arm dropped entries the oracle holds. Under F4
  both sides hold until echo/reject/overtake and kernel retirements tally as
  findings. Removed the watch, `currentExpire` and `expireOne`; `expire()`
  stays (undriven) for a future timer.
- **The accept-after-remote finding.** edit → remote → accept: the kernel
  drops its overlay at receipt (`mutationApplied` finding-2: server moved
  past the enqueue baseline), the contract holds Mine until the echo. Both
  converge at the echo. Counted per oracle check as `kernelDiffers`.
  Ruling F4 keeps it a finding; the alternative (gen accept writing truth)
  is with the coordinator.
- **The chained-hold stale title.** An entry enqueued behind a same-row
  sibling is chained: the kernel holds its overlay past a newer server value
  (no moved-past escape), showing stale Mine while arm, oracle and server
  agree on Theirs. The gate skips exactly those rows (live == server ==
  oracle-display, kernel retired value) and counts them as
  `staleSkippedTotal` — incapable of masking an arm bug. Seed-2/step-139
  minimal case: edit, remote, echo (marks GenServer applied), online-drain
  re-send dedupe-resolves into the receipt both logs settle on.
- **Plant (f): bootstrap drops a pending entry.** `bootstrap` skipping its
  first entry (temporary mutation, `cp` aside and back, `git diff` empty
  after): fixed sequence edit → refresh fails AT the refresh step with live
  server title vs expected pending title. The post-swap compare (ruling)
  catches it where a 10-step-later check might not.
- **Plant (e): ignore receipts.** `handleAccepted` replaced by a no-op
  (temporary mutation, `cp` aside and back, `git diff` empty after): the
  seed-2 gate fails at step 139 with live "Title t10" vs expected "Theirs
  r28" — the stale-hold mirror, caught by the reference oracle. Failing
  test: `gate-truth.test.ts` "passes every seed against the rebuild and the
  write oracle".
- **Deduped re-sends are receipts.** The echo step marks the GenServer id
  applied; a later re-send (online drain, reload) is answered at once and
  the arm settles on it. The oracle observes the same signal by scanning the
  server's arrival log (`consumeServerAnswers`) — without it the oracle
  holds entries the arm settled.
- **Gate edits are titles + mark-reads** (`editFields`). A pending stage
  moves progress roll-ups, which titles-overlaid-on-the-kernel-snapshot
  cannot judge; pending stages flow through the same overlaid row inputs as
  server stages (the server-stage fences prove that path), so Mc2 holds the
  one drawn editable field and leaves stage edits to the full phase-c gate.
- **(b) and (d) are commit-count plants.** Equal values are invisible to any
  snapshot comparison by construction, and MobX's `view: computedStruct`
  absorbs equal notifications, so their catching checks are the
  `settle.test.tsx` count cells (echo 0, dup 0 + no re-send), proven red by
  mutation below — not the L4b gate. (a) and (c) corrupt values and fail the
  gate's rebuild/oracle on fixed sequences (+ (c) on a random run).
- **(a)'s MobX shape is a stale-table restore.** The overlay never renders
  the log's rewind target (it mirrors newest-pending-per-field; with no
  entries left the table shows), so "remote never reaches the log" is
  invisible here. The plant snapshots the server row at edit time and puts
  it back on reject, clobbering the remote value. First version (noop
  `handleRemote`) passed — kept as the lesson, not the plant.

## Evidence

- `settle.test.tsx` 5/5: echo 0 commits (edit 1, receipt 0); remote 1 commit
  with stage kept local and title taken; dup receipt 0 commits + `sent`
  stays 1 + late/unknown no-ops; rebuild equals snapshot with pending;
  bootstrap re-applies one queued entry with no re-send.
- `gate-truth.test.ts` fixed plants: clean green + planted red for (a)
  (live stale vs rebuild/oracle server) and (c) (live server vs oracle
  pending).
- Truth-gate smoke: 1 seed × 50 steps green (rebuild + overlaid oracle,
  `mobx-write-truth-gate` result file).
- Mutations (planted alone with `cp` aside, restored after; prod files
  verified byte-identical via `git diff`):
  - (b) `handleRemote` skipping `log.remote`: the echo never confirms, the
    entry never settles — the echo step goes red (`log.size` 1, not 0).
    Attempted `IssueModel.view: computedStruct → computed` stayed GREEN:
    observer rows track fields, so equal values redraw nothing even with a
    fresh view identity; the zero-commit property rests on field-level
    observation plus never writing an equal echo, not on view equality alone.
  - (d) `handleAccepted` re-sending on a duplicate receipt: `transport.sent`
    grows to 2 — red on the no-resend assertion.
- `edit.test.tsx` + `gate-with-edits.test.ts` still green with the layer
  changes (8/8): the idle layer stays invisible.

## Open

- 20 × 300 gate NOT green: the shared oracle's remote pipe lags the arm's
  across the accept boundary (W8 overtake resolves opposite). Shakedown
  3 × 200 (new whole-snapshot oracle): all plants pass, main test fails all
  3 seeds — seed 1 @119 (accept e7: live "Title t6" vs expected "Theirs r8"),
  seed 2 @139 (newIssue bystander: live "Theirs r28" vs expected "Title t10"),
  seed 3 @9 (reAdd bystander: live "Title t2" vs expected "Theirs r5"),
  kernelDiffers=0 throughout (kernel agrees with expected). Complete-or-fail
  works: every seed ran, per-seed rows (steps, ok, failStep, change, diff,
  kernel finding) are in the result file, one error at the end.
- Mechanism (proven, not speculation): seed-3/step-9 has IDENTICAL changes
  in two runs (`gen` is prefix-consistent) with OPPOSITE oracle states — a
  lifecycle probe holds/holds at step 9, the gate run held/dropped. The
  reference log's `ackBase` (value seen at receipt) is timing-dependent: the
  arm observes remotes via the feed subscription during `apply`, the oracle
  via `syncPending` in `onStep`. If the oracle hasn't synced the remote by
  the accept, `ackBase` is stale and the later remote OVERTAKES (W8,
  write-contract.ts `remote`) and drops the entry; whichever side saw the
  remote holds it. Contract-correct per F4 is holding Mine until the echo
  (the arm held in all three seeds). No arm bug, no oracle-rule bug: the
  test double observes through a later pipe. Any fix (shared harness
  serialization, or contract W8 change) is outside the write path — asked
  the coordinator (mail, QUESTION) before touching shared code. NOT
  re-running 20 × 300 until ruled: a lucky-green run would prove nothing.
- Plants (i)+(ii) proven red (in-test plants; (i) also by cp-revert of
  80e65b1ca with byte-identical restore): (i) lane-only visibility fails the
  fixed mark-read sequence (live hides, rebuild shows); (ii) an arm-log-only
  phantom mark-read fails the shared oracle (both arm derivations show,
  kernel and oracle hide). Lesson: derivations re-run only on observable
  change — a plant must move the overlay map, property patching alone goes
  stale; a cold target needs the same hydration a real edit does.
- 20 × 300 gate 16/20: seeds 7/9/11/19 fail single-row membership at tail
  steps (extra i2110/i3232, missing i656/i1771), each with a superseded
  mark-read in its past. Root cause (probe: arm holds TWO wall-clock
  mark-reads ms apart, oracle holds ZERO, no edit steps involved): a
  supersede step presses one arm mark-read per handle, but feedStep never
  fed them to the oracle (cut with the outcome mapping). Fix in the shared
  feeding (authorized construction): append every claimed kernel id of a
  supersede step like an edit intent. The collapse outcomes already arrive
  through the stream on both sides.
- The superseded seed-4 i1397 note (pending-mark-read membership vs the old
  title-patching oracle) is closed by the option-(b) whole-snapshot oracle:
  membership now follows the spec rules over the overlaid rows.
- TTL expiry has the `expire()` API but no gate exercise (the kernel's
  awaiting-truth expiry runs on the wall clock, which the gate does not
  drive); reference-log level is covered by L1c.
- Shared diff (`gen/run.ts`, `gen/check.ts`, `receipts.ts` export) is
  additive; flag for the L4a/L4b/L3b owners at review. The gate-only
  kernel-minted path differs from production W2 (arm-minted via
  `createWriteTransport`); noted, per the ruling.

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
