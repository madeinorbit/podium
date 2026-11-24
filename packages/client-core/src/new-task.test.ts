import { type GitRepositoryWire, type MachineWire, machinePathKey } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_FIRST_TASK_DRAFT,
  readFirstTaskDraft,
  serializeFirstTaskDraft,
} from './first-task-draft'
import {
  COORDINATOR_PROMPT,
  checkoutForMachine,
  countWords,
  firstTaskLaunchNote,
  firstTaskMachines,
  firstTaskRepositoryChoices,
  firstTaskRepositorySubtitle,
  promptTitle,
  rankFirstTaskRepositories,
  selectedFirstTaskMachine,
} from './new-task'
import { reposToViews } from './values/compose/machines/facts'
import { indexedRepoUsageAt } from './values/repository-usage'

const repo = (path: string, extra = {}): GitRepositoryWire =>
  ({ path, kind: 'repository', worktrees: [], ...extra }) as GitRepositoryWire

describe('shared New Task helpers', () => {
  it('keeps desktop server identities for same-origin registrations and names their machines', () => {
    const repos = [
      repo('/home/podium/pipp', {
        repoId: 'repo_2928f71bab0412fa',
        machineId: 'linux',
        originUrl: 'https://github.com/madeinorbit/pipp.git',
      }),
      repo('/Users/till/Sites/pipp', {
        repoId: 'repo_6a281f1347ed8b9f',
        machineId: 'mac',
        originUrl: 'git@github.com:madeinorbit/pipp.git',
      }),
    ]
    const choices = firstTaskRepositoryChoices(repos)
    // Old desktop grouping is the identity authority, including separate IDs.
    expect(choices).toEqual(reposToViews(repos))
    expect(choices).toHaveLength(2)
    const machines = [
      { id: 'linux', name: 'vmi3431366' },
      { id: 'mac', name: 'MBP-Cofo' },
    ] as MachineWire[]
    expect(choices.map((choice) => firstTaskRepositorySubtitle(choice, machines))).toEqual([
      'vmi3431366 · github.com/madeinorbit/pipp',
      'MBP-Cofo · github.com/madeinorbit/pipp',
    ])
    expect(
      choices.map(
        (choice) => checkoutForMachine(repos, choice, choice.machines?.[0]?.machineId)?.path,
      ),
    ).toEqual(['/home/podium/pipp', '/Users/till/Sites/pipp'])
  })

  it('groups unstamped SSH and HTTPS clones but keeps local-only checkouts separate', () => {
    const choices = firstTaskRepositoryChoices([
      repo('/linux/pipp', { machineId: 'linux', originUrl: 'git@github.com:madeinorbit/pipp.git' }),
      repo('/mac/pipp', { machineId: 'mac', originUrl: 'https://github.com/madeinorbit/pipp/' }),
      repo('/work/local', { machineId: 'linux' }),
      repo('/work/local', { machineId: 'mac' }),
    ])
    expect(choices).toHaveLength(3)
    expect(choices[0]?.machines?.map((checkout) => checkout.machineId)).toEqual(['linux', 'mac'])
  })

  it('keeps the desktop first-nonempty-line title, including its 120 character limit', () => {
    for (const prompt of [
      '',
      ' \n \n',
      '\n  First line  \nsecond',
      'x'.repeat(121),
      COORDINATOR_PROMPT,
    ]) {
      const oldTitle = (
        prompt
          .split('\n')
          .map((line) => line.trim())
          .find(Boolean) ?? prompt.trim()
      ).slice(0, 120)
      expect(promptTitle(prompt)).toBe(oldTitle)
    }
    expect(promptTitle('\n  First line  \nsecond')).toBe('First line')
  })

  it('counts runs of non-space exactly as desktop does', () => {
    for (const text of [
      '',
      ' \t\n',
      'one',
      'one\n two\tthree',
      'punctuation, stays-together',
      '你好 世界',
    ]) {
      expect(countWords(text)).toBe(text.trim() ? text.trim().split(/\s+/).length : 0)
    }
    expect(COORDINATOR_PROMPT).toBe(
      'This is a complex epic. You are the designated coordinator. Organize your work accordingly. Check with me on key decisions.',
    )
  })

  it('matches the old ranking with alias checkouts and nested worktree usage, filtering unlaunchable roots', () => {
    const repos = [
      repo('/a', { repoId: 'a', machineId: 'one' }),
      repo('/z', { repoId: 'z', machineId: 'one' }),
      repo('/other/z', { repoId: 'z', machineId: 'two', worktrees: [{ path: '/z/task' }] }),
      repo('/orphan', { repoId: 'orphan', machineId: 'one', kind: 'worktree' }),
    ]
    const usage = new Map([
      [machinePathKey('/a'), 10],
      [machinePathKey('/z/task'), 50],
    ])
    const times = new Map(repos.map((row) => [row.path, indexedRepoUsageAt(row, usage)]))
    const at = (view: ReturnType<typeof reposToViews>[number]) =>
      Math.max(
        times.get(view.path) ?? 0,
        ...(view.machines ?? []).map(({ path }) => times.get(path) ?? 0),
      )
    const old = reposToViews(repos)
      .filter((view) =>
        repos.some(
          (row) =>
            row.kind !== 'worktree' &&
            (view.path === row.path || view.machines?.some((host) => host.path === row.path)),
        ),
      )
      .sort(
        (a, b) => at(b) - at(a) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
    expect(rankFirstTaskRepositories(repos, usage)).toEqual(old)
    expect(rankFirstTaskRepositories(repos, usage).map((row) => row.repoId)).toEqual(['z', 'a'])
  })

  it('keeps deterministic checkout selection and an explicit second clone on the selected machine', () => {
    const repos = [
      repo('/b', { repoId: 'one', machineId: 'one' }),
      repo('/a', { repoId: 'one', machineId: 'one' }),
      repo('/remote', { repoId: 'one', machineId: 'two' }),
    ]
    const view = reposToViews(repos)[0]
    if (!view) throw new Error('Missing fixture project')
    expect(checkoutForMachine(repos, view, 'one')?.path).toBe('/a')
    expect(checkoutForMachine(repos, view, 'one', '/b')?.path).toBe('/b')
    expect(checkoutForMachine(repos, view, 'two', '/b')?.path).toBe('/remote')
    expect(checkoutForMachine(repos, view, 'gone')).toBeUndefined()
  })

  it('preserves the prompt and picks through the existing device-local draft serialization', () => {
    const draft = {
      ...EMPTY_FIRST_TASK_DRAFT,
      title: '  Exact prompt\n\nContext. ',
      repoPath: '/repo',
      machineId: 'host',
      agent: 'codex' as const,
      model: 'reported-model',
      effort: 'high',
      launchPickTouched: true,
    }
    expect(readFirstTaskDraft(serializeFirstTaskDraft(draft))).toEqual(draft)
    expect(readFirstTaskDraft('{')).toEqual(EMPTY_FIRST_TASK_DRAFT)
  })

  it('uses the desktop blocked-message precedence and sign-in wording verbatim', () => {
    const input = {
      machineDenied: false,
      signInFirst: false,
      ready: false,
      hasCheckout: true,
      readiness: { state: 'missing' as const },
      agentLabel: 'Codex',
      projectLabel: 'podium',
      machineLabel: 'MBP-Cofo',
    }
    expect(firstTaskLaunchNote({ ...input, machineDenied: true })).toBe(
      'You do not have access to run work on this machine. Ask its owner for access, or pick another machine.',
    )
    expect(firstTaskLaunchNote(input)).toBe(
      'The selected agent is not ready on this machine yet. Open Settings → Agents to finish setup.',
    )
    expect(firstTaskLaunchNote({ ...input, hasCheckout: false })).toBe(
      'podium is not checked out on MBP-Cofo. Pick another machine, or clone it there first.',
    )
    expect(
      firstTaskLaunchNote({
        ...input,
        signInFirst: true,
        ready: true,
        readiness: { state: 'logged-out', machine: { name: 'MBP-Cofo' } as MachineWire },
      }),
    ).toBe('Codex is not signed in on MBP-Cofo. It opens in its terminal, where you can sign in.')
    expect(firstTaskLaunchNote({ ...input, ready: true })).toBeUndefined()
  })

  it('skips a remembered offline default but respects a machine picked in this opening', () => {
    const hosts = [
      { id: 'offline', name: 'Offline', online: false, use: 'granted' },
      { id: 'ready', name: 'Ready', online: true, use: 'granted' },
      { id: 'denied', name: 'Denied', online: true, use: 'denied' },
    ].map((host) => ({
      ...host,
      serviceAssignment: { server: false, agentExecution: true },
      availability: { epoch: 'boot', server: false, daemon: true, supervisor: true },
    })) as MachineWire[]
    const view = reposToViews([repo('/repo', { machineId: 'ready' })])[0]
    if (!view) throw new Error('Missing fixture project')
    expect(firstTaskMachines(view, hosts).map((row) => row.id)).toEqual(['ready'])
    expect(selectedFirstTaskMachine(hosts, 'offline')?.id).toBe('ready')
    expect(selectedFirstTaskMachine(hosts, 'offline', 'offline')?.id).toBe('offline')
  })
})
