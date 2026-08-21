# Updater convergence: one update path for dev and prod

Status: DRAFT v2 (2026-08-20, POD-2462). Companion to
`2026-08-14-update-operations-design.md` (the operation/wave machinery, which this spec
keeps) and the process-model notes attached to POD-2462.

## Goal

Updating is exercised many times a day during development over the **same code path**
production users run. The only differences between `dev`, `edge`, and `stable` are the
feed URL, the signing key, and who mints new artifacts — never the mechanism. A separate,
explicit iteration mode (hot reload, updater off) is the sole sanctioned divergence.

Reference topology: source checkout + server + dev feed on one VPS (ludovico); further
VPSs and the user's Mac (desktop all-in-one) are installed consumers on channel `dev`.
To the user every machine just runs "Podium"; component names below are internal.

## 1. Channels and feeds

| Channel | Feed origin | Trust root | Who mints artifacts |
|---|---|---|---|
| `stable` | GitHub releases `latest` | baked release Ed25519 + baked minisign | CI on tag |
| `edge` | GitHub releases `edge` tag | same baked keys | CI on tag |
| `dev` | the source server's own HTTP feed | headless: instance Ed25519 key pinned at pairing; shell: the baked release minisign key (dev references edge shells, §5) | headless: ludovico, on operator approval (§6); shell: none (edge-referenced) |

`dev` becomes a *pulled* channel: the source server publishes real manifests
(`podium-update.json`, desktop `latest.json`) and all three channels resolve through
`resolveReleaseTarget`. The publisher-push path, the `dev` exclusion in
`target-refresh.ts`, and the `bundle`/`git` delivery kinds are retired. Dev versions
become orderable: `<base>.dev.<N>+<sha>` replaces `dev+<sha>`, so `isProvablyNewer`,
drift refusal, and `critical` behave identically on every channel.

AS BUILT (POD-2502, approved 2026-08-21 — this paragraph is the authority, superseding
the sketch in §8 disposition 23 and §8c decision 13): the base and counter are
**publisher-owned monotonic state** in the server state dir, never derived per-build from
the checkout. The gate asks one question — does the version about to be handed out clear
the PREVIOUS MINT? — rather than comparing bases, which is what let a stable cut mint
backwards. After a bare `X.Y.Z` base the publisher mints on the next patch
(`X.Y.(Z+1)-dev.N+<sha>`), so it sorts above the release it builds on, above every
`X.Y.Z-edge.N.dev.M`, and below `X.Y.(Z+1)-edge.1` — rejoining the edge train instead of
minting `X.Y.(Z+1)-dev.N` forever. Ordering therefore holds across the edge train, across
a stable cut, and across branch hops to an older base. Normalisation happens where the
value ENTERS; on read the stored base is only validated for orderability, never re-bumped
(re-bumping on read made an unchanged checkout climb 0.1.2 → 0.1.5 over four mints).

## 2. Component update matrix

| Component | Delivered by | Update mechanism (all channels) |
|---|---|---|
| Parent, server (with janitor worker), daemon | `podium-headless-*.tar.gz` | fleet grant → download → verify → atomic dir swap → parent restart (§3) |
| Web UI (browser and desktop webview) | `web/` inside the headless bundle, served by the server | swaps with the bundle; page detects skew (build stamp + wire digest) and reloads via the existing UpdatesEngine |
| Mobile web (`/mobile`) | `mobile/` inside the bundle | same — a second served dist |
| Desktop shell (Tauri frame) | `latest.json` + `.app.tar.gz` / AppImage | whole-app swap via Tauri updater; the manifest decides when (§5) |
| Expo native app | app stores / dev client | outside this system |

### 2.1 Desktop web served by the connected server

The webview loads the UI from the server it is connected to (local sidecar or remote
VPS) instead of the dist baked into the .app. One web-update mechanism everywhere; the
UI always matches the server it talks to; the shell becomes a pure frame.

**Durability requirement:** Podium is offline-first — clients hold a replica
(IndexedDB / SQLite). An offline client has data, so the offline UI must run the FULL
app against the local replica; a reconnect screen is not sufficient. (Linear's browser
answer: SW-cached assets + IndexedDB, eviction accepted as a "be online once" repair,
`/refresh` as the hatch. Acceptable for browsers; our shell can do better.)

**Durability model (deliberately modest for now):**

1. **Live server** — source of truth; serving live whenever reachable.
2. **Service-worker cache** — the offline layer, best-effort. Evictable (the webview
   engine owns eviction; nothing is contractual; `persist()` helps). Keyed by origin
   (scheme+host+port) — server-origin stability is part of the contract. WKWebView SW
   support is **degraded** (see verification below); the design tolerates that. In
   browsers this is all there is — same accepted risk as Linear (`/refresh`-style
   repair, "be online once" recovery).
3. **Baked dist in the .app** — last resort, potentially stale. Guarded: if it is too
   old for the local replica, show a clear "connect once to update Podium" error
   instead of running stale code against newer local data. The ordinary skew machinery
   cannot answer this — it grades the page against a REACHABLE server's `/version`, and
   this is the case where nothing answers. So the comparison is against a LOCAL record:
   the shell persists the build identity (`wireVersion`, `minSupportedVersion`,
   `wireSchemaDigest`, `appVersion`) of the local server it last actually read, and
   injects it into local documents as `__PODIUM_LOCAL_BUILD__`
   (`bootstrap::local_build_injection_script`). `SetupGate` grades this build against it
   on the unreachable path only, and blocks on `client-too-old` — this build is below
   the recorded wire version, or below the minimum that build supported. A digest
   difference at the SAME wire version deliberately does not block: wire-compatible
   builds decode each other's rows, dev builds differ by digest constantly, and the
   existing skew notice already speaks to that case. Residual: the stamp a page holds
   is fixed at window creation (an initialization script cannot be rewritten), so a
   server updated in place mid-session leaves the open window's copy one build behind;
   the watchdog refreshes the PERSISTED stamp every ~30s so the next boot is accurate.

**Boot order (shell):** reachable connected server → load its http(s) origin; else
baked `frontendDist` (tauri scheme) with reconnect injection. SW cache is not a
separate shell URL choice — when present it answers inside the served origin.

**Stable local origin contract:** all-in-one / local-server webviews load
`http://127.0.0.1:<port>/`, where `<port>` is `PODIUM_PORT` → `config.port` →
`defaultInstancePorts(PODIUM_INSTANCE).server` (`18787` for the `default` instance;
a hashed triplet in `20000..43999` for a named one). That is the full `resolvePort`
precedence from `@podium/runtime`, and the shell mirrors it — including the FNV-1a
per-instance derivation — in `bootstrap::resolve_local_port`, pinned against the
TypeScript values by a unit test. The origin must not change across ordinary
restarts: SW cache identity, cookies, and IndexedDB are all origin-keyed. Ephemeral
`pick_free_port()` is retired for this path. A second desktop shell on the same box
must therefore differ in `PODIUM_INSTANCE`, `PODIUM_PORT`, or `config.port` — two
shells sharing an origin is not merely untidy, because the shell grants its served
origin window controls, the opener, `sql:default` + `sql:allow-execute` and the
update bridge (see `docs/multi-instance.md`). Prefer `127.0.0.1` over `localhost`
(distinct origins).

**The origin has to identify itself.** The port is fixed and unprivileged, so
"something accepted a TCP connection there" is not evidence that it is ours. The
shell loads the served origin only after `/version` answers with a Podium payload
(`wireVersion` + `wireSchemaDigest`) carrying THIS instance's `instanceId`;
otherwise it falls back to the baked dist. Liveness polling afterwards uses the
cheap `/health`, but every decision to LOAD the origin — boot, and the return from a
fallback — re-runs the identity probe.

**Server-down while running:** the boot probe answers "was the sidecar up when we
opened the window", which is not the same question as "is it up now". A local window
therefore keeps watching (`spawn_local_document_watchdog`): after ~6s of consecutive
failures it navigates to the baked dist (reconnect UX, `__PODIUM_SERVER__` pinned to
the loopback ws), and once the server answers the identity probe again it navigates
back — the served UI is the one that matches the server. It only ever moves the
window between those two documents, and stops as soon as a runtime transfer has
retargeted the window to a remote origin.

**Verification (POD-2510, 2026-08-21) — IPC / SW / CSP for served origins**

There is no Mac in the fleet this run (offline 10+ days), so nothing below is
macOS-observed. The platform of each observation is named; where the answer is
inference, the verdict says so.

| Concern | Finding | Consequence |
|---|---|---|
| IPC from served http(s) — **WebKitGTK (Linux): observed** | Tauri v2 grants it via `CapabilityBuilder::remote(urlPattern)` (v1's `dangerousRemoteDomainIpcAccess` equivalent). POD-1782 evidence: on **Linux native Tauri WebView under isolated Xvfb — WebKitGTK, not WKWebView** — after retarget to a remote http origin, `toggleMaximize` / `startDragging` / `internalToggleMaximize` invoked successfully (`apps/desktop/src-tauri/tests/evidence/pod-1782-native-runtime.json`, field `platform`). | Served-local all-in-one uses the same grant pattern for `http://127.0.0.1:<port>/*`. |
| IPC from served http(s) — **WKWebView (macOS): expected to work, UNVERIFIED** | The grant mechanism is engine-independent (Tauri's capability layer, not a webview API), and macOS client/daemon shells have loaded a remote http(s) origin as the page since `6352c24e4` (2026-06-30) — a fix made *because* WKWebView failed the cross-origin alternative (WebSocket close 1006 from `tauri://localhost`). That commit sources macOS *page loading* from a served origin; it does not by itself record an IPC invocation from one. No macOS run was performed for this issue. | Proceed with server-served UI; no auto-sync-tauri-scheme fallback issue needed. If WKWebView IPC did fail from `http://127.0.0.1`, the all-in-one Mac would lose window controls and the SQL replica — worth 10 minutes on the first Mac that comes back online. |
| Service workers in WKWebView — **desk research, not a run** | Apple/WebKit state the SW API is available in Safari, SFSafariViewController, and home-screen web apps — not general third-party WKWebView ([WebKit, "Workers at Your Service"](https://webkit.org/blog/8090/workers-at-your-service/), 2017 + post update). Nothing was measured here. Secure-context rules still apply where SW exists (`https` or loopback). | Treat layer 2 as absent on macOS until measured; the design already tolerates that — macOS desktop relies on live server + baked fallback. |
| CSP — **read from config** | App `tauri.conf.json` sets `"csp": null` (no Tauri-injected asset CSP). A served page is governed by the **server's** CSP/CORS headers, identical to a browser tab. Remote-mode shells already depend on this. | No extra shell CSP work for served-local; keep server headers correct. |

DEFERRED: a shell-managed durable dist copy in Application Support (engine-evict-proof
offline boot). Adopt only if the layer-3 error is actually seen in practice.

### 2.2 Desktop component matrix (explicit)

Three desktop-related components, three install types, all channels. The payload
("podium bundle": the server/daemon/janitor binary + web/mobile dists) moves OUT of the
.app into Application Support: seeded from the .app on first run, then updated by
normal fleet grants. Why, honestly: DEV cannot rebuild the shell per release (a Tauri
build + signing per accepted commit is the burden this spec removes), so dev must
decouple payload from shell — and prod then adopts the same mechanism because running
two different desktop update mechanisms would rebuild the dev/prod divergence this
spec exists to eliminate, in the most safety-critical spot. The PRIMARY reason is one
mechanism across channels; the prod-side gains (fleet safety machinery finally
reaching Macs, coordinated rollouts, small fast updates, no notarization round-trip
on hotfixes) are what make prod's adoption a net win on its own terms rather than a
sacrifice for dev. Corollary: shells are minted only on shell-input change (§5); a
headless-only release then updates the Mac's server/daemon via grants like any VPS. The historical
"copied-out binary is damaged" failure was quarantine propagation from `fs::copy` out
of the quarantined .app; grant-delivered payloads are downloaded by the app itself and
never carry quarantine. The one-time seed copy must strip the quarantine attribute →
verification item. Consequence: the supervised-daemon exclusion (`wave.ts:91`) and the
required `DESKTOP_INSTALL_ASK` retire — the Mac becomes an ordinary fleet machine.

| Component | all-in-one | daemon-only (remote server) | UI-only |
|---|---|---|---|
| Shell (frame) | Tauri whole-.app swap when the channel manifest names a newer shell (stable/edge: minted on shell-input change; dev: references current edge shell) | same | same |
| Podium bundle (outside .app) | updated by its OWN local server's update operation — the Mac is an installed host like any VPS | daemon updated via grants from the remote server, like any VPS daemon | none installed |
| Running web UI | served by the local server → always matches the local bundle | served by the remote server → matches it; reload-on-skew | same as daemon-only |

Staleness: the bundle can never go stale (fleet cadence everywhere); the shell may
trail by design (frame only, §5); the web UI matches its serving server by
construction, with the baked dist only as the §2.1 offline fallback.

**Shell-release behavior:** a new shell rides the existing Tauri mechanism unchanged
(dialog → verify → whole-.app swap → restart; drift guard, `critical`, restart-failed
reporting all apply). Two rules, no new mechanism: (a) SEEDING — at shell boot,
before the parent starts: **seed iff the payload directory is absent.** One filesystem
check, no health judgment. Broken payloads have owners elsewhere: a bad update →
parent crash-loop detection → `.old` rollback (§4); corruption beyond that → the
EXPLICIT repair action (settings button / CLI) that re-downloads the current payload
from the feed via the ordinary grant machinery — always repairing to current, never
to the seed's age; payload so broken it cannot serve the UI → the shell (independent
of the payload) shows a minimal error page carrying that repair button. Stale seeds
are therefore harmless, which is what makes mint-on-change safe on every channel: the
payload self-updates regardless of shell age.

Who updates the all-in-one Mac ("which fleet"): its own embedded server — every
server carries the update engine, and the all-in-one is a coordinator of a fleet of
one, exactly like a single-VPS install today. It pulls the channel feed itself
(GitHub for edge/stable, the source server for dev), resolves the target, and runs
the standard operation on its own machine. Daemon-only Macs receive grants from the
remote server they are paired to, which pulled the same feed. (b) A shell that requires a newer payload
(bridge-contract change) expresses it via the manifest's minimum-version lever; shell
and payload releases are otherwise independent. Dev exercises the shell swap at
edge-shell cadence automatically (dev's `latest.json` references the current edge
shell, so each edge shell release rolls every dev machine through the real swap on the
identical CI-signed bits), plus on demand via the local fixture feed.

**Shell version rule (coordinates with POD-2451):** the shell's version is the version
of the shell artifact itself — `CARGO_PKG_VERSION` baked at build, reported over the
bridge. On the dev channel it therefore shows its edge version (e.g. `0.1.0-edge.20`):
that is what it IS; there is no dev shell version. Deriving a shell version from the
headless VERSION, the channel target, or any second source is a bug. Single-sourcing
of the build-time stamp is POD-2451's scope.

### 2.2b Per-component version display (requirement)

The settings UI's per-component versions must stay accurate under this redesign, which
makes them genuinely diverge: the shell carries an edge version while headless runs a
dev version (§5); the web UI's build may trail or lead the page's server during an
update; the janitor stops having its own process (its version IS the server's); machine
daemons version per-machine. Each displayed version must come from the running artifact
itself (shell: Tauri getVersion; server/daemon: their build version over the wire; web:
its build stamp), never inferred from the channel's target or from a sibling component.
The exact surfaces and data sources are inventoried in the coverage audit attached to
POD-2462.

Display rule: when every component reports the same version (the normal edge/stable
case), settings shows ONE line — "Podium <version>". The per-component breakdown
appears only on divergence, and marks each divergent row as expected (shell trailing on
dev; web page mid-rollout) or unexpected (a machine stuck behind its target).

## 3. Process/supervision target

- **Two supervised children, not three.** The thin `podium` parent (same binary) spawns
  the **server** and the **daemon** as separate OS processes. The **janitor runs inside
  the server process as a worker** (worker thread or in-process loop — implementation
  detail): it is firmly part of the server, needs no independent process isolation for
  now, and its 30-second housekeeping tick must not block the server's event loop —
  a worker thread satisfies both (≈3 MB measured). Its lease handshake with the server
  is unchanged; it simply loses the separate PID and unit.
- **One external supervisor per platform** keeps the parent alive: a single
  `podium.service` user unit on Linux; the Tauri shell on macOS.
- **Update = self-handover, one mechanism everywhere (DECIDED 2026-08-21)**: verify +
  atomic swap on disk → the OLD parent spawns the NEW-version parent (via the install
  path) → waits for it to report healthy (children up, serving the new version) → only
  then exits. No mixed versions persist; the old version never exits into the void.
  Supervisors are demoted to CRASH-AND-BOOT safety nets only: systemd restarts the
  current parent if it crashes and starts it at boot (plus watchdog); the Tauri shell
  does the same on macOS, following the successor PID the parent reports. Under
  systemd the handover re-declares the unit's main PID (`sd_notify MAINPID=`,
  `Type=notify`, nginx-reload pattern) so the unit stays active across it. This
  generalizes the existing, exercised `--takeover` pattern; the same path runs on
  systemd VPSs, detached VPSs, the source host, and the Mac — so daily dev releases
  exercise the identical restart a rare detached install depends on. Retires
  `installed-restart.ts`'s systemd/detached split, `source-redeploy.ts`, and — except
  for hand-started foreground runs, where the refusal remains — the "no restart
  capability" state. Children still come up in priority order (server first, then
  daemon); agents survive under abduco; update-operation progress lives in the DB and
  resumes after handover.

## 4. Migration from the 3-unit topology — without losing failed-update protection

Existing installs run three role units (dev hosts: 8 definitions). The updater has no
unit-topology step today; units are written at install/setup time. The seam to build on:
`apps/cli/src/role-reconcile.ts` (renders/writes/enables/disables role units at runtime)
plus `cli-systemd.ts` removal + `daemon-reload` helpers.

**Supervision reconciliation at first boot of each new version**, health-gated so the
handover can never strand a machine:

1. The old updater swaps the bundle and restarts the legacy units (old mechanism, final
   use).
2. The new version boots under a legacy unit, detects the legacy topology, writes and
   enables `podium.service`, and starts the parent.
3. **Only after the parent reports healthy** — children up, server answering `/health` —
   are the legacy units stopped, disabled, and removed (`daemon-reload`). Until that
   moment the legacy topology stays fully armed: if the new parent never becomes
   healthy, the machine is exactly where the old protection left it — three
   `Restart=always` units running the swapped (or rolled-back) bundle.
4. Reconciliation is idempotent and runs every boot: version-skipping installs and dev
   hosts (shedding redeploy/health/backend/system-daemon units) converge identically,
   and future topology changes reuse the hook.

**Failure containment after migration** (replacing what 3× `Restart=always` provided):

- systemd restarts the parent on crash (`Restart=always` + start-rate limiting).
- The parent restarts crashed children with backoff. A child that fails repeatedly right
  after an update triggers the parent's **rollback**: restore the `.old` bundle
  (the atomic-swap sibling that already exists), restart children on it, and report the
  update `stuck`/`rejected` through the existing grant-status channel. Today's per-unit
  protection cannot do that — it only thrashes; the parent upgrade is a net gain, but
  only because rollback is specified here as a requirement, not an option.
- The daemon child keeps its own first-person refusals (schema regression etc.) —
  unchanged.

## 5. When does the shell update? (stable AND dev — same mechanism)

The **desktop manifest decides**. `latest.json` carries the shell artifact's own
version; the Tauri updater installs only when that version is provably newer than the
installed shell. Therefore:

- A release whose shell is unchanged publishes a `latest.json` still pointing at the
  existing shell artifact/version → every installed shell sees "not newer" → no shell
  update. Headless updates flow regardless (the strict same-version pair rule relaxes to
  a compatibility window enforced by the existing wire-version handshake).
- A release with a new shell publishes a bumped shell version → shells offer/install it.

Channels differ only in **who mints a new shell version**:

- `stable`/`edge`: CI bumps the shell version when shell inputs changed (hash of
  `apps/desktop/src-tauri` + Tauri config + staged-resource layout — exact input set to
  be defined), instead of unconditionally every release.
- `dev`: **no shell is minted at all.** The dev `latest.json` references the current
  EDGE shell by its GitHub asset URL. Dev machines install the edge-built, CI-signed,
  notarized shell verified with the baked release key — fully production bits; every
  edge release exercises the real desktop swap on the dev channel. The drift (shell =
  last edge) is acceptable because the desktop web UI comes from the connected server
  (§2.1); the shell is only the frame, covered by the wire-compatibility window.
  Consequences: no instance minisign key, no per-developer shell storage or retention,
  nothing extra between developers — GitHub's edge release (reference-pruned, §above)
  is the single shell store. Working ON the shell uses the existing local fixture-feed
  machinery (`serve-update-feed.ts`, `verify-update.sh`) and ships via a normal edge
  release. Required change: an edge-built shell must accept channel `dev` from
  persisted config with a configurable feed endpoint (the source server's
  `latest.json`).

Same consumer logic, same manifest shape, different mint policy — which is a cadence
difference, not a mechanism difference.

**Asset retention rule (required for edge and any CI-built dev shell):** rolling
channels prune old assets today by version. That breaks a manifest that points at the
previous shell. New rule on every channel: **prune assets not referenced by the current
manifests** (`podium-update.json` + `latest.json`). The referenced shell artifact
survives any number of headless-only releases; everything unreferenced is pruned as
before.

## 6. The dev release flow (release button, build preparation, handoff)

Owner: the server's updates module on the source host grows one **pre-release stage**;
everything after "manifests published" is the unchanged shared path.

1. **Proposal.** The source server already watches its checkout; on a new commit on the
   release branch it publishes a *release proposal* fact (version it would become,
   commits since last release) — no building. The web UI's existing updates surface
   renders it: "Commit X landed — release to dev?". The popup is
   therefore ordinary frontend state fed by the server, appearing wherever the update
   dialog appears today; no new channel of control.
2. **Approve.** An admin accepts. Approval consents to BUILD + PUBLISH only (the dev
   counterpart of CI reacting to a tag). The ROLLOUT is then consented exactly as on
   every channel: the published release surfaces as the normal update offer in the UI
   and a user clicks it (grilling Q11 — two prompts on dev, so the full offer
   mechanism is exercised prod-identically; updates are never silent on any channel).
3. **Build.** The server runs the packaged build: `package:headless` for fleet
   platforms, signs with the instance key, writes `podium-update.json`. Clean-tree and
   identity gates from the current dev-bundle builder carry over. Failures surface in
   the same UI as a failed proposal, with logs; nothing was granted yet, so there is
   nothing to roll back.

   *What this is:* the EXISTING dev-bundle publisher, repurposed — same module inside
   the server process on source hosts (config-gated on a checkout), same build-scope
   fencing (batch-tier transient scope: CPU quota so builds cannot starve the live
   server; deterministic name = build mutex), no separate daemon, no extra unit,
   nothing alive between releases. Three behavioral changes only: (a) it emits
   standard feed manifests that the normal resolver PULLS, instead of pushing special
   dev targets; (b) it runs on explicit operator approval, not automatically per
   commit; (c) it stamps orderable versions. Scope: headless bundle + web/mobile dists
   + manifests — shells are never minted here (§5). It is the dev channel's
   counterpart of CI runners for edge/stable, equally outside the update path, which
   begins at "manifests published".

   **Shell leg: none.** Dev never builds shells; `latest.json` is regenerated to
   reference the current edge shell (§5). A dev release is therefore never blocked on
   a darwin builder.
4. **Handoff.** Publishing the manifests into the feed *is* the handoff: the server
   nudges its own target refresh, `resolveReleaseTarget` sees the new pair, and the
   standard operation (prepare → machines → server → web) runs to completion under the
   consent from step 2. From this point dev is indistinguishable from a stable rollout.

## 7. Iteration mode (the sanctioned divergence)

`bun run iterate` (name TBD) on the VPS: Vite dev server for the web UI next to the
backend, hot reload, updater fully off. The Mac attaches via browser or a debug Tauri
shell pointing at the Vite URL; debug shells keep the existing updater refusal — that
refusal *defines* iteration mode instead of leaking into every dev build.

## 8. Audit dispositions (gap numbers from `pod-2462-coverage-audit.md`)

Resolved into the spec:

- **Trust per channel, not per delivery kind** (1, 2): `resolveReleaseTarget` gains a
  per-channel feed origin + trust root; `dev` → source-server URL + pairing-pinned key,
  `edge`/`stable` → GitHub + baked key. The non-feed-delivery rejection stays.
- **Dev feed stays machine-authenticated** (3): the resolver fetches dev manifests and
  artifacts with machine credentials; release channels remain public. Streaming,
  digest re-derivation, and key-fingerprint checks carry over verbatim (18).
- **Rollback substrate** (4): the swap RETAINS `.old` until the parent declares the new
  version healthy; only then is it pruned. This is a change to both swap sites, and it
  is what makes §4's rollback real.
- **Git delivery retirement is intentional** (5): exactly one machine runs from source —
  the publisher — and it is not a fleet consumer; the dirty-checkout acceptance drive
  is deleted deliberately. (Needs operator confirmation.)
- **`machine-cannot-restart` survives** (6) for unsupervised shapes (foreground runs,
  Windows until it has a supervisor story) — retired only where a parent exists.
- **Server-only self-swap moves into the parent** (11): the parent performs
  schema-gate-before-fetch, verified fetch, swap, and the post-swap `VERSION` re-read
  (the rolling-feed fence) for every shape, daemonless included.
- **Drift guard re-sourced** (12): the page passes the *desktop manifest's* shell
  version as `expectedVersion`, never the headless target. Channel plumbing (13): the
  shell accepts `dev` + a feed endpoint via persisted config written by the page
  (`setUpdateChannel` gains an endpoint argument); the web bridge type widens.
- **426 loop** (15): parent-managed daemons never self-update — the parent owns the
  bundle; `podium update` remains the standalone-CLI path only.
- **Double-approve refuses** (16): the in-flight/debounce refusal semantics of
  `decideDevBuild` carry into the approval endpoint; the scope mutex stays the backstop.
- **Withdrawal and queued targets keep their producer** (19, 20): on the source host
  the publisher and updater share a process, so withdrawal and `nextTargets` remain
  internal events exactly as today; pulling replaces only how OTHER machines' servers
  learn of targets.
- **Operation steps redefined** (21): `prepare` = resolve + preflight (artifacts
  reachable, schema declarations present); `web` = verify page rollout after restart.
  The dist becomes current at swap/restart, which restates dev-web-build's
  blast-radius rule (22): the dist still only ever moves on operator-approved update.
- **Retention** (17): local publisher retention keeps the last N releases by manifest
  reference (same rule as §5), replacing the `dev+<sha>` sweep pattern together with
  the version rename.
- **Version ordering** (23): dev versions are the last release's version with an
  APPENDED prerelease segment plus the commit as semver build metadata — e.g.
  `0.1.0-edge.20.dev.5+656f49b` — which sorts above the release it builds on and below
  the next edge cut (build metadata is ignored for ordering but keeps the commit
  visible and greppable). Dev versions exist ONLY for publisher-minted headless
  bundles; shells never carry one (§2.2), and edge/stable names are unchanged. UI may
  display the short form "dev.5 (656f49b)". Schema declarations ship in every dev
  manifest (the publisher reads them from the checkout, as `release.ts` does).
- **Health gate probe** (24): "healthy" = both children running, server serving
  `/version` with the NEW version, daemon connected — not the bare `/health` listener
  check. Port/lock contention during handover folds into the §9 choreography item.

Need operator decisions:

- **Component failure policy** (generalizes 7–9; DECIDED 2026-08-20): two failure
  classes. (a) CRASH: the parent restarts the component with backoff; a persistent
  crash-loop right after an update triggers the §4 rollback. (b) REFUSAL — the
  component itself declines to run (e.g. the janitor's schema check): no restart loop;
  the component stays stopped, the parent/server reports a DEGRADED state
  (`/version` + settings), and the refusal is retried after the next successful
  update. Degraded never bubbles to systemd as "unhealthy" — a serving server beats a
  suicide over a stopped janitor; the systemd watchdog covers only "parent wedged",
  and its petting incorporates component-advance signals so a wedged worker is
  visible (9). The janitor's schema check ("does the DB carry migrations my code does
  not know?") stays as a guard, though the parent's all-at-once restart shrinks the
  window that creates it today (unit restart races leaving an old janitor beside a
  migrated DB); `reviveCompatibilityBlockedJanitor` (8) is subsumed by the
  retry-after-update rule.
- **Settings UI redesign** (display breaks 1–2): per-component versions become
  ALWAYS-VISIBLE rows with an expected/unexpected skew marking (shell trailing on dev
  = normal, not a fault); the "Web app" row is replaced by a "UI source" row (live
  server / offline cache / built-in fallback + build stamp); `launchMode` over the
  bridge is authoritative for surface classification — the page never re-derives it
  from its own origin, and the legacy origin heuristic runs only for a shell too old
  to report `launchMode` at all. The shell computes it by comparing
  `window.location.origin` against the served-local origin IT chose, so a served-local
  all-in-one page reports `all-in-one` while a page a runtime transfer moved to a
  remote server reports `daemon` (POD-2510; `LOCAL_LAUNCH_MODE_EXPRESSION` in
  `main.rs`, evaluated by `tauri-conf.test.ts`).

### 8a. Full update matrix (components × running modes × channels)

Channel differences are ONLY: feed origin + trust root (§1), artifact mint policy
(§5/§6), and dev's approval popup (§6). Mechanisms below are channel-identical unless
noted. Platforms: linux-x64, linux-arm64, darwin-arm64, darwin-x64 (Intel Mac desktop
added 2026-08; headless bundles ship for all four, cross-compiled per §8b).

| Component \ mode | VPS systemd | VPS detached (no systemd) | Source host (ludovico) | macOS all-in-one | macOS daemon-only | Desktop UI-only | Linux desktop (AppImage) | Windows | Browser / phone |
|---|---|---|---|---|---|---|---|---|---|
| Shell (Tauri frame) | — | — | — | .app swap when channel manifest names newer shell (edge/stable: mint-on-change; dev: references edge). Drift guard re-sourced. ✓ | same ✓ | same ✓ | AppImage swap, same manifest logic ✓ | no desktop build exists → n/a | — |
| Payload (parent + server + daemon, janitor as worker) | grants from own server → swap → parent exits → systemd restarts ✓ | **FLAG 1** — no external supervisor; needs explicit choreography (see below) | **FLAG 2** — what does the source host RUN? (see below) | fleet-of-one: own server pulls channel feed → swap → parent exit → shell restarts ✓; seed iff absent ✓ | grants from paired remote server, like any VPS daemon ✓ | no payload ✓ | same as macOS modes; Linux already copies the payload out of the AppImage today, so seeding is the existing mechanism ✓ | headless not published for Windows; out of scope (open item) | — |
| Web UI (running page) | n/a (serves it) | n/a | n/a | served by local server → always matches ✓ | served by remote server; skew reload ✓ | same ✓ | same as macOS ✓ | n/a | SW-cached, reload on skew; eviction = "be online once" (Linear risk, accepted) ✓ |
| Mobile web (`/mobile`) | ships in bundle, served by server — updates with payload, every mode ✓ | | | | | | | | phone browser = Browser column ✓ |
| CLI (`podium` shim + binary) | part of the payload bundle ✓; standalone `podium update` remains for manual/unsupervised use ✓ | | | | | | | | — |

**FLAG 1 — RESOLVED by making the detached-style handover THE universal mechanism
(§3, decided 2026-08-21).** There are no longer two restart mechanisms: every update
on every mode is old-parent-spawns-new-parent-waits-healthy-exits; systemd/the shell
are crash-and-boot safety only. Detached mode is therefore not a special case — it is
the same path minus the crash net. The `machine-cannot-restart` refusal remains only
for hand-started foreground runs.

**FLAG 2 — the source host itself. DECIDED 2026-08-21 (operator): option (a).** The
source host is ALSO an installed consumer of its own dev feed. The checkout is where
agents work and what releases are BUILT from; what RUNS is the installed bundle,
updated through the identical publish → resolve → swap → restart path as every other
machine. Zero machines are exempt from the update path. (Status quo being replaced:
ludovico's live server/daemon currently execute the checkout's working tree directly
via `bun --conditions=@podium/source` — verified 2026-08-21.) Transition note: the
first cutover is a one-time supervised switch (install bundle, migrate units per §4,
stop the source-run services); the existing cutover-lab experiments on ludovico are
the natural proving ground.

### 8b. Darwin headless production (cross-compiled, no Mac in the loop)

The headless bundle for macOS is CROSS-COMPILED from Linux, identically in prod (the
existing Linux release job) and dev (ludovico): Bun supports
`--target=bun-darwin-arm64` / `bun-darwin-x64`; the native-build reason today is only
the embedded abduco helper, which becomes a prebuilt per-platform binary (tiny,
stable C program, built rarely and cached — producible from Linux via `zig cc`
cross-compilation); Apple Silicon's signature requirement is met with an ad-hoc
signature applied from Linux via `rcodesign`. Consequences: darwin-arm64 AND
darwin-x64 headless tarballs ship in every release next to the Linux bundles; Mac CI runs
ONLY when a shell is minted; ludovico produces darwin payloads for the dev fleet with
the same code path. DECISIVE SPIKE (top priority): a Bun cross-compiled,
rcodesign-ad-hoc-signed darwin binary must run on macOS and spawn abduco correctly —
the fallback if it fails is a Mac CI leg per release and stale dev Mac payloads, which
this design otherwise avoids.

**Spike status (POD-2501, 2026-08-21): GO.** The whole darwin-arm64 headless
payload was cross-compiled on Linux (Bun `--target=bun-darwin-arm64` + a `zig cc`
prebuilt abduco + an `rcodesign` ad-hoc signature carrying Bun's JIT entitlements),
and that payload was then **executed and passed on an Apple Silicon macOS 15 CI
runner** — GitHub Actions run `32433063958`, job `verify-macos`, host
`Darwin 24.6.0 … RELEASE_ARM64_VMAPPLE arm64`, a GitHub-hosted VM on a blacksmith
runner. Transcript:
`docs/internal/superpowers/spikes/2026-08-21-mac-verify-round2.log` (round 1:
`…-round1.log`). On that run: `--version` printed `podium spike-darwin+0.1.1-edge.1`;
`all-in-one` booted server + janitor + daemon against a throwaway `PODIUM_STATE_DIR`
(so `bun:sqlite` in a cross-built binary works); the embedded abduco materialized to
`state/bin/abduco` and ran; an abduco session was created and survived the
all-in-one being killed. **No Mac is needed to build Darwin headless payloads.**

What the macOS run does NOT establish, and who closes it:

- **darwin-x64 execution.** The x64 payload cross-builds and asserts on Linux, but
  has never been run on an Intel Mac or under Rosetta. POD-2520 carries an
  `macos-15-intel` leg.
- **A real end-user Mac.** The run was a CI VM, not fleet hardware and not a
  user's laptop. Two consequences follow from that and are open: whether Gatekeeper
  blocks a quarantined copy (on the CI VM it did not, so "Gatekeeper cleared" is
  *not* claimed), and whether AMFI enforces the arm64 signature requirement the way
  a normal Mac does.
- **`codesign --verify`.** The CI run only ran `codesign -dv`, which displays a
  signature without validating the seal. That an rcodesign signature satisfies
  Apple's own verifier is therefore still unproven; the verifier script now runs
  `codesign --verify --strict`.
- **The discovery-worker entrypoint** is compiled in as a second entrypoint but was
  never executed, and abduco was invoked directly rather than through a podium
  agent session — materialization is proven, the daemon→abduco→session path is not.
- **The spike `headless/` is not the production layout** (no `systemd/`, no
  NOTICE/LICENSE, stub web/mobile `index.html`). POD-2504 must not assume the full
  bundle layout was exercised; the Mac boot logged "Served web bundle has no valid
  build stamp" for exactly that reason.

**What `rcodesign` actually contributes: the entitlements, not the signature.**
`bun build --compile --target=bun-darwin-*` already emits an ad-hoc signed Mach-O —
verified on the Linux box: `CodeSignatureFlags(ADHOC | LINKER_SIGNED)`, identifier
`a.out`. The `rcodesign sign` pass replaces that with `ADHOC`, identifier `podium`,
plus the five Bun JIT entitlement keys. So an earlier reading of the CI log —
"unsigned ran anyway, AMFI anomaly" — was wrong: that binary was never unsigned, and
nothing in the run showed AMFI to be lenient. If the release job ever drops
`rcodesign`, what breaks is JIT, not code signing. A genuine unsigned probe needs the
signature stripped on purpose (`scripts/spike/macho-strip-signature.py`), which the
Mac verifier now does.

The Linux-side assertions run against the binary **inside the shipped tarball**
(`scripts/spike/linux-assert-darwin-spike.sh`), and
`scripts/spike/prove-assert-can-fail.sh` demonstrates all ten of their failure modes
going red — a hello-world binary, a Linux ELF, a build with the Linux abduco
embedded, a stripped signature, a flipped sealed byte, empty entitlements, Bun's raw
linker-signed output, a deleted input, the wrong tarball layout, and a missing file.

| Step | Result |
|---|---|
| Prebuilt abduco via `zig cc` (darwin-arm64 + darwin-x64) | GO — Mach-O, not host ELF; `rcodesign` ADHOC |
| `bun build --compile --target=bun-darwin-arm64` embedding that abduco | GO — spike `scripts/spike/build-bun-darwin.ts`; the darwin abduco is present verbatim in the shipped binary and no ELF header is |
| Ad-hoc sign from Linux with Bun JIT entitlements | GO — `rcodesign sign --binary-identifier podium --entitlements-xml-file scripts/spike/bun-jit.entitlements.plist`; adds the entitlements on top of Bun's own linker signature |
| Updater tarball layout (`headless/` root) | GO — matches `update-install.ts` |
| macOS arm64: `--version`, all-in-one boot, abduco materialize + session survives | **GO — executed on Apple Silicon macOS 15 CI runner, Actions run 32433063958** |
| macOS arm64 on real user hardware: Gatekeeper w/ quarantine, AMFI signature enforcement, `codesign --verify` | NOT PROVEN — POD-2520 |
| macOS x64 execution | NOT PROVEN — POD-2520 `macos-15-intel` leg |

Re-running the execution proof: `.github/workflows/darwin-mac-execution-proof.yml`
(`workflow_dispatch`). It is deliberately **not** a per-release gate — no Mac sits in
the build loop — but it exists so the proof can be repeated after a Bun bump, an
abduco rebuild, or a change to the signing step.

Evidence write-up:
`docs/internal/superpowers/spikes/2026-08-21-darwin-cross-compile-spike.md`.
**LANDED 2026-08-21 (POD-2504).** The spike returned GO and the matrix is
collapsed. One Linux job (`headless` in `.github/workflows/release.yml`) builds
all four bundles: `zig cc` cross-compiles the abduco helper from the vendored
source, content-addressed on that source's hash and CI-cached — nothing is
checked in, so the shipped helper cannot drift from the source under review —
and `rcodesign` re-signs each Mach-O ad-hoc with the Bun JIT entitlements Bun's
own linker signature lacks. Linux helpers now link musl statically, which
removes the glibc floor the native leg silently imposed; that is the one
deliberate behavioural difference, and the temporary `ab-check` job confirms it
on ARM hardware before `publish` runs. The dev host takes the SAME path — every
dev build passes `--target`, its own platform included — and mints
fleet-scoped: this host always, plus every platform a registered machine
actually reported. Per-release CI proves the Darwin artifacts exist, are summed,
verify under the release key, and carry the right architecture, helper,
signature and entitlements; it does NOT run them. Mac execution stays manual
until CI has a Mac verifier (POD-2520). How-to and provenance:
`docs/internal/headless-cross-compilation.md`.

The spike scripts named above have productized successors, and it is those the
release job runs: `scripts/spike/linux-assert-darwin-spike.sh` became
`scripts/assert-headless-bundle.sh` (any of the four platforms, not just Darwin),
and `scripts/spike/prove-assert-can-fail.sh` became
`scripts/prove-headless-assertions-can-fail.sh` — which additionally requires each
mutation to be rejected FOR THE RIGHT REASON, matching the failure line rather than
merely exiting non-zero. Two of the ten cases were not testing what they claimed
until that check existed. `scripts/spike/macho-strip-signature.py` moved to
`scripts/macho-strip-signature.py`; the spike copies remain for the record.

## 8c. Decisions log (grilling round 1, 2026-08-21)

1. **Proposal pile-up**: one collapsing proposal, always offering latest HEAD;
   approval releases HEAD-at-approval-time; during an in-flight operation new commits
   keep collecting and approval queues via the existing `nextTargets`.
2. **Updates are user-controlled on every channel — never silent.** The UI (web or
   desktop) offers the available update and the user decides, exactly as today.
   (Revised by Q11:) On `dev` there are TWO prompts: the release proposal consents to
   build+publish (CI's role on prod), then the published release surfaces as the
   NORMAL update offer and is clicked like on any channel — the rollout consent is
   prod-identical and exercised daily. "Falls into the background" means unbreaking
   and frictionless, not consent-free; a zero-touch "auto-accept offers on this
   machine" policy could later layer on the same machinery without a second path.
11. **(Q12) Mobile web gets a lightweight refresh banner** — in scope: when the
   server serves a newer expo-web build than the phone's service worker holds
   (i.e., after an update was approved and applied elsewhere), the page shows a
   small "new version — refresh" offer that switches the service worker. Not the
   full update-management banner; just the reload offer the web app already has.
12. **(Q13) No manual rollback; dev reverts roll FORWARD**: commit the revert (clean
   tree required), approve, roll out as `dev.N+1`. Rule: a revert release may revert
   code but must NEVER delete a migration definition machines have applied — the
   schema gate requires targets to declare applied migrations.
13. **Branch testing is supported** (2026-08-21): a dev release is whatever the
   checkout's HEAD is — branches release like main, guarded by the schema gate.
   Two consequences: (a) VERSIONING IS PUBLISHER-OWNED — the dev version's base is
   the highest release base the publisher has ever minted on and the counter is
   monotonic, so a branch based on older main still mints provably-newer versions
   and branch-hopping never manufactures downgrade refusals; (b) a branch that ADDS
   a migration commits the fleet's databases to it until merge — migration-free
   branches test freely on the live dev fleet, migration-carrying branches go to a
   disposable ISOLATED INSTANCE first (the cutover-lab pattern).
14. **(Q14) No forced or auto-applied updates, period.** Users operate Podium through
   the UI; a machine whose owner never opens the UI may go stale — accepted for now.
   `critical` remains a display lever (louder offer wording), never an auto-apply
   trigger. A per-machine "auto-accept offers" policy stays a possible future layer
   on the unchanged mechanism.
3. **Server-code iteration needs no extra mechanism**: edit → approve → dev release is
   acceptable; iteration mode covers the web UI only.
4. **Rollback only when the release carried no schema migration**; otherwise
   forward-fix. The parent must report WHY rollback was unavailable.
5. **Channel-switch downgrade window accepted** (edge.N+1 → dev waits for the first
   post-release dev mint; the proposal popup reappears on the next commit anyway).
6. **Same wave machinery on dev** — canary → widen always, however small the fleet.
7. **Release popup is admin-only; any admin may approve; approval is recorded.**
8. **Page reload on skew stays a user action on every channel.**
9. **Instances stay fully isolated**: one parent per instance, no cross-instance
   anything (that is the point of isolated instances).
10. **Windows is out of scope** — its own future issue; nothing in this design
    forecloses it.

## 9. Open items

- Spike: updater-swapped ad-hoc-signed .app relaunches cleanly on macOS (Gatekeeper).
- Verify **on a Mac**: IPC from a served origin in Tauri's WKWebView, and service
  workers there (§2.1). POD-2510 answered the mechanism (remote capabilities) and
  observed it on WebKitGTK/Linux; WKWebView remains inference, because no Mac was
  online during that issue. The SW answer is desk research from WebKit's own
  documentation, not a measurement. Both rows and their consequences are recorded
  under §2.1 — this stays open until someone runs it on macOS.
- Define the shell-input hash set for CI's shell-version mint decision (§5).
- Dev feed manifest validation scoped to fleet platforms vs production's full set.
- Parent↔shell relationship on macOS: shell *as* parent vs shell supervising the parent.
- Windows story for supervision (no systemd; today's detached mode).
- Migration handover choreography details (avoiding systemd killing the in-flight
  handover; `--takeover`/transfer-lifecycle precedent).
