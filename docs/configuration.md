# Configuration

Everything Podium reads about *this deployment* — where it listens, what mode it
runs in, how it is reached, who updates it — resolves through one rule, in one
place: `packages/runtime/src/config.ts`.

## The rule

**env (`PODIUM_*`) → `config.json` → built-in default.**

One typed accessor per key, and nothing outside that accessor reads
`process.env.PODIUM_*` for a layered key. `resolveSetting(key)` is the single
implementation of the precedence; every accessor is a projection of it, and it
also reports **which layer answered**.

Three properties follow from that, and they are what the rest of this document
is about:

1. **Env is boot-time.** A process cannot see an environment change, so an
   env-set value is never "stale" and never "activation pending".
2. **A forced value locks its UI and refuses its mutation.** Not a silent no-op —
   a no-op reads as success and leaves the deployment somewhere else. The
   refusal is `PRECONDITION_FAILED` and it always names the variable to unset.
3. **Security switches stay file-only.** A stray variable must not widen trust.

A server adds a fourth layer for a few keys: a settings ROW in `podium.db`,
applied by `apps/server`. Today that is `transcriptLake` — see below.

## The layered keys

| Variable | Config key | Default | What reads it |
|---|---|---|---|
| `PODIUM_PORT` | `port` | per-instance block | `resolvePort()` |
| `PODIUM_HOOK_PORT` | `hookPort` | per-instance block | `resolveHookPort()` |
| `PODIUM_AGENT_RELAY_PORT` | `agentRelayPort` | per-instance block | `resolveAgentRelayPort()` |
| `PODIUM_AGENT_HOME` | `agentHome` | `$HOME` (named instances isolate) | `resolveAgentHomeDir()` |
| `PODIUM_UPDATE_CHANNEL` | `updateChannel` | `stable` | `resolveUpdateChannel()` |
| `PODIUM_UPDATE_FEED` | `updateFeed` | GitHub Releases | `resolveUpdateFeed()` |
| `PODIUM_MODE` | `mode` | unset (needs setup) | `resolveMode()` |
| `PODIUM_PUBLIC_URL` | `publicUrl` | unset | `resolvePublicUrl()` |
| `PODIUM_APP_URL` | `appUrl` | unset (this server serves its own UI) | `resolveAppUrl()` |
| `PODIUM_ALLOWED_ORIGINS` | `allowedOrigins` | `[]` | `resolveAllowedOrigins()` |
| `PODIUM_UPDATE_SCOPE` | `updateScope` | `all` | `resolveUpdateScope()` |
| `PODIUM_TRANSCRIPT_LAKE` | `transcriptLake` | the Settings toggle, else `on` | `resolveTranscriptLake()` |

Every one is optional. With none set, an install behaves exactly as it did
before any of them existed.

### `PODIUM_MODE`

`all-in-one | daemon | client | server`; anything else fails the boot naming the
accepted list. This is the key whose absence made a headless boot impossible:
`mode` gates the whole data plane through readiness, so a container with a fully
specified environment and an empty state dir still had to be walked through a
setup wizard by a human.

With it set, readiness treats this process as configured, a `config.json` that
disagrees cannot make it stale, and every setup mutation of `mode` refuses.

### `PODIUM_PUBLIC_URL`

Normalized to a **bare origin**, and **`https:` unless the host is loopback**.
The file layer is deliberately unchanged — a self-hosted `http://box.lan:18787`
keeps working — because the file is what an operator typed at setup, while the
environment is what a deployment platform injects, and a platform that can inject
a URL can inject an https one.

**One channel, and changing it is deliberate.** The URL is embedded in every join
token already issued and every paired device's record; replacing it strands all
of them with no way back. `podium setup` asks for a confirmation word before
replacing a URL that is already set, and `--confirm-url-change` answers that
ahead of time for a run that cannot show a prompt. Re-saving the *same* URL is
idempotent and is never questioned.

### `PODIUM_APP_URL`

Where the web UI is served from **when it is not this server** — the hosted
shape, an `app.` origin in front of an API-only `api.` one. Absent for every
self-hosted install, and absent changes nothing.

It must be an `https:` bare origin, and it must share a registrable domain with
`publicUrl` **unless it also appears in `allowedOrigins`**. The session cookie is
host-only on the API origin and `SameSite=Lax`, so a UI on an unrelated site
could not log in; without this check the failure would be a redirect into a page
that silently cannot authenticate. The boot fails rather than advertising it.

A server with **no web bundle** redirects `/`, `/desktop`, `/mobile` and
`/mobile/*` there. A server that *has* a bundle keeps serving it: redirecting
away from a working local UI would take it from the operator standing at the box.

### `PODIUM_ALLOWED_ORIGINS`

A comma-separated list of origins allowed to make **credentialed** cross-site
requests. Each entry must be exactly an origin — scheme, host, optional port,
nothing else — so a later `origin === entry` comparison cannot be widened by a
stray path, and a wildcard cannot arrive disguised as a hostname. Duplicates are
dropped, first occurrence wins, order is preserved.

A **present but empty** variable is a deliberate empty list, not "unset".

This one has an env layer where `auth.openMode` deliberately does not, and the
distinction is the point: it widens trust only to an explicit, fully-qualified
list, never to "anyone".

### `PODIUM_UPDATE_SCOPE`

`all` (default) or `fleet-only`. Under `fleet-only` the deployment replaces the
server binary out-of-band — a container image, a CI deploy — and Podium only ever
updates the **joined machines**.

It is a declaration rather than a runtime probe because the current correctness
is accidental: a container has no parent supervisor, so the local update
participant happens not to start and `canRestartServer` happens to be false —
while the wave planner still holds the host row `coordinator-last` and the UI
still offers a server update that can never land. Under `fleet-only` the
coordinator is **excluded** from planning rather than held, because a hold is
something a human can wait out and this one never resolves.

### `PODIUM_TRANSCRIPT_LAKE`

`on` (default) or `off` — whether this server mirrors and indexes daemon
transcripts into `<stateDir>/transcripts`.

This one is a **user-facing choice first**: Settings → Privacy carries "Mirror
transcripts to this server", stored as an instance-tier settings row, and the
env and config layers sit *above* it. An untouched toggle is not "off" — it is
nobody having chosen, and the built-in answer is on. When a deployment sets
either layer, the toggle renders locked **at the value the deployment chose**,
naming the layer: a disabled control that is also wrong would be worse than no
control at all.

## The file-only keys, and why

Two keys have **no** env layer, deliberately:

- **`features`** — operator feature-flag overrides. These enable hidden code
  paths.
- **`auth.openMode`** — serves everything without a login.

One turns off authentication and the other runs code that is otherwise not
reachable. Neither should be settable from a process environment that a
supervisor, a container platform, or a stray `.env` file can populate by
accident. They are file-and-command only.

## Forced settings in the UI

`setup.provenance` reports, for every layered key, which layer answered and — when
it was the environment — which variable. The web reads it once through
`useForcedSetting(key)`; a forced control renders **disabled** with:

> `<PODIUM_X>` is set in this deployment's environment and overrides this setting.

It never hides the value: the operator still needs to see what the deployment
chose. It removes only the affordance to change it. An absent or failed
provenance read means **not forced** — "the environment might be holding this" is
not a reason to take an affordance away — so an older server changes nothing.

The setup wizard skips a step the environment has already answered rather than
drawing a dead control on the one screen a first-time operator has no context to
interpret.

## `/readiness`

Answers **503 while the data plane is blocked**, and 200 once it is available.
The body is unchanged in both cases. A platform health check reads the status
code and nothing else, so 200 with a body saying `dataPlane: "blocked"` told
every orchestrator that an instance which could not serve any work was healthy.

Clients that read this route parse the body on 503 as well as 200.

## The headless boot profile

An instance boots to a serving state from environment variables alone, against an
empty state directory, with no interactive setup and no pre-seeded `config.json`:

```sh
PODIUM_MODE=server
PODIUM_STATE_DIR=/data
PODIUM_HOST=0.0.0.0
PODIUM_PORT=8080
PODIUM_PUBLIC_URL=https://api.example.com
PODIUM_APP_URL=https://app.example.com
PODIUM_TRUSTED_PROXY_HOPS=1
PODIUM_PASSWORD=<secret>          # one-shot first-admin seed
PODIUM_ALLOWED_ORIGINS=https://app.example.com
PODIUM_UPDATE_SCOPE=fleet-only    # CI deploys the server
PODIUM_UPDATE_CHANNEL=stable      # locks the fleet default
PODIUM_TRANSCRIPT_LAKE=off
PODIUM_TELEMETRY=off
```

`apps/server/src/headless-boot.integration.test.ts` runs exactly this shape and
asserts that `/readiness` reports `dataPlane: "available"`, `/setup/config`
reports `needsSetup: false`, and no `config.json` is written.
