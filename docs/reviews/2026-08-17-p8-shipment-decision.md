# The widened op catalog, both sides of it — probe, fix, and a recorded decision

**Issue:** POD-2223 · **Closes:** POD-2217, POD-2218 · **Epic:** POD-2087 · **Written:**
2026-08-17.

Findings D1 and D2 of `docs/reviews/2026-08-16-updater-closing-review.md` are the same
shipment seen from two sides. The reviewer said plainly that both were derived by reading
and neither was probed. This ran them.

---

## 1. What was actually run

Both findings turn on the same claim: `98f65d411` added a value (`dev` on
`ApprovalChannelTarget`) that a peer built before that commit cannot parse. So the probe is
the obvious one — take the protocol *as it was* at `98f65d411^`, and feed it the frames the
server sends *now*.

The pre-widening `packages/protocol/src` was extracted from git into a scratch tree inside
the package (so `@podium/model` and `zod` still resolved), and run under
`bun --conditions=@podium/source`. Both arms carry a control: the same frame with a value
that build *does* know, which isolates the value from the probe's own plumbing.

| Probe | Result |
| --- | --- |
| old daemon, `approvalExecRequest { op: { kind: 'channel', target: 'dev' } }` | **throws** — `invalid_enum_value: received "dev", options ["stable","edge"]` |
| *control:* same frame, `target: 'edge'` | parses |
| old daemon, can it encode `approvalExecResult`? | yes — the reply shape predates the widening |
| old bundle, `approvalsChanged` with one `dev` row + one readable row | **throws the whole frame** |
| *control:* same frame with the `dev` row removed | parses, `dropped=0` |

Both findings are real, and the old enum is exactly the two values the review named. The
scratch tree was deleted; nothing of it is in the commit.

**One thing the review got wrong, and it changes the fix.** D1's preferred repair is an
`approvalExecRequest` arm on `payloadRejectionReply`. But that function runs on **the daemon
that cannot read the frame** — which is, by construction, a daemon older than the release
that adds the value. On merge day every daemon in the fleet is that daemon. The arm is worth
nothing to this widening and everything to the next one. It is the *right* change and it is
not the *sufficient* one; the merge-day net has to sit on the server, which is the half that
is new.

---

## 2. POD-2217 — fixed, in two places, for two populations

**`apps/daemon/src/frame-guards.ts` — answer the frame (the next widening).**
`payloadRejectionReply` gained an `approvalExecRequest` arm replying `approvalExecResult
{ ok: false, exitCode: null }`, whose output names the op, this daemon's version, and the
remedy. `exitCode: null` is the honest value — nothing was spawned. The bar POD-1464 set for
adding an arm is unchanged and met: the result frame already exists in the daemon's own
vocabulary, so refusing invents nothing. The op is read defensively rather than through the
schema that just refused it, so the operator is told *which* operation their approval was
for even when this build has no arm for that op kind at all.

**`apps/server/src/modules/approvals/service.ts` — a deadline (the fleet that exists).**
`sweepStalledExecutions()` fails an approval whose daemon took the exec request and went
silent, driven from a 60-second timer in `relay.ts` beside the message sweep.

`APPROVAL_EXEC_DEADLINE_MS` is 7 minutes, and both bounds are load-bearing. **Above** the
daemon's own executor ceiling: `runApprovalExec` spawns with `timeout: 300_000` and reports
either outcome, so a merely-slow daemon always answers inside 5 minutes. **Below**
`APPROVAL_WAIT_MS` (10 min), the window the requesting agent's CLI blocks for — firing inside
it means the agent's own command prints the real answer and exits, instead of printing *"the
request is still live … you will be told the outcome"*, which for a row nobody will ever
answer is false twice over.

Three exemptions, all of them about not lying:

- **`stop`** kills its own daemon mid-exec, so no result is *expected*. Its row staying
  `executing` is documented as honest where it is dispatched, and is left alone.
- **A machine whose daemon is away** has its frame *queued* by `toMachine`, not lost — it
  still runs on the next attach. So the stall clock is a clock, not a timestamp: it is
  deleted whenever the daemon is absent and restarted on the tick that finds it back, and
  the deadline only ever measures time a daemon *had* the frame and stayed silent.
- **A row seen for the first time** — after a restart, or one already stuck when this ships —
  starts its clock rather than being failed on sight. The clock is in memory on purpose; a
  restart costs one extra deadline of patience on a row that was already stuck, which is the
  conservative direction, and the durable alternative is a column, a migration and a ledger
  for an error path measured in minutes.

The failure text says what is known and no more. The machine may in fact have run the op and
lost its reply, so it does not claim nothing happened — it names the machine, the one thing
that is certainly true (the daemon was connected and did not answer), the likely cause and
the remedy, and where to look for what that machine is actually on. A result that arrives
**anyway** re-opens the row and corrects it: being told "it failed" about an op that ran is
worse than being told nothing.

**Tests.** `apps/daemon/src/payload-rejection.test.ts` covers the arm;
`frame-guards.test.ts` drives the real `receive()` path, because the point is that the arm is
*reached*, not that the function returns the right object in isolation. Both use a channel
target no build has ever shipped, so they assert the same failure `dev` made against a
pre-POD-2199 daemon without rotting the next time the enum widens.
`apps/server/src/modules/approvals/service.test.ts` covers the deadline, each exemption, the
restart, and the late result. The shard roster is unchanged and its drift guard re-run: no
test *file* was added, so no membership or input moved.

---

## 3. POD-2218 — decided: accept the bundle freeze, do not split the shipment

The split was **still available** when this was decided. The epic has not merged, so `dev`
could have been held back one release behind the quarantine that survives it. Declining it
is therefore a decision, not a default, which is the thing POD-2218 says is missing.

Declined for four reasons:

1. **The reason to split was the daemon half, and the daemon half no longer needs it.** The
   server deadline is a guarantee that does not depend on any fleet converging. Splitting
   would have bought convergence-shaped safety for a problem that now has a
   convergence-independent answer.
2. **The bundle failure is loud, correctly diagnosed, and lossless.**
   `recordSkew({ refusedFrames: 1 })` drives `describeWireSkew` to the severe copy — *"This
   app build cannot read what the server is sending … Reload to pick up a newer build"* —
   which is the right sentence and the right remedy. The approval rows are durable SQLite
   with no timeout, so nothing is lost server-side.
3. **It costs a reload, not a convergence.** One per-session act, prompted by copy already on
   screen. That is a categorically cheaper thing than the fleet convergence this epic exists
   to manage, and it is why the P8 argument, which is about convergence windows, binds less
   tightly here than it does on the daemon side.
4. **The trigger population and the reloading population are nearly the same people.** `dev`
   is the only channel a *source checkout's* own `dev+<sha>` target is ever published on, so
   provoking this at all means an agent on a source machine asking for it.

Against that, splitting costs a release of exactly what POD-2199 shipped — an agent on a
source machine pinning its own box to the only channel its target appears on, the last
holdout the operator half (POD-2198) had already fixed — and leaves a half-shipment for
someone to remember to finish.

### The rule this leaves

So that the next widening is decided rather than defaulted:

> Tolerance goes in one release and the value that needs it in the next — **unless** the
> receiver-side failure is loud, lossless and self-healing, or a producer-side net covers it
> independently of convergence.

And the structural distinction that decided which half got code and which got a paragraph:

> A closed enum on a frame carrying **one** element has no per-element quarantine available
> to it at all, and must take the producer-side net. A frame carrying an **array** can be
> quarantined, and then the question is only whether the receiver's failure is tolerable in
> the window before the tolerance lands.

`approvalExecRequest` is the first; `approvalsChanged` is the second.

Both are recorded in §19.2f of
`docs/internal/superpowers/specs/2026-08-14-update-operations-design.md`.

---

## 4. What was not touched

`apps/web`, the fleet read model (POD-2222), and the daemon's update install path
(POD-2221) — the two live siblings. D3 (`lint:architecture`) and D4 (the canary un-proved by
a single-row Apply) are not this issue's and are untouched.
