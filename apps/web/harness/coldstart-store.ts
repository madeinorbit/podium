/**
 * A STUBBED STORE, so the REAL cold-start composer renders in a real browser
 * (POD-1203).
 *
 * Aliased over `@/app/store` by `vite.coldstart.config.ts`. Everything above it
 * — ColdStartComposer, PropertyMenu, the model/effort pickers, the attachment
 * strip and the shipping stylesheet — is exactly what ships; only the data
 * underneath is invented. That is the point: a screenshot of a re-implementation
 * proves nothing about the thing that ships.
 *
 * `sessions.uploadImage` answers like the daemon does (an absolute path on the
 * machine that took the bytes) so a picked file walks the whole chip state
 * machine, `uploading` → `ready`, in front of the camera.
 */
type Selector<T> = (store: unknown) => T

/** The composer persists its draft through ui-state; a `get: () => null` stub
 *  makes the box permanently forget what was typed, which the fold now depends
 *  on (an unlaunched prompt must come back UNFOLDED). */
const rows = new Map<string, string>()
const listeners = new Set<() => void>()

const harness = new URLSearchParams(location.search).get('agent') ?? 'claude-code'

const machine = {
  id: 'machine-a',
  name: 'Studio Mac',
  hostname: 'studio',
  online: true,
  lastSeenAt: new Date(0).toISOString(),
  inventory: {
    os: 'darwin' as const,
    arch: 'arm64' as const,
    agents: ['claude-code', 'codex', 'grok', 'opencode', 'cursor'].map((kind) => ({
      kind: kind as 'claude-code',
      installed: true,
      login: { state: 'in' as const },
    })),
    tools: [],
  },
}

const store = {
  repos: [
    {
      path: '/work/podium',
      kind: 'repository' as const,
      branch: 'main',
      worktrees: [],
      machineId: machine.id,
    },
  ],
  machines: [machine],
  sessions: [],
  uiState: {
    get: (key: string): string | null => rows.get(key) ?? null,
    set: (key: string, value: string | null): void => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
      for (const listener of listeners) listener()
    },
    // The composer SUBSCRIBES to its draft key (POD-1469) — without this the
    // harness box would not render a single character that was typed into it.
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
  focusIssueSession: async () => null,
  // POD-1469: a promptless Launch starts the agent instead of creating a
  // mission, so the harness has to carry the four store writes that path makes
  // — otherwise the shot of the closed box is of a button that would throw.
  spawnDraftAgent: () => ({ sessionId: 'session-harness', issueId: 'issue-harness' }),
  setSelectedIssueId: () => {},
  setSelectedWorktree: () => {},
  setPane: () => {},
  setView: () => {},
  trpc: {
    settings: {
      // `roles.coding` is what the box reads to open on the operator's harness
      // (POD-1469), and `?agent=codex` is how the harness shows that the chip's
      // glyph follows the selection rather than being Claude's clay forever.
      get: {
        query: async () => ({
          roles: { coding: { accountId: `native:${harness}` } },
          gitWorkflow: { defaultParentBranch: 'main' },
        }),
      },
      updatePersonal: {
        mutate: async () => ({ roles: { coding: { accountId: `native:${harness}` } } }),
      },
    },
    issues: {
      create: { mutate: async () => ({ id: 'issue-harness' }) },
      start: { mutate: async () => ({ id: 'issue-harness' }) },
    },
    sessions: {
      uploadImage: {
        mutate: async (input: { filename: string }) => {
          await new Promise((r) => setTimeout(r, 400))
          return { path: `/home/podium/.podium/uploads/coldstart/${input.filename}` }
        },
      },
    },
  },
}

export function useStoreSelector<T>(selector: Selector<T>): T {
  return selector(store)
}
