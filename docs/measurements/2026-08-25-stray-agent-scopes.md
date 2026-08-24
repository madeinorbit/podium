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
