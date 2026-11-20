/**
 * SAVING A FILE AS AN EFFECT RECORD (POD-6395).
 *
 * Through the composed server: `files.write` creates a `file.write` record, the
 * executor writes through the daemon's file RPC (stubbed here: it is the one
 * boundary these tests do not cross), and the route answers as before.
 */

import { asMachineId, type MachineId, mintDeviceId } from '@podium/model'
import { fixtureCommitWriter, fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EffectsRunner } from '../effects/runner'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { changeRows, envelope, submit } from '../sync-write/outbox-test-support'
import { FILE_WRITE_EFFECT_KIND } from './write-effect'

afterEach(() => {
  vi.restoreAllMocks()
  return disposeOracles()
})

const SECRET = 'the text of the file, which no feed row may carry'

async function oracle(): Promise<Oracle> {
  const o = await makeOracle()
  await o.store.repos.addRepo('/p', o.machineId)
  return o
}

const rpc = (o: Oracle) => o.reg.modules.rpc

async function twoMachines() {
  const machineId = asMachineId('file-repository-machine')
  const o = await makeOracle({ offlineMachines: [{ id: machineId, name: 'Repository machine' }] })
  await o.reg.gateway.attachDaemon(machineId, () => {})
  // The fleet default holds a different checkout. Root ownership must win.
  vi.spyOn(o.reg.modules.machines, 'defaultMachine').mockResolvedValue(o.machineId)
  return { o, machineId }
}

/** Keep the real file RPC and observe which daemon receives its write. */
function answeringWrites(o: Oracle) {
  const machines: MachineId[] = []
  const original = o.reg.modules.machines.toMachine
  vi.spyOn(o.reg.modules.machines, 'toMachine').mockImplementation((machineId, message) => {
    if (message.type !== 'fileWriteRequest') return original(machineId, message)
    machines.push(machineId)
    void o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'fileWriteResult',
      requestId: message.requestId,
      ok: true,
      baseHash: '2:9',
    })
  })
  return machines
}

async function fileEffects(o: Oracle) {
  const rows = (await changeRows(o)).filter((row) => row.entity === 'effect')
  const ids = [...new Set(rows.map((row) => row.entityId))]
  return { rows, records: await Promise.all(ids.map(async (id) => await o.store.effects.get(id))) }
}

describe('files.write runs as an effect record', () => {
  it('routes a session-addressed save to the session machine', async () => {
    const o = await makeOracle({ machineId: asMachineId('file-session-machine') })
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    const machines = answeringWrites(o)
    expect(await o.call.files.write({ sessionId, path: 'a.txt', content: 'new' })).toEqual({
      ok: true,
      baseHash: '2:9',
    })
    expect(machines).toEqual([o.machineId])
    expect((await fileEffects(o)).records[0]?.target).toEqual({ kind: 'session', id: sessionId })
  })

  it('routes an unnamed root save to its sole registering machine', async () => {
    const { o, machineId } = await twoMachines()
    await o.store.repos.addRepo('/p', machineId)
    const machines = answeringWrites(o)
    expect(await o.call.files.write({ root: '/p', path: 'a.txt', content: 'new' })).toEqual({
      ok: true,
      baseHash: '2:9',
    })
    expect(machines).toEqual([machineId])
    expect((await fileEffects(o)).records[0]?.target).toEqual({ kind: 'machine', id: machineId })
  })

  it('refuses an ambiguous repository root as BAD_REQUEST before recording a save', async () => {
    const o = await oracle()
    await o.store.repos.addRepo('/p', asMachineId('file-other-machine'))
    const machines = answeringWrites(o)
    await expect(
      o.call.files.write({ root: '/p', path: 'a.txt', content: 'new' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'repository root is registered on several machines; specify machineId',
    })
    expect(machines).toEqual([])
    expect((await fileEffects(o)).records).toEqual([])
  })

  it('honours an explicit machine for a root registered on several machines', async () => {
    const { o, machineId } = await twoMachines()
    await o.store.repos.addRepo('/p', o.machineId)
    await o.store.repos.addRepo('/p', machineId)
    const machines = answeringWrites(o)
    expect(
      await o.call.files.write({
        machineId,
        root: '/p',
        path: 'a.txt',
        content: 'new',
      }),
    ).toEqual({ ok: true, baseHash: '2:9' })
    expect(machines).toEqual([machineId])
  })

  it('a written file answers ok with the new base hash; the feed never carries the text', async () => {
    const o = await oracle()
    const write = vi.spyOn(rpc(o), 'writeFile').mockResolvedValue({ ok: true, baseHash: '2:9' })
    const answer = await o.call.files.write({
      root: '/p',
      path: 'a.txt',
      content: SECRET,
      baseHash: '1:3',
    })
    expect(answer).toEqual({ ok: true, baseHash: '2:9' })
    expect(write).toHaveBeenCalledWith({
      machineId: o.machineId,
      root: '/p',
      path: 'a.txt',
      content: SECRET,
      baseHash: '1:3',
    })
    const { rows, records } = await fileEffects(o)
    expect(records.map((r) => [r?.kind, r?.status])).toEqual([
      [FILE_WRITE_EFFECT_KIND, 'succeeded'],
    ])
    expect(records[0]?.target).toEqual({ kind: 'machine', id: o.machineId })
    for (const row of rows) expect(row.payload ?? '').not.toContain(SECRET)
    expect(JSON.parse(rows.at(-1)?.payload ?? 'null').input).toEqual({
      path: 'a.txt',
      size: SECRET.length,
      root: '/p',
      baseHash: '1:3',
    })
  })

  it('a file changed on disk answers conflict, and the record failed with code conflict', async () => {
    const o = await oracle()
    vi.spyOn(rpc(o), 'writeFile').mockResolvedValue({ ok: false, conflict: true, baseHash: '5:5' })
    const answer = await o.call.files.write({
      root: '/p',
      path: 'a.txt',
      content: 'x',
      baseHash: '1:3',
    })
    expect(answer).toEqual({ ok: false, conflict: true, baseHash: '5:5' })
    expect((await fileEffects(o)).records[0]?.error?.code).toBe('conflict')
  })

  it("the daemon's error answers as that error", async () => {
    const o = await oracle()
    vi.spyOn(rpc(o), 'writeFile').mockResolvedValue({
      ok: false,
      error: 'EACCES: permission denied',
    })
    expect(await o.call.files.write({ root: '/p', path: 'a.txt', content: 'x' })).toEqual({
      ok: false,
      error: 'EACCES: permission denied',
    })
  })

  it('a root that is not a repository is refused as before, and nothing is recorded', async () => {
    const o = await oracle()
    const write = vi.spyOn(rpc(o), 'writeFile')
    await expect(
      o.call.files.write({ root: '/etc', path: 'passwd', content: 'x' }),
    ).rejects.toThrow('root is not a known repository path')
    expect(write).not.toHaveBeenCalled()
    expect((await fileEffects(o)).records).toEqual([])
  })

  it('a timed-out write is read back: the saved text there means it landed', async () => {
    const o = await oracle()
    vi.spyOn(rpc(o), 'writeFile').mockResolvedValue({ ok: false, error: 'timeout' })
    const read = vi
      .spyOn(rpc(o), 'readFile')
      .mockResolvedValue({ ok: true, path: 'a.txt', content: 'new', baseHash: '7:3' })
    expect(
      await o.call.files.write({ root: '/p', path: 'a.txt', content: 'new', baseHash: '1:3' }),
    ).toEqual({
      ok: true,
      baseHash: '7:3',
    })
    expect(read).toHaveBeenCalledWith({ root: '/p', path: 'a.txt', machineId: o.machineId })
  })

  it('a timed-out write whose file still has the old snapshot did not land', async () => {
    const o = await oracle()
    vi.spyOn(rpc(o), 'writeFile').mockResolvedValue({ ok: false, error: 'timeout' })
    vi.spyOn(rpc(o), 'readFile').mockResolvedValue({
      ok: true,
      path: 'a.txt',
      content: 'old',
      baseHash: '1:3',
    })
    const answer = await o.call.files.write({
      root: '/p',
      path: 'a.txt',
      content: 'new',
      baseHash: '1:3',
    })
    expect(answer).toEqual({ ok: false, error: 'The save did not reach the file.' })
    expect((await fileEffects(o)).records[0]?.error?.code).toBe('interrupted')
  })

  it('refuses a record whose input addresses another target than it names', async () => {
    const o = await oracle()
    const reply = await submit(
      o,
      envelope(
        'effects.create',
        {
          id: mintDeviceId('eff_'),
          kind: FILE_WRITE_EFFECT_KIND,
          target: { kind: 'machine', id: o.machineId },
          input: { machineId: 'some-other-machine', root: '/p', path: 'a.txt', content: 'x' },
        },
        'm-mismatch',
      ),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'invalid', details: ['target'] },
    })
  })
})

describe('a save left running by a stopped server', () => {
  it('is read back by the recovery: the text there means it succeeded', async () => {
    const { o, machineId } = await twoMachines()
    await o.store.repos.addRepo('/p', o.machineId)
    await o.store.repos.addRepo('/p', machineId)
    const effects = o.reg.modules.effects
    if (effects === undefined) throw new Error('no effects module')
    await effects.runner.stop()
    const id = mintDeviceId('eff_')
    await o.store.effects.insert(
      fixtureWriteScope(),
      {
        id,
        kind: FILE_WRITE_EFFECT_KIND,
        target: { kind: 'machine', id: machineId },
        input: { root: '/p', path: 'a.txt', content: 'saved' },
        deadlineAt: Date.now() + 60_000,
        createdBy: null,
      },
      Date.now(),
    )
    await o.store.effects.claim(fixtureWriteScope(), id, Date.now())
    const write = vi.spyOn(rpc(o), 'writeFile')
    const read = vi.spyOn(rpc(o), 'readFile').mockResolvedValue({
      ok: true,
      path: 'a.txt',
      content: 'saved',
      baseHash: '9:5',
    })
    const runner = new EffectsRunner({
      writer: fixtureCommitWriter(),
      repo: o.store.effects,
      registry: effects.executors,
      now: Date.now,
      every: () => () => undefined,
    })
    await runner.sweep()
    await runner.idle()
    const row = await o.store.effects.get(id)
    expect(row?.status).toBe('succeeded')
    expect(row?.result).toEqual({ baseHash: '9:5' })
    expect(read).toHaveBeenCalledExactlyOnceWith({ root: '/p', path: 'a.txt', machineId })
    // Checked, never written again.
    expect(write).not.toHaveBeenCalled()
  })
})
