import { useCommands, useRequestClient } from '@podium/client-core/react'
import { type AgentSetupPreferences, AgentSetupView } from '@podium/client-graph/agent-setup-view'
import { here } from '@podium/client-graph/lookup'
import { myPreferences } from '@podium/client-graph/per-user-records'
import { useEffect, useMemo } from 'react'
import { useMobilePool } from './mobile-pool'
import type { MobileTrpc } from './trpc'

/** Pickers read the panel's same items and groups without starting any setup work. */
export function useAgentSetupPicker(machineIds: readonly string[]): readonly AgentSetupView[] {
  const pool = useMobilePool()
  const client = useRequestClient<MobileTrpc>()
  const commands = useCommands<MobileTrpc>()
  const preferences = useMemo<AgentSetupPreferences>(
    () => ({
      credentialDefaults: () => (pool ? (myPreferences(pool)?.credentialDefaults ?? {}) : {}),
      saveCredentialDefaults: (next) =>
        commands.preferences.setPreferences({ credentialDefaults: next }),
      savedCredentials: () => [],
    }),
    [pool, commands],
  )
  // Membership only; machine facts stay on their shared models. A pending
  // lookup joins this opening as soon as its record becomes available.
  const key = machineIds.filter((id) => pool && here(pool.model('machine', id))).join('\n')
  const views = useMemo(
    () =>
      pool
        ? key
            .split('\n')
            .filter(Boolean)
            .flatMap((id) => {
              const machine = here(pool.model('machine', id))
              return machine
                ? [
                    new AgentSetupView({
                      machine,
                      client,
                      preferences,
                      origin: { kind: 'settings' },
                    }),
                  ]
                : []
            })
        : [],
    [pool, key, client, preferences],
  )
  useEffect(
    () => () => {
      for (const view of views) view.close()
    },
    [views],
  )
  return views
}
