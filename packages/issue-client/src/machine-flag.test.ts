/**
 * `--machine <name|id>` on `issue start` and `issue create` (POD-1386).
 *
 * A human names a machine; `issues.machine_id` stores an id. These pin the two
 * properties that make the flag safe to hand an agent: it resolves EXACTLY, and
 * it refuses rather than guessing.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './client.js'
import { ISSUE_COMMANDS } from './commands.js'

const MACHINES = [
  { id: 'm-here', name: 'ludovico', hostname: 'ludovico' },
  { id: 'm-there', name: 'quiet-box', hostname: 'quiet-box.example.net' },
]

function client(machines: unknown = MACHINES) {
  const startMutate = vi.fn(async () => ({ seq: 7, branch: 'b', worktreePath: '/w' }))
  const updateMutate = vi.fn(async () => ({ seq: 7 }))
  const createMutate = vi.fn(async () => ({ seq: 8, title: 'T' }))
  const listQuery = vi.fn(async (): Promise<unknown> => machines)
  return {
    trpc: {
      issues: {
        start: { mutate: startMutate },
        update: { mutate: updateMutate },
        create: { mutate: createMutate },
      },
      machines: { list: { query: listQuery } },
    } as unknown as IssueTrpc,
    startMutate,
    updateMutate,
    createMutate,
    listQuery,
  }
}

const command = (name: string) => {
  const entry = ISSUE_COMMANDS.find((c) => c.name === name)
  if (!entry) throw new Error(`missing ${name} command`)
  return entry
}

describe('issue start --machine', () => {
  it('homes the issue on the named machine before starting it', async () => {
    const c = client()
    await command('start').run(c.trpc, { id: '7', machine: 'quiet-box' })
    // The pin is WRITTEN, not passed as a one-shot placement: `issues.machine_id`
    // is where an issue lives, and every later `agent spawn --issue` must land in
    // the same worktree. A per-start override would let the pin and the worktree
    // disagree — one issue with two homes.
    expect(c.updateMutate).toHaveBeenCalledWith({ id: '7', patch: { machineId: 'm-there' } })
    expect(c.startMutate).toHaveBeenCalledWith({ id: '7' })
  })

  it('leaves the issue alone when no machine is named', async () => {
    const c = client()
    await command('start').run(c.trpc, { id: '7' })
    expect(c.updateMutate).not.toHaveBeenCalled()
    expect(c.listQuery).not.toHaveBeenCalled()
  })

  it('refuses a near-miss instead of starting work on the wrong host', async () => {
    const c = client()
    await expect(command('start').run(c.trpc, { id: '7', machine: 'quiet' })).rejects.toThrow(
      /no visible machine named 'quiet'/u,
    )
    // Nothing was written and nothing was started: the refusal happens before any
    // state changes, so a mistyped name costs nothing to recover from.
    expect(c.updateMutate).not.toHaveBeenCalled()
    expect(c.startMutate).not.toHaveBeenCalled()
  })

  it('accepts a raw machine id as well as a name', async () => {
    const c = client()
    await command('start').run(c.trpc, { id: '7', machine: 'm-there' })
    expect(c.updateMutate).toHaveBeenCalledWith({ id: '7', patch: { machineId: 'm-there' } })
  })

  it('refuses a machine that is not in the visible set', async () => {
    // The list is already scoped to what this caller may see, so a machine it
    // cannot see is refused as unknown — the same answer that leaks nothing about
    // whether it exists at all.
    const c = client([{ id: 'm-here', name: 'ludovico', hostname: 'ludovico' }])
    await expect(command('start').run(c.trpc, { id: '7', machine: 'm-there' })).rejects.toThrow(
      /no visible machine named 'm-there'/u,
    )
  })

  it('resolves a name, an id and a hostname to the same machine', async () => {
    for (const ref of ['quiet-box', 'm-there', 'quiet-box.example.net']) {
      const c = client()
      await command('start').run(c.trpc, { id: '7', machine: ref })
      expect(c.updateMutate).toHaveBeenCalledWith({ id: '7', patch: { machineId: 'm-there' } })
    }
  })

  it('says so when the transport cannot enumerate machines at all', async () => {
    const c = client()
    const trpc = { ...c.trpc, machines: undefined } as unknown as IssueTrpc
    await expect(command('start').run(trpc, { id: '7', machine: 'quiet-box' })).rejects.toThrow(
      /cannot resolve machine names/u,
    )
  })

  it('names nothing visible when the fleet is empty, rather than a bare failure', async () => {
    const c = client([])
    await expect(command('start').run(c.trpc, { id: '7', machine: 'quiet-box' })).rejects.toThrow(
      /no visible machine named 'quiet-box' — see `podium machine list`/u,
    )
  })
})

describe('issue create --machine', () => {
  it('resolves a name rather than requiring the caller to know a uuid', async () => {
    const c = client()
    await command('create').run(c.trpc, {
      repoPath: '/r',
      title: 'T',
      machine: 'quiet-box',
      start: false,
    })
    expect(c.createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 'm-there', repoPath: '/r', title: 'T' }),
    )
  })

  it('refuses a near-miss without creating the issue', async () => {
    const c = client()
    await expect(
      command('create').run(c.trpc, { repoPath: '/r', title: 'T', machine: 'quiet', start: false }),
    ).rejects.toThrow(/no visible machine named 'quiet'/u)
    expect(c.createMutate).not.toHaveBeenCalled()
  })

  it('sends no machineId when none was asked for', async () => {
    const c = client()
    await command('create').run(c.trpc, { repoPath: '/r', title: 'T', start: false })
    expect(c.createMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ machineId: expect.anything() }),
    )
  })
})
