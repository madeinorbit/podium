/** Only the menu's inputs are stubbed; its rows and setup footer are product code. */
import { BUNDLED_DESCRIPTORS } from '@podium/harness/browser'
import { asMachineId, type MachineFacts } from '@podium/model/browser'

const second = new URLSearchParams(location.search).get('state') === 'fleet'
export const machine: MachineFacts = {
  id: asMachineId('fixture-machine'),
  name: 'Research machine',
  hostname: 'research',
  online: true,
  lastSeenAt: '2026-11-01T00:00:00Z',
  serviceAssignment: { server: false, agentExecution: true },
  availability: { epoch: 'fixture', daemon: true, server: false, supervisor: true },
  inventory: {
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: [
      { kind: 'claude-code', installed: true, login: { state: 'in' } },
      {
        kind: 'antigravity',
        installed: true,
        login: { state: 'in' },
        management: { installable: false },
      },
      { kind: 'pi', installed: true, login: { state: 'out' } },
      {
        kind: 'codex',
        installed: false,
        login: { state: 'unknown' },
        management: { installable: true },
        install: { managed: { paused: false, installing: { version: '0.171.0' } } },
      },
      {
        kind: 'grok',
        installed: false,
        login: { state: 'unknown' },
        management: { installable: false },
      },
    ],
  },
}
const machines = second
  ? [machine, { ...machine, id: asMachineId('build-machine'), name: 'Build machine' }]
  : [machine]
export const worktree = {
  path: '/work/project/topic',
  repoPath: '/work/project',
  machineId: machine.id,
  branch: 'topic',
  isMain: false,
}
const repo = {
  path: '/work/project',
  name: 'project',
  worktrees: [worktree],
  machines: machines.map(({ id }) => ({ machineId: id, path: '/work/project' })),
}

export const usePoolMachine = (id: string) => machines.find((candidate) => candidate.id === id)
export const useResolvedDescriptors = () => [...BUNDLED_DESCRIPTORS]
export const useCommandLaunchOrigin = () => ({ machines, repo, sourceMachineId: machine.id })
export const useCommandTargetMachines = () => ({
  'claude-code': machine.id,
  antigravity: machine.id,
  pi: machine.id,
  shell: machine.id,
})
export const useCommandRecentFiles = () => []
export const useCommandLaunchActions = () => ({
  launchSession: () => ({ sessionId: 'fixture-session' }),
  setPanelMode: () => {},
})
export const useFeature = () => false
export const NewSessionCredentialSection = () => null
export const ARTIFACTS_TAB_ARTIFACT_ID = 'fixture-artifacts'
export const useArtifactCount = () => 0
export const useOpenArtifactsTab = () => () => {}
