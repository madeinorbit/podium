/**
 * The shell dependencies Settings → Updates has, stubbed so the REAL section
 * renders against the REAL stylesheet with no server behind it (POD-2511).
 *
 * The scene is chosen by `?scene=` and read here rather than passed as a prop,
 * because the component reads the store — which is the point: what is being
 * looked at is the shipping component, not a copy of it.
 */

export type SceneName = 'agree' | 'dev' | 'trouble'

interface Scene {
  channel: 'stable' | 'edge' | 'dev'
  /** What `/version` and the fleet snapshot say the server is. */
  serverVersion: string
  /** The build stamp the harness document carries, i.e. this page's version. */
  pageVersion: string
  /** The shell's own artifact version over the bridge, when there is a shell. */
  desktopVersion?: string
  servedWebDigest?: string
  servedMobileWeb?: { present: boolean; appVersion?: string; digest?: string }
  targetVersion: string | null
  machines: Array<{
    id: string
    name: string
    hostname: string
    appVersion: string
    versionState: 'unreported' | 'current' | 'behind' | 'ahead'
    supervised?: boolean
  }>
  wave: Array<{
    id: string
    version: string
    state: 'current' | 'granted' | 'downloading' | 'restarting' | 'rejected' | 'stuck'
  }>
}

const SCENES: Record<SceneName, Scene> = {
  // Edge steady state: everything is on one build, so the panel says so once.
  agree: {
    channel: 'edge',
    serverVersion: '0.1.1-edge.4',
    pageVersion: '0.1.1-edge.4',
    desktopVersion: '0.1.1-edge.4',
    servedWebDigest: '47a01e3',
    servedMobileWeb: { present: true, appVersion: '0.1.1-edge.4', digest: '47a01e3' },
    targetVersion: '0.1.1-edge.4',
    machines: [
      {
        id: 'm-ludovico',
        name: 'ludovico',
        hostname: 'ludovico.local',
        appVersion: '0.1.1-edge.4',
        versionState: 'current',
      },
    ],
    wave: [{ id: 'm-ludovico', version: '0.1.1-edge.4', state: 'current' }],
  },
  // Development steady state: the shell carries its EDGE version by design, and
  // a machine sits on an offer nobody has accepted yet.
  dev: {
    channel: 'dev',
    serverVersion: '0.1.2.dev.7+ab12cd3',
    pageVersion: '0.1.2.dev.7+ab12cd3',
    desktopVersion: '0.1.1-edge.4',
    servedWebDigest: '9c31be2',
    servedMobileWeb: { present: true, appVersion: '0.1.2.dev.7+ab12cd3', digest: '9c31be2' },
    targetVersion: '0.1.2.dev.8+77f0e91',
    machines: [
      {
        id: 'm-ludovico',
        name: 'ludovico',
        hostname: 'ludovico.local',
        appVersion: '0.1.2.dev.8+77f0e91',
        versionState: 'current',
      },
      {
        id: 'm-studio',
        name: "Michael's Mac",
        hostname: 'studio.local',
        appVersion: '0.1.2.dev.7+ab12cd3',
        versionState: 'behind',
      },
    ],
    wave: [
      { id: 'm-ludovico', version: '0.1.2.dev.8+77f0e91', state: 'current' },
      { id: 'm-studio', version: '0.1.2.dev.7+ab12cd3', state: 'current' },
    ],
  },
  // The cases that are somebody's problem: a phone bundle built from other
  // source, a page that has not reloaded, and a machine that never arrived.
  trouble: {
    channel: 'edge',
    serverVersion: '0.1.1-edge.4',
    pageVersion: '0.1.1-edge.3',
    servedWebDigest: '47a01e3',
    servedMobileWeb: { present: true, appVersion: '0.1.1-edge.4', digest: 'b40c118' },
    targetVersion: '0.1.1-edge.4',
    machines: [
      {
        id: 'm-ludovico',
        name: 'ludovico',
        hostname: 'ludovico.local',
        appVersion: '0.1.1-edge.3',
        versionState: 'behind',
      },
      {
        id: 'm-vmi',
        name: 'vmi',
        hostname: 'vmi.example',
        appVersion: '0.1.1-edge.2',
        versionState: 'behind',
      },
    ],
    wave: [
      { id: 'm-ludovico', version: '0.1.1-edge.3', state: 'stuck' },
      { id: 'm-vmi', version: '0.1.1-edge.2', state: 'current' },
    ],
  },
}

export function currentSceneName(): SceneName {
  const raw = new URLSearchParams(window.location.search).get('scene')
  return raw === 'dev' || raw === 'trouble' ? raw : 'agree'
}

export function currentScene(): Scene {
  return SCENES[currentSceneName()]
}

export const useReplicaIssues = (): unknown[] => []

export const useStoreSelector = <T>(selector: (store: unknown) => T): T => {
  const scene = currentScene()
  return selector({
    machines: scene.machines.map((machine) => ({
      ...machine,
      updateChannelOverride: null,
      targetUnavailableReason: null,
      targetVersion: scene.targetVersion,
      inventory: { podiumVersion: machine.appVersion },
    })),
    trpc: {
      setup: {
        channel: { query: async () => ({ channel: scene.channel, envForced: false }) },
        info: { query: async () => ({ appVersion: scene.serverVersion }) },
        setChannel: { mutate: async () => ({ channel: scene.channel, envForced: false }) },
      },
      features: {
        state: {
          query: async () => ({
            devMode: false,
            channel: 'edge' as const,
            flags: [
              {
                id: 'podium-development',
                name: 'Podium development',
                description: '',
                visibility: 'hidden' as const,
                listed: false,
                enabled: scene.channel === 'dev',
                source: 'user' as const,
                locked: false,
              },
            ],
          }),
        },
      },
      updates: {
        fleet: {
          query: async () => ({
            appVersion: scene.serverVersion,
            servedWebDigest: scene.servedWebDigest,
            servedMobileWeb: scene.servedMobileWeb,
            targetVersion: scene.targetVersion,
            machines: scene.wave.map((row) => ({ ...row, online: true, busy: false })),
            allMachines: scene.wave.map((row) => ({ ...row, online: true, busy: false })),
            channelChecks: [
              {
                channel: scene.channel,
                checkedAt: Date.now() - 5_400_000,
                outcome: { status: 'ok' },
              },
            ],
          }),
        },
        checkNow: { mutate: async () => [] },
      },
      operations: {
        history: {
          query: async () => [
            {
              id: 'op_01j',
              kind: 'update',
              state: 'done',
              details: { target: { version: scene.targetVersion ?? scene.serverVersion } },
              startedAt: Date.now() - 36_000_000,
              finishedAt: Date.now() - 35_760_000,
            },
          ],
        },
      },
    },
  })
}
