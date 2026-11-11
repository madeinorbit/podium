/** Isolated fixtures for the shipping settings view. No requests reach a server. */

import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import {
  asUserId,
  INSTANCE_PREFERENCES_ROW_ID,
  resolveInstancePreferences,
  resolveUserPreferences,
} from '@podium/model'
import { FEATURES } from '@podium/protocol'
import { observable, runInAction } from 'mobx'
import { useMemo, useSyncExternalStore } from 'react'
import { headerEntities } from '../../../packages/client-graph/src/header-entities'
import { liveFixture } from '../../../packages/client-graph/src/live-fixture'

const params = new URLSearchParams(location.search)
export const member = params.get('as') === 'member'
const selected = observable.map<string, string | null>([['page', params.get('page')]])
export const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
pool.apply({
  type: 'update',
  rows: [
    {
      kind: 'userPreferences',
      id: 'demo',
      value: { ...resolveUserPreferences(undefined, asUserId('demo')), id: 'demo' } as never,
    },
    {
      kind: 'instancePreferences',
      id: INSTANCE_PREFERENCES_ROW_ID,
      value: { ...resolveInstancePreferences(undefined), id: INSTANCE_PREFERENCES_ROW_ID } as never,
    },
  ],
})
const catalog: { machines: string[]; repositories: string[] } = { machines: [], repositories: [] }
pool.sources.register(['settingsWindow', 'settingsCatalog', 'settingsRepository', 'preference'], {
  read(entity, id) {
    return entity === 'settingsWindow'
      ? { settingsTab: selected.get('page') ?? null }
      : entity === 'settingsCatalog'
        ? catalog
        : entity === 'settingsRepository'
          ? repositories.find((repo) => repo.path === id)
          : entity === 'preference'
            ? { value: deviceState.get(id) }
            : undefined
  },
  dispose() {},
})
export const useWorklistPool = () => pool
export function useWorklistPoolProjection<T>(read: (pool: MobxPool) => T) {
  const projection = useMemo(() => createPoolProjection(pool, read), [read])
  return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
}
const deviceValues = observable.map<string, string | null>()
const listeners = new Set<(keys: ReadonlySet<string>) => void>()
export const deviceState = {
  get: (key: string) =>
    deviceValues.has(key)
      ? deviceValues.get(key)!
      : localStorage.getItem(`settings-harness:${key}`),
  set: (key: string, value: string | null) => {
    runInAction(() => deviceValues.set(key, value))
    if (value === null) localStorage.removeItem(`settings-harness:${key}`)
    else localStorage.setItem(`settings-harness:${key}`, value)
    for (const listener of listeners) listener(new Set([key]))
  },
  subscribe: (listener: (keys: ReadonlySet<string>) => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
pool.bindLayout({
  read: deviceState.get,
  write: (key, value) => deviceState.set(key, value as string | null),
  ready: () => true,
})
const live = liveFixture(pool)
live.outbox({ pending: 0, deadLetters: [] })
const repositories: {
  path: string
  repoId: string
  name: string
  prefix: string
  defaultParentBranch: string
  checkouts: unknown[]
}[] = []
const setupInfo = {
  configured: true,
  mode: 'server',
  networkOption: 'own-domain',
  publicUrl: 'https://podium.example.com',
  port: 18787,
  appVersion: '0.3.1',
  transcriptLake: 'off',
  bindHost: '0.0.0.0',
}
const answers: Record<string, unknown> = {
  'settings.viewer.query': {
    permitted: {
      'records.userPreferences.edit': true,
      ...(!member && { 'records.instancePreferences.edit': true, 'settings.setSecret': true }),
    },
  },
  'settings.secretPresence.query': [],
  'settings.telegramBotPresence.query': false,
  'accounts.list.query': [],
  'accounts.keys.query': [],
  'auth.profile.query': { email: member ? 'member@example.com' : 'admin@example.com' },
  'auth.status.query': {
    configured: true,
    loginRequired: true,
    hasPassword: true,
    canManageInstance: !member,
  },
  'auth.mobileSessions.query': [],
  'setup.info.query': setupInfo,
  'setup.provenance.query': {},
  'setup.options.query': [
    { id: 'own-domain', label: 'Own domain', description: 'A stable address for this workspace.' },
  ],
  'setup.commandFor.query': {},
  'setup.channel.query': { channel: 'stable', envForced: false },
  'operations.history.query': [],
  'updates.checkSpace.query': { machines: [] },
  'telemetry.state.query': {
    usage: 'off',
    crash: 'off',
    endpoint: 'https://telemetry.example.com',
    installId: 'demo',
  },
  'telemetry.preview.query': { version: '0.3.1', os: 'linux', machines: 0 },
}
const calls: { key: string; input?: unknown }[] = []
Object.assign(window, { settingsHarness: { calls, pool } })
function endpoint(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_, key) {
      return key === 'then' ? undefined : endpoint([...path, String(key)])
    },
    apply(_, __, args) {
      const key = path.join('.')
      calls.push({ key, input: args[0] })
      if (params.get('write') === 'error' && path.at(-1) === 'mutate')
        return Promise.reject(new Error('This change could not be saved. Try again.'))
      if (key === 'auth.setDisplayName.mutate')
        Object.assign(answers['auth.profile.query'] as object, args[0])
      if (key === 'auth.setEmail.mutate')
        Object.assign(answers['auth.profile.query'] as object, { email: args[0].email })
      if (key === 'setup.setChannel.mutate')
        answers['setup.channel.query'] = {
          ...(answers['setup.channel.query'] as object),
          ...args[0],
        }
      if (key === 'setup.setChannel.mutate') return Promise.resolve(answers['setup.channel.query'])
      return Promise.resolve(answers[key] ?? {})
    },
  })
}
export const trpc = endpoint() as never
const setSettingsTab = (page: string | null) => {
  runInAction(() => selected.set('page', page))
  history.pushState(
    null,
    '',
    page ? `/settings/${page}${location.search}` : `/settings${location.search}`,
  )
}
const noop = () => {}
function updatePreferences(
  kind: 'userPreferences' | 'instancePreferences',
  id: string,
  patch: object,
) {
  if (params.get('write') === 'error') throw new Error('This change could not be saved. Try again.')
  calls.push({ key: kind, input: patch })
  const previous = pool.row(kind, id)
  pool.apply({
    type: 'update',
    rows: [{ kind, id, value: { ...(previous as object), ...patch } as never }],
  })
}
const client = {
  trpc,
  uiState: deviceState,
  owner: {},
  setSettingsTab,
  setPreferences: async (patch: object) => updatePreferences('userPreferences', 'demo', patch),
  setInstancePreferences: async (patch: object) =>
    updatePreferences('instancePreferences', INSTANCE_PREFERENCES_ROW_ID, patch),
  setView: noop,
  navigateToSession: noop,
}
export const useSettingsClient = () => client as never
export const useSettingsTrpc = () => trpc
export const useFeature = () => false
export const useFeaturesState = () => ({
  channel: 'edge',
  devMode: false,
  flags: FEATURES.map((flag) => ({
    ...flag,
    listed: flag.visibility === 'stable' || flag.visibility === 'edge',
    enabled: false,
    locked: false,
  })),
})
export const useDeviceState = () => deviceState
export const useRequestClient = () => trpc
export const useUi = () => ({ setSettingsTab, setView: noop })
export const useClientRuntime = () => ({})
export const useCommands = () => ({ machines: { rename: noop, setUpdateChannel: noop } })
export const useModelCatalog = () => ({})
export const useModelCatalogState = () => ({ catalog: {}, status: 'unavailable' })
export const useHarnessDescriptors = () => ({ served: undefined, status: 'unavailable' })
const updates = {
  fleet: {
    appVersion: '0.3.1',
    machines: [],
    allMachines: [],
    targetVersion: null,
    channelChecks: [],
  },
  active: [],
  proposal: null,
  fleetError: null,
  watch: () => noop,
  refresh: async () => {},
  waitFor: async () => {},
}
export const updateStatus = () => updates
const members = [
  { id: 'demo', displayName: 'Alex Morgan', email: 'admin@example.com', role: 'admin' },
  { id: 'member', displayName: 'Sam Lee', email: 'member@example.com', role: 'member' },
]
const populated = params.has('populated')
const signIns = populated
  ? [
      {
        id: 'session-browser',
        memberId: 'demo',
        memberName: 'Alex Morgan',
        kind: 'login',
        deviceName: 'Work browser',
        platform: 'linux',
        createdAt: '2026-11-11T08:00:00Z',
        lastSeenAt: '2026-11-11T10:30:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      {
        id: 'session-phone',
        memberId: 'member',
        memberName: 'Sam Lee',
        kind: 'mobile',
        deviceName: 'Sam’s phone',
        platform: 'ios',
        createdAt: '2026-11-10T08:00:00Z',
        lastSeenAt: '2026-11-11T10:15:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    ]
  : []
if (populated) {
  Object.assign(answers['auth.profile.query'] as object, members[member ? 1 : 0])
  Object.assign(answers['auth.status.query'] as object, { hasOwnCredential: true })
  answers['accounts.list.query'] = [
    {
      id: 'native:claude-code',
      provider: 'anthropic',
      source: 'native',
      harness: 'claude-code',
      status: 'connected',
      identity: 'alex@example.com',
      identityFingerprint: 'demo-claude',
      machines: ['Studio'],
      useOnMyMachines: true,
      loginMachines: [{ id: 'studio', name: 'Studio' }],
    },
    {
      id: 'native:codex',
      provider: 'openai',
      source: 'native',
      harness: 'codex',
      status: 'not-configured',
      loginRequired: true,
      loginMachines: [
        { id: 'studio', name: 'Studio' },
        { id: 'builder', name: 'Build machine' },
      ],
    },
    ...['anthropic', 'openai', 'openrouter'].map((provider) => ({
      id: `managed:${provider}`,
      source: 'managed',
      kind: 'api-key',
      provider,
      status: provider === 'openai' ? 'not-configured' : 'connected',
      credentialSource: provider === 'anthropic' ? 'shared' : 'stored',
      sharedBy: 'member',
      identity: 'sk-…demo',
      sharing: { everyone: false, users: [] },
      sentTo: [],
      sendableTo: [{ id: 'builder', name: 'Build machine' }],
    })),
    {
      id: 'managed:claude-oauth',
      source: 'managed',
      kind: 'oauth',
      provider: 'anthropic',
      status: 'not-configured',
    },
  ]
  const machines = [
    {
      id: 'studio',
      name: 'Studio',
      custodian: member ? 'member' : 'demo',
      owned: true,
      transferable: true,
      hostsServer: true,
      use: 'granted',
      online: true,
      appVersion: '0.3.1',
    },
    {
      id: 'builder',
      name: 'Build machine',
      custodian: 'demo',
      owned: !member,
      transferable: !member,
      use: 'granted',
      online: true,
      appVersion: '0.3.1',
    },
    {
      id: 'laptop',
      name: 'Travel laptop',
      custodian: member ? 'member' : 'demo',
      owned: true,
      transferable: true,
      use: 'granted',
      online: false,
      appVersion: '0.3.0',
    },
  ]
  catalog.machines.push(...machines.map((m) => m.id))
  repositories.push({
    path: '/workspace/podium',
    repoId: 'repo-podium',
    name: 'Podium',
    prefix: 'POD',
    defaultParentBranch: 'main',
    checkouts: [{ machineId: 'studio', path: '/workspace/podium', branch: 'main', worktrees: [] }],
  })
  catalog.repositories.push(...repositories.map((repo) => repo.path))
  pool.apply({
    type: 'update',
    rows: machines.map((machine) => ({
      kind: 'machine',
      id: machine.id,
      value: {
        ...machine,
        hostname: `${machine.id}.example.com`,
        os: 'linux',
        arch: 'x64',
        loggedOutHarnesses: [],
        grants: [],
        serviceAssignment: { server: machine.id === 'studio', agentExecution: true },
        services: {
          server: { policy: 'enabled', state: 'available' },
          agentExecution: { policy: 'enabled', state: 'available' },
        },
        installedAgents: [],
      } as never,
    })),
  })
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'repo',
        id: 'repo-podium',
        value: {
          id: 'repo-podium',
          name: 'Podium',
          prefix: 'POD',
          defaultParentBranch: 'main',
          path: '/workspace/podium',
        } as never,
      },
    ],
  })
  headerEntities(pool).apply([
    {
      kind: 'repository',
      id: 'scan-podium',
      value: {
        kind: 'repository',
        repoId: 'repo-podium',
        machineId: 'studio',
        path: '/workspace/podium',
        name: 'Podium',
        originUrl: 'https://example.com/team/podium.git',
        branch: 'main',
        worktrees: [],
      } as never,
    },
  ])
  headerEntities(pool).order('repository', ['scan-podium'])
  for (const machine of machines) live.online(machine.id, machine.online)
  updates.fleet.machines = machines.map((m) => ({
    ...m,
    version: m.appVersion,
    state: 'current',
    busy: false,
  })) as never
  updates.fleet.allMachines = updates.fleet.machines
}
window.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(String(input), location.href).pathname
  if (path === '/auth/admin/viewer') {
    if (params.get('viewer') === 'slow') await new Promise((resolve) => setTimeout(resolve, 4000))
    if (params.get('viewer') === 'error')
      return Response.json({ error: 'Unavailable' }, { status: 503 })
    return Response.json({
      sections: member ? [] : ['people', 'access', 'machines', 'instance', 'audit'],
    })
  }
  if (path === '/auth/client-sessions')
    return Response.json({
      sessions: populated
        ? [
            {
              sessionId: 'demo-browser-session-0001',
              userId: member ? 'member' : 'demo',
              label: 'login',
              deviceId: 'browser-device',
              kind: 'browser',
              deviceName: 'This browser',
              platform: 'linux',
              createdAt: '2026-11-11T08:00:00Z',
              lastSeenAt: '2026-11-11T10:30:00Z',
              expiresAt: '2099-01-01T00:00:00Z',
              current: true,
            },
          ]
        : [],
    })
  if (path === '/auth/members/directory')
    return Response.json({ members, currentMemberId: member ? 'member' : 'demo' })
  if (path === '/auth/members/list')
    return Response.json({
      members,
      invites: populated
        ? [
            {
              id: 'invite',
              email: 'new-member@example.com',
              role: 'member',
              expiresAt: '2099-01-01T00:00:00Z',
            },
          ]
        : [],
      currentMemberId: 'demo',
      mailAvailable: false,
      hasOwnCredential: true,
      actions: { demo: [], member: ['setRole', 'disable', 'remove', 'recovery'] },
    })
  if (path === '/auth/admin/access')
    return Response.json({
      admission: {
        mode: 'invitation',
        signInRequired: true,
        openInvites: 0,
        expiredInvites: 0,
        activeMembers: 2,
        disabledMembers: 0,
      },
      signIns,
    })
  if (path === '/auth/admin/audit')
    return Response.json({
      events: populated
        ? [
            {
              id: 2,
              at: '2026-11-11T10:30:00Z',
              command: 'members.setRole',
              result: 'refused',
              actor: { kind: 'member', id: 'demo', name: 'Alex Morgan' },
              target: { kind: 'member', id: 'demo', name: 'Alex Morgan' },
              facts: {},
            },
            {
              id: 1,
              at: '2026-11-11T09:30:00Z',
              command: 'members.invite',
              result: 'applied',
              actor: { kind: 'member', id: 'demo', name: 'Alex Morgan' },
              target: { kind: 'invite', id: 'invite', name: 'New member' },
              facts: { role: 'member' },
            },
          ]
        : [],
      nextBefore: null,
    })
  return Response.json({})
}) as typeof fetch
Object.assign(window, { settingsHarness: { calls, pool, deviceState, navigate: setSettingsTab } })
