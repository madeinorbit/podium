# Contract delivery rollout

The server-local `features.daemon-headed-delivery` config setting enables daemon
inbox delivery for bind-confirmed headed contract sessions. It defaults to false.
It does not enable `runtime-drivers`, change the picker default, or change legacy
bindings. Headless, unknown-driver and missing-driver contract bindings always
retain daemon delivery because they have no known PTY fallback.

The server rereads the setting on admission. After installing the candidate,
change the **running server's** config file, not the agent worktree's config or a
remote daemon's config. For the default instance this is normally
`~/.podium/config.json`; confirm its state root first. Preserve the rest of the
file. For example, this atomic edit disables the widening without restarting:

```sh
python3 - ~/.podium/config.json false <<'PY'
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
PY
```

Use `true` to enable it. The off/on/off regression test rewrites a real temporary
config file while keeping the same inbox alive and observes legacy bytes, daemon
forwarding, and legacy bytes again. This is hermetic switch evidence, not a live
fleet soak.

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
