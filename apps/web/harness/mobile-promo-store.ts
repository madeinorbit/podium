/**
 * The one dependency the two mobile-handoff surfaces have on the shell: the
 * issue list (their gate), the `trpc.setup.info` probe (their URL) and the
 * ui-state collection (the dismissal). Stubbed here so the harness renders the
 * REAL components against the REAL stylesheet with no server behind them.
 */

const rows = new Map<string, string>()
const listeners = new Set<() => void>()

export const useReplicaIssues = (): Array<{ deletedAt?: string }> => [{}]

export const useStoreSelector = <T>(selector: (store: unknown) => T): T =>
  selector({
    trpc: {
      setup: { info: { query: async () => ({ publicUrl: 'https://podium.example.com' }) } },
    },
    uiState: {
      get: (key: string) => rows.get(key) ?? null,
      set: (key: string, value: string | null) => {
        if (value === null) rows.delete(key)
        else rows.set(key, value)
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })
