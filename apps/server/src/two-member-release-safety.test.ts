import { fixtureWriteScope } from '@podium/sync/testing'
/** Release witnesses added after the owning tasks: actual caller/root resolution
 * for MU-08, disabled module callers, and MU-30 on a machine shared both ways. */
import {
  asIssueId,
  asMachineId,
  asSessionId,
  type UsageBucketWire,
  type UsageSourceWire,
} from '@podium/model'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  MEMBERS,
  REPO_PATH,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => await f?.close())
afterEach(() => vi.restoreAllMocks())
const registry = () => f.handle.registry

it('a disabled explicit owner cannot create a session through the module', async () => {
  const disabledSessionId = asSessionId('disabled-release-owner')
  const create = (ownerUserId: typeof MEMBERS.bob.id) =>
    registry().modules.sessions.createSession({
      ownerUserId,
      agentKind: 'shell',
      cwd: '/wt/release-owner-check',
      machineId: f.machines.bob,
      ...(ownerUserId === MEMBERS.carol.id ? { sessionId: disabledSessionId } : {}),
    })
  // An active explicit owner is still accepted on the same machine/path.
  await expect(create(MEMBERS.bob.id)).resolves.toHaveProperty('sessionId')
  const before = f.daemonFrames(f.machines.bob).filter((frame) => frame.type === 'spawn').length
  await expect(create(MEMBERS.carol.id)).rejects.toThrow(/disabled|active member/i)
  expect(await registry().sessionStore.sessions.getSession(disabledSessionId)).toBeUndefined()
  expect(f.daemonFrames(f.machines.bob).filter((frame) => frame.type === 'spawn')).toHaveLength(
    before,
  )
})

describe('MU-08: real raw-git and file routes resolve the actor and the checkout', () => {
  it('admin Alice cannot write Bob’s session; Bob’s session resolves to his cwd/machine', async () => {
    const alice = (await f.as('alice')).trpc
    const bob = (await f.as('bob')).trpc
    const input = { sessionId: f.sessions.bob, path: 'review.txt', content: 'hello' }
    await expect(alice.files.write.mutate(input)).rejects.toThrow(/not found/i)
    const writes = (who: 'alice' | 'bob') =>
      f
        .daemonFrames(f.machines[who])
        .filter((frame) => frame.type === 'fileWriteRequest' && frame.path === input.path)
    expect(writes('bob')).toEqual([])
    expect(writes('alice')).toEqual([])
    const pending = bob.files.write.mutate(input)
    await vi.waitFor(() => expect(writes('bob')).toHaveLength(1))
    const frame = writes('bob')[0]!
    if (frame.type !== 'fileWriteRequest') throw new Error('wrong fixture frame')
    const session = await registry().sessionStore.sessions.getSession(f.sessions.bob)
    expect(frame).toMatchObject({ cwd: session!.cwd, path: input.path, content: input.content })
    expect(writes('alice')).toEqual([])
    await registry().gateway.routeDaemonFrame(f.machines.bob, {
      type: 'fileWriteResult',
      requestId: frame.requestId,
      ok: true,
    })
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('a grantee reads raw git and writes only an allowed root on the permitted machine', async () => {
    const alice = (await f.as('alice')).trpc
    const bob = (await f.as('bob')).trpc
    const git = vi
      .spyOn(registry().modules.rpc, 'repoOp')
      .mockResolvedValue({ ok: true, output: '' })
    const write = vi.spyOn(registry().modules.rpc, 'writeFile').mockResolvedValue({ ok: true })
    const input = { machineId: f.machines.alice, root: REPO_PATH }
    await expect(bob.git.status.query(input)).rejects.toThrow(/not found/i)
    await expect(alice.git.status.query(input)).resolves.toMatchObject({ ok: true })
    git.mockClear()
    await alice.machines.share.mutate({
      id: f.machines.alice,
      grantee: MEMBERS.bob.id,
      verb: 'use',
      acknowledgeSharedMachine: true,
    })
    try {
      await expect(bob.git.status.query(input)).resolves.toMatchObject({ ok: true })
      expect(git).toHaveBeenCalledWith('statusProbe', REPO_PATH, undefined, f.machines.alice)
      await expect(
        bob.files.write.mutate({ ...input, path: 'allowed.txt', content: 'ok' }),
      ).resolves.toMatchObject({ ok: true })
      const nested = { ...input, root: `${REPO_PATH}/nested-checkout` }
      await expect(bob.git.status.query(nested)).resolves.toMatchObject({ ok: true })
      expect(git).toHaveBeenCalledWith('statusProbe', nested.root, undefined, f.machines.alice)
      await expect(
        bob.files.write.mutate({ ...nested, path: 'allowed.txt', content: 'ok' }),
      ).resolves.toMatchObject({ ok: true })
      git.mockClear()
      write.mockClear()
      await expect(
        bob.git.status.query({ ...input, root: '/unregistered-private-checkout' }),
      ).rejects.toThrow(/known repository/i)
      await expect(
        bob.files.write.mutate({
          ...input,
          root: '/unregistered-private-checkout',
          path: 'no.txt',
          content: 'no',
        }),
      ).rejects.toThrow(/known repository/i)
      await expect(
        bob.git.status.query({ ...input, machineId: asMachineId('machine-without-use') }),
      ).rejects.toThrow(/not found/i)
      expect(git).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      // Machine use adds no access to Alice's session on that checkout.
      await expect(
        bob.files.write.mutate({ sessionId: f.sessions.alice, path: 'no.txt', content: 'no' }),
      ).rejects.toThrow(/not found/i)
      expect(write).not.toHaveBeenCalled()
    } finally {
      await alice.machines.unshare.mutate({
        id: f.machines.alice,
        grantee: MEMBERS.bob.id,
        verb: 'use',
      })
    }
  })

  it('a root reported only by Alice’s machine is refused when Bob addresses his own machine', async () => {
    await registry().sessionStore.repos.addRepo('/alice-only-checkout', f.machines.alice)
    const alice = (await f.as('alice')).trpc
    const bob = (await f.as('bob')).trpc
    const git = vi
      .spyOn(registry().modules.rpc, 'repoOp')
      .mockResolvedValue({ ok: true, output: '' })
    const write = vi.spyOn(registry().modules.rpc, 'writeFile').mockResolvedValue({ ok: true })
    await expect(
      alice.git.status.query({ machineId: f.machines.alice, root: '/alice-only-checkout' }),
    ).resolves.toMatchObject({ ok: true })
    git.mockClear()
    const wrongMachine = { machineId: f.machines.bob, root: '/alice-only-checkout' }
    await expect(bob.git.status.query(wrongMachine)).rejects.toThrow(/known repository/i)
    await expect(bob.files.read.query({ ...wrongMachine, path: 'private.txt' })).rejects.toThrow(
      /known repository/i,
    )
    await expect(
      bob.files.write.mutate({ ...wrongMachine, path: 'private.txt', content: 'no' }),
    ).rejects.toThrow(/known repository/i)
    expect(git).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
  it.each([
    'git',
    'read',
    'write',
    'list',
    'search',
  ] as const)('pins the default target through %s authorization and dispatch', async (route) => {
    const bob = (await f.as('bob')).trpc
    const machines = registry().modules.machines
    let selected = f.machines.bob
    const defaultMachine = vi
      .spyOn(machines, 'defaultMachine')
      .mockImplementation(async () => selected)
    const repoMachine = vi
      .spyOn(machines, 'resolveMachine')
      .mockImplementation(async (requested) => (requested ? asMachineId(requested) : selected))
    const repos = registry().sessionStore.repos
    const list = repos.listRepos.bind(repos)
    vi.spyOn(repos, 'listRepos').mockImplementation(async (machineId) => {
      const roots = await list(machineId)
      // Both hosts register /repo. The default changes after the authorized
      // root was read, before the broker resolves an omitted dispatch target.
      selected = f.machines.alice
      return roots
    })
    const root = `${REPO_PATH}/mu08-pin-${route}`
    const requests = () =>
      [f.machines.alice, f.machines.bob].flatMap((machineId) =>
        f
          .daemonFrames(machineId)
          .flatMap((frame) =>
            ((frame.type === 'repoOpRequest' ||
              frame.type === 'fileReadRequest' ||
              frame.type === 'fileWriteRequest') &&
              frame.cwd === root) ||
            (frame.type === 'dirListRequest' && frame.root === root)
              ? [{ machineId, frame }]
              : [],
          ),
      )
    const pending =
      route === 'git'
        ? bob.git.status.query({ root })
        : route === 'read'
          ? bob.files.read.query({ root, path: `${root}/private.txt` })
          : route === 'write'
            ? bob.files.write.mutate({ root, path: `${root}/private.txt`, content: 'owner-only' })
            : route === 'list'
              ? bob.files.list.query({ root })
              : bob.files.search.query({ root, query: '' })
    await vi.waitFor(() => expect(requests()).toHaveLength(1))
    const request = requests()[0]!
    const { frame, machineId } = request
    if (frame.type === 'repoOpRequest')
      await registry().gateway.routeDaemonFrame(machineId, {
        type: 'repoOpResult',
        requestId: frame.requestId,
        ok: true,
        output: `${machineId === f.machines.alice ? 'alice-private' : 'bob-own'}.txt\0`,
      })
    else if (frame.type === 'fileWriteRequest')
      await registry().gateway.routeDaemonFrame(machineId, {
        type: 'fileWriteResult',
        requestId: frame.requestId,
        ok: true,
      })
    else if (frame.type === 'dirListRequest')
      await registry().gateway.routeDaemonFrame(machineId, {
        type: 'dirListResult',
        requestId: frame.requestId,
        ok: true,
        path: frame.path,
        entries: [],
      })
    // File reads are answered by the fixture's normal daemon handler.
    await pending
    expect(request.machineId).toBe(f.machines.bob)
    expect(
      route === 'git' || route === 'search' ? repoMachine : defaultMachine,
    ).toHaveBeenCalledTimes(1)
    expect(requests().filter((item) => item.machineId === f.machines.alice)).toEqual([])
  })

  it('keeps the path index on its resolved machine when two checkouts have the same root', async () => {
    const alice = (await f.as('alice')).trpc
    const bob = (await f.as('bob')).trpc
    let selected = f.machines.alice
    vi.spyOn(registry().modules.machines, 'defaultMachine').mockImplementation(async () => selected)
    vi.spyOn(registry().modules.machines, 'resolveMachine').mockImplementation(async (requested) =>
      requested ? asMachineId(requested) : selected,
    )
    const repo = vi
      .spyOn(registry().modules.rpc, 'repoOp')
      .mockImplementation(async (_op, _root, _args, machineId) => ({
        ok: true,
        output: `${(machineId ?? selected) === f.machines.alice ? 'alice-private-plan' : 'bob-own-file'}.txt\0`,
      }))
    const root = `${REPO_PATH}/mu08-path-index`
    expect(await alice.files.search.query({ root, query: '' })).toEqual({
      paths: ['alice-private-plan.txt'],
    })
    selected = f.machines.bob
    // Explicit routing is the positive control, even while Alice's paths are cached.
    expect(await bob.files.search.query({ machineId: f.machines.bob, root, query: '' })).toEqual({
      paths: ['bob-own-file.txt'],
    })
    expect(repo).toHaveBeenLastCalledWith('lsFiles', root, undefined, f.machines.bob)
    expect(await bob.files.search.query({ root, query: '' })).toEqual({
      paths: ['bob-own-file.txt'],
    })
  })
})

describe('MU-30: usage belongs to the run owner on a shared OS account', () => {
  const bucket = (model: string): UsageBucketWire => ({
    hour: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString(),
    model,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messages: 1,
  })

  it('shared task totals include both humans while session lines and hourly usage stay personal after reassignment', async () => {
    const alice = (await f.as('alice')).trpc
    const bob = (await f.as('bob')).trpc
    const task = (await alice.issues.create.mutate({
      repoPath: REPO_PATH,
      title: 'Shared accounting witness',
      startNow: false,
    })) as { id: string }
    const machineId = f.machines.alice
    await alice.machines.share.mutate({
      id: machineId,
      grantee: MEMBERS.bob.id,
      verb: 'use',
      acknowledgeSharedMachine: true,
    })
    const ids = { alice: f.sessions.alice, bob: f.sessions.bobOnAliceTask }
    const sources: Array<UsageSourceWire & { windowBuckets: UsageBucketWire[] }> = []
    for (const who of ['alice', 'bob'] as const) {
      const row = await registry().sessionStore.sessions.getSession(ids[who])
      if (!row) throw new Error('missing fixture session')
      const nativeId = `shared-accounting-${who}`
      const path = `/transcripts/${nativeId}.jsonl`
      await registry().sessionStore.sessions.upsertSession(fixtureWriteScope(), {
        ...row,
        machineId,
        issueId: asIssueId(task.id),
        resumeKind: 'claude-code',
        resumeValue: nativeId,
      })
      await registry().sessionStore.conversations.registry.ensure({
        machineId,
        nativeId,
        providerId: 'claude-code',
        path,
      })
      const b = bucket(`shared-${who}-model`)
      sources.push({
        path,
        harness: 'claude-code',
        scannedBytes: 1,
        firstTsMs: Date.now(),
        lastTsMs: Date.now(),
        models: [b],
        windowModels: [b],
        windowBuckets: [b],
      })
    }
    vi.spyOn(registry().modules.machines, 'defaultMachine').mockResolvedValue(machineId)
    vi.spyOn(registry().modules.rpc, 'answeringMachineId').mockResolvedValue(machineId)
    vi.spyOn(registry().modules.rpc, 'usage').mockResolvedValue({
      hostname: machineId,
      buckets: sources.flatMap((source) => source.windowBuckets),
      sources,
    })
    try {
      for (const client of [alice, bob]) await client.usage.summary.query()
      for (const who of ['alice', 'bob'] as const) {
        const client = who === 'alice' ? alice : bob
        const costs = await client.cost.task.query({ issueId: task.id })
        expect(costs.own.models.map((model) => model.model).sort()).toEqual([
          'shared-alice-model',
          'shared-bob-model',
        ])
        expect(costs.sessions.map((session) => session.sessionId)).toEqual([ids[who]])
        const totals = JSON.stringify(costs.own)
        for (const privateValue of [
          MEMBERS.alice.id,
          MEMBERS.bob.id,
          ...sources.map((source) => source.path),
        ])
          expect(totals).not.toContain(privateValue)
      }
      await alice.issues.update.mutate({
        id: task.id,
        patch: { assignee: MEMBERS.bob.id },
      } as never)
      for (const who of ['alice', 'bob'] as const) {
        const client = who === 'alice' ? alice : bob
        expect((await client.usage.summary.query()).buckets.map((b) => b.model)).toEqual([
          `shared-${who}-model`,
        ])
        expect(
          (await client.cost.task.query({ issueId: task.id })).sessions.map(
            (session) => session.sessionId,
          ),
        ).toEqual([ids[who]])
      }
    } finally {
      await alice.machines.unshare.mutate({ id: machineId, grantee: MEMBERS.bob.id, verb: 'use' })
    }
  })

  it.each([
    'alice',
    'bob',
  ] as const)('both members see only their run usage on %s’s machine', async (host) => {
    const other = host === 'alice' ? 'bob' : 'alice'
    const machineId = f.machines[host]
    const hostClient = (await f.as(host)).trpc
    await hostClient.machines.share.mutate({
      id: machineId,
      grantee: MEMBERS[other].id,
      verb: 'use',
      acknowledgeSharedMachine: true,
    })
    const answering = vi
      .spyOn(registry().modules.rpc, 'answeringMachineId')
      .mockResolvedValue(machineId)
    vi.spyOn(registry().modules.machines, 'defaultMachine').mockResolvedValue(machineId)
    const sources: Array<UsageSourceWire & { windowBuckets: UsageBucketWire[] }> = []
    for (const who of ['alice', 'bob'] as const) {
      const sessionId = f.sessions[who]
      const row = await registry().sessionStore.sessions.getSession(sessionId)
      if (!row) throw new Error('missing fixture session')
      const nativeId = `${host}-${who}-usage`
      const path = `/transcripts/${nativeId}.jsonl`
      await registry().sessionStore.sessions.upsertSession(fixtureWriteScope(), {
        ...row,
        machineId,
        resumeKind: 'claude-code',
        resumeValue: nativeId,
      })
      await registry().sessionStore.conversations.registry.ensure({
        machineId,
        nativeId,
        providerId: 'claude-code',
        path,
      })
      const b = bucket(`${who}-only-model`)
      sources.push({
        path,
        harness: 'claude-code' as const,
        scannedBytes: 1,
        firstTsMs: Date.now(),
        lastTsMs: Date.now(),
        models: [b],
        windowModels: [b],
        windowBuckets: [b],
      })
    }
    // A native transcript with no Podium run owner must not be assigned to a grantee/custodian.
    sources.push({
      ...sources[0]!,
      path: '/transcripts/unattributed.jsonl',
      windowBuckets: [bucket('unattributed-model')],
    })
    vi.spyOn(registry().modules.rpc, 'usage').mockResolvedValue({
      hostname: machineId,
      buckets: sources.flatMap((source) => source.windowBuckets),
      sources,
    })
    try {
      for (const who of ['alice', 'bob'] as const) {
        const usage = await (await f.as(who)).trpc.usage.summary.query()
        expect(usage.buckets.map((b) => b.model)).toEqual([`${who}-only-model`])
        expect(usage).not.toHaveProperty('sources')
      }
      // The original owner still spends under their own identity after reassignment.
      await hostClient.issues.update.mutate({
        id: f.tasks[host],
        patch: { assignee: MEMBERS[other].id },
      } as never)
      expect((await hostClient.usage.summary.query()).buckets.map((b) => b.model)).toEqual([
        `${host}-only-model`,
      ])
    } finally {
      answering.mockRestore()
      await hostClient.machines.unshare.mutate({
        id: machineId,
        grantee: MEMBERS[other].id,
        verb: 'use',
      })
    }
  })

  it('an older daemon’s aggregate without source buckets is never disclosed on a multi-member instance', async () => {
    vi.spyOn(registry().modules.rpc, 'usage').mockResolvedValue({
      hostname: f.machines.bob,
      buckets: [bucket('another-person')],
    })
    vi.spyOn(registry().modules.rpc, 'answeringMachineId').mockResolvedValue(f.machines.bob)
    vi.spyOn(registry().modules.machines, 'defaultMachine').mockResolvedValue(f.machines.bob)
    const response = await (await f.as('bob')).trpc.usage.summary
      .query()
      .catch((error: Error) => error.message)
    expect(response).toMatch(/upgrade.*daemon|daemon.*upgrade/i)
  })

  it('disabling the other member does not make their historical machine usage public', async () => {
    const store = registry().sessionStore
    await store.users.disable(MEMBERS.bob.id, new Date().toISOString(), MEMBERS.alice.id)
    vi.spyOn(registry().modules.rpc, 'usage').mockResolvedValue({
      hostname: f.machines.alice,
      buckets: [bucket('disabled-bob-history')],
    })
    vi.spyOn(registry().modules.rpc, 'answeringMachineId').mockResolvedValue(f.machines.alice)
    try {
      await expect((await f.as('alice')).trpc.usage.summary.query()).rejects.toThrow(
        /upgrade.*daemon|daemon.*upgrade/i,
      )
    } finally {
      await store.users.enable(MEMBERS.bob.id, new Date().toISOString(), MEMBERS.alice.id)
    }
  })
})
