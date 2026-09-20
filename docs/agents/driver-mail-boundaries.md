# Driver mail boundaries

Unread issue mail and delivered-but-unacknowledged reply reminders use the same
harness-neutral policy sources in `apps/daemon/src/mail-injector.ts`. The owning
driver selects the safe boundary and performs the intervention. Hook ingress
only transports a driver's response; it does not select a mail policy.

| Driver family | Boundary and intervention | Activity contract |
| --- | --- | --- |
| Claude/Codex terminal | Private Stop hook returns `decision: block` with inbox or reply instructions | The harness must continue its current turn. `stop_hook_active` suppresses both polls, so the continuation can stop. |
| Grok terminal | Private PreToolUse hook returns `decision: deny` | One tool attempt is vetoed; the harness remains active and may retry after reading/replying. Grok Stop is not a blocking boundary. |
| Codex app-server, OpenCode server (including OpenCode 2), Grok ACP, Claude SDK | A successful provider completion triggers `send` with `delivery: at-boundary` | The completed epoch stays closed. Accepted mail opens a new active turn; an idle interval during the bounded relay is allowed. These providers do not pretend to veto a completed turn or an already executing tool. |

Terminal arbitrary `send(at-boundary)` remains unsupported: a queued paste cannot
claim the Stop/tool veto guarantee. Its driver-private hook response is the
boundary delivery mechanism. Every agent launch/reconnect requires an owned
handle; a terminal callback for an unowned session fails open without polling.

Native boundary sends preserve normal queue ordering, outstanding interactions
and controller leases. Their origin is `mail` and acting principal is
`{ kind: 'system', ref: 'issue-mail' }`. The relay remains scoped to the receiving
session, and the rendered context retains the server-supplied senders. The
continuation helper runs inside each native driver's adapter, not a generic
server event observer.

Each policy has a per-session 60-second cooldown and rejects overlapping polls.
The composition also rejects overlapping checks. Unread mail takes precedence;
reply reminders are fetched only if the unread policy declines. The reminder
endpoint persists `reminded_at` before returning rows, so the driver never
implements a second reminder counter or resets one on restart.

Only a live successful completion can trigger a native continuation. The driver
claims the epoch before awaiting the relay, remembers mail origin, rejects
replayed/duplicate completions, and discards results after handle replacement or
a newer turn. A bootstrap start may identify an initial prompt still running;
a bootstrap completion never triggers delivery. Mail-origin completion does
not poll either policy, even after cooldown expires.

Relay errors, malformed/empty responses and the 2.5-second deadline all fail open.
Cancellation is checked between policies, so a late unread result cannot consume a
reply reminder after the boundary deadline. The terminal responder also accepts the
shared hook AbortSignal when supplied by ingress. There is no timer-driven retry or
automatic mail loop. As with the existing
hook path, a reminder already marked by the server may be consumed if its relay
response arrives too late or delivery is refused; the driver must not manufacture
another reminder. Refused/unverified native delivery is logged.

Acceptance lives in the mail policy tests, driver boundary tests, terminal hook
HTTP tests, Codex adapter tests and the shared driver conformance corpus. It checks
active state and epoch behavior in addition to text, plus active Stop suppression,
tool denial, reminders, relay failure, duplicate completion and empty inboxes.
