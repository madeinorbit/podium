# Telemetry design (POD-678)

Date: 2026-07-16
Status: approved design, ready for implementation

## Goal

Learn what Podium features are used and what breaks in the field, without spending
community trust. Podium sits next to private code; the bar for what leaves a user's
machine is higher than for a typical SaaS product.

## Non-goals

- Per-user analytics, funnels, session tracking, or anything person-shaped.
- Public aggregate dashboard (deferred; see "Deferred" below).
- Performance/latency telemetry (cut; see "Decisions" D3).
- Self-hosting the analytics vendor (deferred; the relay makes it a server-side change).

## Evidence base

The design is built on what actually caused (and did not cause) community anger:

| Project | What happened | Lesson |
| --- | --- | --- |
| Go 1.23 | Minimal, fully-published payload; opt-out default still blew up ([discussion 58409](https://github.com/golang/go/discussions/58409)). Shipped uneventfully once [made opt-in](https://research.swtch.com/telemetry-opt-in). | The **default** is the fight, not the payload. |
| Homebrew | Anger was about **Google Analytics** as vendor; resolved by [moving to their own InfluxDB](https://brew.sh/2023/07/20/homebrew-4.1.0/) with barely any change to data collected. | The **vendor** is the second fight. |
| Homebrew | A repeating analytics notice drew complaints ([brew#15678](https://github.com/Homebrew/brew/issues/15678), [brew#15719](https://github.com/Homebrew/brew/issues/15719)). | Ask **at most once**. Never nag. |
| Syncthing | Richer payload than ours (folder counts, sizes, hardware), ~zero friction — opt-in, and the UI shows the exact report. | Showing the payload buys more trust than shrinking it. |
| Syncthing | Had to [further anonymize](https://github.com/syncthing/syncthing/issues/7787) published aggregates — small slices de-anonymize. | Suppress small buckets when publishing. |
| Firefox | Opt-in UI got [~4% even on pre-release channels](https://bugzilla.mozilla.org/show_bug.cgi?id=652657); ~93% under opt-out default. | Buried opt-in ⇒ single digits. |
| Ubuntu 18.04 | Asked at install with a data preview → [67% yes](https://itsfoss.com/ubuntu-data-collection-stats/), to a payload richer than ours. | A good prompt at the right moment wins the rate. |

Synthesis: **payload richness barely moves the opt-in rate; the default, the prompt, and the
moment decide it.** Payload minimalism is for the vocal minority who read the schema and shape
everyone else's default trust — worth doing, but not as a rate lever.

## Decisions

- **D1 — Opt-in, default off.** Nothing is sent until the user explicitly says yes.
- **D2 — Two tiers: `usage` and `crash`**, independently consented. Crash is riskier (traces
  can leak paths) and is the highest-value tier for a self-hosted tool where field crashes
  are otherwise invisible.
- **D3 — No `perf` tier.** Field histograms across heterogeneous self-hosted machines are
  noisy and hard to action, and local perf instrumentation already exists (`scripts/loop-probe.mjs`).
  If a concrete regression question arises, perf slots into `usage` as bucketed counters
  without a new tier.
- **D4 — No collection before consent.** Deliberately *not* Go's `local` mode. Go's local mode
  is its **default** (so data exists when someone later opts in via a delayed gopls prompt) and
  backs a user-facing `gotelemetry view`. Podium's default is off and Podium asks at setup,
  when counters would be zero anyway — so local collection would buy nothing while adding an
  objection surface ("it counts even if I never opt in"). "Off means off."
- **D5 — Opting in starts the clock.** Matches Go, whose mode file records the mode *and* its
  effective date (`Mode() (string, time.Time)`); per x/telemetry docs, "calling SetMode with
  `on` effectively resets the timeout before the next telemetry report is uploaded". With D4
  there is no backlog to ship regardless.
- **D6 — Show the example report by default** in the prompt. The audience is developers; the
  JSON documents itself better than prose describing it.
- **D7 — First-party relay, disclosed vendor.** Clients POST to a Podium-operated endpoint that
  drops the source IP and forwards to PostHog Cloud. Relay **source lives in the public repo**;
  deployment is in podium cloud. `TELEMETRY.md` names PostHog explicitly — undisclosed
  processors being *discovered* is the scandal pattern; disclosed ones are a footnote.
- **D8 — Telemetry state lives in `config.json`**, not the settings blob, so `podium telemetry off`
  works whether or not the server is running. Mirrors `updateChannel` / `persistence` / `features`.
- **D9 — Read consent fresh at flush time**, never cached at boot, so `podium telemetry off`
  takes effect on a running server without a restart.
- **D10 — Only hosts emit and only hosts are asked.** The server is the sole emitter; joined
  daemons/clients are covered by the hub's decision and are never prompted.
- **D11 — Ask at most once per setup run, never on bare `podium`.** Re-running `podium setup`
  asks again (Homebrew's nagging lesson bounds this to an explicit user action).

## Consent model

Tri-state per tier, in `config.json`:

```jsonc
{
  "telemetry": {
    "installId": "3f9c1a2e-…",   // random UUIDv4, not derived from anything
    "usage": "on" | "off",        // absent = never asked (behaves as off)
    "crash": "on" | "off"         // absent = never asked (behaves as off)
  }
}
```

Absent ≠ `off`: both suppress all sending, but absent is what lets setup know to ask.
`installId` is minted on first *opt-in* (not at install), and `podium telemetry reset-id`
regenerates it.

Hard kill switches, checked before anything else including the prompt:
- `DO_NOT_TRACK=1` (the [community standard](https://consoledonottrack.com/))
- `PODIUM_TELEMETRY=off`
- `podium telemetry off`

## What is sent

### `usage` tier — one report per day

```json
{
  "schema": 1,
  "installId": "3f9c1a2e-…",
  "version": "1.4.2",
  "os": "linux",
  "arch": "x64",
  "installAge": "1-7d",
  "machines": "2-5",
  "sessions": { "claude": 14, "codex": 2 },
  "features": { "issues": true, "spec": true, "handoff": false }
}
```

Every field is enumerated in the schema module. Counts are integers; `installAge` and
`machines` are **pre-bucketed** enums (`0d`,`1-7d`,`8-30d`,`31-90d`,`90d+` / `1`,`2-5`,`6-20`,`20+`)
so raw values never exist in the payload. `sessions` keys are harness kinds from the existing
protocol enum — not free strings.

### `crash` tier — rate-limited per issue signature

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

- **Error messages are dropped entirely** — they routinely embed paths, repo names, and user data.
- Frames are scrubbed to **Podium-relative paths only**; any frame outside the Podium install
  (node internals, user code, node_modules) is dropped, not rewritten.
- Rate-limited per `(errorType, top-frame)` signature so a crash loop can't beacon.

### Never sent, at any tier

Filesystem paths, repo names, branch names, issue titles, prompts, transcripts, code, agent
output, env vars, hostnames, usernames, IPs (dropped at ingest), or any free-text field.

**The type system enforces this**: the schema module admits only enums and numbers — there is
no free-string field to misuse. If a field isn't in the schema, it cannot be sent.

## Architecture

```
server process (sole emitter, D10)
  ├── counters (in-memory, only while a tier is on)
  ├── queue     <state-dir>/telemetry/queue.jsonl   (capped, readable)
  └── flusher   daily + jitter, on graceful shutdown, best-effort
        │  reads consent fresh (D9)
        ▼
  https://telemetry.podium.dev  (relay: validate → drop IP → forward)
        ▼
  PostHog Cloud (disclosed)
```

New package `packages/telemetry`:

| Module | Responsibility |
| --- | --- |
| `schema.ts` | The single source of truth. Every event/field enumerated, zod. Enums+numbers only. |
| `scrub.ts` | Stack-trace scrubbing to Podium-relative frames; message dropping. |
| `queue.ts` | Append/read/truncate the capped JSONL queue. |
| `emitter.ts` | Counters, daily flush w/ jitter, consent check at flush time, POST. |
| `consent.ts` | Tri-state read/write against `config.json`; kill-switch precedence. |

Failure is silent and free: no retries that pester air-gapped installs, one debug-level log
line at most. A telemetry failure must never affect a user-visible code path.

`docs/TELEMETRY.md` documents the schema; **CI fails if the doc and the schema module drift.**

## Setup flow placement

### CLI — host modes (`all-in-one`, `server`)

Existing flow (`apps/cli/src/cli-setup.ts`), with the new step marked:

1. `install.sh` — download, verify Ed25519 signature, symlink, persist channel → `Done. Run: podium`
2. `podium` on a TTY with no `mode` → `interactive-setup` (`needsSetup` = `!config.mode`)
3. Mode menu (`cli-setup.ts:342`)
4. `reachabilityStep` — pick tunnel, paste public URL
5. `passwordStep` — password, or the literal word `open` to confirm none
6. `saveConfig({ mode, publicUrl })` — the first write, deliberately late (issue #21)
7. `persistenceStep` — systemd? → `startBackendEngine` → backend running
8. **`telemetryStep` (new) → patch `config.telemetry`**
9. Status

**Rationale for last:** steps 3–7 are all *required* for a working Podium; telemetry is the only
optional question and must not be a tollbooth on the way to a working install. Ctrl-C at step 8
leaves a fully working install with telemetry off — the best available failure mode. And the
user has just succeeded, which is when goodwill is highest (Ubuntu's 67% slot).

Because the backend is already running at step 8, D9 (consent read fresh at flush) is what makes
this correct — and it is the right behavior independently.

### CLI — join mode

3. Mode menu → "add this machine to a Podium you already run"
4. Join code
5. `persistenceStep` → daemon starts
6. **No telemetry prompt** (D10 — the hub decided)

`install.sh --join` runs `podium setup --join … --persist systemd` non-interactively with no TTY;
it cannot and need not prompt.

### CLI — re-running setup

`podium setup` on a configured host shows the mode menu, which already grows host-only entries
(`4) Change how this machine is reached`, `5) Change or remove the login password`). Add:

```
  6) Change telemetry
```

visible under the same `hostsServer` condition. Picking a host mode (1/2) also re-walks
`hostStep` and therefore reaches step 8 again. This is the entire "ask an existing install"
story — no one-time card, no bare-`podium` prompt (D11).

### Web

0. Version handshake (stale PWA shell hard-reloads) — `SetupGate.tsx:107`
1. Login wall — **conditional**: `/auth/status` gates only when a password is set, so a fresh
   install passes straight through
2. Setup gate probes `/setup/config` → `!mode` → `SetupView`
3. Sub-step `mode` — 4 radios (`SetupView.tsx:78`)
4. Sub-step `network` — public URL + password (host modes only, `SetupView.tsx:116`)
5. **Sub-step `telemetry` (new, host modes only)**
6. `setup.complete` → restart/reload
7. `OnboardingWizard` — scan folder, add repos (gated on `repos.length === 0`)
8. `AppShell`

Telemetry must precede `setup.complete`, which triggers a reload. It deliberately does **not**
live in `OnboardingWizard`, whose dismissal is in-memory only (`AppShell.tsx:120`) and therefore
not a reliable one-time surface. The telemetry choice rides the `setup.complete` payload so the
whole wizard commits atomically, consistent with the existing whole-blob round-trip.

### Desktop (Tauri)

Mode resolves in Rust before the webview (`bootstrap.rs:76`). Client/daemon installs inject
`__PODIUM_SKIP_SETUP__` and skip `SetupView` entirely → no telemetry prompt, correctly (D10).
All-in-one desktop gets the web flow above.

## Prompt text (CLI)

```text
── Anonymous telemetry (opt-in) ─────────────────────────────────

  Nothing is collected unless you turn it on. One report a day,
  and this is exactly what it looks like:

    {
      "schema":    1,
      "installId": "3f9c1a2e-…",        // random · reset-id to change
      "version":   "1.4.2",
      "os": "linux", "arch": "x64",
      "installAge": "1-7d",
      "machines":   "2-5",
      "sessions":   { "claude": 14, "codex": 2 },
      "features":   { "issues": true, "spec": true, "handoff": false }
    }

  • Never     paths, repo names, prompts, code, any free text
  • Your IP   dropped at ingest, never reaches analytics
  • Opt out   anytime in Settings → Privacy, or: podium telemetry off
  • Details   podium telemetry show · podium.dev/telemetry

  Send anonymous usage reports?           [y/N]
  Send crash reports (scrubbed traces)?   [y/N]
```

Both default to N; Enter-Enter opts out of both. Rendered through the existing `SetupIO` seam
(`cli-setup.ts:12`) with a bounded prompt loop — stdin EOF makes `rl.question` resolve `''`
forever, so unbounded loops spin (`cli-setup.ts:119`).

The web step shows the same example report and the same four bullets, with two switches.

## CLI surface

```
podium telemetry              # status: per-tier state + endpoint + installId
podium telemetry on [--usage] [--crash]    # no flag = both
podium telemetry off [--usage] [--crash]   # no flag = both
podium telemetry show         # the exact pending + last-sent payloads
podium telemetry reset-id     # new installId
```

`podium telemetry show` is the standing audit tool and prints the same report the prompt showed.

## Settings → Privacy

New 17th settings tab (`SettingsView.tsx`: `SettingsTab` union + `SETTINGS_TABS` + `SECTION_VIEWS`
must all be updated — they are the three places that must stay in sync). It is a **self-persisting**
section (like Security/Updates/Network), not a blob-editing one, because telemetry lives in
`config.json` (D8), not the settings blob.

Contents: one switch per tier, the example report, the endpoint URL, the `installId` with a reset
button, and a link to `podium.dev/telemetry`. A tier disabled by `DO_NOT_TRACK` /
`PODIUM_TELEMETRY=off` renders disabled with the reason shown — mirroring how `experimental.tsx`
renders config-locked flags.

New tRPC router `telemetry.*`: `state` (read), `set` (per-tier), `resetId`, `preview` (example
report). Reads/writes `config.json` via `loadConfig`/`saveConfig`.

## Endpoint configuration

The relay URL is resolvable, highest wins:

1. `PODIUM_TELEMETRY_ENDPOINT` (env)
2. `config.telemetry.endpoint` (config file)
3. Value from the **signed update manifest**, if present
4. Baked-in default

The signed-manifest layer is safe: whoever controls the update channel can already ship arbitrary
code, so a URL field adds no trust surface — but it must stay subordinate to the consent toggles,
and an **unsigned response can never change it**.

Update-URL self-migration (the `[newUrl, oldUrl]` list, probe-then-persist, monotonic counter) is
**out of scope here** — it belongs to the updater, and is filed separately.

## Relay

A small worker in the public repo (`services/telemetry-relay/`), deployed in podium cloud:

1. Validate the body against the published schema (reject anything else).
2. **Drop the source IP** — never logged, never forwarded.
3. Forward to PostHog Cloud with a server-side key.

The relay's real value is **vendor abstraction**: no third-party domain in anyone's firewall logs,
and PostHog can be swapped (or self-hosted, or replaced with ClickHouse) without touching a single
client. `TELEMETRY.md` states honestly that the deployment cannot be verified against the source.

## Testing

- **Scrubber**: hostile paths (repo names, usernames, `/home/*`, Windows paths, symlinked
  worktrees), error messages containing paths, frames outside the install.
- **Schema lint**: a test that fails if any schema field admits a free string.
- **Doc drift**: CI test that `docs/TELEMETRY.md` matches the schema module.
- **Consent**: absent ≠ off ≠ on; kill-switch precedence; `DO_NOT_TRACK` suppresses the prompt;
  consent read fresh at flush (turn off mid-run → next flush sends nothing).
- **Setup**: telemetry step reached at CLI step 8; Ctrl-C at step 8 leaves working install with
  telemetry absent; join path never prompts; non-interactive `--join` never prompts.
- **Relay contract**: schema round-trip; malformed bodies rejected; IP absent from forwarded body.
- **E2E**: enable a tier, force a flush against a local stub relay, assert the wire payload
  byte-matches what `podium telemetry show` printed.
- **Web**: real-click Playwright through the new setup sub-step and the Privacy settings page
  (per `docs` convention that interactive UI needs runtime verification).

## Deferred

- **Public aggregate dashboard.** Gate on >1k active installs; publish shares/trends, not raw
  counts, and suppress any bucket below ~20 installs (Syncthing's de-anonymization lesson).
  Until then, occasional "what telemetry taught us" notes — insights flatter at any scale.
- **Self-hosted PostHog.** [Hobby Docker](https://posthog.com/docs/self-host) is MIT but
  [explicitly unsupported](https://posthog.com/docs/self-host/open-source/disclaimer) and guided
  at ~100k events/month (≈3k daily installs at one report/day). Kubernetes support was
  [sunset](https://posthog.com/blog/sunsetting-helm-support-posthog). The relay makes this a
  server-side-only change if scale or sentiment demands it.
- **`perf` tier** (D3).
- **Update-URL self-migration** (filed separately).
