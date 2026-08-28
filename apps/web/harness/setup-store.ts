/**
 * A STUBBED STORE for the ONBOARDING screens (POD-1225).
 *
 * Aliased over `@/app/store` by `vite.setup.config.ts`, the same trick
 * `coldstart-store.ts` plays: the components, the stylesheet and the layout are
 * exactly what ships, and only the machine inventory underneath is invented.
 * One installed-and-logged-in agent and three missing ones, so the agents
 * screen renders both groups and the divider between them.
 */
type Selector<T> = (store: unknown) => T

const machine = {
  id: 'machine-a',
  name: 'MBP-Cofo',
  hostname: 'MBP-Cofo.local',
  online: true,
  lastSeenAt: new Date(0).toISOString(),
  inventory: {
    os: 'darwin' as const,
    arch: 'arm64' as const,
    agents: [
      { kind: 'codex' as const, installed: true, login: { state: 'in' as const } },
      { kind: 'claude-code' as const, installed: false, login: { state: 'out' as const } },
      { kind: 'opencode' as const, installed: false, login: { state: 'out' as const } },
      { kind: 'cursor' as const, installed: false, login: { state: 'out' as const } },
    ],
    tools: [],
  },
}

const uiValues = new Map<string, string>()

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
    get: (key: string) => uiValues.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) uiValues.delete(key)
      else uiValues.set(key, value)
    },
  },
  trpc: {
    settings: {
      get: {
        query: async () => ({
          sessionDefaults: { agent: 'codex' },
          gitWorkflow: { defaultParentBranch: 'main' },
        }),
      },
    },
    accounts: { login: { mutate: async () => ({ sessionId: 'session-harness' }) } },
    telemetry: {
      state: {
        query: async () => ({
          usage: 'absent',
          crash: 'absent',
          endpoint: 'https://pulse.meetpodium.com/v1/u',
        }),
      },
      set: { mutate: async () => ({ usage: 'off', crash: 'off' }) },
    },
  },
}

export function useStoreSelector<T>(selector: Selector<T>): T {
  return selector(store)
}

export function useStore(): unknown {
  return store
}

// The login dialog reaches AgentPanel, which imports these by name; they are
// never called on the two screens this harness renders.
export function useSlice(): unknown {
  return {}
}

export function useReplicaIssues(): unknown[] {
  return []
}

export function useSession(): undefined {
  return undefined
}

export function useSessionDraft(): string {
  return ''
}

export function useSessionExitKind(): undefined {
  return undefined
}
