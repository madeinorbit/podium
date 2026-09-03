# POD-2059 — attaching a terminal to an opencode session

What changed, and what a real run on this machine actually did. Everything below
was measured against opencode 1.18.16 on 2026-08-14, not inferred.

## Before

Asking an opencode server session for a terminal got a polite refusal: *"this
machine cannot host a client terminal for the session."* The driver already knew
what the answer should look like — opencode's own TUI, pointed at the session's
private server — but the daemon had nowhere to run it.

## After

The daemon runs `opencode attach <url> --session <conversation>` under abduco, in
its own systemd scope beside the session's, and hands back a stream.

Observed during the live run (`systemctl --user list-units --type=scope`):

```
podium-oc-<session>.scope         [systemd-run] opencode serve --port 42501 --hostname 127.0.0.1
podium-oc-attach-<session>.scope  [systemd-run] abduco -n podium-oc-attach-<session> \
                                      opencode attach http://127.0.0.1:42501 --session ses_0000f155…
```

Two scopes, not one inside the other. The client can be reclaimed on its own, it
dies when the session does, and — the rule with teeth — its memory is not the
agent's. Note what is *not* on that command line: the password. It rides the
environment, the same rule the server half already follows, because
`/proc/<pid>/cmdline` is readable by everyone on the box.

## The credential really does travel in the environment

The same attach, run twice, one string different:

| | what the terminal received |
|---|---|
| correct secret (env only) | 289 bytes of terminal handshake, no error, client alive |
| wrong secret | `Error: opencode server GET …/session/ses_… → 401 Unauthorized`, then it exits |

## What it does not do yet — say it plainly

**Nothing renders this terminal, and nothing types into it.** Both directions are
dead, not just the keyboard:

* **Out.** The client's frames go onto the daemon's relay under the stream id
  this work mints. The server looks that id up among its sessions, finds no row —
  a stream is not a session — and drops them. The frames leave the machine and
  are discarded one hop later.
* **In.** Keystrokes and window size are addressed to sessions, and this terminal
  deliberately is not one, so nothing can reach it either.

Which matters, because opencode's interface interrogates the terminal and waits
for the answers before it draws anything. With no way back, a correctly connected
client finishes its handshake and holds. What is real: the process, its scope,
the warm window, and the daemon's side of the relay. What is not: a picture.

Making a stream id resolvable in **both** directions is the next piece of work,
filed as its own issue (*Attach stream input and geometry*, POD-2108). It is
attach v2's daemon half, which this epic scoped out of the current issue.

## One thing this landing made reachable — since fixed

Attaching in take-over mode claims the session's control lease, and the opencode
driver used to write that lease *unconditionally*: it did not refuse when someone
else already held it, where the terminal-family driver does. The code was
unreachable while the attach in front of it always refused, so wiring the port up
is what would have put it in the path of a real request.

It mattered more than bookkeeping — whose turns get delivered is decided by that
lease, so a second attacher would have silently taken control from the first, and
the first would have kept sending into a queue with nothing telling it why.
Reported as a measurement rather than a patch, confirmed unintended, and **fixed
on the same branch** by the driver's own issue before this could reach anyone: a
take-over now refuses with `lease_held` when someone else holds it, and it checks
*before* starting a client rather than after, so a refusal cannot leave an
orphaned terminal attached to a session it was refused access to.

## Warm-parking, and giving it back under pressure

The client is parked rather than killed: it stays alive under abduco for a
30-minute **idle** window — idle meaning nobody has the session open, so a
terminal you are actually watching is never reaped out from under you. Coming
back is a reconnect, not a cold start. A client that outlived a daemon restart is
adopted back under the reaper instead of sitting resident forever, and stopping
or killing the session takes its client with it — as does a rebind that finds the
session's server gone.

When the host runs short of memory, these terminals are the **first** thing given
back — before any agent is parked. The server owns the threshold and asks; the
machine chooses which to close and never offers up one somebody is watching. If
freeing them was enough, no agent was touched at all; if it was not, the next
sample parks one as it always did.

## Evidence

* `apps/daemon/src/runtime/opencode-attach.test.ts` — the label, the argv, the
  secret's placement, the provider keys stripped as the server half strips them,
  warm re-attach, the idle clock, the reclaim order, teardown, and the memory
  rule asserted against the real attribution function.
* `apps/server/src/modules/hosts/service.test.ts` — terminals given back before
  any agent is parked, and the old behaviour preserved for a machine that has
  none to give.
* `apps/daemon/src/runtime/opencode-attach.live.test.ts` — the live re-proof
  (`PODIUM_OPENCODE_LIVE=1`): real server, real client, real abduco, real
  `/proc`, plus the wrong-secret control above.
