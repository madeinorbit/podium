# The session-write oracle (POD-379)

**What it is:** 122 characterization tests that pin TODAY's observable behaviour of every session
write, so the 3.2 migration onto command contracts (POD-380 presence class, POD-381 command plane,
POD-642 handoff, POD-382 the cutover that deletes the hand-written router mutations) can be proven
behaviour-preserving instead of merely compiling.

**Where it lives**

| File | Covers |
|---|---|
| `apps/server/src/modules/sessions/oracle-support.ts` | Fixtures, the two tag helpers, predicate waiting |
| `…/oracle-presence.test.ts` | rename · archive · read/unread · workState · issue attachment · snoozes · pins · tab order · drafts |
| `…/oracle-commands.test.ts` | create · resume · hibernate · resurrect · kill · sendText · resumeAndSend · answerAskUserQuestion |
| `…/oracle-authz.test.ts` | the agent-capability path: relay allowlist, scope gate, issueless targets, payload-identity inertness |
| `…/oracle-errors.test.ts` | not-found shape per write; unreachable-machine shape for create/resume/handoff |
| `…/oracle-attribution.test.ts` | spawnedBy · nameSource · deletion_source · stopReason · inputOrigin · humanQuestionAskedBy · (handoff: none) |
| `…/oracle-idempotency.test.ts` | mutationId dedup — what makes an outbox replay safe — and the writes with no replay protection |
| `…/oracle-handoff.test.ts` | two machines: success + ordering, bundle base, mid-transfer crash, duplicate dispatch, worktree reuse |
| `…/oracle-tags.test.ts` | the ratchet: every characterization carries a tag, every will-change tag names a real issue |
| `packages/client-core/src/engine/outbox-coverage.oracle.test.ts` | which writes are offline-queued, and which deliberately are not |

## The two tags

A green oracle must never be used as evidence that a deliberate replacement is a regression, so
each test declares which kind of statement it is:

- **must-not-change** — the migration must preserve this verbatim. Red here is a regression.
- **will-change `POD-…`** — a named later issue replaces this. Red here means *read that issue, then
  update the characterization* — never *restore the old behaviour*.

The will-change classes, all four represented and enforced by the ratchet:

| Issue | What it replaces |
|---|---|
| POD-1076 | readAt / snooze / pins / tab order become per-user state keyed `(userId, entityId)` |
| POD-1075 | one shared password ⇒ `OPERATOR` admin/all; attribution becomes (actor, on-behalf-of) |
| POD-1073 | human-vs-human authorization; consistent-error rule (§3.1.5) |
| POD-1079 | machines become owned compute — `use` defaults to the owner only |

## Three things the oracle found that the brief did not predict

1. **Offline queueing is NOT issue-writes-only.** `createEngineOutbox` covers eight SESSION writes
   (rename, setArchived, setWorkState, snoozeSet, snoozeClear, markRead, markUnread, resumeAndSend)
   plus three issue writes. Pins, tab order and sendText are the deliberate exclusions.
2. **The not-found shape is not uniform, and one write succeeds against a ghost.** Presence writes
   are silent no-ops; hibernate/resurrect return `{ ok: false, reason: 'unknown session' }`; handoff
   throws; sends dead-letter; and `snoozes.set`, `pins.set`, `tabs.setOrder` *persist a row for an id
   that does not exist*. §3.1.5's consistent-error rule has to reconcile all four shapes.
3. **An operator chat send is stamped `inputOrigin: 'mail'`, not `'human'`.** Only the direct
   keystroke path (`answerAskUserQuestion`) stamps `'human'`. The field records the PATH, not the
   person — one more attribution field that has to grow a second half.

Also worth stating plainly: **the presence writes have no agent path at all.** They are operator-only
by ABSENCE from `RELAY_ALLOWED`, not by a check. A uniform command plane must reproduce that absence
deliberately.

## Proof the net catches things

Ten mutants were applied to the product, run, and reverted; every one turned the intended test red:

| Mutant | Test that caught it |
|---|---|
| Agent may overwrite a user-set name | presence · "a user-set name is sovereign" |
| Archive stops parking the process | presence · "archiving … parks a running session" |
| Cleared draft no longer flushes immediately | presence · "persistence is DEBOUNCED …" |
| `withMutation` stops reading the applied-mutation row | idempotency · "a replayed rename does NOT re-apply" |
| `rename` added to the relay allowlist | authz · "sessions.rename is refused via the relay" |
| `askedBy` spoof guard removed | attribution · "humanQuestionAskedBy is stamped from the transport principal" |
| Bundle-base guard removed | handoff · "no verified common bundle base ⇒ refuse" |
| Handoff rollback removed | handoff · "an export failure rolls the session back onto the SOURCE" |
| An untagged characterization added | tags · "every characterization opens with a tag helper" |
| A will-change tag naming an unknown issue | tags · "every will-change tag names a superseding issue" |

## Deliberate deviations

- **Handoff runs against two paired machines with SCRIPTED daemons**, not the POD-498 iso harness.
  That harness needs a second real machine over the tailnet and is a hand-driven script, not a lane;
  it cannot run hermetically and there was no human in this run to drive it. The orchestration being
  characterized (ordering, refusals, rollback, occupancy guard) lives in `SessionsService`, which is
  what these tests exercise. The real-hardware transfer path — bundle apply, `git worktree add`,
  credential install — remains the iso harness's job and is filed as deferred.
- **No test asserts on UI copy or a bare substring.** Error messages are pinned with exact equality
  (POD-743). No test uses a fixed sleep; waiting is always on a predicate (POD-757).
