/**
 * AUTOMATION AND WORKFLOW WRITES ON THE SYNC WRITE ENTRY POINT (POD-6418).
 *
 * Through the registry the server actually composes. Each write arrives through
 * `submit` with a receipt at the head (and, for automations, provenance on its
 * change rows: workflow tables are not on the change log yet); a replay answers
 * the recorded result and runs nothing; the target check refuses before the
 * handler, and a revoked grant refuses a replay; the checkpoint's coordinator
 * notice is sent once after the commit and never on a rollback; the old routes
 * are thin adapters onto the entry point on tRPC and on the agent relay.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asMutationId,
  asUserId,
  firstAdminMemberId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CommandPrincipal,
  resolvePrincipalAsync,
  userCommandPrincipal,
} from '../../command-principal'
import { currentPlainCommand } from '../../plain-command-scope'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { workflowRelayWrite } from '../workflows/rpc'
import type { WorkflowServiceDeps } from '../workflows/service'
import { appliedReply, envelope, expectAppliedOnPath, rowsOf, submit } from './outbox-test-support'

afterEach(() => disposeOracles())

async function member(o: Oracle, id = 'usr_member_6418'): Promise<UserId> {
  const user = asUserId(id)
  await o.store.users.createUnclaimed({
    id: user,
    displayName: 'Member',
    email: null,
    role: 'member',
    createdAt: new Date().toISOString(),
    disabledAt: null,
  })
  return user
}

const submitAs = async (
  o: Oracle,
  principal: CommandPrincipal,
  command: string,
  input: unknown,
  mutationId = `mut_${command}_${Math.random()}`,
  transport: 'trpc' | 'relay' = 'trpc',
) =>
  await o.reg.modules.syncWrite.submit(envelope(command, input, mutationId), principal, transport)

const nightly = (name: string) => ({
  name,
  scheduleKind: 'cron' as const,
  cron: '0 3 * * *',
  agentKind: 'claude-code',
  prompt: 'sweep',
})

describe('automations on the entry point', () => {
  it('create, update, setEnabled and remove apply once, with provenance and a receipt', async () => {
    const o = await makeOracle()
    const created = await expectAppliedOnPath(
      o,
      envelope('automations.create', nightly('nightly'), 'mut_aut_create'),
      { writes: true },
    )
    const { id } = created.result as { id: string }
    expect(created.rows.map((row) => [row.entity, row.entityId])).toEqual([['automation', id]])

    const updated = await expectAppliedOnPath(
      o,
      envelope('automations.update', { id, patch: { name: 'renamed' } }, 'mut_aut_update'),
      { writes: true },
    )
    expect(updated.result).toMatchObject({ id, name: 'renamed' })
    await expectAppliedOnPath(
      o,
      envelope('automations.setEnabled', { id, enabled: true }, 'mut_aut_enable'),
      { writes: true },
    )
    const removed = await expectAppliedOnPath(
      o,
      envelope('automations.remove', { id }, 'mut_aut_remove'),
      { writes: true },
    )
    expect(removed.result).toEqual({ removed: true })
    expect(await o.call.automations.list()).toEqual([])
  })

  it('a replay runs nothing: the service is called once for two submits', async () => {
    const o = await makeOracle()
    const create = vi.spyOn(o.reg.modules.automations, 'create')
    const env = envelope('automations.create', nightly('once-only'), 'mut_aut_replay')
    appliedReply(await submit(o, env))
    expect(appliedReply(await submit(o, env)).replayed).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("the schedule rules' refusal is a rejected reply with the service's words", async () => {
    const o = await makeOracle()
    const reply = await submit(
      o,
      envelope(
        'automations.create',
        {
          name: 'late',
          scheduleKind: 'once',
          runAt: '2000-01-01T00:00:00.000Z',
          agentKind: 'claude-code',
          prompt: 'x',
        },
        'mut_aut_past',
      ),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'invalid', message: 'one-off runAt timestamp must be in the future' },
    })
    expect(await rowsOf(o, 'mut_aut_past')).toEqual([])
  })

  it("a member's write to someone else's automation is refused before the handler", async () => {
    const o = await makeOracle()
    const { id } = appliedReply(
      await submit(o, envelope('automations.create', nightly('admins'), 'mut_aut_admin')),
    ).result as { id: string }
    const user = await member(o)
    const update = vi.spyOn(o.reg.modules.automations, 'update')

    const reply = await submitAs(o, userCommandPrincipal(user, 'member'), 'automations.update', {
      id,
      patch: { name: 'mine now' },
    })
    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(update).not.toHaveBeenCalled()
  })

  it('a member writes their own; once the account is disabled, the replay is refused', async () => {
    const o = await makeOracle()
    const user = await member(o, 'usr_member_disable_6418')
    const principal = userCommandPrincipal(user, 'member')
    const created = appliedReply(
      await submitAs(o, principal, 'automations.create', nightly('members'), 'mut_aut_member'),
    )
    const { id } = created.result as { id: string }
    appliedReply(
      await submitAs(o, principal, 'automations.setEnabled', { id, enabled: true }, 'mut_aut_m_on'),
    )

    await o.store.users.disable(user, new Date().toISOString())
    const replay = await submitAs(
      o,
      principal,
      'automations.setEnabled',
      { id, enabled: true },
      'mut_aut_m_on',
    )
    expect(replay).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
  })

  it('an update of a missing automation is not found, in the words of the service', async () => {
    const o = await makeOracle()
    const reply = await submit(
      o,
      envelope('automations.update', { id: 'aut_missing', patch: { name: 'x' } }, 'mut_aut_none'),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found', message: 'unknown automation: aut_missing' },
    })
  })

  it('operator-only: the relay is refused by the coarse check, before the parse', async () => {
    const o = await makeOracle()
    const admin = userCommandPrincipal(firstAdminMemberId(), 'admin')
    const reply = await submitAs(
      o,
      admin,
      'automations.create',
      { not: 'even valid' },
      'mut_aut_relay',
      'relay',
    )
    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
  })

  it('the four old routes are thin adapters onto the entry point, with the old errors', async () => {
    const o = await makeOracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const created = await o.call.automations.create(nightly('via-route'))
    await o.call.automations.update({ id: created.id, patch: { name: 'via-route 2' } })
    await o.call.automations.setEnabled({ id: created.id, enabled: true })
    await o.call.automations.remove({ id: created.id })
    expect(entry.mock.calls.map(([env, , transport]) => [env.command, transport])).toEqual([
      ['automations.create', 'trpc'],
      ['automations.update', 'trpc'],
      ['automations.setEnabled', 'trpc'],
      ['automations.remove', 'trpc'],
    ])
    await expect(
      o.call.automations.update({ id: 'aut_gone', patch: { name: 'x' } }),
    ).rejects.toThrow('unknown automation: aut_gone')
  })
})

/** A workflow with two steps, as the admin through `sync.submit`. */
async function adminWorkflow(o: Oracle, name: string, scope: 'global' | 'task' = 'task') {
  const reply = appliedReply(
    await submit(
      o,
      envelope(
        'workflows.create',
        {
          name,
          description: '',
          scope,
          ...(scope === 'task' ? { scopeRef: 'issue-6418' } : {}),
          instructions: 'do it',
          steps: [
            { id: 'build', title: 'Build', instructions: 'b', completionGuidance: 'green' },
            { id: 'ship', title: 'Ship', instructions: 's', completionGuidance: 'shipped' },
          ],
        },
        `mut_wf_${name}`,
      ),
    ),
  )
  return reply.result as { workflow: { id: string }; revision: { id: string } }
}

describe('workflows on the entry point', () => {
  it('create applies once with a receipt; the replay runs nothing', async () => {
    const o = await makeOracle()
    const execute = vi.spyOn(o.reg.modules.workflows, 'execute')
    const { result } = await expectAppliedOnPath(
      o,
      envelope(
        'workflows.create',
        { name: 'library', description: '', scope: 'global', instructions: 'x', steps: [] },
        'mut_wf_create',
      ),
      // Workflow tables are not on the change log yet (POD-5802 makes them synced).
      { writes: false },
    )
    expect(result).toMatchObject({ workflow: { name: 'library' } })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('revise and publish apply through the entry point', async () => {
    const o = await makeOracle()
    const { workflow } = await adminWorkflow(o, 'revisable')
    const revised = appliedReply(
      await submit(
        o,
        envelope(
          'workflows.revise',
          { workflowId: workflow.id, instructions: 'better', steps: [] },
          'mut_wf_revise',
        ),
      ),
    ).result as { id: string; version: number }
    expect(revised.version).toBe(2)
    const published = appliedReply(
      await submit(o, envelope('workflows.publish', { revisionId: revised.id }, 'mut_wf_pub')),
    )
    expect(published.result).toMatchObject({ id: revised.id })
  })

  it("a member's revise of the admin's workflow is refused before the handler", async () => {
    const o = await makeOracle()
    const { workflow } = await adminWorkflow(o, 'admins-own')
    const user = await member(o)
    const execute = vi.spyOn(o.reg.modules.workflows, 'execute')

    const reply = await submitAs(o, userCommandPrincipal(user, 'member'), 'workflows.revise', {
      workflowId: workflow.id,
      instructions: 'mine',
      steps: [],
    })
    // One answer for a workflow the caller may not write and one that does not
    // exist (ADR 3 Amendment 1 D20.2), in the words the handler always used.
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found', message: `unknown workflow: ${workflow.id}` },
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('a grant lets a member revise; once it is revoked, the replay is refused', async () => {
    const o = await makeOracle()
    const { workflow } = await adminWorkflow(o, 'shared')
    const user = await member(o, 'usr_grantee_6418')
    await o.store.grants.upsert({
      resourceKind: 'workflow-definition',
      resourceId: workflow.id,
      grantee: user,
      verb: 'write',
      owner: firstAdminMemberId(),
      visibility: 'personal',
      createdAt: new Date().toISOString(),
      actorKind: 'user',
      actorId: firstAdminMemberId(),
    })
    const principal = userCommandPrincipal(user, 'member')
    const input = { workflowId: workflow.id, instructions: 'shared edit', steps: [] }
    appliedReply(await submitAs(o, principal, 'workflows.revise', input, 'mut_wf_granted'))

    await o.store.grants.remove('workflow-definition', workflow.id, user, 'write')
    const replay = await submitAs(o, principal, 'workflows.revise', input, 'mut_wf_granted')
    expect(replay).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found', message: `unknown workflow: ${workflow.id}` },
    })
  })

  it("a handler's own refusal carries its words", async () => {
    const o = await makeOracle()
    const { revision } = await adminWorkflow(o, 'assignable')
    // A shared default needs a published revision: the handler's own rule.
    const reply = await submit(
      o,
      envelope(
        'workflows.assign',
        { targetKind: 'global', targetId: '', revisionId: revision.id },
        'mut_wf_assign_draft',
      ),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: {
        kind: 'invalid',
        message: 'shared workflow defaults require a published revision',
      },
    })
  })

  it('the ten old routes are thin adapters onto the entry point', async () => {
    const o = await makeOracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const created = await o.call.workflows.create({
      name: 'via-route',
      description: '',
      scope: 'global',
      instructions: 'x',
      steps: [],
    })
    expect(created).toMatchObject({ workflow: { name: 'via-route' } })
    await o.call.workflows.publish({ revisionId: created.revision.id })
    expect(entry.mock.calls.map(([env, , transport]) => [env.command, transport])).toEqual([
      ['workflows.create', 'trpc'],
      ['workflows.publish', 'trpc'],
    ])
  })
})

describe("a worker's checkpoint and its coordinator notice", () => {
  /** A live run coordinated by C, its current step assigned to worker W. */
  async function runWithWorker(o: Oracle) {
    const { revision } = await adminWorkflow(o, `run ${Math.random()}`, 'global')
    const coordinator = (
      await o.reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    ).sessionId
    const worker = (
      await o.reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    ).sessionId
    const run = await o.reg.modules.workflows.startRun({
      sessionId: coordinator,
      cwd: '/w',
      revisionId: revision.id,
      onBehalfOf: firstAdminMemberId(),
    })
    await o.store.workflows.assignStep(run.id, 'build', worker)
    const principal = await resolvePrincipalAsync(
      await o.reg.modules.sessions.capabilityForSession(worker),
      { parentSessionOf: async () => undefined, onBehalfOfFor: async () => firstAdminMemberId() },
    )
    const deps = (o.reg.modules.workflows as unknown as { deps: WorkflowServiceDeps }).deps
    const notify = vi.spyOn(deps, 'notifyCoordinator' as never) as unknown as ReturnType<
      typeof vi.fn
    >
    notify.mockResolvedValue(undefined)
    return { run, principal, notify }
  }

  const checkpoint = (runId: string) => ({
    runId,
    stepId: 'build',
    status: 'complete' as const,
    summary: 'built',
  })

  it('a rolled-back checkpoint sends no notice; a committed one sends exactly one', async () => {
    const o = await makeOracle()
    const { run, principal, notify } = await runWithWorker(o)
    const next = vi
      .spyOn(o.reg.modules.workflows, 'nextPacket')
      .mockRejectedValueOnce(new Error('forced failure after the notice was registered'))

    await expect(
      submitAs(o, principal, 'workflows.checkpoint', checkpoint(run.id), 'mut_cp_fail', 'relay'),
    ).rejects.toThrow('forced failure')
    await o.reg.modules.sessions.flushBroadcasts()
    expect(notify).not.toHaveBeenCalled()
    const untouched = await o.store.workflows.getRunSteps(run.id)
    expect(untouched.find((s) => s.stepId === 'build')?.status).not.toBe('complete')

    next.mockRestore()
    const reply = await submitAs(
      o,
      principal,
      'workflows.checkpoint',
      checkpoint(run.id),
      'mut_cp_ok',
      'relay',
    )
    expect(appliedReply(reply).result).toMatchObject({ message: 'Step complete. Next: Ship' })
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    expect(notify.mock.calls[0]?.[0]).toBe(run.coordinatorSessionId)

    // The replay answers the recorded packet and sends nothing more.
    const replay = await submitAs(
      o,
      principal,
      'workflows.checkpoint',
      checkpoint(run.id),
      'mut_cp_ok',
      'relay',
    )
    expect(appliedReply(replay).replayed).toBe(true)
    await o.reg.modules.sessions.flushBroadcasts()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("an older CLI's relay call goes onto the entry point as the relay", async () => {
    const o = await makeOracle()
    const { run, principal, notify } = await runWithWorker(o)
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const write = workflowRelayWrite(o.reg.modules.syncWrite, async () => principal, false)

    const mutationId = asMutationId('mut_cp_relay_old')
    await write('checkpoint', { ...checkpoint(run.id), mutationId })
    expect(
      entry.mock.calls.map(([env, , transport]) => [env.command, env.mutationId, transport]),
    ).toEqual([['workflows.checkpoint', mutationId, 'relay']])
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))

    // Not the coordinator: refused by the handler, in its words, as before.
    await expect(write('skip', { runId: run.id, stepId: 'ship', reason: 'no' })).rejects.toThrow(
      'only the workflow coordinator may perform this transition',
    )
  })
})

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

describe('the agent relay', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function relay(
    o: Oracle,
    sessionId: SessionId,
    requestId: string,
    router: string,
    proc: string,
    input: unknown,
  ): Promise<RelayResult> {
    await o.reg.gateway.routeDaemonFrame(o.store.hostMachineId, {
      type: 'agentRelayRequest',
      requestId,
      sessionId,
      router,
      proc,
      input,
    })
    const answered = (): RelayResult | undefined =>
      o.daemon.find(
        (msg): msg is RelayResult => msg.type === 'agentRelayResult' && msg.requestId === requestId,
      )
    await vi.waitFor(() => expect(answered()).toBeDefined())
    return answered() as RelayResult
  }

  it("an older CLI's workflows.<proc> and a newer CLI's sync.submit both reach the entry point", async () => {
    const o = await makeOracle()
    const { revision } = await adminWorkflow(o, 'relay run', 'global')
    const coordinator = (
      await o.reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    ).sessionId
    const run = await o.reg.modules.workflows.startRun({
      sessionId: coordinator,
      cwd: '/w',
      revisionId: revision.id,
      onBehalfOf: firstAdminMemberId(),
    })
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    const old = await relay(o, coordinator, 'r-old', 'workflows', 'checkpoint', {
      runId: run.id,
      stepId: 'build',
      status: 'complete',
      summary: 'built',
      mutationId: 'mut_relay_old_cp',
    })
    expect(old).toMatchObject({ ok: true, result: { message: 'Step complete. Next: Ship' } })

    const fresh = await relay(o, coordinator, 'r-new', 'sync', 'submit', {
      mutationId: 'mut_relay_new_cp',
      command: 'workflows.checkpoint',
      version: 1,
      input: { runId: run.id, stepId: 'ship', status: 'complete', summary: 'shipped' },
    })
    expect(fresh).toMatchObject({ ok: true, result: { outcome: 'applied', replayed: false } })
    expect(entry.mock.calls.map(([env, , transport]) => [env.command, transport])).toEqual([
      ['workflows.checkpoint', 'relay'],
      ['workflows.checkpoint', 'relay'],
    ])
  })

  it('specs.create on the relay runs on the plain command path, not the sync write entry point', async () => {
    const o = await makeOracle()
    const repo = mkdtempSync(join(tmpdir(), 'podium-spec-relay-'))
    dirs.push(repo)
    await o.store.repos.addRepo(repo, o.store.hostMachineId)
    const agent = (
      await o.reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: repo })
    ).sessionId
    const scopes: (string | undefined)[] = []
    const create = o.reg.modules.specs.create.bind(o.reg.modules.specs)
    vi.spyOn(o.reg.modules.specs, 'create').mockImplementation(async (input) => {
      scopes.push(currentPlainCommand())
      return await create(input)
    })
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    const r = await relay(o, agent, 'r-spec', 'specs', 'create', {
      repoPath: repo,
      title: 'Relay rules',
      parent: 'SP-root',
    })
    expect(r).toMatchObject({ ok: true, result: { title: 'Relay rules' } })
    expect(scopes).toEqual(['specs.create'])
    expect(entry).not.toHaveBeenCalled()

    // Its reads are the service's own, as before.
    const list = await relay(o, agent, 'r-spec-list', 'specs', 'list', { repoPath: repo })
    expect(list.ok).toBe(true)
  })

  it('specs.create on tRPC runs on the plain path too, and sync.submit does not take it', async () => {
    const o = await makeOracle()
    const repo = mkdtempSync(join(tmpdir(), 'podium-spec-trpc-plain-'))
    dirs.push(repo)
    await o.store.repos.addRepo(repo, o.store.hostMachineId)
    const scopes: (string | undefined)[] = []
    const create = o.reg.modules.specs.create.bind(o.reg.modules.specs)
    vi.spyOn(o.reg.modules.specs, 'create').mockImplementation(async (input) => {
      scopes.push(currentPlainCommand())
      return await create(input)
    })

    const created = await o.call.specs.create({ repoPath: repo, title: 'Plain', parent: 'SP-root' })
    expect(created).toMatchObject({ title: 'Plain' })
    expect(scopes).toEqual(['specs.create'])

    const reply = await submit(
      o,
      envelope('specs.create', { repoPath: repo, title: 'x', parent: 'SP-root' }, 'mut_spec'),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'invalid', details: ['command'] },
    })
  })
})
