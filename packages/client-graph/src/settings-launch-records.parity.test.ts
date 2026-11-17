import type { CredentialView, GitRepositoryWire, MemberView } from '@podium/model'
import { asCredentialId, asMachineId, asRepoId, asUserId } from '@podium/model/browser'
import type { DeviceSignInView } from '@podium/protocol'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { headerEntities } from './header-entities'
import { createLaunchWorkPicker } from './launch-option-views'
import { launchRecords } from './launch-records'
import { here, isGone } from './lookup'
import { MemberDirectory } from './member-directory'
import { MemberRoster } from './member-roster'
import { MobxPool } from './pool'
import { RecordRequest } from './requested-records'
import { SettingsRepositories } from './settings-repositories'
import { createLaunchWorkPicker as beforePicker } from './test-support/launch-option-views-before.test.fixture'

const credential: CredentialView = {
  id: asCredentialId('cred_found'), ownerUserId: asUserId('user:owner'),
  label: 'Found Codex', type: 'openai.chatgpt-login', identity: { email: 'person@example.test', fingerprint: 'fingerprint' },
  status: 'ok', access: 'owner', homes: [], allowedMachines: [], sessionCount: 0,
  nativeLogin: {
    harness: 'codex', required: false, useOnMyMachines: false, keptOn: [],
    machines: [{ id: asMachineId('host'), name: 'Host', state: 'in' }],
    attempt: { sessionId: 'login', machineId: asMachineId('host'), machineName: 'Host', status: 'succeeded' },
  },
}
const member: MemberView = {
  id: 'owner',
  displayName: 'Owner',
  email: 'owner@example.test',
  role: 'admin',
  accountId: 'managed:openai',
  avatar: null,
  createdAt: '2026-01-01T00:00:00Z',
  disabledAt: null,
}
const device: DeviceSignInView = {
  id: 'abcdefghijklmnopqrstuvwx',
  kind: 'phone',
  deviceName: 'Phone',
  platform: 'ios',
  current: false,
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
  lastSeenAt: null,
}
const pool = () => new MobxPool({ selectedIssueId: null, coarseNow: 0 })
function values(model: object, wire: object) {
  return Object.fromEntries(
    Object.keys(wire).map((key) => [key, (model as Record<string, unknown>)[key]]),
  )
}
it('matches every credential/member/device fact from the old section responses and updates the same models across requests', async () => {
  const p = pool()
  const accounts = new RecordRequest(p, 'credential', (row) => row.id)
  const other = new RecordRequest(p, 'credential', (row) => row.id)
  const directory = new MemberDirectory(p)
  const devices = new RecordRequest(p, 'device', (row) => row.id)
  try {
    await accounts.read(async () => [credential])
    await directory.read(async () => ({
      members: [member],
      invites: [],
      currentMemberId: 'owner',
    }))
    await devices.read(async () => [device])
    const accountAnswer = values(accounts.models[0]!, credential)
    if (process.env.POD5870_PARITY_MUTANT === '1') accountAnswer.status = 'unknown'
    expect(accountAnswer).toEqual(credential)
    expect(values(directory.members[0]!, member)).toEqual(member)
    expect(values(devices.models[0]!, device)).toEqual(device)
    // The old loaders returned exactly the payload. Poisoning one new answer
    // must fail this same comparison, not an assertion about the implementation.
    expect(() =>
      expect({ ...values(accounts.models[0]!, credential), status: 'unknown' }).toEqual(credential),
    ).toThrow()
    const a = accounts.models[0],
      m = directory.members[0],
      d = devices.models[0]
    const seen: string[] = []
    const stop = autorun(() => seen.push([a?.identity.email, m?.displayName, d?.deviceName].join('|')))
    await other.read(async () => [{ ...credential, identity: { email: 'changed elsewhere' } }])
    await directory.read(async () => ({
      members: [{ ...member, displayName: 'Renamed' }],
      invites: [],
      currentMemberId: 'owner',
    }))
    await devices.read(async () => [{ ...device, deviceName: 'Renamed phone' }])
    expect(accounts.models[0]).toBe(a)
    expect(directory.members[0]).toBe(m)
    expect(devices.models[0]).toBe(d)
    expect(seen.at(-1)).toContain('changed elsewhere|Renamed|Renamed phone')
    stop()
    await devices.read(async () => [])
    expect(devices.answer).toEqual([])
    expect(devices.models).toEqual([])
    expect(isGone(p.model('device', device.id))).toBe(true)
  } finally {
    accounts.dispose()
    other.dispose()
    directory.dispose()
    devices.dispose()
    p.dispose()
  }
})
it('rejects superseded and closed responses before they can change shared records', async () => {
  const p = pool(),
    request = new RecordRequest(p, 'credential', (row) => row.id)
  let finish!: (rows: CredentialView[]) => void
  const old = request.read(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await request.read(async () => [{ ...credential, identity: { email: 'new' } }])
  finish([credential])
  await old
  expect(request.models[0]?.identity.email).toBe('new')
  const closing = request.read(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  request.close()
  finish([{ ...credential, identity: { email: 'closed' } }])
  await closing
  expect(here(p.model('credential', credential.id))?.identity.email).toBe('new')
  p.dispose()
})
it('matches the original repository grouping, pinned filtering and open order on the same fixtures', () => {
  const legacy = pool(),
    next = pool()
  const repos: GitRepositoryWire[] = [
    {
      kind: 'repository',
      path: '/repo/z',
      originUrl: 'https://example.test/z.git',
      branch: 'main',
      worktrees: [{ path: '/repo/z/topic', branch: 'topic' }],
    },
    { kind: 'repository', path: '/repo/a', originUrl: 'https://example.test/a.git', worktrees: [] },
  ]
  for (const p of [legacy, next]) {
    headerEntities(p).apply(repos.map((value, i) => ({ kind: 'repository', id: `r${i}`, value })))
    vi.spyOn(p.queries, 'activity').mockReturnValue(0)
    vi.spyOn(p.queries, 'latestMachineSession').mockReturnValue(undefined)
  }
  const old = beforePicker(legacy),
    migrated = createLaunchWorkPicker(next)
  old.open()
  migrated.open()
  const render = (picker: ReturnType<typeof migrated.newWork>) =>
    picker.repos.map((repo) => ({
      path: repo.path,
      name: repo.name,
      originUrl: repo.originUrl,
      repoId: repo.repoId,
      machines: repo.machines.map((machine) => ({
        machineId: machine.machineId,
        path: machine.path,
      })),
      worktrees: repo.worktrees.map((tree) => ({
        path: tree.path,
        branch: tree.branch,
        repoPath: tree.repoPath,
        isMain: tree.isMain,
        repoName: tree.repoName,
        repoId: tree.repoId,
        machineId: tree.machineId,
        sessions: tree.sessions,
        issues: tree.issues,
      })),
    }))
  try {
    expect(render(migrated)).toEqual(
      render(old.newWork() as unknown as ReturnType<typeof migrated.newWork>),
    )
    expect(migrated.repositoryPaths).toEqual(old.repositoryPaths)
    expect(() =>
      expect({ ...render(migrated)[0], name: 'wrong' }).toEqual(
        render(old.newWork() as unknown as ReturnType<typeof migrated.newWork>)[0],
      ),
    ).toThrow()
    const first = migrated.repos.find((repo) => repo.path === '/repo/z')!
    const branches: (string | undefined)[] = []
    const stop = autorun(() => branches.push(first.worktrees[0]?.branch))
    headerEntities(next).apply([
      { kind: 'repository', id: 'r0', value: { ...repos[0]!, branch: 'elsewhere' } },
    ])
    expect(first).toBe(migrated.repos.find((repo) => repo.path === '/repo/z'))
    expect(branches.at(-1)).toBe('elsewhere')
    stop()
  } finally {
    legacy.dispose()
    next.dispose()
    vi.restoreAllMocks()
  }
})

it('shows a registered repository once, with its worktree folded under its checkout, and follows a remote prefix edit', () => {
  const p = pool(),
    machineId = asMachineId('host'),
    repoId = asRepoId('project')
  const scans = [
    { machineId, path: '/repo', originUrl: 'https://example.test/project.git', repoId },
    { machineId, path: '/repo/topic', originUrl: 'https://example.test/project.git', repoId },
  ]
  try {
    p.apply({
      type: 'update',
      rows: [
        { kind: 'repo', id: repoId, value: { id: repoId, prefix: 'OLD', path: '/repo' } as never },
      ],
    })
    headerEntities(p).apply(
      scans.map((row, i) => ({
        kind: 'repository' as const,
        id: `scan${i}`,
        value: {
          kind: i === 0 ? ('repository' as const) : ('worktree' as const),
          machineId,
          path: row.path,
          originUrl: row.originUrl,
          repoId,
          worktrees: i === 0 ? [{ path: '/repo/topic', branch: 'topic' }] : [],
        },
      })),
    )
    headerEntities(p).order('repository', ['scan0', 'scan1'])
    const section = new SettingsRepositories(p)
    // POD-6267: the registered worktree used to be a second "repository" row
    // carrying the same prefix. It is the checkout's worktree, listed once.
    expect(
      section.rows.map((row) => ({
        repoId: row.repoId,
        prefix: row.prefix,
        origin: row.origin,
        checkouts: row.checkouts.map((c) => ({
          machineId: c.machineId,
          path: c.path,
          worktrees: c.worktrees.map((w) => w.path),
        })),
      })),
    ).toEqual([
      {
        repoId,
        prefix: 'OLD',
        origin: 'example.test/project',
        checkouts: [{ machineId, path: '/repo', worktrees: ['/repo/topic'] }],
      },
    ])
    const retained = section.rows[0]!,
      seen: (string | null)[] = []
    const stop = autorun(() => seen.push(retained.prefix))
    p.apply({
      type: 'update',
      rows: [
        { kind: 'repo', id: repoId, value: { id: repoId, prefix: 'NEW', path: '/repo' } as never },
      ],
    })
    expect(seen.at(-1)).toBe('NEW')
    expect(section.rows[0]).toBe(retained)
    stop()
  } finally {
    p.dispose()
  }
})

it('keeps repository names live and resolves root, clone and nested launch targets from shared scans', () => {
  const p = pool(),
    machineId = asMachineId('host')
  let step = 'apply'
  const repos: GitRepositoryWire[] = [
    {
      kind: 'repository',
      machineId,
      path: '/repo/first',
      originUrl: 'https://example.test/original.git',
      worktrees: [{ path: '/repo/first/topic', branch: 'topic' }],
    },
    {
      kind: 'repository',
      machineId,
      path: '/repo/second',
      originUrl: 'https://example.test/original.git',
      worktrees: [],
    },
  ]
  try {
    headerEntities(p).apply(repos.map((value, i) => ({ kind: 'repository', id: `r${i}`, value })))
    step = 'initial lookup'
    const records = launchRecords(p),
      retained = records.at('/repo/first')!
    step = 'target comparisons'
    for (const path of ['/repo/first', '/repo/first/topic', '/repo/second']) {
      const before = repos
        .flatMap((repo) => [
          {
            path: repo.path,
            repoPath: repo.path,
            isMain: true,
            machineId: repo.machineId,
            branch: repo.branch,
          },
          ...repo.worktrees.map((tree) => ({
            path: tree.path,
            repoPath: repo.path,
            isMain: false,
            machineId: repo.machineId,
            branch: tree.branch,
          })),
        ])
        .find((tree) => tree.path === path)!
      const answer = records.treeAt(path, machineId)!
      expect({
        path: answer.path,
        repoPath: answer.repoPath,
        isMain: answer.isMain,
        machineId: answer.machineId,
        branch: answer.branch,
      }).toEqual(before)
    }
    step = 'observe names'
    const seen: string[] = [],
      stop = autorun(() => seen.push(`${retained.path}|${retained.name}`))
    step = 'origin update'
    headerEntities(p).apply([
      {
        kind: 'repository',
        id: 'r0',
        value: { ...repos[0]!, originUrl: 'https://example.test/renamed.git' },
      },
    ])
    step = 'updated answer'
    expect(records.at('/repo/first')).toBe(retained)
    expect(seen.at(-1)).toBe('/repo/first|renamed')
    step = 'stop names'
    stop()
    step = 'dispose'
  } catch (cause) {
    throw new Error(step, { cause })
  } finally {
    p.dispose()
  }
})

it('preserves People account fields when the active roster returns partial member records', async () => {
  const p = pool(),
    directory = new MemberDirectory(p),
    roster = new MemberRoster(p)
  const alice = { ...member, id: 'alice', displayName: 'Alice', email: 'alice@example.com' }
  const bob = { ...member, id: 'bob', displayName: 'Bob', email: 'bob@example.com', role: 'member' }
  try {
    await directory.read(async () => ({
      members: [alice, bob],
      invites: [],
      currentMemberId: 'alice',
    }))
    const before = directory.members[0]
    await roster.read(async () => ({
      currentMemberId: 'alice',
      members: [
        { id: 'alice', displayName: 'Alice', role: 'admin' },
        { id: 'bob', displayName: 'Bob', role: 'member' },
      ],
    }))
    expect(directory.members[0]).toBe(before)
    expect(directory.members.map((m) => m.email)).toEqual(['alice@example.com', 'bob@example.com'])
    expect(directory.members[0]?.accountId).toBe(alice.accountId)
  } finally {
    directory.dispose()
    roster.dispose()
    p.dispose()
  }
})
it('an active-only roster does not remove a disabled member from the admin People record set', async () => {
  const p = pool(),
    directory = new MemberDirectory(p),
    roster = new MemberRoster(p)
  try {
    await directory.read(async () => ({
      currentMemberId: 'alice',
      invites: [],
      members: [
        { ...member, id: 'alice', displayName: 'Alice' },
        { ...member, id: 'bob', displayName: 'Bob', disabledAt: '2026-11-01T00:00:00Z' },
      ],
    }))
    await roster.read(async () => ({
      currentMemberId: 'alice',
      members: [
        { id: 'alice', displayName: 'Alice', role: 'admin' },
        { id: 'bob', displayName: 'Bob', role: 'member' },
      ],
    }))
    await roster.read(async () => ({
      currentMemberId: 'alice',
      members: [{ id: 'alice', displayName: 'Alice', role: 'admin' }],
    }))
    expect(roster.members.map((m) => m.id)).toEqual(['alice'])
    expect(directory.members.map((m) => m.id)).toEqual(['alice', 'bob'])
  } finally {
    directory.dispose()
    roster.dispose()
    p.dispose()
  }
})
