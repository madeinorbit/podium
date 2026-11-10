import { lazy } from '@podium/mobx-helpers'
import {
  type AutomationRunWire,
  type AutomationWire,
  effectiveServiceReport,
  type HostMetricsWire,
  type MachineAccessWire,
  type MachineProjection,
  type MachineServiceReport,
  serverMoveEligibilityOf,
} from '@podium/model'
import type { MachineConditionPayload } from '@podium/protocol'
import { here } from './lookup'
import { EntityModel, type ModelHost, registerModels } from './models'
import type { FieldSource, ModelSchema } from './shared/schema'

/** Deferred definitions only. Record storage and ingestion stay in the generic
 * pool tables; field access uses the shared schema installer. */
const machineAccess = (): FieldSource => ({
  schema: 'MachineAccessWire',
  arrivesOn: 'replica:machineAccess',
})
const machineProjection = (): FieldSource => ({
  schema: 'MachineProjection',
  arrivesOn: 'replica:machines',
})
const automationWire = (): FieldSource => ({
  schema: 'AutomationWire',
  arrivesOn: 'replica:automations',
})
const automationRunWire = (): FieldSource => ({
  schema: 'AutomationRunWire',
  arrivesOn: 'replica:automationRuns',
})

type Condition = Omit<MachineConditionPayload, 'online' | 'since'>

/**
 * One machine: its `machine` record (every member) joined with my own
 * `machineAccess` row (POD-6644). Stored fields are schema-installed.
 *
 * LIVE FIELDS (POD-5798; guide rule 1). Whether the machine is online, since
 * when, its presence and its load are CONDITIONS: they come from this user's
 * LiveStore, not the record. None is known before its first reading, so an app
 * started offline shows "unknown", never yesterday's answer. Reading `metrics`
 * from an observer is what asks the machine's daemon to sample.
 */
export class MachineModel extends EntityModel {
  declare readonly id: MachineProjection['id']
  constructor(id: string, host: ModelHost) {
    super('machine', id, host)
  }

  // Live condition
  /**
   * Online now, by the server's view of the daemon connection. True only while
   * that is KNOWN: before the first reading, or once the connection is lost,
   * the machine is not known online, so it is not offered as one.
   * {@link onlineKnown} says which case "false" is.
   */
  @lazy get online(): boolean {
    const reading = this.host.live?.conditionOf(this.id)
    return reading?.known === true && reading.value.online
  }
  /** Whether {@link online} is a current reading (false: unknown, shown as such). */
  @lazy get onlineKnown(): boolean {
    return this.host.live?.conditionOf(this.id)?.known === true
  }
  /**
   * When `online` last changed, as the server saw it. Null when the server has
   * not seen the machine connect since it started; undefined until known.
   */
  @lazy get onlineSince(): string | null | undefined {
    const reading = this.host.live?.conditionOf(this.id)
    return reading?.known ? reading.value.since : undefined
  }
  /** The newest presence facts, known or last known (a lost link keeps them). */
  @lazy private get condition(): Condition | undefined {
    const reading = this.host.live?.conditionOf(this.id)
    if (reading === undefined) return undefined
    return (reading.known ? reading.value : reading.last) as Condition | undefined
  }
  /** When the server last heard from the machine; undefined until read. */
  @lazy get lastSeenAt(): string | undefined {
    return this.condition?.lastSeenAt
  }
  @lazy get presenceSource(): Condition['presenceSource'] {
    return this.condition?.presenceSource
  }
  /** What the current boot is observed to run; undefined until read. */
  @lazy get availability(): Condition['availability'] {
    return this.condition?.availability
  }
  @lazy get daemonReadiness(): Condition['daemonReadiness'] {
    return this.condition?.daemonReadiness
  }
  /** The supervisor's last report as it stands now (its record, joined with
   *  the live availability: an agent plane that has gone is not available). */
  @lazy get services(): MachineServiceReport | undefined {
    return effectiveServiceReport(
      here(this.row)?.['services'] as MachineServiceReport | undefined,
      this.availability,
    )
  }
  /** Whether a server move to this machine is possible now. */
  @lazy get serverMoveEligibility(): ReturnType<typeof serverMoveEligibilityOf> {
    return serverMoveEligibilityOf(
      here(this.row) as Pick<MachineAccessWire, 'hostsServer' | 'serverMoveSupported'> | undefined,
      this.online,
    )
  }

  // Live load
  /** The newest host sample (CPU, memory, load, disk, loop); undefined until known. */
  @lazy get metrics(): HostMetricsWire | undefined {
    const reading = this.host.live?.metricsOf(this.id)
    return reading?.known ? reading.value : undefined
  }
}
type MachineLiveFields =
  | 'services'
  | 'lastSeenAt'
  | 'presenceSource'
  | 'availability'
  | 'daemonReadiness'
export interface MachineModel
  extends Readonly<MachineProjection>,
    Readonly<Partial<Omit<MachineAccessWire, 'userId' | 'machineId' | MachineLiveFields>>> {}

/** Stored target, schedule and agent instruction fields are schema-installed. */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: The registered schema installs these readonly record fields.
export class AutomationModel extends EntityModel {
  declare readonly id: AutomationWire['id']
  constructor(id: string, host: ModelHost) {
    super('automation', id, host)
  }
}
export interface AutomationModel extends Readonly<AutomationWire> {}

/** Stored occurrence and link fields are schema-installed. */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: The registered schema installs these readonly record fields.
export class AutomationRunModel extends EntityModel {
  declare readonly id: AutomationRunWire['id']
  constructor(id: string, host: ModelHost) {
    super('automationRun', id, host)
  }
}
export interface AutomationRunModel extends Readonly<AutomationRunWire> {}

const schema = {
  machine: {
    key: 'id',
    why: 'One fleet identity shared by settings, placement, headers and session joins.',
    components: {
      projection: {
        schema: 'MachineProjection',
        arrivesOn: 'replica:machines',
        joinKey: 'id',
        precedence: 0,
        why: 'The machine record every member reads: name, custody, logged-out harnesses, build and update (POD-6644).',
      },
      access: {
        schema: 'MachineAccessWire',
        arrivesOn: 'replica:machineAccess',
        joinKey: 'machineId',
        precedence: 1,
        why: 'My own access row: my verdicts and the operational facts I may read (POD-6644). The row source joins it by my user id.',
      },
    },
    fields: {
      // Identity and custody
      id: { type: 'id', source: machineProjection() },
      name: { type: 'string', source: machineProjection() },
      // Who holds custody (POD-6291): what moves a task's worktree between readers.
      custodian: { type: 'id', optional: true, nullable: true, source: machineProjection() },
      loggedOutHarnesses: { type: 'object', source: machineProjection() },
      // My verdicts (absent: I may not see the machine's operational facts)
      use: { type: 'enum', optional: true, source: machineAccess() },
      owned: { type: 'boolean', optional: true, source: machineAccess() },
      transferable: { type: 'boolean', optional: true, source: machineAccess() },
      unowned: { type: 'boolean', optional: true, source: machineAccess() },
      adoptable: { type: 'boolean', optional: true, source: machineAccess() },
      supersedable: { type: 'boolean', optional: true, source: machineAccess() },
      // Who else holds a grant (POD-6700): only the custodian's and admins' rows carry it.
      grants: { type: 'object', optional: true, source: machineAccess() },
      // Identity and lifecycle
      hostname: { type: 'string', optional: true, source: machineAccess() },
      revokedAt: { type: 'isoDate', optional: true, nullable: true, source: machineAccess() },
      supersededBy: { type: 'id', optional: true, nullable: true, source: machineAccess() },
      podiumManaged: { type: 'boolean', optional: true, source: machineAccess() },
      hostsServer: { type: 'boolean', optional: true, source: machineAccess() },
      serverMoveSupported: { type: 'boolean', optional: true, source: machineAccess() },
      // Services and transport. `services`, presence and availability are the
      // model's, joined with the LiveStore (above).
      serviceAssignment: { type: 'object', optional: true, source: machineAccess() },
      components: { type: 'object', optional: true, source: machineAccess() },
      deliveryCaps: { type: 'object', optional: true, source: machineAccess() },
      checkoutReach: { type: 'enum', optional: true, source: machineAccess() },
      wireSchemaDigest: { type: 'string', optional: true, nullable: true, source: machineAccess() },
      buildReportedAt: { type: 'isoDate', optional: true, nullable: true, source: machineAccess() },
      // Execution detail (present only with `use`)
      harnessVersions: { type: 'object', optional: true, source: machineAccess() },
      inventory: { type: 'object', optional: true, source: machineAccess() },
      // Build and update authority
      updateChannel: { type: 'enum', optional: true, source: machineProjection() },
      updateChannelOverride: {
        type: 'enum',
        optional: true,
        nullable: true,
        source: machineProjection(),
      },
      appVersion: { type: 'string', optional: true, nullable: true, source: machineProjection() },
      installKind: { type: 'string', optional: true, nullable: true, source: machineProjection() },
      versionState: { type: 'enum', optional: true, source: machineProjection() },
      targetVersion: {
        type: 'string',
        optional: true,
        nullable: true,
        source: machineProjection(),
      },
      targetUnavailableReason: {
        type: 'string',
        optional: true,
        nullable: true,
        source: machineAccess(),
      },
    },
    relations: {},
    cold: { kind: 'never', why: 'The currently synced fleet stays resident, as before.' },
  },
  automation: {
    key: 'id',
    why: 'One scheduled definition shared by its list, card and editor.',
    components: {
      automation: {
        schema: 'AutomationWire',
        arrivesOn: 'replica:automations',
        joinKey: 'id',
        precedence: 0,
        why: 'The definition already arrives as one replica row.',
      },
    },
    fields: {
      // Identity and target
      id: { type: 'id', source: automationWire() },
      name: { type: 'string', source: automationWire() },
      enabled: { type: 'boolean', source: automationWire() },
      repoPath: { type: 'string', nullable: true, source: automationWire() },
      targetSessionId: { type: 'id', nullable: true, source: automationWire() },
      createdAt: { type: 'isoDate', source: automationWire() },
      // Schedule
      scheduleKind: { type: 'enum', source: automationWire() },
      cron: { type: 'string', nullable: true, source: automationWire() },
      runAt: { type: 'isoDate', nullable: true, source: automationWire() },
      nextRunAt: { type: 'isoDate', nullable: true, source: automationWire() },
      lastRunAt: { type: 'isoDate', nullable: true, source: automationWire() },
      // Agent instructions
      agentKind: { type: 'string', source: automationWire() },
      model: { type: 'string', source: automationWire() },
      effort: { type: 'string', source: automationWire() },
      prompt: { type: 'string', source: automationWire() },
      sessionMode: { type: 'enum', source: automationWire() },
    },
    relations: {},
    cold: { kind: 'never', why: 'The currently synced definitions stay resident, as before.' },
  },
  automationRun: {
    key: 'id',
    why: 'One scheduled occurrence shared by every history window showing its ID.',
    components: {
      run: {
        schema: 'AutomationRunWire',
        arrivesOn: 'replica:automationRuns',
        joinKey: 'id',
        precedence: 0,
        why: 'Runs already arrive through sync; a history request selects IDs only.',
      },
    },
    fields: {
      // Identity and links
      id: { type: 'id', source: automationRunWire() },
      automationId: { type: 'id', source: automationRunWire() },
      sessionId: { type: 'id', nullable: true, source: automationRunWire() },
      // Occurrence
      firedAt: { type: 'isoDate', source: automationRunWire() },
      outcome: { type: 'enum', source: automationRunWire() },
      detail: { type: 'string', nullable: true, source: automationRunWire() },
    },
    relations: {},
    cold: {
      kind: 'never',
      why: 'The currently synced run set stays resident; history windows keep only IDs.',
    },
  },
} satisfies Pick<ModelSchema, 'machine' | 'automation' | 'automationRun'>

registerModels(schema, {
  machine: MachineModel,
  automation: AutomationModel,
  automationRun: AutomationRunModel,
})
