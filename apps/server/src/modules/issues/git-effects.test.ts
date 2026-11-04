/**
 * AN ISSUE'S GIT ACTIONS AS EFFECT RECORDS (POD-6394).
 *
 * Through the composed server: `issues.action` / `issues.integrate` create an
 * effect record, the registered executor runs it after the commit, and the
 * command answers `{ ok, output, issue }` as before. The git work itself is the
 * unchanged `GitWorkflow` (covered by `issues.test.ts`); here it is stubbed on
 * the composed workflow object, so these tests are about the record, its status
 * and the answer.
 */

import { type IssueId, mintDeviceId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EffectsRunner } from '../effects/runner'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { changeRows } from '../sync-write/outbox-test-support'
import { ISSUE_GIT_EFFECT_KIND } from './git-effects'

afterEach(() => {
  vi.restoreAllMocks()
  return disposeOracles()
})

async function withIssue(): Promise<{ o: Oracle; id: IssueId }> {
  const o = await makeOracle()
  await o.store.repos.addRepo('/p', o.store.hostMachineId)
  const id = mintDeviceId('iss_') as IssueId
  await o.call.issues.create({ id, repoPath: '/p', title: 'merge me', startNow: false })
  return { o, id }
}

const workflow = (o: Oracle) => o.reg.modules.issues.gitWorkflow

async function effectsOn(o: Oracle, issueId: string) {
  const ids = new Set(
    (await changeRows(o))
      .filter((row) => row.entity === 'effect' && row.payload !== null)
      .filter((row) => JSON.parse(row.payload ?? 'null')?.target?.id === issueId)
      .map((row) => row.entityId),
  )
  return await Promise.all([...ids].map(async (id) => await o.store.effects.get(id)))
}

describe('issues.action merge runs as an effect record', () => {
  it('answers as before, and the record shows its stages and its outcome', async () => {
    const { o, id } = await withIssue()
    const issue = await workflow(o).projectionNow(id)
    vi.spyOn(workflow(o), 'branchLanded').mockResolvedValue(false)
    const action = vi.spyOn(workflow(o), 'action').mockImplementation(async (_ref, _kind, opts) => {
      await opts?.onStage?.('merging')
      return { ok: true, output: 'Fast-forward', issue: { ...issue, landedSha: 'abc123' } }
    })

    const reply = await o.call.issues.action({ id, kind: 'merge' })
    expect(reply.ok).toBe(true)
    expect(reply.output).toBe('Fast-forward')
    expect(reply.issue.id).toBe(id)
    expect(action).toHaveBeenCalledTimes(1)
    expect(action.mock.calls[0]?.slice(0, 2)).toEqual([id, 'merge'])

    const [record] = await effectsOn(o, id)
    expect(record?.kind).toBe(ISSUE_GIT_EFFECT_KIND.merge)
    expect(record?.status).toBe('succeeded')
    expect(record?.result).toEqual({ output: 'Fast-forward', landedSha: 'abc123' })
    // The stage went to every device on the way.
    const stages = (await changeRows(o))
      .filter((row) => row.entity === 'effect' && row.entityId === record?.id)
      .map((row) => JSON.parse(row.payload ?? 'null')?.effect?.stage)
    expect(stages).toContain('merging')
  })

  it('a git failure answers ok: false with the output, and the record failed', async () => {
    const { o, id } = await withIssue()
    const issue = await workflow(o).projectionNow(id)
    vi.spyOn(workflow(o), 'branchLanded').mockResolvedValue(false)
    vi.spyOn(workflow(o), 'action').mockResolvedValue({
      ok: false,
      output: "repo root at /p is on 'dev', not the parent branch 'main'.",
      issue,
    })
    const reply = await o.call.issues.action({ id, kind: 'merge' })
    expect(reply).toMatchObject({
      ok: false,
      output: expect.stringContaining('not the parent branch'),
    })
    const [record] = await effectsOn(o, id)
    expect(record?.status).toBe('failed')
    expect(record?.error?.code).toBe('git')
  })

  it('a refusal answers as the refusal it always was (an issue not started)', async () => {
    const { o, id } = await withIssue()
    // The real workflow: this issue was never started.
    await expect(o.call.issues.action({ id, kind: 'merge' })).rejects.toThrow('issue not started')
    const [record] = await effectsOn(o, id)
    expect(record?.status).toBe('failed')
    expect(record?.error).toEqual({ code: 'refused', message: 'issue not started' })
  })

  it('a merge whose branch has already landed finishes the landing and never merges again', async () => {
    const { o, id } = await withIssue()
    const issue = await workflow(o).projectionNow(id)
    vi.spyOn(workflow(o), 'branchLanded').mockResolvedValue(true)
    const finish = vi
      .spyOn(workflow(o), 'finishLanding')
      .mockResolvedValue({ ...issue, landedSha: 'def456' })
    const action = vi.spyOn(workflow(o), 'action')
    const reply = await o.call.issues.action({ id, kind: 'merge' })
    expect(reply).toMatchObject({ ok: true, output: 'already landed' })
    expect(action).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledWith(id)
  })
})

describe('a merge left running by a stopped server', () => {
  async function stranded() {
    const { o, id } = await withIssue()
    const effects = o.reg.modules.effects
    if (effects === undefined) throw new Error('no effects module')
    await effects.runner.stop()
    const record = mintDeviceId('eff_')
    await o.store.effects.insert(
      {
        id: record,
        kind: ISSUE_GIT_EFFECT_KIND.merge,
        target: { kind: 'issue', id },
        input: {},
        deadlineAt: Date.now() + 60_000,
        createdBy: null,
      },
      Date.now(),
    )
    await o.store.effects.claim(record, Date.now())
    const runner = new EffectsRunner({
      repo: o.store.effects,
      registry: effects.executors,
      now: Date.now,
      every: () => () => undefined,
    })
    const recover = async () => {
      await runner.sweep()
      await runner.idle()
      return await o.store.effects.get(record)
    }
    return { o, id, recover }
  }

  it('landed: the recovery finishes the landing and the record succeeds', async () => {
    const { o, id, recover } = await stranded()
    const issue = await workflow(o).projectionNow(id)
    vi.spyOn(workflow(o), 'branchLanded').mockResolvedValue(true)
    const finish = vi.spyOn(workflow(o), 'finishLanding').mockResolvedValue(issue)
    const action = vi.spyOn(workflow(o), 'action')
    expect((await recover())?.status).toBe('succeeded')
    expect(finish).toHaveBeenCalledWith(id)
    expect(action).not.toHaveBeenCalled()
  })

  it('not in its parent: failed, nothing landed, and it is not merged by the recovery', async () => {
    const { o, recover } = await stranded()
    vi.spyOn(workflow(o), 'branchLanded').mockResolvedValue(false)
    const action = vi.spyOn(workflow(o), 'action')
    const row = await recover()
    expect(row?.status).toBe('failed')
    expect(row?.error?.code).toBe('interrupted')
    expect(action).not.toHaveBeenCalled()
  })

  it('the machine cannot say: unknown', async () => {
    const { o, recover } = await stranded()
    vi.spyOn(workflow(o), 'branchLanded').mockResolvedValue(undefined)
    expect((await recover())?.status).toBe('unknown')
  })
})

describe('issues.integrate runs as an effect record', () => {
  it('answers as before, and the summary is attributed to who asked', async () => {
    const { o, id } = await withIssue()
    const issue = await workflow(o).projectionNow(id)
    const integrate = vi
      .spyOn(workflow(o), 'integrate')
      .mockResolvedValue({ ok: true, output: 'integrated 2 children', issue })
    const reply = await o.call.issues.integrate({ id })
    expect(reply).toMatchObject({ ok: true, output: 'integrated 2 children' })
    const [record] = await effectsOn(o, id)
    expect(record?.kind).toBe(ISSUE_GIT_EFFECT_KIND.integrate)
    expect(record?.status).toBe('succeeded')
    const by = integrate.mock.calls[0]?.[1] as { actor: string; onBehalfOf: string | null }
    expect(by.actor).toBe(record?.actor)
    expect(by.onBehalfOf).toBe(record?.createdBy)
    expect(by.actor).toBeTruthy()
  })
})
