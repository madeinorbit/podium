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
const catalog = { machines: [], repositories: [] }
pool.sources.register(['settingsWindow', 'settingsCatalog', 'settingsRepository'], {
  read(entity) {
    return entity === 'settingsWindow'
      ? { settingsTab: selected.get('page') ?? null }
      : entity === 'settingsCatalog'
        ? catalog
        : undefined
  },
  dispose() {},
})
export const useWorklistPool = () => pool
export function useWorklistPoolProjection<T>(read: (pool: MobxPool) => T) {
  const projection = useMemo(() => createPoolProjection(pool, read), [read])
  return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
}
const listeners = new Set<(keys: ReadonlySet<string>) => void>()
export const deviceState = {
  get: (key: string) => localStorage.getItem(`settings-harness:${key}`),
  set: (key: string, value: string | null) => {
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
function endpoint(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_, key) {
      return key === 'then' ? undefined : endpoint([...path, String(key)])
    },
    apply() {
      const key = path.join('.')
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
const client = {
  trpc,
  uiState: deviceState,
  owner: {},
  setSettingsTab,
  setPreferences: async () => {},
  setInstancePreferences: async () => {},
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
  if (path === '/auth/members/directory')
    return Response.json({ members, currentMemberId: member ? 'member' : 'demo' })
  if (path === '/auth/members/list')
    return Response.json({
      members,
      invites: [],
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
      signIns: [],
    })
  if (path === '/auth/admin/audit') return Response.json({ events: [], nextBefore: null })
  return Response.json({})
}) as typeof fetch
