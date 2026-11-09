import { lazy } from '@podium/mobx-helpers'
import type { AccountView, GitRepositoryWire, MemberView } from '@podium/model'
import { machinePathBasename, repoNameFromOrigin } from '@podium/model/browser'
import type { MobileClientSession } from '@podium/protocol'
import { EntityModel, type ModelHost, registerModels } from './models'
import type { EntitySpec, FieldSpec, ModelSchemaName, RowArrival } from './shared/schema'

export class AccountModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('account', id, host)
  }
}
export interface AccountModel extends Readonly<AccountView> {}
export class MemberModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('member', id, host)
  }
}
export interface MemberModel extends Readonly<MemberView> {}
export class DeviceModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('device', id, host)
  }
}
export interface DeviceModel extends Readonly<MobileClientSession> {}
/** Existing per-machine scan storage, now read through the pool's model identity. */
export class RepositoryModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('repository', id, host)
  }
  @lazy get name(): string {
    return repoNameFromOrigin(this.originUrl) ?? (machinePathBasename(this.path) || this.path)
  }
}
export interface RepositoryModel extends Readonly<GitRepositoryWire> {}

function record(
  schema: ModelSchemaName,
  arrivesOn: RowArrival,
  key: string,
  fields: Readonly<Record<string, FieldSpec['type']>>,
  optional: readonly string[] = [],
  nullable: readonly string[] = [],
): EntitySpec {
  return {
    key,
    components: {},
    relations: {},
    cold: {
      kind: 'never',
      why: 'Only the requested working set is resident in the principal-owned pool.',
    },
    why: 'One shared identity for a public requested record.',
    fields: Object.fromEntries(
      Object.entries(fields).map(([property, type]) => [
        property,
        {
          type,
          ...(optional.includes(property) ? { optional: true } : {}),
          ...(nullable.includes(property) ? { nullable: true } : {}),
          source: { schema, arrivesOn },
        },
      ]),
    ),
  }
}
registerModels(
  {
    account: record(
      'AccountView',
      'request:accounts.list',
      'id',
      {
        // Identity and authentication availability
        id: 'id',
        provider: 'string',
        source: 'enum',
        kind: 'enum',
        harness: 'enum',
        identity: 'string',
        identityFingerprint: 'string',
        status: 'enum',
        credentialSource: 'enum',
        // Per-user managed key sharing
        sharing: 'object',
        sharedBy: 'string',
        // Machine/login observations
        machines: 'object',
        serverAi: 'object',
        loginRequired: 'boolean',
        loginMachines: 'object',
        loginAttempt: 'object',
        // Where the viewer's own managed connection runs beyond their machines (POD-6300)
        sentTo: 'object',
        sendableTo: 'object',
        // The D11 box on a native login, and where a different login was kept (POD-6301)
        useOnMyMachines: 'boolean',
        keptOn: 'object',
      },
      [
        'kind',
        'harness',
        'identity',
        'identityFingerprint',
        'credentialSource',
        'sharing',
        'sharedBy',
        'machines',
        'serverAi',
        'loginRequired',
        'loginMachines',
        'loginAttempt',
        'sentTo',
        'sendableTo',
        'useOnMyMachines',
        'keptOn',
      ],
    ),
    member: record(
      'MemberView',
      'request:members.list',
      'id',
      {
        id: 'id',
        displayName: 'string',
        email: 'string',
        role: 'string',
        accountId: 'id',
        avatar: 'string',
        createdAt: 'isoDate',
        disabledAt: 'isoDate',
      },
      ['accountId', 'avatar', 'createdAt', 'disabledAt'],
      ['email', 'accountId', 'avatar', 'disabledAt'],
    ),
    device: record(
      'MobileClientSession',
      'request:auth.mobileSessions',
      'sessionId',
      {
        sessionId: 'id',
        userId: 'id',
        label: 'string',
        deviceId: 'id',
        deviceName: 'string',
        platform: 'enum',
        createdAt: 'isoDate',
        expiresAt: 'isoDate',
        lastSeenAt: 'isoDate',
        current: 'boolean',
      },
      [],
      ['lastSeenAt'],
    ),
    repository: (() => {
      const scan = record(
        'GitRepositoryWire',
        'engine:repos',
        'id',
        {
          path: 'string',
          kind: 'enum',
          branch: 'string',
          originUrl: 'string',
          repoId: 'id',
          machineId: 'id',
          worktrees: 'object',
        },
        ['branch', 'originUrl', 'repoId', 'machineId'],
      )
      // Per-machine scans use the source's identity, independent of their path.
      return {
        ...scan,
        fields: {
          ...scan.fields,
          id: { type: 'id', source: { schema: 'RequestRecordKey', arrivesOn: 'engine:repos' } },
        },
      }
    })(),
  },
  {
    account: AccountModel,
    member: MemberModel,
    device: DeviceModel,
    repository: RepositoryModel,
  },
)
