# Telemetry

**Podium sends nothing unless you turn it on.** There is no telemetry by default, no "anonymous
usage statistics are enabled to help us improve the product" that you have to go find and switch
off, and nothing is collected locally while it is off either.

If you never touch this page, nothing about your machine ever leaves it.

This document is the contract. A CI test (`packages/telemetry/src/docs-drift.test.ts`) fails the
build if the field tables below stop matching the schema in code, so this cannot quietly drift
from what actually ships.

## The short version

| | |
| --- | --- |
| **Default** | Off. Both tiers. Always. |
| **Asked** | Once, at the end of `podium setup`, after your install already works. |
| **Where** | `Settings → Privacy`, or `podium telemetry` from a terminal. |
| **How much** | One report a day, ~400 bytes. |
| **Your IP** | Dropped at ingest. Never reaches the analytics vendor. |
| **Vendor** | PostHog Cloud, behind a Podium-operated relay (named below, on purpose). |
| **Kill switch** | `DO_NOT_TRACK=1` or `PODIUM_TELEMETRY=off` — disables everything, including the prompt. |

## Turning it off (and on)

```sh
podium telemetry                 # what is on, where it goes, your install id
podium telemetry off             # both tiers off
podium telemetry off --usage     # just one tier
podium telemetry on --crash      # opt into one tier
podium telemetry show            # the exact pending + last-sent payloads
podium telemetry reset-id        # new random install id
```

`podium telemetry off` works whether or not the server is running: consent lives in
`~/.podium/config.json` (not the database, not a settings blob), and the running server re-reads
it before every send — so turning it off takes effect immediately, with no restart.

You can also just edit the file:

```jsonc
{
  "telemetry": {
    "usage": "off",
    "crash": "off"
  }
}
```

Absent, `"off"`, and a kill switch all send nothing. The only difference is that *absent* means
"never asked", which is how `podium setup` knows whether to ask.

## What is sent

Two tiers, consented independently. You can enable one and not the other.

### `usage` — one report per day

```json
{
  "schema": 1,
  "installId": "3f9c1a2e-…",
  "version": "1.4.2",
  "os": "linux",
  "arch": "x64",
  "installAge": "1-7d",
  "machines": "2-5",
  "sessions": { "claude-code": 14, "codex": 2 },
  "features": { "issues": true, "spec": true, "handoff": false }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `schema` | `1` | Wire version. |
| `installId` | random UUIDv4 | Minted when you opt in — **not** at install, and never if you decline. Not derived from your hostname, username, MAC, or anything else about your machine. Reset it any time with `podium telemetry reset-id`. |
| `version` | e.g. `1.4.2`, or `dev` | Which Podium build. |
| `os` | `linux` \| `darwin` \| `win32` \| `other` | |
| `arch` | `x64` \| `arm64` \| `other` | |
| `installAge` | `0d` \| `1-7d` \| `8-30d` \| `31-90d` \| `90d+` | **Bucketed.** The raw age never exists in the payload. |
| `machines` | `1` \| `2-5` \| `6-20` \| `20+` | **Bucketed**, same reason. |
| `sessions` | counts, keyed by harness | How many sessions you started, per agent kind (`claude-code`, `codex`, `grok`, `opencode`, `cursor`, `shell`). Counts only. |
| `features` | booleans, keyed by feature | Whether you used `issues`, `spec`, or `handoff` — never what you used them on. |

### `crash` — rate-limited, one per distinct crash

```json
{
  "schema": 1,
  "installId": "3f9c1a2e-…",
  "version": "1.4.2",
  "os": "linux",
  "arch": "x64",
  "errorType": "TypeError",
  "frames": [
    { "file": "apps/server/src/router.ts", "line": 412, "fn": "handleSession" },
    { "file": "packages/runtime/src/config.ts", "line": 187, "fn": "saveConfig" }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `errorType` | a fixed list | `Error`, `TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`, `EvalError`, `URIError`, `AggregateError`, or `Other`. A custom error class reports as `Other` — class names never leave your machine. |
| `frames` | up to 20 | `file` is always a path **inside the Podium source tree**; `line` a number; `fn` an identifier, omitted when there isn't one. |

Two things this tier does *not* do:

- **The error message is dropped entirely.** Not scrubbed — dropped. Messages routinely contain
  paths, repo names, URLs and whatever the failing code interpolated. There is no allowlist that
  makes free text safe, so it never enters the payload.
- **Frames outside the Podium install are dropped, not rewritten.** A stack frame in your own code,
  in `node_modules`, or in node internals is discarded whole. We do not "sanitize" your path down
  to a filename — the basename of your file is still your data.

Crash reports are rate-limited per `(errorType, top frame)` signature, so a crash loop cannot turn
into a beacon.

## What is never sent, at any tier

Filesystem paths · repo names · branch names · issue titles · prompts · transcripts · your code ·
agent output · environment variables · hostnames · usernames · IP addresses (dropped at ingest) ·
any free-text field at all.

**This is enforced by the type system, not by our diligence.** The schema
(`packages/telemetry/src/schema.ts`) admits only enums, bounded numbers, booleans, and strings
pinned by a regex or UUID check. There is no free-string field anywhere in it, so there is nothing
for user data to hide in — and a test walks the schema tree on every CI run and fails if anyone
adds one. If a field isn't in the tables above, it cannot be sent.

## Where it goes

```
your machine  ──POST──▶  telemetry.podium.dev  ──▶  PostHog Cloud
                         (Podium-operated relay:
                          validate → drop your IP → forward)
```

The relay's job is three steps: validate the body against the published schema (reject anything
else), **drop the source IP** (never logged, never forwarded), and forward to PostHog with a
server-side key. It stores nothing.

**The vendor is PostHog Cloud**, and we name it here because an undisclosed data processor being
*discovered* is how these things become scandals. The relay exists so that this stays our
implementation detail rather than your problem: no third-party domain appears in your firewall
logs, and we can swap the vendor (or self-host, or drop it for plain ClickHouse) without any
client needing to change.

The relay's source is in this repo: [`services/telemetry-relay/`](../services/telemetry-relay/).
**In fairness: you cannot verify that the deployed relay matches that source.** You are trusting us
either way — we would rather say so than imply a proof we can't give. What you *can* verify is
everything on your side of the wire: `podium telemetry show` prints the exact bytes queued and last
sent, and `~/.podium/telemetry/queue.jsonl` is plain text you can read with `cat`.

To point Podium somewhere else entirely (your own collector, or `/dev/null`):

```sh
PODIUM_TELEMETRY_ENDPOINT=https://my-collector.example podium
```

Resolution order is `PODIUM_TELEMETRY_ENDPOINT` → `config.telemetry.endpoint` → the signed update
manifest → the built-in default. Note that an endpoint override does **not** imply consent: it only
says where reports would go if you turned any on.

## Who sends

Only a **host** (an `all-in-one` or `server` install) ever sends, and only a host is ever asked.
Machines that joined your Podium never emit and are never prompted — they are covered by the
decision you made on the hub.

## Failure

Telemetry never affects Podium. If the relay is unreachable, reports queue (capped at 32 entries /
64KB, oldest dropped first) and are retried at most once per daily flush — no retry storms, nothing
that pesters an air-gapped install. If anything in the telemetry path throws, it is swallowed: a
telemetry problem you can see would be a worse bug than no telemetry at all.

## Why we ask at all

Podium is self-hosted, which means we are otherwise blind: we cannot tell whether a feature is used
by everyone or no one, and a crash on your machine is invisible to us unless you file it. The
alternative to a small opt-in signal isn't a better signal — it's guessing.

We would rather have a low opt-in rate on a payload you're comfortable with than a high one you'd
be annoyed to discover. If you'd rather not, `podium telemetry off` (or just never turning it on)
is a completely legitimate answer, and nothing in Podium will nag you about it again.
