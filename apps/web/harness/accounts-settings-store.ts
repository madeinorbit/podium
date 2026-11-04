/**
 * SETTINGS → ACCOUNTS, REAL, WITH NO SERVER (POD-6300).
 *
 * The section reads its rows through the shared pool (`useWorklistPool`) and
 * calls the server through `useSettingsTrpc`; `vite.accounts-settings-harness.config.ts`
 * points both imports here. `accounts.list` answers as the server does for Bob,
 * a member who holds `use` on Alice's machine: his own Anthropic key, not yet
 * sent anywhere. `accounts.send` records the send, so the list then says where
 * it runs.
 */
import { MobxPool } from '@podium/client-graph/pool'
import type { AccountView } from '@podium/model'
import { asMachineId } from '@podium/model/browser'

const alice = { id: asMachineId('machine-alice'), name: 'alice-desk' }
let sent = false

const rows = (): AccountView[] => [
  {
    id: 'native:claude-code',
    provider: 'anthropic',
    source: 'native',
    harness: 'claude-code',
    identity: 'bob@example.com',
    machines: ['bob-laptop'],
    status: 'connected',
    loginMachines: [{ id: asMachineId('machine-bob'), name: 'bob-laptop' }],
  },
  {
    id: 'managed:anthropic',
    provider: 'anthropic',
    source: 'managed',
    kind: 'api-key',
    identity: 'sk-a…1111',
    status: 'connected',
    credentialSource: 'stored',
    sentTo: sent ? [alice] : [],
    sendableTo: sent ? [] : [alice],
  },
  {
    id: 'managed:openai',
    provider: 'openai',
    source: 'managed',
    kind: 'api-key',
    status: 'not-configured',
  },
  {
    id: 'managed:claude-oauth',
    provider: 'anthropic',
    source: 'managed',
    kind: 'oauth',
    status: 'not-configured',
  },
]

const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
export const useWorklistPool = (): MobxPool | null => pool
/** The section's projections (e.g. "is the login PTY present") over the pool. */
export const useWorklistPoolProjection = <T>(read: (pool: MobxPool) => T, _fallback: T): T =>
  read(pool)

const trpc = {
  accounts: {
    list: { query: async () => rows() },
    send: {
      async mutate() {
        await new Promise((resolve) => setTimeout(resolve, 250))
        sent = true
        return { ok: true, sent: true }
      },
    },
    connect: { mutate: async () => ({ id: 'managed:openai' }) },
    disconnect: { mutate: async () => ({ ok: true }) },
    login: { mutate: async () => undefined },
  },
}

export const useSettingsTrpc = () => trpc as never
export const useSettingsClient = () => ({ trpc, navigateToSession: () => {} }) as never
