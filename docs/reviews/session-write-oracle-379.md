# The session-write oracle (POD-379)

**What it is:** 161 characterization tests that pin TODAY's observable behaviour of every session
write, so the 3.2 migration onto command contracts (POD-380 presence class, POD-381 command plane,
POD-642 handoff, POD-382 the cutover that deletes the hand-written router mutations) can be proven
behaviour-preserving instead of merely compiling.

**Where it lives**

| File | Covers |
|---|---|
| `apps/server/src/modules/sessions/oracle-support.ts` | Fixtures, the two tag helpers, predicate waiting |
| `…/oracle-presence.test.ts` | rename · archive · read/unread · workState · issue attachment · snoozes · pins · tab order · drafts |
| `…/oracle-commands.test.ts` | create · resume · hibernate · resurrect · kill · stop · continue · sendText · resumeAndSend · answerAskUserQuestion |
| `…/oracle-authz.test.ts` | the agent-capability path: relay allowlist (and the two session writes that ARE relay-allowed, `continue` and `stop`), scope gate, issueless targets, payload-identity inertness |
| `…/oracle-errors.test.ts` | not-found shape per write; unreachable-machine shape for create, resume, both send paths and handoff |
| `…/oracle-attribution.test.ts` | spawnedBy · nameSource · deletion_source · stopReason · inputOrigin · humanQuestionAskedBy · (handoff: none) |
| `…/oracle-idempotency.test.ts` | mutationId dedup, ONE test per mutation-bearing route, and the writes with no replay protection |
| `…/oracle-handoff.test.ts` | two machines: success + ordering, bundle base, mid-transfer crash, duplicate dispatch, worktree reuse |
| `…/oracle-ask-upload.test.ts` | the remaining hand-written router mutations: `sessions.ask` (the seance, answered and unanswered) and `sessions.uploadImage` (machine routing as an invariant, ambient machine authz as a separate POD-1079 baseline, both failure modes, detached-vs-deaf timeout) |
| `…/oracle-tags.test.ts` | the ratchet over EVERY oracle file (including the client-core one): every characterization carries a tag, every will-change tag names a real issue |
| `packages/client-core/src/engine/outbox-coverage.oracle.test.ts` | which writes are offline-queued, and which deliberately are not |

## The two tags

A green oracle must never be used as evidence that a deliberate replacement is a regression, so
each test declares which kind of statement it is:

- **must-not-change** — the migration must preserve this verbatim. Red here is a regression.
- **will-change `POD-…`** — a named later issue replaces this. Red here means *read that issue, then
  update the characterization* — never *restore the old behaviour*.

The will-change classes, all five represented and enforced by the ratchet:

| Issue | What it replaces |
|---|---|
| POD-1076 | readAt / snooze / pins / tab order become per-user state keyed `(userId, entityId)` |
| POD-1075 | one shared password ⇒ `OPERATOR` admin/all; attribution becomes (actor, on-behalf-of) |
| POD-1073 | human-vs-human authorization; consistent-error rule (§3.1.5) |
| POD-1079 | machines become owned compute — `use` defaults to the owner only |
| POD-642 | handoff gains idempotency across duplicate dispatch — a retry must not fork the session |

## Six things the oracle found that the brief did not predict

1. **Offline queueing is NOT issue-writes-only.** `createEngineOutbox` covers eight SESSION writes
   (rename, setArchived, setWorkState, snoozeSet, snoozeClear, markRead, markUnread, resumeAndSend)
   plus three issue writes. The deliberate exclusions are pins, tab order, sendText, `ask` and
   `uploadImage` — all five are machine-enforced, so adding an executor for any of them turns the
   oracle red.
2. **The not-found shape is not uniform, and one write succeeds against a ghost.** Presence writes
   are silent no-ops; hibernate/resurrect return `{ ok: false, reason: 'unknown session' }`; handoff
   throws; sends dead-letter; and `snoozes.set`, `pins.set`, `tabs.setOrder` *persist a row for an id
   that does not exist*. §3.1.5's consistent-error rule has to reconcile all four shapes.
3. **An operator chat send is stamped `inputOrigin: 'mail'`, not `'human'`.** Only the direct
   keystroke path (`answerAskUserQuestion`) stamps `'human'`. The field records the PATH, not the
   person — one more attribution field that has to grow a second half.
4. **A send to a session whose machine has gone away reports success.** Both send paths return
   `{ ok: true, queued: true, disposition: 'queued' }` — indistinguishable from a busy-agent queue.
   §3.1.4 M5 requires unreachable and unauthorized to be distinguishable; today unreachable is not
   even distinguishable from *reachable*, and unauthorized has no shape at all.
5. **Concurrent handoff is not serialized.** Two simultaneous `handoffSession` calls both run end to
   end — two exports, two imports, two spawns on the target, one kill on the source — and still
   converge on a single row. Pinned as exact counts and tagged **will-change POD-642**, which
   requires idempotency across duplicate dispatch: this test exists to make that change visible, not
   to forbid it.
6. **`sessions.ask` is unreachable via the relay.** `relay.ts`'s sessions arm has an explicit
   `if (proc === 'ask')` branch routing to the MessageGate, but `RELAY_ALLOWED.sessions` does not
   list `ask` (nor `recap`), and the allowlist runs first — so the branch is dead code today. A
   cutover that merges the two lists would silently GRANT agents the seance. That is a policy
   change, not a refactor, and it is pinned as such.

Also worth stating plainly: **the presence writes have no agent path at all.** They are operator-only
by ABSENCE from `RELAY_ALLOWED`, not by a check. A uniform command plane must reproduce that absence
deliberately.

## Proof the net catches things

**28 mutants applied to the product, run, and reverted. 28 caught.** Every one turned the test named
below red, and every one was reverted with the working tree verified clean afterwards.

| # | Mutant | Test that caught it |
|---|---|---|
| 1 | Agent may overwrite a user-set name | presence · "a user-set name is sovereign" |
| 2 | Archive stops parking the process | presence · "archiving … parks a running session" |
| 3 | Cleared draft no longer flushes immediately | presence · "persistence is DEBOUNCED …" |
| 4 | `withMutation` stops reading the applied-mutation row | idempotency · "a replayed rename does NOT re-apply" |
| 5 | `withMutation` removed from `sessions.setIssueId` | idempotency · "sessions.setIssueId dedupes its replay" |
| 6 | `withMutation` removed from `sessions.markUnread` | idempotency · "sessions.markUnread dedupes its replay" |
| 7 | `withMutation` removed from `snoozes.clear` | idempotency · "snoozes.clear dedupes its replay" |
| 8 | `withMutation` removed from `sessions.resumeAndSend` | idempotency · "sessions.resumeAndSend dedupes its replay" |
| 9 | A CR appended inside the bracketed paste (`typeText`) | commands · "reaches the PTY stamped 'mail'" AND idempotency · "does not double-type" |
| 10 | `rename` added to the relay allowlist | authz · "sessions.rename is refused via the relay" |
| 11 | `askedBy` spoof guard removed | attribution · "humanQuestionAskedBy is stamped from the transport principal" |
| 12 | Bundle-base guard removed | handoff · "no verified common bundle base ⇒ refuse" |
| 13 | Handoff rollback removed | handoff · "an export failure rolls the session back onto the SOURCE" |
| 14 | Source killed BEFORE the target's bundle-base probe | handoff · "the whole two-machine step sequence, in order" |
| 15 | An in-flight guard added (handoff serialized) | handoff · "CONCURRENT duplicate dispatch is NOT serialized" |
| 16 | An untagged characterization added in apps/server | tags · "every characterization opens with a tag helper" |
| 17 | An untagged `test(` added in packages/client-core | tags · same, for the client-core oracle |
| 18 | The client-core tag literal drifted | tags · "a file that re-declares the tag locally must use the canonical literal" |
| 19 | A will-change tag naming an unknown issue | tags · "every will-change tag names a superseding issue" |
| 20 | `POD-642` dropped from the declared superseding set | tags · same |
| 21 | Self-stop kill armed BEFORE the relay reply | authz · "a self-stop … kill reaches the daemon strictly AFTER the reply" |
| 22 | `ask` added to the relay allowlist | ask-upload · "ask is NOT relay-reachable" |
| 23 | `ask`'s session-target gate removed | ask-upload · "ask against an unknown session THROWS 'session not found'" |
| 24 | `uploadImage`'s empty-path TIMEOUT guard removed | ask-upload · "an answer with no path is treated as NOBODY ANSWERING" |
| 25 | `uploadImage` routed to the default machine instead of the session's | ask-upload · "an upload is routed to the SESSION's machine" |
| 26 | The ack never stamped, so `ask` cannot resolve answered | ask-upload · "an ANSWERED ask returns answered:true …" |
| 27 | An `ask` executor added to `createEngineOutbox` | outbox-coverage · "… ask and uploadImage are NOT offline-capable" |
| 28 | An `uploadImage` executor added to `createEngineOutbox` | outbox-coverage · same |

Two attempts are worth recording because neither was a caught mutant and both taught something:

- **A mutant applied at the wrong site proves nothing.** Appending a CR to `PASTE_END` in
  `packages/composer/src/driver.ts` reddened no test — the server builds its own wrapper in
  `SessionsService.typeText`, which is row 9. Mutate the code the test's path actually executes.
- **A mutant that HANGS is not a kill.** Mutants 27–28 first hung to a bounded process timeout
  instead of failing: the fake api in the outbox oracle had no `ask`/`uploadImage` procedure, so the
  mutant executor threw a retryable `TypeError` and the drain loop retried forever. Fixed in the
  harness, not worked around — the fake api now exposes both procedures, and `drainFully()` bounds
  the loop at 20 passes and throws with the stuck count. Both mutants now fail on the first
  assertion. A stall says a test noticed something; it never says what.

## The name audit (POD-279 broadcast: "a test that asserts its own name")

The upload-routing miss was not a one-off. A pass over every test name in this suite that makes a
SPECIFIC claim — this machine, this order, this principal, this reason, this count — found four more
where the assertion checked something adjacent, all now fixed:

| Test | The claim its body did not check | Fix |
|---|---|---|
| "carries the bytes to the SESSION's machine" | ran on a one-machine fixture, so "which machine" was unassertable | renamed to what it checks; the routing claim now lives only in the two-machine test |
| "kill signals the OWNING daemon" | one machine, so a kill broadcast to everyone would pass | second machine added; asserts it stays silent |
| "sendText bypasses CONTROLLER gating" | no controller was ever established | attaches a controller and asserts `controllerId` before sending |
| "kill / hibernate / resurrect / handoff are not replay-protected" | exercised `kill` only | all four exercised; each asserted to record nothing |
| "a send … fails with a distinct message from an authz denial" | never compared the two messages | both produced in one test and asserted different |

The general form of the trap, worth more than the individual fixes: **a name that says "routed to X"
needs a fixture containing a Y that could have received it.** A single-machine fixture cannot express
that claim however the assertion is written, so the name will outrun the body no matter how carefully
the body is written.

One flake was found and fixed during the same pass: the two-machine upload test re-attached the
default machine's daemon handler mid-test, and `attachDaemon` has retarget side effects. It failed
1 run in 3 under load. Rewritten so no handler is ever swapped; 8 consecutive clean runs, and the
routing mutant still reds.

## Deliberate deviations

- **Handoff runs against two paired machines with SCRIPTED daemons**, not the POD-498 iso harness.
  That harness needs a second real machine over the tailnet and is a hand-driven script, not a lane;
  it cannot run hermetically and there was no human in this run to drive it. The orchestration being
  characterized (ordering, refusals, rollback, occupancy guard) lives in `SessionsService`, which is
  what these tests exercise. The real-hardware transfer path — bundle apply, `git worktree add`,
  credential install — remains the iso harness's job and is filed as deferred.
- **No test asserts on UI copy or on a substring of a string.** Error messages are pinned with exact
  equality and PTY traffic is asserted as the exact decoded frame sequence, so an added wrapper or a
  second frame fails (POD-743). The remaining `toContainEqual` / `toContain` calls are array
  membership by whole structured value, not substring matching. No test uses a fixed sleep; waiting
  is always on a predicate (POD-757).
