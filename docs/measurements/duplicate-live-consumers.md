# Duplicate live message consumers

Audit for POD-5796 on `integrate/4286-pilot`, 2026-10-08.

| Consumer | Existing data path | Removal |
| --- | --- | --- |
| Web session lists, titles and phases | `client-graph` shared session models, worklist and navigation readers; `app/pool-navigation-provider.ts`, `app/command-launch-readers.ts` | No legacy list subscription remains in production views. |
| Web conversations and automation definitions/runs | `client-graph` conversation and automation sources backed by the runtime replica | No legacy list subscription remains in production views. |
| Phone | `client/mobile-pool.ts`, `client/use-session-context.ts` and shared screen readers | Session and discovery views read the same synced pool/replica. |
| Desktop shell | Bundled web client; shell owns window, native notifications and terminal plumbing | No separate reader of these seven server messages. |
| CLI | Session, conversation and automation RPC commands | No `SocketHub` list/event consumer; RPC reads remain authoritative. |
| Notification sounds | `ClientRuntime.start()` alone subscribes to `hub.on('sessions')` | Move to one reaction on addressed pool session phase changes. |
| Terminal browser test API | `terminal-client/session-mount.ts` exposes `__podium.sessions()` from the old hub getter | The web app injects an on-request reader of shared pool session models; the terminal hook forwards it without remounting. |
| Transport/protocol tests | Old list observers, dispatch cases, frame fixtures and relay broadcast assertions | Replace retired expectations with sync/phase assertions; remove fixtures for deleted server frames. |
| Daemon conversation discovery | Daemon sends `conversationsChanged` into the server conversation registry | Retain this ingress message and daemon classification. It is not a server-to-client list. |

Server producers still present are the title projection and three agent-state
broadcast sites. Full session/conversation/automation broadcasts were already
retired on the pilot branch; protocol and client legacy arms still admitted them.
The wire-v1 adapter's four corresponding projection fields are also removed;
its unrelated projection fields remain. Production runtime startup supplies the
canonical sync feed.

`machinesList`, `approvalsList`, `hostMetricsList` and their live message handlers
are outside this removal and remain in place. Other hub projections are outside
this issue's scope. Terminal output, geometry, draft, transcript and attention
messages also remain live channels.
