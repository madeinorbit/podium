import { gateHarnessVersion, HARNESS_VERSION_POLICIES } from '@podium/harness/browser'
import {
  AgentKind,
  type MachineId,
  type MachineProjection,
  type MachineServiceReport,
  resolveMachineChannel,
  type SyncedServiceReport,
} from '@podium/model'
import { SERVER_MOVE_CAPABILITY, wireSchemaDigest } from '@podium/protocol'
import type { MachineRecord, SessionStore } from '../../store'
import type { GrantRow } from '../../store/grants'
import { custodianFromEdges } from '../issues/execution-visibility'
import type { MachineRecordFacts } from './service'
import { deriveVersionState } from './version-state'

/** A pure read of the rows a worker can open; no daemon links or update maps. */
export async function storedMachineRecordFacts(
  store: Pick<SessionStore, 'machines' | 'grants'>,
  ids?: readonly MachineId[],
  loaded?: {
    readonly grants?: ReadonlyMap<string, readonly GrantRow[]>
    readonly records?: readonly MachineRecord[]
  },
): Promise<MachineRecordFacts[]> {
  const records =
    loaded?.records ??
    (ids === undefined
      ? await store.machines.listMachines()
      : [...(await store.machines.getMachines(ids)).values()])
  const grants =
    loaded?.grants ??
    (await store.grants.loadForResources(
      'machine',
      records.map((machine) => machine.id),
    ))
  const custodians = new Map(
    records.map((machine) => [machine.id, custodianFromEdges(grants.get(machine.id))]),
  )
  const { fleetChannel, targets, serverMoveAvailable } = await store.machines.recordContext.read()
  return records.map((m) => {
    const updateChannel = resolveMachineChannel(m.updateChannelOverride, fleetChannel)
    let target: string | undefined
    try {
      const published = targets.get(updateChannel)
      target = published?.version
    } catch {
      target = undefined
    }
    const machine: MachineProjection = {
      id: m.id,
      name: m.name,
      loggedOutHarnesses: AgentKind.options.filter((kind) =>
        m.inventory?.agents.some(
          (agent) => agent.kind === kind && agent.installed === true && agent.login.state === 'out',
        ),
      ),
      custodian: custodians.get(m.id) ?? null,
      appVersion: m.appVersion,
      updateChannel,
      updateChannelOverride: m.updateChannelOverride,
      targetVersion: target ?? null,
      versionState: deriveVersionState(m.appVersion, target),
      installKind: m.installKind,
    }
    return {
      machine,
      revokedAt: m.revokedAt,
      supersededBy: m.supersededBy ?? null,
      see: {
        hostname: m.hostname,
        revokedAt: m.revokedAt,
        supersededBy: m.supersededBy ?? null,
        ...(m.podiumManaged === false ? { podiumManaged: false } : {}),
        hostsServer: serverMoveAvailable && m.serviceAssignment.server,
        serverMoveSupported:
          serverMoveAvailable &&
          m.wireSchemaDigest === wireSchemaDigest() &&
          m.deliveryCaps.includes(SERVER_MOVE_CAPABILITY),
        // No heartbeat times on a synced record: they moved every few seconds
        // and rewrote every member's access row (see SyncedServiceReport).
        ...(m.serviceReport ? { services: withoutObservedAt(m.serviceReport) } : {}),
        serviceAssignment: m.serviceAssignment,
        components: m.components ?? [],
        deliveryCaps: m.deliveryCaps,
        wireSchemaDigest: m.wireSchemaDigest,
      },
      use: {
        harnessVersions: (m.harnessVersions ?? []).map(({ lastSeen: _lastSeen, ...report }) => {
          const policy =
            HARNESS_VERSION_POLICIES[report.harness as keyof typeof HARNESS_VERSION_POLICIES]
          return {
            ...report,
            ...(policy
              ? {
                  verifiedThrough: policy.verifiedThrough,
                  unverified: gateHarnessVersion(policy, report.version) === 'unverified',
                }
              : {}),
          }
        }),
        ...(m.inventory ? { inventory: m.inventory } : {}),
      },
    }
  })
}

function withoutObservedAt(report: MachineServiceReport): SyncedServiceReport {
  const { observedAt: _server, ...server } = report.server
  const { observedAt: _agents, ...agentExecution } = report.agentExecution
  return { ...report, server, agentExecution }
}
