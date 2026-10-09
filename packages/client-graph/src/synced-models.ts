import type { AutomationRunWire, AutomationWire, MachineProjection, MachineWire } from '@podium/model'
import { EntityModel, registerModels, type ModelHost } from './models'
import type { FieldSource, ModelSchema } from './shared/schema'

/** Deferred definitions only. Record storage and ingestion stay in the generic
 * pool tables; field access uses the shared schema installer. */
const machineWire = (): FieldSource => ({ schema: 'MachineWire', arrivesOn: 'engine:machines' })
const machineProjection = (): FieldSource => ({ schema: 'MachineProjection', arrivesOn: 'replica:machines' })
const automationWire = (): FieldSource => ({ schema: 'AutomationWire', arrivesOn: 'replica:automations' })
const automationRunWire = (): FieldSource => ({ schema: 'AutomationRunWire', arrivesOn: 'replica:automationRuns' })

/** Stored identity, presence, execution and update fields are schema-installed. */
export class MachineModel extends EntityModel {
  declare readonly id: MachineWire['id']
  constructor(id: string, host: ModelHost) { super('machine', id, host) }
}
export interface MachineModel extends Readonly<MachineWire>, Readonly<MachineProjection> {}

/** Stored target, schedule and agent instruction fields are schema-installed. */
export class AutomationModel extends EntityModel {
  declare readonly id: AutomationWire['id']
  constructor(id: string, host: ModelHost) { super('automation', id, host) }
}
export interface AutomationModel extends Readonly<AutomationWire> {}

/** Stored occurrence and link fields are schema-installed. */
export class AutomationRunModel extends EntityModel {
  declare readonly id: AutomationRunWire['id']
  constructor(id: string, host: ModelHost) { super('automationRun', id, host) }
}
export interface AutomationRunModel extends Readonly<AutomationRunWire> {}

const schema = {
  machine: {
    key: 'id',
    why: 'One fleet identity shared by settings, placement, headers and session joins.',
    components: {
      projection: { schema: 'MachineProjection', arrivesOn: 'replica:machines', joinKey: 'id', precedence: 0,
        why: 'Replicated name and logged-out harness facts remain available without live presence.' },
      live: { schema: 'MachineWire', arrivesOn: 'engine:machines', joinKey: 'id', precedence: 1,
        why: 'Principal-scoped machine detail; the existing applying path preserves live/replicated precedence.' },
    },
    fields: {
      // Identity and custody
      id: { type: 'id', source: machineProjection() },
      name: { type: 'string', source: machineProjection() },
      hostname: { type: 'string', source: machineWire() },
      revokedAt: { type: 'isoDate', optional: true, nullable: true, source: machineWire() },
      supersededBy: { type: 'id', optional: true, nullable: true, source: machineWire() },
      supersedable: { type: 'boolean', optional: true, source: machineWire() },
      use: { type: 'enum', optional: true, source: machineWire() },
      owned: { type: 'boolean', optional: true, source: machineWire() },
      transferable: { type: 'boolean', optional: true, source: machineWire() },
      unowned: { type: 'boolean', optional: true, source: machineWire() },
      adoptable: { type: 'boolean', optional: true, source: machineWire() },
      podiumManaged: { type: 'boolean', optional: true, source: machineWire() },
      // Presence and execution
      online: { type: 'boolean', source: machineWire() },
      lastSeenAt: { type: 'isoDate', source: machineWire() },
      presenceSource: { type: 'enum', optional: true, source: machineWire() },
      services: { type: 'object', optional: true, source: machineWire() },
      serviceAssignment: { type: 'object', optional: true, source: machineWire() },
      availability: { type: 'object', optional: true, source: machineWire() },
      daemonReadiness: { type: 'object', optional: true, source: machineWire() },
      components: { type: 'object', optional: true, source: machineWire() },
      inventory: { type: 'object', optional: true, source: machineWire() },
      harnessVersions: { type: 'object', optional: true, source: machineWire() },
      loggedOutHarnesses: { type: 'object', source: machineProjection() },
      deliveryCaps: { type: 'object', optional: true, source: machineWire() },
      serverMoveEligibility: { type: 'object', optional: true, source: machineWire() },
      // Build and update authority
      updateChannel: { type: 'enum', optional: true, source: machineWire() },
      updateChannelOverride: { type: 'enum', optional: true, nullable: true, source: machineWire() },
      appVersion: { type: 'string', optional: true, nullable: true, source: machineWire() },
      wireSchemaDigest: { type: 'string', optional: true, nullable: true, source: machineWire() },
      installKind: { type: 'string', optional: true, nullable: true, source: machineWire() },
      buildReportedAt: { type: 'isoDate', optional: true, nullable: true, source: machineWire() },
      versionState: { type: 'enum', optional: true, source: machineWire() },
      targetVersion: { type: 'string', optional: true, nullable: true, source: machineWire() },
      targetUnavailableReason: { type: 'string', optional: true, nullable: true, source: machineWire() },
    },
    relations: {},
    cold: { kind: 'never', why: 'The currently synced fleet stays resident, as before.' },
  },
  automation: {
    key: 'id',
    why: 'One scheduled definition shared by its list, card and editor.',
    components: { automation: { schema: 'AutomationWire', arrivesOn: 'replica:automations', joinKey: 'id', precedence: 0,
      why: 'The definition already arrives as one replica row.' } },
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
    components: { run: { schema: 'AutomationRunWire', arrivesOn: 'replica:automationRuns', joinKey: 'id', precedence: 0,
      why: 'Runs already arrive through sync; a history request selects IDs only.' } },
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
    cold: { kind: 'never', why: 'The currently synced run set stays resident; history windows keep only IDs.' },
  },
} satisfies Pick<ModelSchema, 'machine' | 'automation' | 'automationRun'>

registerModels(schema, { machine: MachineModel, automation: AutomationModel, automationRun: AutomationRunModel })
