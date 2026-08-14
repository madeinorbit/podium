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

## What it does not do yet

**Nothing renders.** The client starts, connects, and streams — but opencode's
interface interrogates the terminal (capability and mode queries) and waits for
answers before it draws, and today nothing types back to it: keystrokes and
window size have no route to an attachment stream. So a correct attach produces
its handshake and then holds.

That return path is the next piece of work, filed as its own issue
(*Attach stream input and geometry*). It is attach v2's daemon half — a wire
frame for attach, viewer connect/disconnect, and routing input to the
attachment — which this epic scoped out of the current issue.

## One thing this landing makes reachable

Attaching in take-over mode claims the session's control lease, and the opencode
driver writes that lease *unconditionally* — it does not refuse when someone else
already holds it, where the terminal-family driver does. That code was
unreachable until now, because the attach it sits behind always refused; wiring
the port up is what puts it in the path of a real request.

It matters more than bookkeeping: whose turns get delivered is decided by that
lease, so a second attacher silently takes control from the first, and the first
keeps sending and gets its messages queued with nothing telling it why. Confirmed
as unintended by the driver's own issue and filed there as a fix before this is
switched on for anyone; the fix is to route the take-over through the same
lease-acquire that already refuses politely. Named here so it is not discovered
later as a surprise.

## Warm-parking

The client is parked rather than killed: it stays alive under abduco for a
30-minute idle window, so coming back to a session is a reconnect and not a cold
start. A client that outlived a daemon restart is adopted back under the reaper
instead of sitting resident forever, and stopping or killing the session takes
its client with it.

The idle clock currently runs from the last attach, because there is no detach
signal to measure from until that same next issue lands one — that limit is
written where the next reader will meet it, not left to be discovered.

## Evidence

* `apps/daemon/src/runtime/opencode-attach.test.ts` — 18 cases: the label, the
  argv, the secret's placement, warm re-attach, the reaper, teardown, and the
  memory rule asserted against the real attribution function.
* `apps/daemon/src/runtime/opencode-attach.live.test.ts` — the live re-proof
  (`PODIUM_OPENCODE_LIVE=1`): real server, real client, real abduco, real
  `/proc`, plus the wrong-secret control above.
