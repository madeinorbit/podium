/**
 * A STUBBED STORE FOR THE REAL MACHINE-LOAD PANEL (POD-1603).
 *
 * Aliased over `@/app/store` by `vite.loadpanel.config.ts`, so `LoadPanel` is
 * exactly what ships and only the host underneath is invented. The panel is
 * almost entirely CSS the unit suite never applies — three meters in a four
 * column grid, a composition bar, the cold slots that stand in for the process
 * list, and a refresh control that has to sit on the hostname's baseline — so
 * "the test passes" says nothing about whether it is right to look at.
 *
 * The walk is served with a settable delay so the cold pass can be photographed
 * for as long as it takes to look at it: `?delay=99999` holds it open forever,
 * `?delay=0` (the default in the settled column) answers immediately.
 */
import { asMachineId, asSessionId } from '@podium/model/browser'

type Selector<T> = (store: unknown) => T

const params = new URLSearchParams(location.search)
const DELAY = Number(params.get('delay') ?? 0)
/** `?disk=none` is the mixed-fleet host whose daemon reports no disk sample. */
const NO_DISK = params.get('disk') === 'none'

const GIB = 1024 ** 3

const memory = {
  totalBytes: 64 * GIB,
  availableBytes: 17 * GIB,
  swapTotalBytes: 8 * GIB,
  swapFreeBytes: 8 * GIB,
}

const disk = {
  path: '/home/podium',
  totalBytes: 916 * GIB,
  usedBytes: 703 * GIB,
  availableBytes: 166 * GIB,
}

const session = (id: string, title: string, phase: 'idle' | 'working' | 'needs_user') => ({
  sessionId: asSessionId(id),
  title,
  status: 'live',
  agentState: { phase, since: '2026-08-24T09:00:00.000Z', nativeSubagentCount: 0 },
  archived: false,
  machineId: asMachineId('vmi34'),
  agentKind: 'claude-code',
  cwd: '/home/podium/podium',
  lastActiveAt: '2026-08-24T09:00:00.000Z',
})

const sessions = [
  session('sess_a', 'Disk usage in load panel', 'working'),
  session('sess_b', 'Explorer scope gate', 'working'),
  session('sess_c', 'Sidebar row menu harness', 'idle'),
  session('sess_d', 'Quota popover pace chips', 'needs_user'),
]

const breakdown = {
  hostname: 'vmi34',
  sampledAt: '2026-08-24T09:00:00.000Z',
  supported: true,
  memory,
  ...(NO_DISK ? {} : { disk }),
  agents: [
    { sessionId: asSessionId('sess_a'), bytes: 4.2 * GIB, processCount: 11 },
    { sessionId: asSessionId('sess_b'), bytes: 3.1 * GIB, processCount: 9 },
    { sessionId: asSessionId('sess_c'), bytes: 1.4 * GIB, processCount: 6 },
    { sessionId: asSessionId('sess_d'), bytes: 0.9 * GIB, processCount: 5 },
  ],
  projects: [
    {
      root: '/home/podium/podium',
      bytes: 6.8 * GIB,
      processCount: 14,
      topProcesses: [
        { name: 'vite', bytes: 3.2 * GIB },
        { name: 'tsgo', bytes: 2.1 * GIB },
      ],
    },
    {
      root: '/home/podium/podium-wt-pod1052',
      bytes: 1.2 * GIB,
      processCount: 3,
      topProcesses: [{ name: 'bun', bytes: 1.2 * GIB }],
    },
  ],
  otherBytes: 29 * GIB,
}

const store = {
  hostMetrics: [
    {
      hostname: 'vmi34',
      machineId: asMachineId('vmi34'),
      name: 'vmi34',
      sampledAt: '2026-08-24T09:00:00.000Z',
      memory,
      // 9.4 / 8 cores = 1.18× per core — under the 1.5 line, so `ok`.
      load: { one: 9.4, five: 8.1, fifteen: 7.2, cpuCount: 8 },
      idleCapUnmet: 0,
    },
  ],
  sessions,
  machines: [{ id: asMachineId('vmi34'), name: 'vmi34' }],
  setView: () => {},
  setSettingsTab: () => {},
  trpc: {
    hosts: {
      memoryBreakdown: {
        mutate: async () =>
          await new Promise((resolve) => setTimeout(() => resolve(breakdown), DELAY)),
      },
    },
    settings: {
      get: {
        query: async () => ({
          hibernation: {
            enabled: true,
            memoryPct: 85,
            idleMinutes: 30,
            loadPerCore: 1.5,
            maxIdleSessions: 8,
          },
          worktreeGc: { mode: 'propose' as const, afterDays: 14 },
        }),
      },
    },
  },
}

export const useStore = (): typeof store => store
export const useReplicaIssues = (): never[] => []
export const useStoreSelector = <T>(selector: Selector<T>): T => selector(store)
export const useSlice = <T>(def: { derive: (s: unknown) => T }): T => def.derive(store)
