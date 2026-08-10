# Podium Cloud: multi-tenant hosting on Cloudflare

Status: proposal (POD-1085) · 2026-07-29

Goal: users pay a subscription and get a hosted Podium instance, later with cloud-hosted
agents. This doc proposes an architecture on Cloudflare that scales to thousands of tenants
without an ops team or per-tenant fixed cost.

## TL;DR

Run **one Cloudflare Container per tenant** carrying the existing Bun server+daemon nearly
unchanged, fronted by a thin **control-plane Worker** (auth, routing, billing, lifecycle).
Persist SQLite/state to **R2** (Litestream-style streaming + the platform's backup/restore
and upcoming native snapshots). Containers **scale to zero** — a sleeping tenant costs
approximately nothing — so subscription price comfortably covers active-use compute.
Cloud agents later land on **Cloudflare Sandboxes** (GA April 2026, native PTY-over-WebSocket)
as remote daemons joining via the existing pairing flow.

## Platform facts (verified July 2026)

- **Containers/Sandboxes GA** (April 2026). Billed per 10 ms of *active* runtime; charges
  stop when the instance sleeps. Sandboxes additionally bill only actively-used CPU cycles
  (idle-waiting-on-LLM is ~free).
- **Instance types**: lite (1/16 vCPU, 256 MiB) → standard-4 (4 vCPU, 12 GiB). Aggregate
  account limits (Feb 2026): 6 TiB RAM / 1,500 vCPU / 30 TB disk ⇒ ~1,500+ concurrent
  standard-1 instances, 15,000 lite; more by request.
- **Rates**: memory $0.0000025/GiB-s, CPU $0.000020/vCPU-s (actual usage), disk
  $0.00000007/GB-s, egress $0.025/GB (NA/EU, 1 TB included).
- **Disk is ephemeral.** Fresh disk on every wake. Persistence options: Durable Object
  SQLite (10 GB/DO), R2, Sandbox `createBackup()/restoreBackup()` (R2-backed FUSE overlay,
  shipped Feb 2026), native full-disk snapshots rolling out (2 s restore claimed).
- **Durable Objects**: SQLite-backed, 10 GB each, hibernatable WebSockets (sleeping DO
  keeps client sockets open at ~no cost), WS ingress billed 20:1.
- **Anthropic × Cloudflare "Claude Managed Agents"** runs Claude Code inside Sandboxes with
  credential injection at the egress proxy (`interceptHttps` swaps a placeholder header for
  the real API key so the secret never enters the container).

## What a Podium instance needs (from the repo audit)

- **Processes**: `server` (Hono/tRPC/WS + SQLite, serves web dist), `daemon` (PTY/abduco,
  git worktrees, agent CLIs, /proc, systemd scopes), `janitor` (maintenance ticks). Server
  and daemon are separate processes connected by one WebSocket with bidirectional RPC —
  remote daemons dialing a hub is already a supported mode (`docs/multi-instance.md`,
  `docs/offline-sync-architecture.md`).
- **State**: `${stateDir}` with `podium.db` (57 tables, drizzle, WAL, bun:sqlite, FTS5;
  ~200 MB observed), transcripts lake, artifacts, uploads, auth.json, daemon.secret.
- **Hard requirements**: Bun (migrator refuses node:sqlite), Linux for the daemon side
  (abduco, PTY, git, /proc). systemd scopes are optional (`PODIUM_NO_SCOPE=1`) — inside a
  container the container itself is the durability boundary, so scopes are unnecessary.
- **Multi-instance support already exists**: `PODIUM_INSTANCE`, `PODIUM_STATE_DIR`,
  port overrides, `instance.json` adoption guard, blue/green integration test.
- **Tenancy seam already exists**: role tiers `core | hub | cloud` (`apps/server/src/roles.ts`),
  `PodiumPlugin` composition for the private cloud module, `cloud-runtime.ts` already types
  `cloud-machine`/`cloud-agent` provisioning. Auth is single-operator per instance — which
  is *fine* under instance-per-tenant: tenancy lives in the control plane, not in podium.db.

## Recommended architecture

### Phase 1 — instance-per-tenant in Containers (MVP)

```
                    ┌────────────────────────────────────────────┐
 user ──HTTPS/WS──▶ │  Control-plane Worker  (app.podium.cloud)  │
                    │  - signup/login (tenant identity)          │
                    │  - Stripe billing + entitlements           │
                    │  - <tenant>.podium.cloud routing           │
                    │  - wake-on-request, health, admin          │
                    └───────────────┬────────────────────────────┘
                                    │  DO stub (one TenantDO per tenant)
                    ┌───────────────▼────────────────────────────┐
                    │  TenantDO (Durable Object)                 │
                    │  - container lifecycle (start/sleep)       │
                    │  - tenant metadata, entitlement cache      │
                    │  - proxies HTTP+WS to the container        │
                    └───────────────┬────────────────────────────┘
                    ┌───────────────▼────────────────────────────┐
                    │  Container (standard-1/2), per tenant      │
                    │  podium server + daemon + janitor (host.ts │
                    │  all-in-one), PODIUM_NO_SCOPE=1,           │
                    │  PODIUM_PASSWORD from control plane        │
                    │  /state on ephemeral disk                  │
                    └───────┬───────────────────────┬────────────┘
                            │ restore on wake       │ continuous WAL stream
                    ┌───────▼───────────────────────▼────────────┐
                    │  R2: per-tenant prefix                     │
                    │  podium.db replica · transcripts/artifacts │
                    │  · state-dir backup / disk snapshot        │
                    └────────────────────────────────────────────┘
```

Why this shape:

- **Near-zero porting.** The container runs the code we ship today (Bun, bun:sqlite, ws,
  abduco all fine inside a container). Single-operator auth per instance is correct — the
  control plane owns tenancy and mints/holds the per-instance operator credential.
- **Strong isolation.** Tenant = VM-isolated container + private R2 prefix. No shared DB,
  no noisy-neighbor SQLite, no cross-tenant authz surface inside Podium itself.
- **Scale-to-zero economics** (see cost model). Idle tenants — the majority in any
  subscription business — cost ~$0.
- **BYO machine day one.** The existing join-token/remote-daemon flow means a cloud-hosted
  hub can drive agents on the *user's own hardware* before we build cloud agents at all.
  That's a real differentiator and dodges the hard agent-compute cost problem initially.

State durability (the one real engineering problem):

1. **podium.db**: stream WAL to R2 continuously (Litestream speaks S3 ⇒ works with R2
   today), restore on wake. Single-writer WAL matches Litestream's model exactly.
   RPO seconds, RTO = download 200 MB from R2 (in-network, fast).
2. **Everything else in `${stateDir}`** (transcripts, artifacts, uploads, secrets):
   periodic + on-sleep `createBackup()` to R2; move to native disk snapshots when they GA
   (2 s restore). Transcripts could later write through to R2 directly (server already
   isolates the transcript lake behind one module).
3. **Live agent sessions do not survive sleep.** Acceptable for phase 1: sleep only after
   true inactivity (no open client WS, no running agent — the daemon already knows
   agent-state), and Podium already handles reattach/resume well. Full memory-state
   snapshots (Cloudflare roadmap) fix this properly later.

Lifecycle: TenantDO wakes the container on first request (cold wake = image start + R2
restore; target < 10 s, show a "warming up" page), puts it to sleep after N minutes of
quiet. The DO uses hibernatable WebSockets toward the browser so an open-but-idle tab
doesn't pin the container awake — the DO can hold the client socket, sleep the container,
and re-wake on the next message.

### Phase 2 — control plane deepens, hub moves toward Workers

Only if/when economics or latency demand it: port the **hub-role server** (already
boundary-checked to exclude daemon concerns) to Workers + TenantDO-SQLite. The audit says
the blockers are bun:sqlite/migrator, FTS5-on-DO, and the `ws`/node:http layer — a real but
bounded rewrite; `packages/sync`'s oplog is the portable federation asset. Payoff: web UI
and issue/state reads served without waking any container. **Not needed for launch.**

### Phase 3 — cloud agents on Sandboxes

Each cloud agent workspace = a **Sandbox** (native PTY over WebSocket, xterm.js-compatible;
preview URLs; `waitForPort`; backup/restore) running the podium daemon + agent CLI, joining
the tenant's hub via the existing join-token flow as just another remote machine. API keys
injected at the egress proxy per the Claude Managed Agents pattern — customer credentials
never enter the sandbox. Sandbox billing (active-CPU-only) is ideal for agents that spend
most wall-clock time awaiting model responses. This slots into the `cloud-machine`/
`cloud-agent` provisioning types that `cloud-runtime.ts` already declares.

## Cost model (per tenant, standard-1: ½ vCPU, 4 GiB, 8 GB disk)

Active-hour cost: memory 4 GiB × $0.0000025 × 3600 ≈ **$0.036/h**; disk ≈ $0.002/h; CPU is
usage-based — an idle-but-awake Podium event loop is a few % ⇒ ~$0.002–0.01/h; call it
**~$0.04–0.05 per awake hour**.

| Tenant profile | Awake | Compute/mo | R2 + egress | Total/mo |
|---|---|---|---|---|
| Dormant (signed up, unused) | ~0 h | ~$0 | ~$0.05 | **~$0.05** |
| Casual (1–2 h/day) | 45 h | ~$2 | ~$0.30 | **~$2.50** |
| Heavy (8 h/day) | 240 h | ~$11 | ~$1 | **~$12** |
| Heavy + always-awake (no sleep at all) | 720 h | ~$32 | ~$1 | **~$33** |

R2: 1 GB state ≈ $0.015/mo; WAL-stream PUTs a few cents; no egress fees R2→container.
Plus flat platform fees: $5/mo Workers Paid + DO/Workers request pennies at this scale.

At a $20–40/mo subscription the margin is healthy for casual/heavy users **provided the
sleep policy works** — the whole business case rests on idle tenants actually sleeping.
That makes the DO-holds-the-WebSocket wake/sleep proxy the single most important piece of
custom engineering in phase 1. Cloud agents (phase 3) are usage-priced compute and should
be metered (included hours + overage), not flat-rate.

Baseline sanity check: a per-tenant Hetzner VPS is ~€4/mo flat but always-on, needs fleet
ops (patching, monitoring, migration), and scales stepwise. Cloudflare wins on dormant/casual
tenants (the majority), on zero fleet ops, and on having Sandboxes ready for phase 3;
raw always-on compute is ~4–8× pricier per hour, so a future escape hatch for very heavy
tenants (dedicated VM tier) remains open.

## Risks / open questions

1. **Sleep discipline** — if browsers or health checks pin containers awake, costs ~triple.
   Mitigation: DO-mediated WS with hibernation; no direct container exposure; measure from
   day one. (Podium's own idle-cycling work, POD-997, is directly relevant: an agent that
   churns while "idle" keeps its tenant awake.)
2. **Wake latency** — image boot + R2 restore. Measure; mitigate with snapshots when GA,
   Litestream `-replica` warm restore, and honest "starting your workspace…" UX.
3. **Data safety** — Litestream-on-R2 needs a restore drill in CI (backup that's never
   restored is a rumor). Pre-migration backup already exists (`migrations/backup.ts`).
4. **Container image size** — Bun + podium + git + agent CLIs; keep the phase-1 image lean
   (no agent CLIs until phase 3 — BYO machines carry those).
5. **Fixed ports assumption** — hook-ingest :45777 etc. are per-container so no clashes,
   but the daemon's "hooks bake the port into settings files" constraint must hold across
   sleep/wake (same container ⇒ same ports; fine).
6. **ToS**: subscription-auth agent CLIs (Claude Pro/Max OAuth) on cloud hardware is a
   provider-ToS question for phase 3 — API-key agents are the safe default there
   (see memory: subscription-auth-providers-tos).
7. **Cloudflare lock-in** — phase 1 is plain containers + S3-compatible storage, so the
   design ports to Fly.io/Railway/Hetzner if pricing shifts; phase 2 (Workers/DO port)
   is where lock-in actually begins. Sequence accordingly.

## Suggested next steps

1. **Spike (1–2 days)**: Dockerfile for all-in-one podium (`PODIUM_NO_SCOPE=1`) + deploy one
   tenant behind a minimal Worker+DO; measure cold-wake time, awake idle CPU, image size.
2. **Litestream drill**: WAL-stream podium.db to R2, kill container, restore, verify with
   the existing multi-instance test suite.
3. **Control-plane skeleton**: tenant registry DO, `<tenant>.podium.cloud` (Cloudflare for
   SaaS custom hostnames), Stripe webhooks → entitlements.
4. **Sleep/wake proxy**: DO hibernatable-WS front; define "quiet" using daemon agent-state.
5. Decide phase-3 posture later; revisit Sandboxes once native snapshots GA.
