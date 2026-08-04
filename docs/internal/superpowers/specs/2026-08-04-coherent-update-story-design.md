# Coherent update story: authority, delivery, and one Podium version

- **Date:** 2026-08-04
- **Issue:** POD-1670 (Coherent update story)
- **Status:** Design (approved in brainstorm, awaiting implementation plan)
- **Supersedes:** `2026-07-01-complete-update-story-design.md` (that spec shipped the wire
  handshake, the 426 self-heal and the daily headless timer; this one replaces its *policy*
  layer, where each component updated itself independently)

## Goal

Make updating Podium one coherent story across web, server, daemon, desktop and mobile, in
development and on production channels. Today each component updates itself from GitHub on its
own schedule, the server cannot see what version any of its daemons run, and development has no
update path at all for a remote machine. This design puts the server in charge of what its
attached components run, separates that authority from how the bytes are delivered, and gives
the user a single decision expressed in a single dialog.

## 1. Principles

### 1.1 There is only Podium

From the user's side there is one product with one version. It runs in places: this app, their
server, their machines. The user does not model "the daemon" or "the web bundle" and should
never be asked to. Every user-facing surface says **what version Podium is on**, **which places
will be touched**, and **what they will notice**. Internal component identity exists to make the
machinery correct, never to make the user reason about it.

### 1.2 Authority and delivery are separate axes

- **Authority** is who decides the target version. For everything attached to a server, that is
  the server.
- **Delivery** is how the bytes arrive. It is pluggable per target: `feed` (a public release
  feed such as GitHub Releases), `bundle` (hosted by the server itself), `git` (a checkout, used
  as a local development fast path).

Separating them is what lets the common case stay cheap (most installs pull from the public
feed) while on-premise, air-gapped and development installs use the same authority, staging,
health-gating and reporting with the server serving the bytes itself.

### 1.3 The user has authority; the question is only where they answer

The server is authority over its attached components, but a human is authority over the server.
That human answers in whatever Podium UI they have open: browser, desktop webview, or mobile.
There is no separate operator surface.

### 1.4 One human decision, then automatic convergence

The user's only routine decision is "move my server". Daemons then converge automatically,
clients reload automatically. This composes with a safety property: the automatic path (daemons)
owns no database, and the component that owns the database (the server) is the one behind the
human click. The dangerous rollback case therefore never happens unattended.

### 1.5 The product version is a label, never a compatibility check

Compatibility is judged only by the wire contract. See §2.

## 2. Version model

### 2.1 Namespaces

Four independent namespaces, never conflated. The first three exist today and are documented in
`packages/protocol/src/version.ts`; the fourth arrives with a native mobile build.

| Namespace | Owner | Purpose |
|---|---|---|
| `appVersion` | root `package.json` | The product **label**. Lockstep across every artifact in a release. Never used to decide compatibility. |
| `WIRE_VERSION` + `[MIN_SUPPORTED_VERSION, WIRE_VERSION]` + `wireSchemaDigest` | `packages/protocol` | The **only** compatibility currency between peers. |
| replica schema version | the client | The client's local store shape. Untouched by this design. |
| **mobile runtime version** | the mobile build | Which native mobile shell can run a given JS bundle. Introduced only when a native build exists. Maps onto Expo's `runtimeVersion` field; that mapping is an implementation detail, not the name. |

The server's drizzle journal remains server-internal and never appears on the wire.

### 2.2 Release train

One product version per release, applied to every artifact, cut by a manual bump of root
`package.json` `"version"` on both channels. This is the existing behaviour
(`docs/update-release-swaps.md`) and it is kept.

A desktop-only fix therefore re-releases everything at version N. That is correct and wanted:
one number, one changelog, no N-by-M compatibility matrix. Lockstep's only real cost, spurious
update prompts for components that did not change, is removed by §2.3.

### 2.3 Per-artifact digests

The release manifest carries a content digest per artifact (headless bundle, desktop shell, web
bundle). Digests decide **which places a given update actually touches**, so the dialog can say
"your server only" instead of prompting everyone because a number moved. Digests are a UX input,
never a compatibility input.

### 2.4 Development identity

Development builds have no semver. Their identity is `dev+<sha>` and their compatibility
currency is `wireSchemaDigest`. Nothing in the update path may assume a parseable semver.

## 3. `GET /version` is a frozen contract

`/version` is the one endpoint by which a peer too old to speak the wire learns that it is too
old. It therefore may never break.

**Law, effective at launch:**

- Fields may be **added**, never removed, never retyped, never given new semantics.
- Every consumer treats every field as optional. **Absent is not a mismatch.**
- Unknown fields are ignored silently, never an error.
- The endpoint is plain JSON, served without wire framing, at a stable path.

`apps/web/src/features/setup/version-guard.ts` already implements this correctly and its
docstring states the reason: a client that treated a missing `wireSchemaDigest` as skew "would
reload-loop against every server predating this field", a detector that fires on healthy pairs.
This design promotes that from a local decision to a global law.

Before launch the shape may still be restructured, and this design takes that freedom to add the
target descriptor.

### 3.1 Payload

```jsonc
{
  "appVersion": "0.4.2",          // or "dev+<sha>"
  "wireVersion": 2,
  "minSupportedVersion": 2,
  "wireSchemaDigest": "…",
  "target": { /* §4 */ },          // what this server says its components should run
  "policy": { /* §8 */ }           // divergence policy this server enforces
}
```

## 4. The target descriptor

The server publishes, per component, what that component should be running and where to get it.

```jsonc
{
  "version": "0.4.2",
  "notes": { "summary": "…", "url": "https://…/CHANGELOG.md#042" },  // §10, optional
  "critical": false,               // structured, replaces the CRITICAL: prose marker
  "minRequired": { /* per surface, per platform; §8 */ },
  "artifacts": {
    "headless": { "delivery": "feed",   "url": "…", "digest": "…", "signature": "…" },
    "desktop":  { "delivery": "feed",   "url": "…", "digest": "…", "signature": "…" },
    "web":      { "digest": "…" }
  }
}
```

Delivery variants for an artifact:

- `feed`: `url` points at the public release feed. The bytes are signed with the release key and
  verified exactly as `apps/cli/src/podium-update.ts` does today.
- `bundle`: `url` points at the server's own artifact endpoint. Bytes are signed with a
  per-server key that the daemon pins at pairing time. The authenticated socket is not accepted
  as a substitute for signature verification; both apply.
- `git`: `{ repo, sha }` instead of `url`. Convergence is a fetch, checkout and restart rather
  than a download and swap. Local development fast path only (§9.2).

`critical` and `minRequired` replace the current prose marker parsed by
`apps/desktop/src-tauri/src/updater.rs::is_critical`, which couples policy to release-note text.
Prose notes stay, for humans only.

## 5. Authority and user involvement per component

| Component | Authority | User in the loop | Mechanism |
|---|---|---|---|
| Server, self-hosted or remote | the user | **Yes. This is the one click.** | Update dialog triggers convergence, server restarts |
| Server, all-in-one desktop | the user | Yes, the same click | The shell update carries the server atomically |
| Daemons | the server | No | Server-orchestrated waves (§6) |
| Web and PWA | the server | No | Service worker prompt, or forced reload on hard skew |
| Desktop shell | the user | Yes | In-app dialog drives the Tauri install (§7) |
| Mobile, web-served today | the server | No | Identical to web |
| Mobile, store build later | the user | Yes, and blocking when stale (§11) | Store deep link, plus OTA for JS-only fixes |

## 6. Daemon convergence

### 6.1 The missing primitive

A daemon today sends only `?v=<wireVersion>` on its socket. `appVersion` never leaves the
server process that owns it (`apps/server/src/server.ts`, `modules/instance/service.ts`). The
server therefore cannot see drift at all, which is why nothing above the socket can exist yet.

**Add to the daemon handshake:** `appVersion`, `wireSchemaDigest`, the delivery methods this
daemon supports, and its install kind (installed bundle versus source run). The server records
these per machine and exposes them.

### 6.2 Server-orchestrated waves

Daemons never act on a version delta by themselves. The server computes the drift set and issues
**update grants**:

1. **Canary.** One machine is granted first. Prefer a machine with no live sessions; otherwise
   any.
2. **Soak.** The wave does not widen until the canary reconnects and completes a healthy
   handshake **at the target version** and holds it for a soak window.
3. **Widen.** Remaining machines are granted in batches under a concurrency cap, with jitter, so
   a `bundle`-delivery server is not stampeded by its own fleet.

This is what makes "fully automatic" safe: without waves, one bad bundle takes the whole fleet
down simultaneously.

### 6.3 Converge to target, not upgrade if newer

`isNewer()` in `apps/cli/src/podium-update.ts` currently refuses to move backwards, which makes
rollback structurally impossible. Under authority the rule becomes **target equality**: a daemon
moves to whatever the server says, up or down.

`podium update` remains as the manual escape hatch and for unattached installs, where "newest on
the channel" stays the right default.

The existing daily timer (`scripts/systemd/podium-update-user.timer`, which runs `podium update`
and restarts the daemon on exit 10) **is** a daemon acting on a version delta by itself, which
§6.2 forbids. It is therefore **disabled for an attached daemon** and kept only for standalone
installs. Left enabled, it would race the server's wave orchestration and defeat both the canary
and the concurrency cap.

### 6.4 Health gate and rollback

After swap and restart, if the daemon does not complete a healthy handshake at the target within
a timeout, it rolls back to `.old` (the backup `podium-update.ts` already creates) and reports
`rejected` with the target it refused. A daemon owns no database, so its rollback is always safe.

### 6.5 Bounded attempts

After N failed convergences on the same target, the daemon pins to last-known-good, reports
`stuck`, and stops. This generalises `decidePostUpdate` in `apps/daemon/src/self-update.ts`,
which gives up correctly today but silently, with the server never hearing about it.

### 6.6 Work safety

A daemon restart does not lose agent work. `packages/pty/src/abduco.ts` states, verified, that
the abduco master "survives both the attach client and the daemon process (it setsids and
reparents to the user manager)", and `apps/daemon/src/reattach-gates.ts` reattaches with bounded
concurrency (6 bridges, 2 tail seeds). The promise "your sessions keep running" in §12 is a
fact, not a hope, and the acceptance tests must keep it that way.

### 6.7 Reporting

Per machine: current version, target version, and state in
`{ current, granted, downloading, restarting, rejected, stuck }`. This is what the dialog's wave
view and the machines UI read.

## 7. Server and desktop shell

### 7.1 Remote or self-hosted server

The server never updates itself. The dialog offers it, the user clicks, the server converges and
restarts. The accepted risk is a server whose owner never opens the app; it is bounded because a
stale server eventually fails its own clients' policy (§8), which is the pressure that produces
the click.

### 7.2 All-in-one desktop

The server is inside the shell, so updating the shell updates the server atomically. One click,
one restart, no ordering problem.

### 7.3 Desktop in remote mode

The desktop follows the same rule as any other client: it may not get ahead of the server it is
attached to in a way that breaks the wire contract. A newer shell against an older server is
handled explicitly (§8.2) rather than as an unrecoverable 426.

### 7.4 Tauri commands

The shell exposes `checkUpdate` and `installUpdate` on the existing frozen bridge,
`window.__PODIUM_DESKTOP__` (built in `apps/desktop/src-tauri/src/main.rs`, read by
`apps/web/src/lib/nativeDesktop.ts`). Both sides feature-detect: the page must tolerate a shell
without the commands, and the shell must never depend on the page in order to update itself.

## 8. Divergence policy

### 8.1 The wire window is unchanged

`[MIN_SUPPORTED_VERSION, WIRE_VERSION]` plus `wireSchemaDigest` remains the hard compatibility
gate, with the per-version edge adapters in `packages/protocol/src/edge/` as the mechanism that
keeps the window wide.

### 8.2 The newer-client case, currently unhandled

Only the lower bound is handled today. A client whose `WIRE_VERSION` exceeds the server's gets a
426 that no reload can fix, because it is genuinely ahead. This is reachable now: a desktop on
stable pointed at a lagging remote server.

**Add:** the client detects `WIRE_VERSION > server.wireVersion` from `/version` and presents
"your server is behind" with the server-update action, instead of reload-looping. The existing
reload loop guard (`MAX_RELOADS = 2`) stays as the backstop.

### 8.3 Bounded product lag, per surface

Product lag is a retirement lever, not a compatibility rule, and its threshold differs by orders
of magnitude across surfaces because their update latencies do.

| Surface | Ordinary lag | Hard requirement |
|---|---|---|
| Web and PWA | Forced immediately; a reload is free | Wire window |
| Desktop | Soft prompt, forced after k releases | Wire window, or `minRequired` |
| Mobile, store build | **Never auto-blocked on lag** | Wire window, or operator-declared `minRequired` per platform |

**Product-version lag never auto-blocks a store build.** The replacement may not have shipped
yet, and blocking would strand a user with no way out. Blocking on a store build fires only when
the client is outside the wire window, or when an operator has explicitly raised `minRequired`
for that platform after confirming the replacement is live in the store. The same discipline
applies to desktop.

## 9. Development

### 9.1 Server-built bundle, same path as production

The development server publishes `dev+<sha>` targets and builds the headless bundle from its own
checkout via `scripts/build-bun.ts`, serving it with `delivery: "bundle"`. Remote daemons
converge through the identical download, verify and swap path used in production.

The point is not only that it works. **Development use becomes the continuous test of the
production update mechanism**, which is otherwise exercised only at release, which is the worst
possible time to discover it is broken.

Constraints, because the development host is the live host:

- The build is **explicit or debounced**, never per-commit. It runs on demand, or on a debounced
  redeploy trigger.
- It is **lock-guarded** with `podium lock`, so two triggers cannot build concurrently.
- Signing uses the development key already in the release path
  (`scripts/.podium-update-dev.key`).

### 9.2 Git fast path for the local host

The machine running the checkout keeps the existing git-based redeploy
(`scripts/systemd/podium-redeploy.path` watching `.git/logs/HEAD`). It needs no build and no
download. It is expressed as a `git` delivery target so it shares the authority, staging and
reporting model rather than being a parallel mechanism.

### 9.3 Development is not a channel

`stable` and `edge` are channels. Development is a different **identity** with no semver.
Nothing may compare a `dev+<sha>` with a semver, and the desktop's existing rule that debug
builds never check production feeds (`production_auto_update_enabled`) is kept.

## 10. Changelog and release notes

Release notes become a first-class artifact.

- Source of truth is root `CHANGELOG.md`, already in Keep a Changelog format.
- `scripts/release.ts` extracts the section for the version being cut and publishes it into the
  target descriptor as a short `summary` plus a `url` to the full changelog.
- The dialog shows "What's new" when notes exist and omits the affordance entirely when they do
  not. It never shows an empty section.
- Notes are prose for humans. Policy lives in the structured `critical` and `minRequired` fields
  (§4), never parsed out of the prose.

## 11. Mobile

### 11.1 Today

`apps/mobile` is a mobile web export served by the server under `/mobile`, with no store build
and no over-the-air update mechanism. It inherits the web path, service worker plus version
guard, with no extra machinery. This design changes nothing about it.

### 11.2 What a store build additionally requires

Recorded now so the decisions above stay valid when it happens.

1. **A blocking update screen.** On a store binary the forced path cannot install, only stop.
   Full screen, non-dismissible, with a store deep link. This *is* the forcing mechanism.
2. **The frozen `/version` endpoint** (§3), which is the only channel by which a client too old
   to speak the wire can be told so.
3. **Over-the-air JS updates plus a mobile runtime version.** Without them a wire bump bricks
   every phone until app review clears, which is days. The runtime version is the native shell
   to JS bundle contract and is bumped only when native dependencies change, so a JS-only fix
   ships in minutes.
4. **Per-platform minimum versions.** iOS and Android reach users at different times because of
   review latency and staged rollout, so `minRequired` is keyed by platform.
5. **A permanently wide wire window.** A store release cannot be rolled back, and raising
   `MIN_SUPPORTED_VERSION` strands phones for good. The edge adapters in
   `packages/protocol/src/edge/` stop being transitional and become permanent, funded
   infrastructure. Their own docstring already calls the window "permanent architecture"; a store
   presence is what gives that teeth.
6. **No client-side rollback.** The mitigation is server-side compatibility discipline instead.

## 12. The update dialog

### 12.1 One component, several action backends

A single React component renders on web, desktop webview and mobile. Only the available actions
differ:

| Surface | Action backend |
|---|---|
| Web and PWA | Service worker takeover, or `forceReload()` on hard skew |
| Desktop | `__PODIUM_DESKTOP__.installUpdate()` |
| Server and daemons | Convergence call over tRPC |

### 12.2 States

`none`, `available`, `required` (blocking), `in-progress` (with the wave view), `failed`.

### 12.3 Copy

Written to §1.1: one Podium, one version, running in places. The body lists the places that will
be touched and what the user will notice.

> **Podium 0.4.2 is available** · *What's new →*
>
> - **This app** will restart, about 5 seconds
> - **Your server** (`ludovico`) will briefly reconnect
> - **3 machines** will not be interrupted
>
> Your sessions keep running. Everything will be where you left it.

Rules:

- Name places, not components. "Your server", not "the headless bundle".
- Say what the user will notice, per place, including when the answer is nothing.
- When no place the user is looking at needs a restart, say "no restart needed" explicitly.
- Only list places that are actually being touched, decided by the per-artifact digests of §2.3.
- Never promise more than §6.6 guarantees.

### 12.4 The native dialog is demoted, not retired

The in-app dialog is the primary surface. The native Tauri dialog stays as a **fallback**.

The reason is that the webview can be the broken thing. If the bundle fails to load, or a remote
server is unreachable, an in-app dialog cannot render and there is then no update path at all.
Worse, in remote mode the shell loads the remote server's web bundle, so the update UI is served
by the very server the user may be trying to update.

**Rule:** if the page has not claimed update ownership within N seconds of window creation, the
shell presents the native dialog itself. The shell never depends on the page in order to update
itself.

### 12.5 Existing surfaces to reconcile

- `apps/web/src/app/UpdatePrompt.tsx`, the sonner service worker toast, becomes one input to the
  new dialog rather than a separate prompt.
- `apps/web/src/features/setup/version-guard.ts` keeps its forced-reload behaviour and gains the
  newer-client case (§8.2).
- `apps/web/src/features/settings/sections/updates.tsx` gains version and fleet state alongside
  the channel selector.
- `apps/desktop/src-tauri/src/updater.rs::check_and_prompt_update` becomes the fallback path of
  §12.4.

## 13. Migrations and rollback

### 13.1 What exists

Verified in the code: migrations are **forward only** (no down blocks anywhere under
`apps/server/src/migrations`), there is **downgrade protection** (a database whose schema is
newer than the running code refuses to open with a clear error), and there are **automatic
pre-migration backups** (`migrations/backup.ts`, timestamped, last three kept, taken before any
version-advancing run). `migrations/restore.ts` exists for the reverse.

### 13.2 Down migrations are not built

A forward migration that drops a column or coalesces rows cannot be inverted; the data is gone.
A `down` that appears to work is a false comfort. The answer is expand and contract.

**Policy: releases are expand-only.** Additive migrations ship in release N; the destructive
contract step ships no earlier than N+1. Rolling back a single release then needs no down
migration at all, because the older code simply ignores columns it does not know.

**Enforcement:** an audit gate flags destructive DDL in a migration, in the style of the existing
`scripts/audit-*.ts` gates. Like every gate here, it must be proven able to fire before its pass
is believed.

### 13.3 Rollback classification

| Case | Action |
|---|---|
| Schema did not advance (the common case, given §13.2) | Swap the binary back. Safe and automatic. |
| Schema advanced | **Do not auto-restore a backup.** That silently discards every write since the upgrade. Halt, stay on the new version, report `stuck`, leave restore to a human. |
| Daemon | Always safe; a daemon owns no database. |

The documented human escape hatch stays as written in `docs/data-and-upgrades.md`.

## 14. Gap list

What has to be built, mapped to what exists.

| # | Gap | Where |
|---|---|---|
| 1 | Daemon reports `appVersion`, digest, delivery capability, install kind | daemon handshake, `packages/protocol` |
| 2 | Server records and exposes per-machine version state | `apps/server`, machines model |
| 3 | Target descriptor published on `/version` | `apps/server/src/server.ts` |
| 4 | Delivery abstraction: `feed`, `bundle`, `git` | `apps/cli/src/podium-update.ts`, daemon |
| 5 | Server-hosted bundle endpoint plus per-server signing key pinned at pairing | `apps/server` |
| 6 | Wave orchestration: canary, soak, widen, jitter, concurrency cap | `apps/server` |
| 7 | Converge-to-target replaces `isNewer` for attached daemons | `apps/cli/src/podium-update.ts` |
| 8 | Health gate plus rollback to `.old`, `rejected` reporting | daemon |
| 9 | Bounded attempts, `stuck` reporting | `apps/daemon/src/self-update.ts` |
| 10 | Newer-client detection and messaging | `apps/web/src/features/setup/version-guard.ts` |
| 11 | Per-surface lag policy and `minRequired` | `packages/protocol`, `apps/server` |
| 12 | Per-artifact digests in the release manifest | `scripts/build-bun.ts`, `scripts/release.ts` |
| 13 | Release notes extracted from `CHANGELOG.md` into the descriptor | `scripts/release.ts` |
| 14 | Structured `critical` replaces the `CRITICAL:` prose marker | `apps/desktop/src-tauri/src/updater.rs`, release manifest |
| 15 | The unified dialog component and its states | `apps/web` |
| 16 | Tauri `checkUpdate` / `installUpdate` on the bridge, plus ownership-claim fallback | `apps/desktop/src-tauri/src/main.rs`, `updater.rs` |
| 17 | Development bundle build: on demand, debounced, lock-guarded | `apps/server`, `scripts/build-bun.ts` |
| 18 | Expand-only migration audit gate | `scripts/` |
| 19 | `/version` extensibility conformance test | `packages/protocol`, `apps/web` |

## 15. Testing strategy

Per the repository testing policy, effort is matched to regression risk. This subsystem is high
risk in one specific way: **most of its failure modes are invisible until a release**, and its
gates are exactly the kind that can silently fail to fire.

- **Protocol, pure functions.** Version classification including the newer-client case; the
  per-surface lag policy; digest comparison. Table-driven.
- **`/version` extensibility conformance.** A consumer parses a payload with unknown extra
  fields, and a payload with each optional field individually absent, and treats neither as a
  mismatch. This test is the enforcement of §3.
- **Daemon convergence.** Target equality including downgrade; health gate producing rollback;
  bounded attempts producing `stuck`. Pure decision functions in the style of the existing
  `self-update.ts`, so no socket is needed.
- **Wave orchestration.** Canary first; no widening before a healthy soak; concurrency cap
  respected; a `rejected` canary halts the wave. Deterministic, with injected time. No fixed
  sleeps: a `setTimeout` before an assertion is a bug in this repository's unit lane.
- **Dialog.** State machine and copy rules, including "no restart needed" and the empty-notes
  case. vitest plus happy-dom.
- **Update path end to end.** The existing `scripts/verify-headless-update.sh` and fixture feed
  are extended to cover `bundle` delivery, not only `feed`.
- **Rollback.** A schema-unchanged rollback swaps back cleanly; a schema-advanced rollback
  refuses and reports `stuck` rather than restoring.
- **Audit gates.** Both the expand-only gate and any ratchet added here must be shown to fire on
  a planted violation before a pass is reported.
- **Desktop Rust.** Endpoint and structured-critical parsing are unit tested; the
  ownership-claim fallback is tested where feasible; full builds are verified in CI, there is no
  local cargo.

Runtime verification is required for the dialog, since it changes interaction behaviour.

## 16. Build order

Leaf first, so each step is independently verifiable.

1. **Protocol.** Target descriptor types; version classification including the newer-client
   case; the per-surface policy shape; `/version` conformance test.
2. **Server publishes.** Target descriptor on `/version`; per-artifact digests produced by the
   build.
3. **Daemon reports.** Handshake carries version, digest, delivery capability, install kind.
   Server records and exposes it. Nothing acts on it yet; this is observable value on its own.
4. **Delivery abstraction.** `feed` and `bundle` behind one interface; converge-to-target; health
   gate; rollback; bounded attempts.
5. **Wave orchestration.** Canary, soak, widen, on the server.
6. **Dialog.** Unified component, web actions first.
7. **Desktop.** Bridge commands, ownership-claim fallback, structured `critical`.
8. **Development.** Server-built bundle, debounced and lock-guarded; `git` delivery for the local
   host.
9. **Release plumbing.** Changelog extraction, per-artifact digests in the manifest,
   `minRequired` wiring.
10. **Migration gate.** Expand-only audit.

Steps 1 to 3 are useful on their own: they make fleet drift visible, which is currently
impossible.

## 17. Non-goals

- Native mobile store build, over-the-air updates and the mobile runtime version. Requirements
  are recorded in §11.2 so nothing here has to be revisited; the work is separate.
- Down migrations, explicitly rejected in §13.2.
- Changing the two-key signing split (headless Ed25519, desktop minisign).
- Changing the channel model. `stable` and `edge`, manually bumped, are kept.
- Multi-server daemons. A daemon has exactly one relay URL and therefore exactly one authority
  (`packages/runtime/src/config.ts` refuses to save a daemon config without one).

## 18. Deferred decisions

Defaults are chosen; each is a single knob to change later.

- **Soak window and wave concurrency.** Start conservative, one canary and a small batch, and
  tune from real fleet data rather than guessing now.
- **`k` for desktop forced lag.** Needs a real release cadence to set honestly.
- **Whether the server should ever nag about its own staleness beyond the dialog** (email,
  notification). Out of scope here.
