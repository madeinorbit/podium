# Daemon inventory reporting (#222)

**Issue:** #222 — Daemon should report an inventory (os / arch / version / installed agents) at pair + hello.
**Status:** design approved 2026-07-13. Web UI deferred to a follow-up.
**Prior art:** the #213 headless-bootstrap investigation (commit `bbdb149`, unmerged) specified this shape in
its design doc §4.4 and prototyped a `--inventory` emitter in `scripts/bootstrap-spike.sh`. This design refines
that proposal: it moves inventory *off* the handshake and adds per-agent login state.

## Problem

Today the daemon tells the server only `{ machineId, hostname }` (`PairFrame` / `HelloFrame` in
`packages/protocol/src/messages/daemon-handshake.ts`). The server therefore cannot know a machine's OS,
architecture, Podium version, or which agent CLIs it can actually run. Consequences: it cannot route a
session to a machine that can run the requested harness; it cannot surface "this machine is missing the
`codex` binary" (the silent-failure of #219); and it has no data source for `podium doctor` (#231).

## Decision: report inventory as a post-auth push, not inside the handshake

The issue title says "at pair + hello", but `pair`/`hello` are the **first frame on socket open**, sent on
every reconnect, and are deliberately **pre-auth** (comment in `daemon-handshake.ts:3`; they sit outside the
Control/Daemon zod unions). Building an inventory requires spawning up to five agent CLIs for `--version`
(the existing probe convention in `apps/server/src/model-probe.ts` uses an 8s timeout each). Embedding that in
the handshake would:

- stall the first frame on every reconnect — on a socket path with a documented ordering fragility
  (`apps/server/src/wsServer.ts:229-236`: *"helloOk must be the first frame"*, a mis-order once looped the
  daemon forever);
- force the server to parse an unauthenticated daemon's arbitrary payload before the token check;
- report an empty inventory on first boot (cold probe cache).

So inventory rides **after** `helloOk`/`paired`, which also places it squarely in the post-#185 frame-handler
registry — the intended architecture.

### Flow

```
pair/hello   ->  paired/helloOk        handshake unchanged, stays fast, bytes identical
daemon       ->  inventoryReport       unsolicited, fired right after auth completes
server       ->  inventoryRequest      on demand (e.g. doctor, manual refresh)
daemon       ->  inventoryReport       registry handler re-builds + reports
```

The daemon builds inventory **once at startup**, caches it, and re-sends the cached value on every reconnect
(self-heals after someone hand-installs a CLI) and whenever an `inventoryRequest` arrives (which rebuilds).

## The Inventory shape

```ts
Inventory = {
  os: 'linux' | 'darwin'
  arch: 'x64' | 'arm64'
  podiumVersion?: string          // optional; populated once #221 ships `podium --version`
  agents: AgentInventory[]        // all 5 HarnessAgent kinds, present or not
}

AgentInventory = {
  kind: HarnessAgent              // 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor'
  installed: boolean
  version?: string                // parsed from `--version`; absent if not installed / parse failed
  path?: string                   // resolved binary path when installed
  login: {
    state: 'in' | 'out' | 'unknown'   // 'unknown' for opencode/cursor: no credential detector exists today
    account?: string                  // email / label when known (claude, codex, grok)
  }
}
```

Deliberate choices:

- **`podiumVersion` optional.** There is no `podium --version` today and bare `podium` starts a server
  (#221, in progress under another agent). The field exists on the wire now; it stays `undefined` until #221
  lands, at which point `buildInventory` fills it. No dependency, no blocking.
- **`login.state` is tri-valued.** A bare boolean would lie for opencode and cursor, which have no
  credential-file detector. `'unknown'` is the honest value; `'in'`/`'out'` come from the extracted detectors
  for claude/codex/grok.
- **`login.account` carries a label** (per the approved decision) — enables "which machine is on which
  subscription" at a glance and pairs with the #212 managed-accounts work. This is the one field that puts
  personal data (an email) on the wire and into the `machines` table; accepted knowingly.
- **`tools[]` dropped from v1.** The #213 doc listed bun/uv/jq/rg/fd/gh, but nothing consumes them until
  `podium doctor` (#231). Adding them is six more subprocess probes for no current consumer. Deferred.

## Components & file layout

### Protocol — `packages/protocol/src/messages/`
- New `inventory.ts`: zod `Inventory` + `AgentInventory` schemas, reusing `HarnessAgent` from
  `messages/harness.ts`.
- Add `InventoryReport` (`{ type:'inventoryReport', machineId, inventory }`) to the **DaemonMessage** union
  (daemon → server).
- Add `InventoryRequest` (`{ type:'inventoryRequest' }`) to the **ControlMessage** union (server → daemon).
- Both are additive; `codec.ts` needs no change (bare-JSON, discriminated on `type`).

### Shared detection — `packages/agent-bridge/src/inventory/`
- Generalize the `*BinCandidates()` / `resolve*Bin()` pattern (today only `cursor/cli.ts` + `opencode/cli.ts`)
  to all five kinds, and **capture the actual `--version` string** (today `--version` is only ever a boolean
  liveness check — capturing the string is new).
- **Extract** `detectClaude` / `detectCodex` / `detectGrok` out of `apps/server/src/accounts.ts` into this
  shared module, parameterized by `homeDir`. Forced by the `login.account` decision: the server-side versions
  read the *server's* home dir, which is wrong for a remote daemon reporting about *its own* machine.
  `accounts.ts` then imports the shared functions — no server-side behavior change.
- `buildInventory({ homeDir, exec }): Promise<Inventory>` composes: `os.platform()` → `os`, `process.arch` →
  `arch`, the five per-kind probes (parallel), and the three login detectors. Injectable `exec` and `homeDir`
  for tests.

### Daemon — `apps/daemon/src/control/inventory.ts`
- A `Pick<ControlHandlers, 'inventoryRequest'>` object registered in `control/registry.ts` (spread alongside
  the existing family handlers). Handler is sync `(ctx,msg) => void` firing `void reportInventory(ctx)`,
  mirroring `control/discovery.ts`.
- `reportInventory(ctx)` rebuilds via `buildInventory` and `ctx.send({ type:'inventoryReport', ... })`.
- Startup wiring in `apps/daemon/src/daemon.ts`: build the inventory once (cache it on the context or a
  closure), and fire an initial `inventoryReport` after the handshake authenticates (in the `helloOk` /
  `paired` reply handling around `daemon.ts:643-676`), plus re-fire on reconnect.

### Server — persist the report
- `authenticateDaemon` and the handshake path are **unchanged**.
- A new inbound-`inventoryReport` handler (alongside the daemon-message handling that feeds
  `MachinesService`) writes the JSON to the machine row.
- **Migration 011** (`apps/server/src/migrations/011-machines-inventory.ts`): add
  `inventory_json TEXT` (nullable) to `machines`. A single JSON blob rather than 4+ typed columns — simpler,
  and the shape will grow. `MachinesRepository` gains `setMachineInventory(id, json)`; `MachineRecord` /
  `MachineWire` optionally surface a parsed `inventory`.

### Web — DEFERRED
`MachineWire` + `MachineRow` rendering (os/arch badge, per-agent installed/login chips) is a follow-on issue.
The #222 completion bar is: daemon emits `inventoryReport`, server persists it to `machines.inventory_json`,
value survives reconnect.

## Error handling

- **Probes never throw.** Reuse the `model-probe.ts` convention: injectable `exec`, ~5s per-probe timeout,
  any failure (binary absent, not logged in, timeout, unparseable output) → `installed:false` / `version`
  absent / `login.state:'out'|'unknown'`. A missing CLI is data.
- **Never blocks the socket.** Inventory build runs off the handshake path; a hung CLI cannot stall reconnect
  or the first frame. `ctx.send` already drops silently when disconnected.
- **Back-compat, both directions.** `inventoryReport` is an additive DaemonMessage — an old server ignores an
  unknown type; a new server tolerates a daemon that never reports (`inventory_json` stays NULL). Handshake
  bytes are literally unchanged, so old/new daemons and servers still pair across the version skew.

## Testing

- `buildInventory()` unit tests with a fake `exec` + fixture `homeDir`: per kind — installed+logged-in,
  installed+logged-out, absent, `--version` timeout; assert os/arch from a stubbed platform/arch.
- Protocol round-trip (`messages.test.ts`) for `inventoryReport` + `inventoryRequest`.
- Daemon handler test: an `inventoryRequest` frame produces an `inventoryReport` via a captured `ctx.send`.
- Server test: an `inventoryReport` persists to `machines.inventory_json` and the value survives a simulated
  reconnect (hello → still present).
- Migration test: 011 adds the column, is idempotent, and existing rows read back NULL.

## Out of scope / deferred (tracked separately)

- Web UI rendering of the inventory (follow-on issue).
- `tools[]` (bun/uv/jq/rg/fd/gh) — add when `podium doctor` (#231) needs it.
- `podiumVersion` population — arrives free once #221 lands `podium --version`.
- Extending `JoinPayload` to v2 with `harnesses?` (that's the #213 bootstrap's concern, not this issue).
