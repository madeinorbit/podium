# Stray agent scopes on flatblock, 2026-08-25

Taken by the POD-1761 coordinator at 2026-08-25T01:24:04+02:00, before any change, on the machine where the incident lives. Numbers are perishable — they do not survive a reboot, and this is the only before-picture we get.

## Totals

- podium user scopes RUNNING: 75
- systemd: systemd 259 (259.5-0ubuntu3.4)
- linger: yes
- host uptime: up 7 weeks, 4 days, 7 hours, 48 minutes

## By instance prefix

(derived by stripping the trailing session UUID from each unit name; the prefix is the
instance that created the scope)

         69 podium
          4 podium-operator
          1 run-p1033397-i13606855
          1 podium-cx

## What this shows

Scopes from at least three distinct instances are running under ONE user manager. The
unnamed `podium` prefix dominates because the default instance never namespaced its units,
so scopes from different runs of it are indistinguishable from each other by name alone —
which is trap 2 of the design brief observed in the wild: a prefix match cannot tell you
which incarnation a unit belongs to.

Nothing in the product today can enumerate these, attribute them to an instance, or reclaim
them. That is the gap POD-2694 specifies and POD-2691 implements.

## Method

    systemctl --user list-units --type=scope --state=running --no-legend | grep podium

A first attempt grouped by stripping only the last hyphenated segment, which produced 75
distinct "slices" for 75 scopes — a number equal to the total is a derivation that is not
grouping anything. Recorded here because the wrong number was plausible.

---

# Addendum: a session that cannot be stopped, 2026-08-25 03:52

Recorded from the coordinator's side, because it is the same defect as the scopes above seen
from the other end: the record and the reality disagree, and the instrument that claims to stop
a thing reports success while the thing keeps running.

## What was attempted, in order

1. `podium session stop <id>` — returned `stopped …; worktree freed (branch kept)`.
   The session was `live` again on the next check, with a **new** abduco pid.
2. `kill` on that abduco pid directly. A replacement appeared within seconds, again with a new
   pid.
3. `podium issue update --stage planning`, then `stop`. Settled at `hibernated`.
4. On the next sweep both sessions were `live/needs_user` again, with the issue still at
   `planning`.

## State at the time of writing

Issue stage `planning`. Both sessions report `live`. Four abduco processes survive across the
two sessions:

    881e53b9  pids 2459841 (master) and 2459844 (attach client)
    986a0b43  pids 2452609 (master) and 2452612 (attach client)

Every one of these pids is newer than the stop that was supposed to end it.

## Why it belongs in this issue's evidence

The 75 scopes above are units nobody can attribute. This is the same problem one layer up: a
supervisor that cannot make a stop *stick*, and cannot tell the caller that it failed. Four
stop attempts returned success. None of them was true for longer than a sweep.

The design's answer — a service manager as the single authority for birth, inventory and kill,
with the outcome VERIFIED rather than assumed — is aimed exactly here. This addendum is the
before-picture for the kill half, as the scope census is the before-picture for the inventory
half.
