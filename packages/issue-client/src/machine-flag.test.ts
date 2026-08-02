/**
 * `--machine <name|id>` on `issue start` and `issue create` (POD-1424).
 *
 * Starting an issue always started it locally. The server has honoured a machine pin
 * since the column existed — workflow.ts requires the machine, creates the worktree
 * there and spawns there — so the flag was the whole gap.
 *
 * These pin the two properties that make it safe to hand an agent: it resolves EXACTLY,
 * and it refuses rather than guessing.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './client.js'
import { ISSUE_COMMANDS } from './commands.js'

const MACHINES = [
  { id: 'm-here', name: 'ludovico', hostname: 'ludovico' },
  { id: 'm-there', name: 'quiet-box', hostname: 'vmi3407763.contaboserver.net' },
]

function client(machines: unknown = MACHINES) {
  const startMutate = vi.fn(async () => ({ seq: 7, branch: 'b', worktreePath: '/w' }))
  const updateMutate = vi.fn(async () => ({ seq: 7 }))
  const createMutate = vi.fn(async () => ({ seq: 8, title: 'T' }))
  const listQuery = vi.fn(async (): Promise<unknown> => machines)
  const trpc = {
    issues: {
      start: { mutate: startMutate },
      update: { mutate: updateMutate },
      create: { mutate: createMutate },
    },
    machines: { list: { query: listQuery } },
  } as unknown as IssueTrpc
  return { trpc, startMutate, updateMutate, createMutate, listQuery }
}

function command(name: string) {
  const cmd = ISSUE_COMMANDS.find((c) => c.name === name)
  if (!cmd) throw new Error(`no such command: ${name}`)
  return cmd
}

describe('issue start --machine', () => {
  it('writes the pin BEFORE starting, so the worktree lands on the named machine', async () => {
    const c = client()
    await command('start').run(c.trpc, { id: '7', machine: 'quiet-box' })
    // Order is the property: start creates the worktree, so a pin written afterwards
    // would leave the issue homed on one machine with its worktree on another.
    expect(c.updateMutate).toHaveBeenCalledWith({ id: '7', patch: { machineId: 'm-there' } })
    expect(c.updateMutate.mock.invocationCallOrder[0]).toBeLessThan(
      c.startMutate.mock.invocationCallOrder[0] as number,
    )
  })

  it('homes the issue rather than passing a one-shot placement', async () => {
    // issues.machine_id is where an issue LIVES; a per-start override would let the pin
    // and the worktree disagree, which is one issue with two homes.
    const c = client()
    await command('start').run(c.trpc, { id: '7', machine: 'quiet-box' })
    expect(c.startMutate).toHaveBeenCalledWith({ id: '7' })
  })

  it('resolves a name, an id and a hostname to the same machine', async () => {
    for (const ref of ['quiet-box', 'm-there', 'vmi3407763.contaboserver.net']) {
      const c = client()
      await command('start').run(c.trpc, { id: '7', machine: ref })
      expect(c.updateMutate).toHaveBeenCalledWith({ id: '7', patch: { machineId: 'm-there' } })
    }
  })

  it('refuses a near-miss WITHOUT pinning or starting anything', async () => {
    const c = client()
    await expect(command('start').run(c.trpc, { id: '7', machine: 'quiet' })).rejects.toThrow(
      /no visible machine named 'quiet' \(visible: ludovico, quiet-box\)/,
    )
    // Neither side effect may happen: a guessed name that reached the server would
    // start real work on a host the caller never named.
    expect(c.updateMutate).not.toHaveBeenCalled()
    expect(c.startMutate).not.toHaveBeenCalled()
  })

  it('leaves a start without --machine completely untouched', async () => {
    const c = client()
    await command('start').run(c.trpc, { id: '7' })
    expect(c.listQuery).not.toHaveBeenCalled()
    expect(c.updateMutate).not.toHaveBeenCalled()
    expect(c.startMutate).toHaveBeenCalledWith({ id: '7' })
  })

  it('says so when the transport cannot enumerate machines at all', async () => {
    const c = client()
    const trpc = { ...c.trpc, machines: undefined } as unknown as IssueTrpc
    await expect(command('start').run(trpc, { id: '7', machine: 'quiet-box' })).rejects.toThrow(
      /cannot resolve machine names/,
    )
  })

  it('names nothing visible when the fleet is empty, rather than a bare failure', async () => {
    const c = client([])
    await expect(command('start').run(c.trpc, { id: '7', machine: 'quiet-box' })).rejects.toThrow(
      /no visible machine named 'quiet-box' — see `podium machine list`/,
    )
  })
})

describe('issue create --machine', () => {
  it('accepts a name where it previously demanded a raw uuid', async () => {
    const c = client()
    await command('create').run(c.trpc, {
      repoPath: '/r',
      title: 'T',
      machine: 'quiet-box',
    })
    expect(c.createMutate).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm-there' }))
  })

  it('refuses a near-miss without creating the issue', async () => {
    const c = client()
    await expect(
      command('create').run(c.trpc, { repoPath: '/r', title: 'T', machine: 'quiet' }),
    ).rejects.toThrow(/no visible machine named 'quiet'/)
    expect(c.createMutate).not.toHaveBeenCalled()
  })

  it('omits machineId entirely when the flag is absent', async () => {
    const c = client()
    await command('create').run(c.trpc, { repoPath: '/r', title: 'T' })
    expect(c.createMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ machineId: expect.anything() }),
    )
  })
})
