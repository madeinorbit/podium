import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { asAgentIdentityId, asMachineId, asSessionId, asUserId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BindingStore } from '../binding-store'
import { memoryMarkers, SessionAccessStore } from './access'
import type { DaemonContext } from './context'
import { exportCwd, handoffHandlers } from './handoff'

const transfer = (sessionId: ReturnType<typeof asSessionId>) => ({
  transferId: 'transfer-denied',
  sessionId,
  agentKind: 'codex' as const,
  fromMachineId: asMachineId('source-machine'),
  toMachineId: asMachineId('target-machine'),
  observationGeneration: 2,
  delegation: {
    actor: asAgentIdentityId(sessionId),
    onBehalfOf: asUserId('user:alice'),
    grantedScope: { kind: 'all' as const },
    parentBindingId: null,
  },
})

function refusalContext(sent: DaemonMessage[]): DaemonContext {
  // No home, package, git, or binding service is supplied. If refusal happens
  // after materialization begins, this deliberately incomplete context explodes.
  return {
    machineId: 'target-machine',
    send: (message: DaemonMessage) => sent.push(message),
    access: new SessionAccessStore({ markers: memoryMarkers() }),
  } as unknown as DaemonContext
}

describe('handoff ADOPT host refusal', () => {
  it.each([
    ['denied', 'unauthorized', 'handoff refused'],
    ['unreachable', 'unreachable', 'handoff target unreachable'],
  ] as const)('refuses %s before package materialization with a distinct transport reason', async (machineAccess, refusal, error) => {
    const sent: DaemonMessage[] = []
    const sessionId = asSessionId(`import-${machineAccess}`)

    handoffHandlers.handoffImportRequest(refusalContext(sent), {
      type: 'handoffImportRequest',
      requestId: `request-${machineAccess}`,
      sessionId,
      repoPath: '/must-not-be-read',
      worktreeName: 'must-not-be-read',
      binding: {
        transitionId: `adopt:${machineAccess}`,
        machineAccess,
        transfer: transfer(sessionId),
      },
    })
    await Promise.resolve()

    expect(sent).toEqual([
      {
        type: 'handoffImportResult',
        requestId: `request-${machineAccess}`,
        ok: false,
        refusal,
        error,
      },
    ])
  })
})

it('refuses a return the history gate would refuse before any file lands (POD-7534)', async () => {
  const sent: DaemonMessage[] = []
  const sessionId = asSessionId('import-history')
  const asked: unknown[] = []
  const ctx = {
    ...refusalContext(sent),
    bindingStore: {
      admitsTargetClaim: async (input: unknown) => {
        asked.push(input)
        return false
      },
    },
  } as unknown as DaemonContext
  handoffHandlers.handoffImportRequest(ctx, {
    type: 'handoffImportRequest',
    requestId: 'request-history',
    sessionId,
    repoPath: '/must-not-be-read',
    worktreeName: 'must-not-be-read',
    binding: {
      transitionId: 'adopt:return',
      machineAccess: 'allowed',
      transfer: transfer(sessionId),
    },
  })
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(asked).toMatchObject([
    {
      event: 'adopt',
      role: 'target',
      phase: 'claim',
      sessionId,
      transferId: 'transfer-denied',
      fromMachineId: 'source-machine',
      toMachineId: 'target-machine',
    },
  ])
  expect(sent).toEqual([
    {
      type: 'handoffImportResult',
      requestId: 'request-history',
      ok: false,
      error: 'handoff refused',
    },
  ])
})

it.each([
  ['/repo', '/repo/src', '/repository/src'],
  [String.raw`c:\repo`, 'C:/REPO/src', String.raw`C:\repository\src`],
])('machine paths: handoff exports the actual cwd within %s', (root, cwd, sibling) => {
  let raw: string | undefined = cwd
  const ctx = { sessionCwdTracker: { rawCwd: () => raw } } as unknown as DaemonContext
  const sessionId = asSessionId('cwd-guard')
  expect(exportCwd(ctx, sessionId, root)).toBe(cwd)
  raw = sibling
  expect(exportCwd(ctx, sessionId, root)).toBe(root)
  raw = undefined
  expect(exportCwd(ctx, sessionId, root)).toBe(root)
})

describe('a return over handoff history, against a real binding store (POD-7534)', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })
  const here = asMachineId('target-machine')
  const away = asMachineId('source-machine')
  const owner = asUserId('user:alice')
  const sessionId = asSessionId('returning')
  const delegation = {
    actor: asAgentIdentityId(sessionId),
    onBehalfOf: owner,
    grantedScope: { kind: 'none' as const },
    parentBindingId: null,
    revision: 1,
  }

  /** Every file under `root`, by relative path, with its bytes. */
  async function snapshot(root: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {}
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else files[relative(root, path)] = await readFile(path, 'utf8')
      }
    }
    await walk(root)
    return files
  }

  async function machineWithHistory(alive: boolean) {
    const root = await mkdtemp(join(tmpdir(), 'podium-return-import-'))
    roots.push(root)
    const receipts = join(root, 'receipts')
    const repo = join(root, 'repo')
    const home = join(root, 'home')
    await mkdir(receipts)
    await mkdir(join(repo, '.worktrees', 'retained'), { recursive: true })
    await mkdir(join(home, '.codex', 'sessions'), { recursive: true })
    // Local work in the retained worktree, its transcript, and the residue marker.
    await writeFile(join(repo, '.worktrees', 'retained', 'uncommitted.txt'), 'local work')
    await writeFile(join(home, '.codex', 'sessions', 'thread.jsonl'), 'transcript')
    await writeFile(join(repo, '.worktrees', 'retained', '.podium-residue'), 'fingerprint')
    const store = await BindingStore.open({ dir: join(root, 'bindings') })
    await store.ensureBinding({
      sessionId,
      agentKind: 'codex',
      claimantMachineId: here,
      delegation,
    })
    for (const phase of ['claim', 'commit'] as const) {
      await store.transition({
        event: 'adopt',
        transitionId: `outbound:${phase}`,
        sessionId,
        machineAccess: 'allowed',
        transferId: 'outbound',
        role: 'source',
        phase,
        fromMachineId: here,
        toMachineId: away,
        at: '2026-07-31T12:00:00.000Z',
      })
    }
    await store.inventory(receipts)
    store.confirmInventory(here, {
      [sessionId]: { owner, machineId: away, closed: false, delegation },
    })
    store.setSourceProcessProbe(async () => alive)
    return { root, receipts, repo, home, store }
  }

  async function sendReturn(machine: Awaited<ReturnType<typeof machineWithHistory>>) {
    const sent: DaemonMessage[] = []
    const ctx = {
      machineId: here,
      homeDir: machine.home,
      send: (message: DaemonMessage) => sent.push(message),
      access: new SessionAccessStore({ markers: memoryMarkers() }),
      bindingStore: machine.store,
    } as unknown as DaemonContext
    handoffHandlers.handoffImportRequest(ctx, {
      type: 'handoffImportRequest',
      requestId: 'return',
      sessionId,
      repoPath: machine.repo,
      worktreeName: 'retained',
      binding: {
        transitionId: 'adopt:return:target-claim',
        machineAccess: 'allowed',
        transfer: {
          transferId: 'return',
          sessionId,
          agentKind: 'codex',
          fromMachineId: away,
          toMachineId: here,
          observationGeneration: 2,
          delegation,
          serverDelegation: delegation,
        },
      },
    } as never)
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000 })
    return sent
  }

  it.each([
    ['a live source process', async () => machineWithHistory(true)],
    [
      'a spooled receipt',
      async () => {
        const machine = await machineWithHistory(false)
        await writeFile(join(machine.receipts, `${sessionId}.json`), '{"session_id":"thread"}')
        return machine
      },
    ],
  ])('refuses with %s before the import touches the worktree, transcript or residue', async (_name, arrange) => {
    const machine = await arrange()
    const before = await snapshot(machine.root)
    const sent = await sendReturn(machine)
    expect(sent).toEqual([
      { type: 'handoffImportResult', requestId: 'return', ok: false, error: 'handoff refused' },
    ])
    expect(await snapshot(machine.root)).toEqual(before)
    expect(machine.store.isQuarantined(sessionId)).toBe(true)
  })

  it('lets an admissible return through to the unpack step', async () => {
    const machine = await machineWithHistory(false)
    const sent = await sendReturn(machine)
    // No package was staged, so the unpack itself fails, past the history gate.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'handoffImportResult', requestId: 'return', ok: false })
    expect(sent[0]).not.toMatchObject({ error: 'handoff refused' })
  })
})
