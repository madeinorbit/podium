import {
  type MachineHarnessInventory,
  buildServedDescriptors,
  declaredValue,
  gateHarnessVersion,
  HARNESS_KINDS,
  harnessServerAlternatives,
  harnessTerminalDriverId,
  harnessVersionPolicyFor,
  manifestFor,
  probeAllModels,
  PROBEABLE_AGENTS,
  type ProbeableAgent,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import { asMachineId, type Inventory } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { sendHarnessVersion } from '../harness-version-reporting'
import {
  managementInventoryCacheKey,
  resolveManagementCredentialHome,
  type HarnessManagementContext,
} from '../harness-management.js'
import { opencode2VersionProbeForExecutable } from '../runtime/version-probe'
import type { ControlHandlers, DaemonContext } from './context'

const log = createLogger('daemon:inventory')

/**
 * Machine inventory reporting (#222): build os/arch + per-harness
 * install/version/login and push it to the server. Fired unsolicited right
 * after the handshake authenticates (every (re)connect) and on an
 * inventoryRequest frame and periodically while connected. Never throws and
 * never rides the handshake path: a hung CLI probe cannot stall reconnect.
 *
 * The build spawns up to five real CLIs for `--version`, so a definitive result
 * is cached inside one completed wave. Reconnects and explicit/periodic requests
 * re-probe it, while concurrent re-probes join the live wave so it can publish.
 * An inconclusive timeout is sent but NOT cached: the next reconnect/report
 * probes again, while explicit and periodic refreshes also re-probe so live
 * changes converge without a daemon restart.
 *
 * The cache is keyed by `(machineId, homeDir)` and holds `MachineHarnessInventory`
 * — a value that names the machine it describes. Not an instance-global "current
 * inventory": per ADR 1 Amendment 1 D13.5 this is a per-machine fact with
 * visibility class `owned-compute` inheriting its machine's scoping, so a
 * singleton here is what POD-1079 would have to unpick to scope it. (machineId
 * alone would do for a daemon, which serves one machine — homeDir stays in the key
 * because the tests boot daemons against fixture homes.)
 */
const inventoryCache = new Map<string, Promise<MachineHarnessInventory>>()
const inventoryInFlight = new Map<string, Promise<MachineHarnessInventory>>()
const inventoryRebuildQueued = new Map<string, Promise<void>>()

export const DEFAULT_INVENTORY_REFRESH_INTERVAL_MS = 60_000

export function terminalRuntimeDriverInventory(): NonNullable<Inventory['runtimeDrivers']> {
  // Every manifest declares its terminal driver (required, never Declared),
  // so these rows are derived from the registry — a seventh harness reports
  // its terminal with no second edit here. (pi included: its manifest
  // declares generic-pty like the rest, and the daemon drives it through the
  // same terminal profile as every other harness.)
  return HARNESS_KINDS.flatMap((harness) => {
    const id = harnessTerminalDriverId(harness)
    return id === undefined ? [] : [{ harness, id, family: 'terminal' as const }]
  })
}

/** Product-facing projection of the bounded harness inventory wave. It reports
 * only concrete drivers this machine can select from the facts already observed. */
export function runtimeDriverInventory(
  inventory: Inventory,
  drivableAlternatives: readonly string[] = [],
): NonNullable<Inventory['runtimeDrivers']> {
  const versionFor = (kind: Inventory['agents'][number]['kind']): string | undefined => {
    const agent = inventory.agents.find((candidate) => candidate.kind === kind)
    return agent?.installed === true ? agent.version : undefined
  }
  // Read per call, not memoized at module scope: tests overlay manifests and
  // a cached map would keep answering for the registry as first imported.
  const alternativeById = new Map(
    harnessServerAlternatives().map((alternative) => [alternative.driverId, alternative]),
  )
  return [
    ...terminalRuntimeDriverInventory(),
    // Server drivers, read off each manifest (POD-4737): a harness without a
    // declared server (today cursor, pi) reports none; a harness without a
    // version policy (today Claude's SDK) reports unconditionally; a gated
    // harness reports only with a known-good version — exactly what the
    // per-harness gates did, with no harness named here. Both axes: most
    // harnesses declare their server on `runtime.server`, while Claude's
    // stream engine rides `runtime.embedded` (ADR 11) with the server family.
    ...HARNESS_KINDS.flatMap((harness) => {
      const runtime = manifestFor(harness)?.runtime
      const server = runtime?.server ? declaredValue(runtime.server) : undefined
      const embedded = runtime?.embedded ? declaredValue(runtime.embedded) : undefined
      const servers = [server, embedded].filter((spec) => spec !== undefined)
      const policy = harnessVersionPolicyFor(harness)
      if (policy !== undefined) {
        const version = versionFor(harness)
        if (version === undefined || gateHarnessVersion(policy, version) === 'too-old') return []
      }
      return servers.map((server) => ({ harness, id: server.driverId, family: 'server' as const }))
    }),
    // Declared server alternatives admitted by probe (POD-4737 D1): each
    // alternative states its own probe binary, so a second alternative
    // anywhere reports with no edit here. Unknown ids never occur — the
    // caller resolves them against the same declarations — and are skipped.
    ...drivableAlternatives.flatMap((driverId) => {
      const alternative = alternativeById.get(driverId)
      return alternative
        ? [{ harness: alternative.harness, id: alternative.driverId, family: 'server' as const }]
        : []
    }),
  ]
}

const inventoryProbeTimes = new WeakMap<Inventory, string>()

function reportHarnessInventory(send: DaemonContext['send'], inventory: Inventory): void {
  // Replaying the same completed wave is not another probe.
  const probedAt = inventoryProbeTimes.get(inventory) ?? new Date().toISOString()
  inventoryProbeTimes.set(inventory, probedAt)
  for (const agent of inventory.agents) {
    if (agent.installed && agent.version) {
      sendHarnessVersion(send, agent.kind, agent.version, probedAt)
    }
  }
}

/**
 * MANAGEMENT OWNERSHIP (POD-4305 F12): executable/version/login reprobes and
 * model discovery are non-live harness-management services. They observe the
 * machine (CLIs, credential homes, generation snapshots) before any agent handle
 * can exist and must survive logged-out, uninstalled, zero-session and
 * multi-home states. Takes `HarnessManagementContext` so legacy turn-path
 * removal cannot delete this as "legacy control". Executable/version admission
 * (`gate*Version`, opencode2 drivable probe), credential-home isolation
 * (`resolveManagementCredentialHome`), per-home memoization
 * (`managementInventoryCacheKey`) and login PTY argv (resolved in
 * `control/session.ts` via `managementLoginCommandFor`) stay with the owner.
 * Shell/login exemption itself is POD-4278; no shell manifest/driver is added.
 */
export async function reportInventory(
  ctx: HarnessManagementContext,
  opts: { rebuild?: boolean; reprobe?: boolean } = {},
): Promise<void> {
  // The separator is a real NUL written as an ESCAPE, deliberately. NUL cannot
  // occur in a machineId or a path, so the composite key can never collide --
  // but a LITERAL NUL byte makes git, grep and `file` classify this module as
  // BINARY, and grep then reports nothing and exits 1 rather than erroring.
  // scripts/check-no-nul-bytes.ts exists for exactly this mistake and caught
  // this line. [POD-758]
  if (ctx.harnessRuntime) {
    try {
      // Every authenticated (re)connect must observe the machine again rather
      // than merely replaying the process-lifetime snapshot. reprobe() is
      // single-flight, so an initial boot wave or periodic tick joins rather
      // than supersedes the observation that is about to repair the server's
      // persisted inventory row.
      const snapshot = await (opts.rebuild
        ? ctx.harnessRuntime.refresh()
        : ctx.harnessRuntime.reprobe())
      if (!ctx.harnessRuntime.isCurrent(snapshot)) return
      // Declared server alternatives admitted by probe (POD-4737 D1): each
      // alternative states its own probe binary, resolved here and probed
      // with its family's probe — today the only declared alternative is
      // opencode2's, whose beta-pin semantics live in its family probe.
      // Version evaluation belongs to families (floors and pins differ per
      // CLI), so each alternative is probed with its own family's probe —
      // the same dispatch the spawn path shares through
      // defaultServerDriverAdmissionProbe.
      const drivableAlternatives: string[] = []
      for (const alternative of harnessServerAlternatives()) {
        const executable = snapshot.commandEnvironment.resolve(alternative.executable)
        if (
          executable &&
          (await opencode2VersionProbeForExecutable(executable)).drivable
        ) {
          drivableAlternatives.push(alternative.driverId)
        }
      }
      if (!ctx.harnessRuntime.isCurrent(snapshot)) return
      ctx.send({
        type: 'inventoryReport',
        machineId: asMachineId(ctx.machineId),
        inventory: {
          ...snapshot.inventory,
          runtimeDrivers: runtimeDriverInventory(snapshot.inventory, drivableAlternatives),
        },
        // Served descriptors (POD-4475): adapter DATA plus this machine's
        // availability, so clients render harnesses they never shipped.
        descriptors: buildServedDescriptors(snapshot.inventory),
      })
      reportHarnessInventory(ctx.send, snapshot.inventory)
    } catch (err) {
      log.warn('inventory report failed', { err })
    }
    return
  }

  const key = managementInventoryCacheKey(ctx.machineId, ctx.homeDir)
  let pending: Promise<MachineHarnessInventory> | undefined
  try {
    // A refresh interval, credential install, or server request can arrive while
    // a loaded CLI is still consuming the entire probe budget. Coalesce those
    // forced rebuilds into one follow-up wave: dropping the request would leave a
    // newly installed credential invisible until the next periodic refresh.
    const active = inventoryInFlight.get(key)
    if ((opts.rebuild || opts.reprobe) && active) {
      let queued = inventoryRebuildQueued.get(key)
      if (!queued) {
        queued = (async () => {
          try {
            await active
          } catch {
            // The active reporter owns logging/eviction. A failed probe still
            // must yield to the queued forced rebuild.
          }
          // The reporter awaiting the same build registered first; let its
          // finally block clear inventoryInFlight before starting the next wave.
          await Promise.resolve()
          inventoryRebuildQueued.delete(key)
          await reportInventory(ctx, { rebuild: true })
        })()
        inventoryRebuildQueued.set(key, queued)
      }
      return await queued
    }
    pending = opts.rebuild || opts.reprobe ? undefined : inventoryCache.get(key)
    if (!pending) {
      if (!ctx.agentRuntime) throw new Error('machine runtime is not composed')
      pending = ctx.agentRuntime.inventory().then((inventory) => ({
        machineId: ctx.machineId,
        inventory,
      }))
      inventoryCache.set(key, pending)
      inventoryInFlight.set(key, pending)
    }
    const { machineId, inventory } = await pending
    // A forced rebuild queued while this probe was running means its facts are
    // already superseded (notably, they may predate a credential install).
    // Publish only the coalesced follow-up result.
    if (inventoryRebuildQueued.has(key)) return
    // A credential install can force a rebuild while the initial handshake
    // probe is still shelling out to the agent CLIs. The old probe observed the
    // pre-copy auth files and may finish last; never let that superseded result
    // overwrite the newer logged-in inventory on the server.
    if (inventoryCache.get(key) !== pending) return
    // Mirror the driver admission verdict: an unprobeable binary is a gap, not a
    // stable fact. Publish it honestly, then evict it so the next report retries
    // without requiring a daemon restart or waiting for the periodic refresh.
    const unprobeable =
      inventory.agents.some((agent) => agent.installed === null) ||
      inventory.tools.some((tool) => tool.installed === null)
    if (unprobeable) inventoryCache.delete(key)
    // machineId comes off the probed value, not from ctx a second time: the fact
    // and the machine it is about travel together by construction.
    // The brand is asserted, not validated: this id is the daemon's OWN, read
    // from its state file at boot and carried through `DaemonContext.machineId`
    // and the inventory build, neither of which is a wire boundary.
    ctx.send({
      type: 'inventoryReport',
      machineId: asMachineId(machineId),
      inventory: { ...inventory, runtimeDrivers: runtimeDriverInventory(inventory) },
      // Served descriptors (POD-4475): see the harnessRuntime path above.
      descriptors: buildServedDescriptors(inventory),
    })
    reportHarnessInventory(ctx.send, inventory)
  } catch (err) {
    // Evict only OUR failed build — a concurrent rebuild may have already stored
    // a fresh pending under this key; don't discard it.
    if (inventoryCache.get(key) === pending) inventoryCache.delete(key)
    log.warn('inventory report failed', { err })
  } finally {
    if (inventoryInFlight.get(key) === pending) inventoryInFlight.delete(key)
  }
}

/** Refresh changing agent capabilities while the authenticated daemon remains live. */
export function startInventoryRefresh(
  ctx: DaemonContext,
  intervalMs = DEFAULT_INVENTORY_REFRESH_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => void reportInventory(ctx, { reprobe: true }), intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * LIVE MODEL ENUMERATION FOR THIS MACHINE (POD-1466).
 *
 * The sibling of `reportInventory`, and it runs HERE for the same reason: which
 * models a harness offers is a fact about the host whose CLIs answered. The
 * server used to shell out on its own process for every machineId, so a remote
 * machine's picker was served the SERVER's models (or nothing).
 *
 * Unlike inventory this is request-correlated and NOT cached here: the caching
 * (stale-while-revalidate, per machine, persisted) is the server's ModelCatalog,
 * and a second cache on this side would only make an upgrade take two refreshes
 * to show up. A failed probe answers with `{}` rather than silence — the server
 * keeps its last-good snapshot and the web falls back to its static catalog, and
 * an unanswered request would just burn the correlator's timeout.
 *
 * THE CLAUDE AUTH IS THIS HOST'S, and that is the point rather than a shortcut:
 * the models the picker should offer for a machine are the ones an agent running
 * ON that machine can actually reach. So the key comes from this host's
 * ANTHROPIC_API_KEY, else this host's Claude Code login. The server's
 * `apiKeys.anthropic` secret is deliberately NOT shipped down — a server-side
 * secret does not cross to a machine just to shorten a model list.
 */
async function runModelProbe(
  ctx: HarnessManagementContext,
  msg: Extract<ControlMessage, { type: 'modelProbeRequest' }>,
): Promise<void> {
  let byAgent: Awaited<ReturnType<typeof probeAllModels>> = {}
  try {
    const snapshot = await ctx.harnessRuntime?.current()
    // MANAGEMENT CREDENTIAL HOME (POD-4305 F12): the probe must name the account
    // the child will run as — the provisioned native-account HOME when present —
    // never the operator's ambient HOME and never a server-side secret.
    const credentialHome = resolveManagementCredentialHome(ctx)
    // Executables for the CLI-probed harnesses, picked by the probeable set
    // itself (POD-4737) — Claude probes through its OAuth token below, never a
    // CLI, so it takes no executable. No harness named here.
    const executables: Partial<Record<ProbeableAgent, string>> = {}
    if (snapshot) {
      for (const kind of PROBEABLE_AGENTS) {
        const path = snapshot.executables.get(kind)?.path
        if (path !== undefined) executables[kind] = path
      }
    }
    byAgent = await probeAllModels({
      ...(snapshot
        ? {
            executables,
            env: snapshot.commandEnvironment.env,
          }
        : {}),
      ...(credentialHome ? { homeDir: credentialHome } : {}),
      claude: {
        ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
        ...(credentialHome ? { homeDir: credentialHome } : {}),
      },
    })
  } catch (err) {
    log.warn('model probe failed', { err, requestId: msg.requestId })
  }
  ctx.send({ type: 'modelProbeResult', requestId: msg.requestId, byAgent })
}

export const inventoryHandlers: Pick<ControlHandlers, 'inventoryRequest' | 'modelProbeRequest'> = {
  inventoryRequest: (ctx) => {
    // A server/CLI request asks for fresh install/login facts. Reusing the
    // captured command environment is sufficient: resolve() checks the
    // filesystem anew, including manifest fallback locations. More importantly,
    // reprobe is single-flight while refresh would supersede an in-flight wave.
    void reportInventory(ctx, { reprobe: true })
  },
  modelProbeRequest: (ctx, msg) => {
    void runModelProbe(ctx, msg)
  },
}
