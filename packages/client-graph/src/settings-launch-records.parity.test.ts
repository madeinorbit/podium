import { expect, it, vi } from 'vitest'
import { autorun } from 'mobx'
import { DEFAULT_SETTINGS } from '@podium/runtime'
import type { AccountView, GitRepositoryWire, MemberView } from '@podium/model'
import type { MobileClientSession } from '@podium/protocol'
import { MobxPool } from './pool'
import { here, isGone } from './lookup'
import { RecordRequest, SettingsRecordRequest } from './requested-records'
import { MemberDirectory } from './member-directory'
import { headerEntities } from './header-entities'
import { createLaunchWorkPicker } from './launch-option-views'
import { launchOptionViews as beforeOptions, createLaunchWorkPicker as beforePicker } from './test-support/launch-option-views-before.test-helper'

const account: AccountView = { id: 'managed:openai', provider: 'openai', source: 'managed', kind: 'api-key',
  identity: 'abcd…1234', status: 'connected', credentialSource: 'stored' }
const member: MemberView = { id: 'owner', displayName: 'Owner', email: 'owner@example.test', role: 'admin' }
const device: MobileClientSession = { sessionId: 'abcdefghijklmnopqrstuvwx', userId: 'owner', label: 'mobile',
  deviceId: 'phone', deviceName: 'Phone', platform: 'ios', current: false,
  createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', lastSeenAt: null }
const pool = () => new MobxPool({ selectedIssueId: null, coarseNow: 0 })
function values(model: object, wire: object) {
  return Object.fromEntries(Object.keys(wire).map(key => [key, (model as Record<string, unknown>)[key]]))
}
it('matches every account/member/device/settings fact from the old section responses and updates the same models across requests', async () => {
  const p = pool()
  const accounts = new RecordRequest(p, 'account', row => row.id)
  const other = new RecordRequest(p, 'account', row => row.id)
  const directory = new MemberDirectory(p)
  const devices = new RecordRequest(p, 'device', row => row.sessionId)
  const settings = new SettingsRecordRequest(p)
  try {
    await accounts.read(async () => [account])
    await directory.read(async () => ({ members: [member], invites: [], currentMemberId: 'owner', mailAvailable: true }))
    await devices.read(async () => [device])
    await settings.read(async () => DEFAULT_SETTINGS)
    expect(values(accounts.models[0]!, account)).toEqual(account)
    expect(values(directory.members[0]!, member)).toEqual(member)
    expect(values(devices.models[0]!, device)).toEqual(device)
    expect(values(settings.model!, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
    // The old loaders returned exactly the payload. Poisoning one new answer
    // must fail this same comparison, not an assertion about the implementation.
    expect(() => expect({ ...values(accounts.models[0]!, account), status: 'unknown' }).toEqual(account)).toThrow()
    const a = accounts.models[0], m = directory.members[0], d = devices.models[0], s = settings.model
    const seen: string[] = []
    const stop = autorun(() => seen.push([a?.identity, m?.displayName, d?.deviceName, s?.sidebar.repoSort].join('|')))
    await other.read(async () => [{ ...account, identity: 'changed elsewhere' }])
    await directory.read(async () => ({ members: [{ ...member, displayName: 'Renamed' }], invites: [], currentMemberId: 'owner', mailAvailable: false }))
    await devices.read(async () => [{ ...device, deviceName: 'Renamed phone' }])
    await settings.read(async () => ({ ...DEFAULT_SETTINGS, sidebar: { ...DEFAULT_SETTINGS.sidebar, repoSort: 'alphabetical' } }))
    expect(accounts.models[0]).toBe(a)
    expect(directory.members[0]).toBe(m)
    expect(devices.models[0]).toBe(d)
    expect(settings.model).toBe(s)
    expect(seen.at(-1)).toContain('changed elsewhere|Renamed|Renamed phone|alphabetical')
    stop()
    await devices.read(async () => [])
    expect(devices.answer).toEqual([])
    expect(devices.models).toEqual([])
    expect(isGone(p.model('device', device.sessionId))).toBe(true)
  } finally { accounts.dispose(); other.dispose(); directory.dispose(); devices.dispose(); settings.dispose(); p.dispose() }
})
it('rejects superseded and closed responses before they can change shared records', async () => {
  const p = pool(), request = new RecordRequest(p, 'account', row => row.id)
  let finish!: (rows: AccountView[]) => void
  const old = request.read(() => new Promise(resolve => { finish = resolve }))
  await request.read(async () => [{ ...account, identity: 'new' }])
  finish([account]); await old
  expect(request.models[0]?.identity).toBe('new')
  const closing = request.read(() => new Promise(resolve => { finish = resolve }))
  request.close(); finish([{ ...account, identity: 'closed' }]); await closing
  expect(here(p.model('account', account.id))?.identity).toBe('new')
  p.dispose()
})
it('matches the original repository grouping, pinned filtering and open order on the same fixtures', () => {
  const legacy = pool(), next = pool()
  const repos: GitRepositoryWire[] = [
    { kind: 'repository', path: '/repo/z', originUrl: 'https://example.test/z.git', branch: 'main', worktrees: [{ path: '/repo/z/topic', branch: 'topic' }] },
    { kind: 'repository', path: '/repo/a', originUrl: 'https://example.test/a.git', worktrees: [] },
  ]
  for (const p of [legacy, next]) {
    headerEntities(p).apply(repos.map((value, i) => ({ kind: 'repository', id: `r${i}`, value })))
    vi.spyOn(p.queries, 'activity').mockReturnValue(0)
    vi.spyOn(p.queries, 'latestMachineSession').mockReturnValue(undefined)
  }
  const old = beforePicker(legacy), migrated = createLaunchWorkPicker(next)
  old.open(); migrated.open()
  const render = (picker: ReturnType<typeof migrated.newWork>) => picker.repos.map(repo => ({
    path: repo.path, name: repo.name, originUrl: repo.originUrl, repoId: repo.repoId,
    machines: repo.machines.map(machine => ({ machineId: machine.machineId, path: machine.path })),
    worktrees: repo.worktrees.map(tree => ({ path: tree.path, branch: tree.branch, repoPath: tree.repoPath,
      isMain: tree.isMain, repoName: tree.repoName, repoId: tree.repoId, machineId: tree.machineId, sessions: tree.sessions, issues: tree.issues })),
  }))
  try {
    expect(render(migrated)).toEqual(render(old.newWork() as ReturnType<typeof migrated.newWork>))
    expect(migrated.repositoryPaths).toEqual(old.repositoryPaths)
    expect(() => expect({ ...render(migrated)[0], name: 'wrong' }).toEqual(render(old.newWork() as ReturnType<typeof migrated.newWork>)[0])).toThrow()
    const first = migrated.repos.find(repo => repo.path === '/repo/z')!
    const branches: (string | undefined)[] = []
    const stop = autorun(() => branches.push(first.worktrees[0]?.branch))
    headerEntities(next).apply([{ kind: 'repository', id: 'r0', value: { ...repos[0]!, branch: 'elsewhere' } }])
    expect(first).toBe(migrated.repos.find(repo => repo.path === '/repo/z'))
    expect(branches.at(-1)).toBe('elsewhere')
    stop()
  } finally { legacy.dispose(); next.dispose(); vi.restoreAllMocks() }
})
