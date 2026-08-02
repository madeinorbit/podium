# POD-327 paired-VPS soak evidence

Gate status: **NOT STARTED — candidate/control-plane mismatch found during preflight**. This
document is the evidence form for the human-owned 48-hour remote-daemon soak. Do not mark it
passed, call the oracle green, or close POD-327/POD-426/POD-292 until every required field and
observation below is present.

Never paste a join token, pair code, machine token, cookie, or credential file into this artifact.

## Failed candidate preflight — no soak time counts

The first monitored attempt on 2026-08-02 was stopped after two minutes and **does not start the
48-hour clock**. It found that the joined VPS and the live control plane were not running the
merged POD-327 candidate lineage:

- The joined VPS was initially running the July 18 `podium 0.1.2-edge.1` bundle, executable
  SHA-256 `308759ec1e0b2527b3ee801436a26a62e82a10732db6c7cb8ab9cc21db68aa57`.
- Exact integration candidate `5d814dd54dbf67f97c5d052445473b6be82b0bc1` was built from a
  detached, frozen-dependency worktree. Its executable SHA-256 is
  `f7dbbfd353711f5e9cb3033830f1ea2ddc70eaf80620fef7b154b9ae5568674a`.
- The one preflight swap/restart completed at `2026-08-02T13:01:04Z`, with `NRestarts=0`.
  Continuous 60-second capture began at `2026-08-02T13:01:58Z` in the transient user unit
  `pod327-soak-monitor.service`, writing to `~/.podium/pod327-soak/monitor.log` on vmi.
- At `2026-08-02T13:04:00Z` the exact candidate reported `disconnected` with automatic retry;
  the contact timestamp had not advanced. The server then refused the machine-pinned POD-1407
  workload because `vmi3407763` was offline.
- The live server was `f97ed4fc2269a8abd2c8c49a22ca9c7770b3ff96` from `main`, started from
  `/home/mgw/src/other/podium`; it is not a descendant of candidate `5d814dd5`. A 48-hour soak of
  those two mismatched endpoints would not verify the merged daemon/gateway contract.
- The attempt was explicitly failed rather than continued. The monitor was stopped, the backed-up
  July binary was atomically restored, and the daemon automatically rejoined at
  `2026-08-02T13:08:44Z` with a five-second-fresh contact and `NRestarts=0`. The exact candidate is
  retained on vmi as `~/.local/share/podium/podium-cli.pod327-5d814dd5` for the valid retry.

A valid boundary may be recorded only after the live server runs the candidate lineage (or a
documented compatible deployed SHA), the exact candidate daemon is installed, authenticated
contact advances, and the pinned workload starts successfully. That shared-server deployment is
outside this issue session's authority because it interrupts active users.

## Enrollment record

| Field | Recorded value |
|---|---|
| Intended human owner / pairer | `<user id and display name>` |
| Admin observers receiving machine diagnostics | `<user ids>` |
| Server host / version / commit | `<host>; <version>; <sha>` |
| VPS host / OS / architecture | `<non-secret host label>; <os>; <arch>` |
| Named Podium instance | `<instance id — deployment partition, not user boundary>` |
| Minted machine id | `<UUID; never local or __local__>` |
| Daemon version / commit | `<version>; <sha>` |
| Pair code minted at / redeemed at (UTC) | `<timestamps only; do not record code>` |
| Soak start / required end (UTC) | `<start>; <start + 48h>` |
| Actual end / elapsed | `<end>; <duration>` |

Pair from **Settings → Machines → Add machine while authenticated as the intended owner**. Run the
generated one-line installer on the VPS, or its equivalent:

```bash
podium setup --join <TOKEN> --persist systemd
```

The first transport credential is the one-shot pair code embedded in the join token. Successful
redemption must persist the pairer as owner and replace that credential with the long-lived
machine token used for every reconnect. Record observable ownership/grants, not either secret.

## Boundary captures

At both the start and end, retain the complete output of:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
podium --version
podium status
systemctl --user show podium-daemon.service --property=ActiveState,SubState,NRestarts,ExecMainStartTimestamp,ExecMainStatus
journalctl --user -u podium-daemon.service --no-pager --since '<boundary window start>'
```

Attach the relevant excerpts below or as additional durable POD-327 artifacts. Preserve timestamps,
connectivity transitions, daemon restarts and version decisions; redact only secrets.

### Start capture

```text
<timestamp, versions, podium status, systemd properties, initial journal excerpt>
```

### End capture

```text
<timestamp, versions, podium status, systemd properties, final journal excerpt>
```

## Ownership and authorization observations

- [ ] The fleet row records the authenticating pairer as machine owner and the machine is private
      to that owner by default.
- [ ] The owner can see and `use` the machine for spawn, attach/PTY, harness control and file work.
- [ ] A server-authenticated non-owner without a grant does not inherit `use`, including on the
      server host machine; no local/loopback/daemon-secret shortcut appears.
- [ ] Machine diagnostics, including an unknown Codex-version warning if one occurs, reach only the
      owner and admins rather than every connected client.
- [ ] The machine identity is a minted UUID. InstanceId remains only the deployment partition and
      is not used as a per-user visibility or authorization boundary.

## Unattended workload and reconnect log

Run a representative owned-machine workload continuously enough to exercise spawn, output, PTY
control and reattach. Record every server/network interruption and the automatic recovery; do not
manually restart, re-pair or update the daemon during the 48-hour interval.

| UTC timestamp | Event / interruption | Connectivity report | Automatic recovery | Session/control result |
|---|---|---|---|---|
| `<time>` | initial authenticated attach | `connected` | n/a | spawn + PTY control passed |
| `<time>` | `<ordinary network or server interruption>` | `disconnected`, retry/backoff visible | `<time to token reconnect>` | surviving session reattached |
| `<time>` | `<additional observed event>` | `<state>` | `<result>` | `<result>` |

The evidence must distinguish transport unreachability from authorization denial:

- Unreachable/offline is `disconnected`, retains the last transport error, and schedules backoff.
- Authorization denial is `unauthorized`, is not reported as an outage, and schedules no reconnect
  backoff. An unexpected `unauthorized` or `blocked` state fails this soak; do not repair it inside
  the interval and continue the clock.

## Pass criteria

- [ ] At least 48 continuous hours elapsed between the recorded boundaries.
- [ ] Authenticated connectivity recovered automatically after ordinary network/server loss using
      the persisted machine token.
- [ ] No manual daemon restart, re-pair, credential edit, update or operator repair occurred.
- [ ] No unexpected `unauthorized` or `blocked` transition occurred.
- [ ] No crash loop or unexplained restart occurred; `NRestarts` and the journal support the claim.
- [ ] Spawn, surviving-session reattach, attach/PTY and representative control operations continued
      on the owner-authorized machine.
- [ ] Owner/admin attention routing and non-owner `use` refusal remained correct.
- [ ] The unchanged 25 ms acceptance measurement and all-five-lane oracle are separately green on
      the candidate SHA; the soak does not substitute for either automated gate.

## Verdict and human gate

Verdict: `<PASS | FAIL — leave NOT STARTED until the run begins>`

Operator notes:

```text
<manual intervention statement, anomalies, exact failed criterion if any>
```

After a PASS, add this file and any supporting logs to POD-327 with `podium issue artifact`, then
run `podium issue needs-human` on POD-327 for explicit sign-off. Until the human accepts the
artifact, keep POD-327, POD-426 and POD-292 open.
