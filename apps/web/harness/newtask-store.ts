/**
 * A STUBBED STORE, so the REAL New Task composer renders in a real browser
 * (POD-1285).
 *
 * Aliased over `@/app/store` by `vite.newtask.config.ts`. Everything above it —
 * `NewIssueDialog`, `PropertyMenu`, the model/effort pickers, the machine menu
 * and the shipping stylesheet — is exactly what ships; only the data underneath
 * is invented.
 *
 * The fleet is picked to exercise every reading the runs-on band can give:
 * two hosts that can run Claude Code, one offline, and one online host that has
 * the harness but is signed out of it (a WARNING, not a refusal).
 */
type Selector<T> = (store: unknown) => T

const claude = (installed: boolean, loggedIn: boolean) => ({
  kind: 'claude-code' as const,
  installed,
  login: { state: loggedIn ? ('in' as const) : ('out' as const) },
})

const machines = [
  {
    id: 'm-ludovico',
    name: 'ludovico',
    hostname: 'ludovico',
    online: true,
    lastSeenAt: new Date(0).toISOString(),
    inventory: {
      os: 'darwin' as const,
      arch: 'arm64' as const,
      agents: [claude(true, true)],
      tools: [],
    },
  },
  {
    id: 'm-vmi',
    name: 'vmi3431366',
    hostname: 'vmi3431366',
    online: true,
    lastSeenAt: new Date(0).toISOString(),
    inventory: {
      os: 'linux' as const,
      arch: 'x64' as const,
      agents: [claude(true, true)],
      tools: [],
    },
  },
  {
    id: 'm-quiet',
    name: 'quiet-box',
    hostname: 'quiet-box',
    online: false,
    lastSeenAt: new Date(0).toISOString(),
    inventory: {
      os: 'linux' as const,
      arch: 'x64' as const,
      agents: [claude(true, true)],
      tools: [],
    },
  },
  {
    id: 'm-mira',
    name: 'mira',
    hostname: 'mira',
    online: true,
    lastSeenAt: new Date(0).toISOString(),
    inventory: {
      os: 'darwin' as const,
      arch: 'arm64' as const,
      agents: [claude(true, false)],
      tools: [],
    },
  },
]

// One repo, carried by all four hosts — same `repoId`, so `reposToViews` merges
// them into the single cross-machine view the machine menu reads.
const repos = machines.map((m) => ({
  path: '/work/podium',
  kind: 'repository' as const,
  branch: 'main',
  repoId: 'repo-podium',
  originUrl: 'git@github.com:podium/podium.git',
  worktrees: [],
  machineId: m.id,
}))

const store = {
  repos,
  machines,
  sessions: [],
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
      update: { mutate: async () => ({ id: 'issue-harness' }) },
    },
  },
}

// Enough of a board for the composer's `POD-1042 next` forecast to have a
// prefix and a high-water seq to read.
const issues = [
  { id: 'iss_a', seq: 1041, displayRef: 'POD-1041', title: 'Quota popover', labels: [] },
  { id: 'iss_b', seq: 1039, displayRef: 'POD-1039', title: 'Shelf line align', labels: [] },
]

export function useStoreSelector<T>(selector: Selector<T>): T {
  return selector(store)
}

export function useStore(): typeof store {
  return store
}

export function useReplicaIssues(): typeof issues {
  return issues
}
