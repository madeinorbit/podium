import type { AccountView, MemberView, GitRepositoryWire } from '@podium/model'
import { machinePathBasename, repoNameFromOrigin } from '@podium/model/browser'
import type { MobileClientSession } from '@podium/protocol'
import type { PodiumClientApi } from '@podium/client-core/api'
type PodiumSettings = Awaited<ReturnType<PodiumClientApi['settings']['get']['query']>>
import { lazy } from '@podium/mobx-helpers'
import { EntityModel, registerModels, type ModelHost } from './models'
import type { EntitySpec, FieldSpec, ModelSchemaName, RowArrival } from './shared/schema'

export class AccountModel extends EntityModel {
  constructor(id: string, host: ModelHost) { super('account', id, host) }
}
export interface AccountModel extends Readonly<AccountView> {}
export class MemberModel extends EntityModel {
  constructor(id: string, host: ModelHost) { super('member', id, host) }
}
export interface MemberModel extends Readonly<MemberView> {}
export class DeviceModel extends EntityModel {
  constructor(id: string, host: ModelHost) { super('device', id, host) }
}
export interface DeviceModel extends Readonly<MobileClientSession> {}
export class PodiumSettingsModel extends EntityModel {
  constructor(id: string, host: ModelHost) { super('podiumSettings', id, host) }
}
export interface PodiumSettingsModel extends Readonly<PodiumSettings> {}
/** Existing per-machine scan storage, now read through the pool's model identity. */
export class RepositoryModel extends EntityModel {
  constructor(id: string, host: ModelHost) { super('repository', id, host) }
  @lazy get name(): string { return repoNameFromOrigin(this.originUrl) ?? (machinePathBasename(this.path) || this.path) }
}
export interface RepositoryModel extends Readonly<GitRepositoryWire> {}

function record(schema: ModelSchemaName, arrivesOn: RowArrival, key: string,
  fields: Readonly<Record<string, FieldSpec['type']>>, optional: readonly string[] = []): EntitySpec {
  return {
    key, components: {}, relations: {},
    cold: { kind: 'never', why: 'Only the requested working set is resident in the principal-owned pool.' },
    why: 'One shared identity for a public requested record.',
    fields: Object.fromEntries(Object.entries(fields).map(([property, type]) => [property, {
      type, ...(optional.includes(property) ? { optional: true } : {}), source: { schema, arrivesOn },
    }])),
  }
}
const settingsFields = {
  // Role and personal preferences
  roles: 'object', sidebar: 'object', notifications: 'object', autoContinue: 'object',
  // Instance policy; requests keep the existing settings classification/transport
  hibernation: 'object', gitWorkflow: 'object', issues: 'object', steward: 'object',
  experimental: 'object', worktreeGc: 'object', transcripts: 'object', deployment: 'object',
  // Legacy public redaction returned by settings.get (never persisted by this pool)
  apiKeys: 'object', integrations: 'object',
} as const
const settingsBase = record('PodiumSettings', 'request:settings.get', 'id', settingsFields)
const settings: EntitySpec = { ...settingsBase, fields: { ...settingsBase.fields, id: { type: 'id', source: { schema: 'RequestRecordKey', arrivesOn: 'request:settings.get' } } } }
registerModels({
  account: record('AccountView', 'request:accounts.list', 'id', {
    // Identity and authentication availability
    id: 'id', provider: 'string', source: 'enum', kind: 'enum', harness: 'enum', identity: 'string',
    identityFingerprint: 'string', status: 'enum', credentialSource: 'enum',
    // Machine/login observations
    machines: 'object', serverAi: 'object', loginRequired: 'boolean', loginMachines: 'object', loginAttempt: 'object',
  }, ['kind', 'harness', 'identity', 'identityFingerprint', 'credentialSource', 'machines', 'serverAi', 'loginRequired', 'loginMachines', 'loginAttempt']),
  member: record('MemberView', 'request:members.list', 'id', {
    id: 'id', displayName: 'string', email: 'string', role: 'string', accountId: 'id', avatar: 'string',
    createdAt: 'isoDate', disabledAt: 'isoDate',
  }, ['accountId', 'avatar', 'createdAt', 'disabledAt']),
  device: record('MobileClientSession', 'request:auth.mobileSessions', 'sessionId', {
    sessionId: 'id', userId: 'id', label: 'string', deviceId: 'id', deviceName: 'string', platform: 'enum',
    createdAt: 'isoDate', expiresAt: 'isoDate', lastSeenAt: 'isoDate', current: 'boolean',
  }),
  podiumSettings: settings,
  repository: record('GitRepositoryWire', 'engine:repos', 'path', {
    path: 'string', kind: 'enum', branch: 'string', originUrl: 'string', repoId: 'id', machineId: 'id', worktrees: 'object',
  }, ['branch', 'originUrl', 'repoId', 'machineId']),
}, { account: AccountModel, member: MemberModel, device: DeviceModel, podiumSettings: PodiumSettingsModel, repository: RepositoryModel })
