# POD-1882 — Experimental updater controls

What changed, why, and what is still open. Written for review, not as a design doc.

## The shape

One Experimental feature, **`podium-development`** ("Podium development",
`stable` visibility, off by default), gates the controls that exist to develop
Podium itself:

| Surface | Flag off | Flag on |
|---|---|---|
| Settings → Updates, channel selector | **Always visible.** Stable · Edge | Stable · Edge · **Development** |
| Settings → Machines, per-machine source | Read-only line: `Fleet default` or `<Channel> (pinned for this machine)` | Full selector: **Fleet default** · Development · Edge · Stable |
| Settings → Updates, machine list | Discloses `Pinned: <Channel>` for every machine off the fleet default | same |

`stable` visibility is deliberate: a Podium developer's install is usually a
released build, so a flag that only listed on `edge` could never be turned on
where it is needed.

## The fleet default is now real

Before this change the Updates selector wrote `config.updateChannel`, which
governed only the server's own self-update — every machine resolved its target
from its own `machines.update_channel` row, defaulted to `stable`. The two
controls looked alike and one of them did nothing to the fleet.

Now:

- `machines.update_channel_override` (new, **nullable**) is the operator's pin.
  `null` means "follow the fleet default".
- `MachinesService.updateChannel(id)` resolves `pin ?? fleetDefault`, and
  `MachineWire.updateChannel` carries that RESOLVED answer while
  `MachineWire.updateChannelOverride` carries the pin.
- `machines.setUpdateChannel` accepts `null`, which is what the **Fleet default**
  choice writes — clearing a pin is an explicit operator act.

### Migration

`20260811115738_machine-update-channel-override` adds the nullable column and
copies **every** existing `update_channel` value into it, `stable` included. An
upgrade is not entitled to reinterpret a stored value as "never chosen": on an
install whose fleet config is Edge, converting stored `stable` rows to inherit
would have moved those machines onto Edge without anyone choosing it. Expand-only
— the old `update_channel` column is left in place and simply no longer read.

## Honesty about the effective channel

`PODIUM_UPDATE_CHANNEL` beats `config.json` in `resolveUpdateChannel`, which is
what machines resolve against. `setup.channel` therefore now answers
`{ channel, envForced, configured }` — the EFFECTIVE authority — and
`setup.setChannel` refuses with `PRECONDITION_FAILED` when the environment forces
the value, rather than writing a config key that cannot take effect. The Updates
page disables the selector and explains why.

## Live refresh ordering

Writing the fleet default re-resolves every unpinned machine. `setChannel` is
async and **awaits** `onFleetChannelChanged`, which loads the new channel's target
FIRST and only then broadcasts. Broadcasting first would ship the new channel
beside the old channel's target chip with no second broadcast to correct it.

## Unavailable targets read as a state, not a blank

Per POD-1880, a dev channel can legitimately have no target while a bundle is
preparing, missing or failed. The Updates machine list renders the server's
sanitized `targetUnavailableReason` as `No target: <reason>`.

## Open, not fixed here

Three tests in `apps/server/src/router.updates.test.ts` fail — and failed at HEAD
before this branch, independently verified by POD-1883. `fleetSnapshot` counts
only machines whose channel is `dev`, so a machine on any other channel is
invisible to the global wave and `converge` refuses with "already at this version
everywhere". That is fleet-default semantics and therefore this issue's area, but
it is a distinct behavioural decision about wave scope, so it is filed separately
rather than changed silently under a visibility ticket.
