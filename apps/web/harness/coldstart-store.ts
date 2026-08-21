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

const machine = {
  id: 'machine-a',
  name: 'Studio Mac',
  hostname: 'studio',
  online: true,
  lastSeenAt: new Date(0).toISOString(),
  inventory: {
    os: 'darwin' as const,
    arch: 'arm64' as const,
    agents: [{ kind: 'claude-code' as const, installed: true, login: { state: 'in' as const } }],
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
  uiState: {
    get: (key: string): string | null => rows.get(key) ?? null,
    set: (key: string, value: string | null): void => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
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
      get: {
        query: async () => ({
          sessionDefaults: { agent: 'claude-code' },
          gitWorkflow: { defaultParentBranch: 'main' },
        }),
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
