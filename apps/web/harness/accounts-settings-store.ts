/**
 * SETTINGS → ACCOUNTS & KEYS, WITH NO SERVER (POD-6390).
 *
 * `vite.accounts-settings-harness.config.ts` points the section's pool, tRPC and
 * member-directory imports here. The pool is a real `MobxPool`; `accounts.list`,
 * `accounts.keys` and `accounts.share` answer from the rows below, and a share
 * writes back, so the sharing editor can be driven end to end.
 *
 * `?scene=` picks the viewer: `admin` (default; reads the member list and every
 * member's keys) or `member` (the member list is refused, as the server does).
 * `custody` keeps the member-owned native login, D11 opt-in and explicit send
 * to a shared machine scenarios (POD-6300, POD-6301).
 */
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { AccountView } from '@podium/model'
import { asMachineId } from '@podium/model/browser'
import { useMemo, useSyncExternalStore } from 'react'

export type SceneName = 'admin' | 'member' | 'custody'
export const sceneName = (): SceneName => {
  const scene = new URLSearchParams(location.search).get('scene')
  return scene === 'member' || scene === 'custody' ? scene : 'admin'
}

const ME = sceneName() === 'admin' ? 'user:robin' : sceneName() === 'custody' ? 'user:bob' : 'user:ana'
const sharedMachine = { id: asMachineId('machine-alice'), name: 'alice-desk' }
const sent = new Set<string>()
let ticked = false
const MEMBERS = [
  { id: 'user:robin', displayName: 'Robin Keller', email: 'robin@example.com', role: 'admin' },
  { id: 'user:ana', displayName: 'Ana Sousa', email: 'ana@example.com', role: 'member' },
  { id: 'user:ben', displayName: 'Ben Okafor', email: 'ben@example.com', role: 'member' },
  { id: 'user:chen', displayName: 'Chen Wei', email: 'chen@example.com', role: 'member' },
]

type Sharing = { everyone: boolean; users: string[] }
interface Key {
  owner: string
  id: string
  provider: string
  kind: 'api-key' | 'oauth'
  identity: string
  sharing: Sharing
}
const KEYS: Key[] = [
  {
    owner: 'user:robin',
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    identity: 'sk-ant-…f9x2',
    sharing: { everyone: false, users: ['user:ana', 'user:ben'] },
  },
  {
    owner: 'user:robin',
    id: 'managed:claude-oauth',
    provider: 'anthropic',
    kind: 'oauth',
    identity: 'sk-ant-oat01-…a1b2',
    sharing: { everyone: true, users: [] },
  },
  {
    owner: 'user:ana',
    id: 'managed:openai',
    provider: 'openai',
    kind: 'api-key',
    identity: 'sk-proj-…77qe',
    sharing: { everyone: false, users: [] },
  },
  {
    owner: 'user:chen',
    id: 'managed:openrouter',
    provider: 'openrouter',
    kind: 'api-key',
    identity: 'sk-or-…c0de',
    sharing: { everyone: false, users: ['user:ana'] },
  },
]

if (sceneName() === 'custody') {
  KEYS.push({
    owner: ME,
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    identity: 'sk-a…1111',
    sharing: { everyone: false, users: [] },
  })
}

const isSharedWith = (key: Key, user: string) =>
  key.sharing.everyone || key.sharing.users.includes(user)

/** `accounts.list` as the viewer sees it: own key, else one shared with them. */
function list(): AccountView[] {
  const native: AccountView[] = [
    {
      id: 'native:claude-code',
      provider: 'anthropic',
      source: 'native',
      harness: 'claude-code',
      status: 'connected',
      identity: ME === 'user:robin' ? 'robin@example.com' : ME === 'user:bob' ? 'bob@example.com' : 'ana@example.com',
      machines: ME === 'user:robin' ? ['ludovico', 'flatblock'] : ME === 'user:bob' ? ['bob-laptop'] : ['ana-laptop'],
      loginMachines: [{ id: asMachineId(`machine-${ME.slice(5)}`), name: `${ME.slice(5)}-laptop` }],
    },
    {
      id: 'native:codex',
      provider: 'openai',
      source: 'native',
      harness: 'codex',
      status: sceneName() === 'custody' ? 'connected' : 'not-configured',
      ...(sceneName() === 'custody' ? {
        identity: 'bob@example.com',
        identityFingerprint: 'fp-bob-codex',
        machines: ['bob-laptop'],
        loginMachines: [{ id: asMachineId('machine-bob'), name: 'bob-laptop' }],
        useOnMyMachines: ticked,
        keptOn: ticked ? [{ id: asMachineId('machine-bob-desk'), name: 'bob-desk' }] : [],
      } : {}),
    },
  ]
  const managed = [
    'managed:anthropic',
    'managed:openai',
    'managed:openrouter',
    'managed:claude-oauth',
  ].map((id): AccountView => {
    const provider = id === 'managed:claude-oauth' ? 'anthropic' : id.slice('managed:'.length)
    const kind = id === 'managed:claude-oauth' ? 'oauth' : 'api-key'
    const base = { id, provider, source: 'managed' as const, kind: kind as 'api-key' | 'oauth' }
    const own = KEYS.find((key) => key.owner === ME && key.id === id)
    if (own)
      return {
        ...base,
        identity: own.identity,
        status: 'connected',
        credentialSource: 'stored',
        sharing: own.sharing,
        sentTo: sceneName() === 'custody' && sent.has(id) ? [sharedMachine] : [],
        sendableTo: sceneName() === 'custody' && !sent.has(id) ? [sharedMachine] : [],
      }
    const shared = KEYS.find((key) => key.owner !== ME && key.id === id && isSharedWith(key, ME))
    if (shared)
      return {
        ...base,
        identity: shared.identity,
        status: 'connected',
        credentialSource: 'shared',
        sharedBy: shared.owner,
      }
    return { ...base, status: 'not-configured' }
  })
  return [...native, ...managed]
}

const later = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), 60))

const trpc = {
  accounts: {
    list: { query: () => later(list()) },
    keys: {
      mutate: () =>
        sceneName() === 'admin'
          ? later(KEYS)
          : Promise.reject(new Error('accounts.keys is not permitted for this caller')),
    },
    send: {
      mutate: async (input: { id: string; machineId: string; acknowledgeSharedMachine: boolean }) => {
        if (!KEYS.some((key) => key.owner === ME && key.id === input.id)) throw new Error('no such stored key')
        if (sceneName() !== 'custody' || input.machineId !== sharedMachine.id || !input.acknowledgeSharedMachine) {
          throw new Error('Shared machine consent required')
        }
        sent.add(input.id)
        return later({ ok: true as const, sent: true as const })
      },
    },
    useOnMyMachines: {
      mutate: async (input: { enabled: boolean }) => {
        ticked = input.enabled
        return later({ ok: true as const, enabled: input.enabled })
      },
    },
    share: {
      mutate: async (input: {
        id: string
        owner?: string
        everyone: boolean
        users?: string[]
      }) => {
        const owner = input.owner ?? ME
        if (owner !== ME && sceneName() !== 'admin') throw new Error('no such stored key')
        const key = KEYS.find((k) => k.owner === owner && k.id === input.id)
        if (!key) throw new Error('no such stored key')
        key.sharing = { everyone: input.everyone, users: input.users ?? [] }
        return later({ ok: true as const })
      },
    },
    connect: { mutate: () => later({ id: 'x' }) },
    disconnect: { mutate: () => later({ ok: true as const }) },
    login: { mutate: () => later({ sessionId: 'login' }) },
  },
}

export async function memberRequest<T>(_origin: string, action: string): Promise<T> {
  if (action !== 'list' || sceneName() !== 'admin') throw new Error('Administrator required')
  return later({
    members: MEMBERS,
    invites: [],
    mailAvailable: false,
    currentMemberId: ME,
  }) as Promise<T>
}

const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
export const useWorklistPool = (): MobxPool | null => pool
export function useWorklistPoolProjection<T>(read: (pool: MobxPool) => T): T {
  const projection = useMemo(() => createPoolProjection(pool, read), [read])
  return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
}
export const useSettingsTrpc = () => trpc as never
export const useSettingsClient = () =>
  ({ trpc: trpc as never, navigateToSession: () => {} }) as never
