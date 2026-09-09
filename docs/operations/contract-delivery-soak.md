# Contract delivery rollout

The server-local `features.daemon-headed-delivery` config setting enables daemon
inbox delivery for bind-confirmed headed contract sessions. It defaults to false.
It does not enable `runtime-drivers`, change the picker default, or change legacy
bindings. Headless, unknown-driver and missing-driver contract bindings always
retain daemon delivery because they have no known PTY fallback.

## Operator switch card

| Item | Action or fact |
|---|---|
| Rollout | Wait for the human's restart decision through POD-3738. Neither lane agent nor coordinator restarts the fleet independently. |
| Location | Running server's `~/.podium/config.json`, key `features.daemon-headed-delivery`, for the default instance on ludovico. Confirm the server state root; a named instance may use another file. |
| ON | After the one-time shell setup below: `delivery_switch true` |
| OFF | In the same shell: `delivery_switch false` |
| Persistence | Yes: the boolean is written to disk and survives a restart. The server rereads it on admission; flipping needs no restart. Missing/invalid config disables the widening. |
| Within one minute | Four idle canaries, one per machine/path cohort, must each appear exactly once as a user turn within 60 seconds. Any missing/duplicate canary or contract failure means OFF. Check admission, not completion of the model's answer. |

Run this **one-time setup in the operator shell on ludovico**, after confirming
that the default instance is the serving instance. It defines the two commands
above and preserves the rest of the config with an atomic file replacement:

```sh
delivery_switch() {
  python3 - "$HOME/.podium/config.json" "$1" <<'PYCODE'
import json, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
enabled = {'true': True, 'false': False}[sys.argv[2]]
config = json.loads(path.read_text())
config.setdefault('features', {})['daemon-headed-delivery'] = enabled
fd, temporary = tempfile.mkstemp(prefix='.delivery-config-', dir=path.parent)
try:
    with os.fdopen(fd, 'w') as out:
        json.dump(config, out, indent=2)
        out.write('\n')
    os.chmod(temporary, path.stat().st_mode & 0o777)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print(f'{path}: features.daemon-headed-delivery={str(enabled).lower()}')
PYCODE
}
```

```sh
# Enable only after the candidate rollout and the preflight below:
delivery_switch true
```

```sh
# Roll back immediately on any stop condition below:
delivery_switch false
```

This does not edit a remote daemon's config or change `runtime-drivers`. The
existing off/on/off regression test rewrites a real temporary config file while
keeping the same inbox alive and observes legacy bytes, daemon forwarding, and
legacy bytes again. That is exercised hermetic rollback evidence; the live
canary/rollback drill below remains required.

## Ownership during a flip

An existing legacy queue batch finishes on the legacy loop. Durable attempts
also keep already-typed rows on that path after a server restart. This avoids
replaying an uncertain legacy send through the daemon.

Turning the switch off immediately stops new headed daemon admissions. Already
forwarded rows retain daemon custody until their delivery events settle them or
an explicit queue cancellation succeeds. New input waits behind those rows,
then uses the legacy path. A failed cancellation keeps custody and the durable
row; it cannot authorize a second delivery. If the daemon is unresponsive,
rollback cannot safely replay those rows automatically. Inspect/cancel the
pending rows through the existing queue controls; do not delete rows directly
from SQLite. This restriction is part of the rollback contract.

The setting is live configuration, not persisted per-row routing. A server-only
restart during the enabled soak must retain the enabled setting until daemon
custody has drained: the server's in-memory forwarding set does not survive a
restart. Do not combine an off flip with a server-only restart while daemon
rows are pending.

## Soak evidence

Coordinate rollout with POD-3738. Install the candidate before enabling it;
landing alone does not restart ludovico. Record actual server and daemon build
versions and the switch timestamp. Keep headed contract and legacy populations
on ludovico and flatblock, record their bind-reported runtimeContract/driverId,
and record the observation window and message counts per cohort. Requested or
selected driver IDs in SQLite are launch history, not proof of the live binding.

Capture pending `queued_messages` counts, age and attempts at both ends. Group
prompt-failure reasons and fleet delivery warnings by machine and cohort. Count
successful delivery outcomes as well as failures: a zero-failure cohort with
zero sends is not soak evidence. Daemon attempt counters are local to its queue;
`queued_messages.attempts` measures the legacy loop, so zero in that column must
not be presented as zero daemon retries. Attribute daemon failures through its
row lifecycle events and prompt-failure reasons.

Inspect duplicate Claude interaction asks separately. POD-3741 observed
`claude-pty` declaring atLeastOnce interactions on the hook path. Duplicates are
not message loss and alone do not stop the soak. The interaction contract
decision is outside this rollout.

Record switch rollback on the running candidate too. Preserve the before/after
counts and any queued custody that delayed fallback. Do not unblock POD-3744
until both machines have a measured mixed-population soak and both audits are
accounted for.

The coordinator reports that the multi-instance acceptance lane and fresh
headed spawns are blocked in agent sessions by inherited supervisor identity
(POD-3755). They are not substitutes for this soak and are not claimed as
verified here.

## Pre-registered measurement contract

Freeze this plan and its commit before ON. Report each of these four cohorts
separately: ludovico/legacy, ludovico/headed-contract, flatblock/legacy,
flatblock/headed-contract. Keep claude-pty and generic-pty subtotals. Assign a
message by its observed admission owner, not merely a selected driver or the
flag value: a legacy batch can still own rows after ON. Exclude pre-existing
backlog from the new-message rate, but continue watching it and report its
age/fate separately. Never erase or relabel it to improve a rate.

**Unit and denominator:** one distinct durably accepted message intent. Use
queue-backed sends in both cohorts; direct terminal typing is outside this
inbox-delivery comparison. Before ON, start a measurement ledger recording admission time, session ID, actual
binding/owner, machine, queue row ID, source message ID when present, and a
unique marker or hash for matching. Count retries, re-forwardings and repeated
failure notifications once, under the original intent. A moved message keeps
its original cohort and ID and gets a destination field; it is not a second
admission. Do not copy private prompt text into the shared report.

Use identified canaries plus natural traffic for which this complete admission
ledger is available. Do not claim a whole-fleet denominator from current queue
rows (successful rows disappear). Unattributable traffic is a separate count;
if its inclusion or outcome is uncertain, the affected cohort cannot pass.
Legacy prompt-failure events contain session ID, text and reason, **not row
ID**. Match them to the admission ledger or unique canary marker; ambiguous
identical-text matches are unknown outcomes, not guessed successes or failures.

**One failure definition for both paths:** an admitted intent has failed if
its delivery owner reports it undelivered/unconfirmed, or the observer sees no
confirmed delivery after 60 continuous seconds of eligibility. Eligibility
means a live bound session on a connected machine, idle with no interaction or
native-control hold, and authorized to accept the message. Record the state
observations supporting that clock; uncertain readiness is unknown, not a
silent clock reset. A later successful retry remains a failed-first-delivery
intent with a separately reported eventual recovery.

| Category | Legacy evidence | Contract evidence | Comparison rule |
|---|---|---|---|
| Retry budget exhausted | `queued_messages.attempts >= 5` together with the matching exhausted-budget `session.input_unconfirmed` reason from `reportPromptFailure` | Persisted runtime event `t=delivery`, `outcome=failed`, reason `delivery could not be confirmed after 5 attempts` | One failed intent. Attempts alone are insufficient; contract SQL attempts are not retry evidence. |
| Other reported delivery failure | Matching `session.input_unconfirmed` or `session.initial_prompt_failed` and its exact reason | Persisted `t=delivery`, `outcome=failed` and its exact reason; subsequent prompt-failure projection corroborates it | One failed intent, preserving exact reason. Do not count the contract event and its projection twice. |
| Eligible delivery stalled | No confirmed transcript/ledger delivery after the 60-second eligibility clock | No confirmed delivery after the same clock, even if no failed event exists | One observer-recorded failure. An absent event cannot turn a stall into success. |
| Confirmed delivery | Correlated transcript user turn or a ledger delivery with transcript confirmation | Persisted `t=delivery`, `outcome=delivered`; canaries additionally require the correlated user turn | Success only if no prior failure; record eventual recovery separately. A queue disappearance or transport receipt alone is insufficient. |
| Intentional cancellation | Explicit cancellation/retraction record for the identified intent | `outcome=dropped` correlated with that cancellation | Separate cancellation outcome, never a delivery success. An unexplained drop is an anomaly and stops the run. Cancellation after failure does not erase the failure. |
| Pre-admission rejection | Authorization or input rejection before durable acceptance | Same admission rejection | Outside the denominator, reported separately. A rejection after acceptance counts as failure. |

Asymmetric categories must remain visible:

- Legacy has readiness/parked-session deadlines, transcript-unavailable or
  too-short-to-witness refusals, and at-most-once creation-prompt warnings.
  The daemon queue has no matching deadline event for every such case; it may
  keep waiting. Report those legacy reasons and contract pending/unknown counts
  separately, and apply the common eligible-stall rule to both.
- Contract has typed permanent refusal reasons (`unsupported`, `session_ended`,
  `staging_failed`, `invalid_value`), disposable-queue teardown and explicit
  `dropped` events. Legacy has no one-for-one event vocabulary. Teardown is not
  delivery or cancellation: retain the same pending intent across rebind/move.
  Report each reason; do not invent an equivalent legacy category.
- Legacy may retain a failed row for retry/cancellation; contract failed events
  settle/remove the physical queue row. Count the durable failure, not the
  number of rows remaining. A later recovery cannot rewrite the first result.

For each machine/path cohort publish `N` accepted intents, `S` successes without
prior failure, `F` distinct failed intents, `C` intentional cancellations without
prior failure, and `P` pending/unknown, with `N = S + F + C + P`.
Publish **`1000 * F / N` failures per 1000 accepted messages** and, separately,
`1000 * F / (S + F)` per 1000 resolved non-cancelled messages. A zero denominator
is N/A, never zero. Show cancellations and pending counts beside both rates so
neither can dilute or hide a bad result. Do not average cohorts of different
sizes or collapse asymmetric reason categories. A combined weighted total may
be supplemental only. Report canaries separately from natural traffic.

Durable contract delivery events are appended to `podium_events` by
`RuntimeEventGate` before projection. Deduplicate by the intent/row ID across
events and owners; group by outcome/reason and correlate the original admission
ledger. Retain evidence of successes too. Neither runtime RPC receipts nor
`queued_messages.attempts` supplies the contract outcome denominator.

## Fixed stop and pass criteria

These are acceptance criteria chosen **before** the run, not measured results.
A criterion change requires a new recorded plan and a new observation window.

**Preflight before ON:** the candidate is running; off/on/off hermetic evidence
is attached; both machines are connected; bind-confirmed legacy and headed
contract cohorts and the admission/event collector are observable; four
human-designated canary sessions are idle/eligible. The existing backlog and
failure/log baseline are captured. If any prerequisite is missing, do not flip.
Use designated soak sessions, not arbitrary human/agent work. Do not restart
anything or request a second restart approval; POD-3738 coordinates the human's
decision.

**STOP and run `delivery_switch false` immediately if any of these occurs:**

1. Any headed-contract intent has a failed runtime delivery event, a matching
   prompt-failure report, or an accepted-then-rejected outcome. Threshold:
   `F_contract >= 1` (there is no minimum sample before stopping).
2. Any monitored intent stays unsettled after 60 continuous eligible seconds,
   or any of the initial four idle canaries is missing after 60 seconds.
3. A canary appears more than once, bytes are reported discarded for a contract
   session, a delivered event lacks its canary's transcript witness, or a row
   disappears/drops without correlated delivery or intentional cancellation.
4. Admission/outcome collection has a gap greater than 60 seconds, either
   machine disconnects for more than 60 seconds, or a move violates the
   exact-once/pending-row conditions below. Loss of observation ends the run;
   it is not proof that delivery failed, and the report must distinguish them.

Record the stop timestamp, exact row/event evidence and reason. OFF prevents
new daemon admissions; it cannot retract existing custody. Let those rows
settle or cancel explicitly. Do not replay them by hand, delete SQLite rows,
or combine OFF with a server-only restart while they remain. Duplicate Claude
interaction asks alone are recorded separately and do not trigger STOP.

**PASS requires all of the following:**

- At least 24 continuous hours with the flag ON and complete observation,
  with at least 100 distinct resolved, non-cancelled intents (`S + F >= 100`)
  in **each** of the four cohorts. Use natural traffic; do not manufacture a
  high-volume workload to finish sooner. If counts are short, extend the run.
- Zero headed-contract failures, duplicate deliveries, unexplained drops or
  eligible stalls; zero stop conditions throughout the window. Show the legacy
  rates and every reason category even if the contract rate is zero. Every
  counted intent has a resolved fate (`P = 0`) at the final cutoff. Publish
  exclusions and cancellations; no retrospective removal of failed intents.
- Initial one-minute canaries, the live OFF/legacy-fallback/ON canary drill,
  and both directions of the machine-move check below succeed. Record the live
  rollback drill separately before starting the 24-hour ON window; do not
  count its intentional OFF interval as continuous ON time.
- Both audits are accounted for, and the full report, exact denominators,
  asymmetric categories, duplicate-ask observations and raw redacted evidence
  are attached before considering POD-3744 unblocked.

A sample of 100 with zero observed failures establishes a bounded soak result,
not a proof of a zero population failure rate. Missing coverage or insufficient
traffic means **incomplete**, not pass. A stopped run remains a stopped run;
after a fix, attach a new plan/window instead of extending away the failure.

## Machine-move redelivery drill

Run on a human-designated headed contract soak session with a unique test
intent, and keep the switch ON for the whole drill. Record source binding,
source durable row ID/source message ID, marker, machine and runtime event
cursor. Hold the session busy so the admitted row remains pending; positively
observe daemon admission and absence of a delivered event/user-turn witness
before requesting the normal handoff to the other machine. Preserve that same
intent through the destination bind; do not resubmit it with a new ID.

After the destination is bound and eligible, require exactly one correlated
user turn and one deduplicated delivered outcome for the original row within
60 seconds, and require the server durable row to settle. Observe the source
for another 60 seconds: it must not deliver a late duplicate. A row that
settled on the source before the handoff is **not** a pending-row move test;
record the race and repeat with a new identified intent. Repeat in the reverse
direction, including a bind on each destination. Record the source/destination
versions, timestamps and correlated evidence.

If normal handoff is unavailable for that profile, requires approval not yet
granted, or cannot retain a genuinely pending intent, mark move coverage
incomplete and leave removal blocked. Do not bypass the handoff mechanism or
move unrelated working sessions to manufacture the result. Flatblock's presence
makes the drill possible to plan; it does not itself prove the property.
