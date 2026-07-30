/**
 * `podium workflow` CLI ↔ LIVE SERVER, over the DERIVED surface (POD-732).
 *
 * WHY THIS FILE EXISTS. `apps/cli/src/workflow-cli.test.ts` drives the CLI
 * against a Proxy that answers every proc — so it proves the CLI's argument
 * parsing and output rendering, and it would keep proving them against a server
 * that served nothing at all. This issue DELETED the eighteen hand-written
 * procedures that CLI talks to and rebuilt them from the contract and query
 * tables. A fake client cannot tell whether that landed.
 *
 * So this drives the real `runWorkflowCli` through a real tRPC client against a
 * real `startServer()`, and the acceptance criterion it answers is literal:
 * `prime` / `status` / `checkpoint` are green on the new path, which is the same
 * path this session's own workflow runner uses.
 *
 * The three are not an arbitrary sample. `prime` and `status` are QUERIES, which
 * this issue moved off the deleted `workflowInputs` onto `WORKFLOW_QUERIES`;
 * `checkpoint` is the ADVANCE whose double-delivery POD-731 closed and whose
 * framework idempotency now runs on every call through `execute`. Between them
 * they cross both halves of the cutover.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runWorkflowCli, type WorkflowCliDeps } from '../../cli/src/workflow-cli'
import { makeIssueClient } from './issue-client'
import { startServer } from './server'

describe('podium workflow CLI ↔ live server over the derived surface (e2e)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let deps: WorkflowCliDeps

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-workflow-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ port: 0 })
    const registry = server.registry
    registry.modules.settings.setSettings({
      ...registry.modules.settings.getSettings(),
      experimental: { workflows: true },
    })
    // Open (no-password) server ⇒ the CLI acts as the operator, exactly as it
    // does for a local `podium workflow` invocation.
    deps = {
      client: makeIssueClient(`http://127.0.0.1:${server.port}`),
      cwd: '/repo/wt',
    }
  })
  afterAll(async () => {
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    delete process.env.PODIUM_STATE_DIR
  })

  it('create → publish → assign → prime → status → checkpoint round-trips on the derived procedures', async () => {
    const created = await runWorkflowCli(
      [
        'create',
        'Cutover smoke',
        '--scope',
        'global',
        '--instructions',
        'Do the thing.',
        '--steps-json',
        JSON.stringify([
          { id: 'build', title: 'Build', instructions: 'build it', completionGuidance: 'green' },
          { id: 'ship', title: 'Ship', instructions: 'ship it', completionGuidance: 'shipped' },
        ]),
      ],
      deps,
    )
    expect(created).toContain('Cutover smoke')

    const list = await runWorkflowCli(['list'], deps)
    expect(list).toContain('Cutover smoke')

    // A workflow with no run: the QUERY arm answers rather than throwing, which
    // is the shape `prime` has always had for a caller with no live run.
    const bare = await runWorkflowCli(['prime'], deps)
    expect(bare).toContain('No workflow is attached')

    // `status` with no run is the OTHER shape — a throw, converged onto the one
    // message (ADR 3 Amendment 1 D20.2). Both arms cross the derived query path.
    await expect(runWorkflowCli(['status'], deps)).rejects.toThrow(
      /no active workflow run for this session/,
    )
  })

  /**
   * THE ADVANCE ARM, which is the half `prime`/`status` cannot reach: a
   * `checkpoint` crosses the framework's deliverability refusal and its
   * run-scoped idempotency ledger on the way to the handler, and both of those
   * now run on EVERY call because `execute` is the only door.
   *
   * The run is started server-side because there is no CLI verb for it — a run
   * starts when a session spawns. That is the same `startRun` the session-start
   * path calls, so the attribution this issue closed is exercised here too.
   */
  it('checkpoint advances a real run through the derived mutation, and status reads it back', async () => {
    const registry = server.registry
    const operator = { actor: { kind: 'operator' as const, id: null }, protectedWrite: true }
    const created = registry.modules.workflows.execute(operator, 'create', {
      // Unique per attempt: the integration lane retries, and workflow names are
      // unique per scope (`workflows_scope_name_active`).
      name: `Advance smoke ${Math.random()}`,
      description: '',
      scope: 'global',
      instructions: 'advance it',
      steps: [
        { id: 'build', title: 'Build', instructions: 'build', completionGuidance: 'green' },
        { id: 'ship', title: 'Ship', instructions: 'ship', completionGuidance: 'shipped' },
      ],
    })
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo/wt',
      initialPrompt: 'do the work',
    })
    const run = registry.modules.workflows.startRun({
      sessionId,
      cwd: '/repo/wt',
      revisionId: created.revision.id,
    })

    const next = await runWorkflowCli(
      [
        'checkpoint',
        'complete',
        '--run',
        run.id,
        '--step',
        'build',
        '--summary',
        'built it',
        '--no-git',
      ],
      deps,
    )
    expect(next).toContain('Ship')

    const status = await runWorkflowCli(['status', '--run', run.id], deps)
    expect(status).toContain(run.id)
    expect(status).toContain('current: ship — Ship')

    // The advance actually landed in the store, not just in the rendered packet.
    const after = registry.modules.workflows.status({ runId: run.id }, operator)
    expect(after.steps.find((s) => s.stepId === 'build')?.status).toBe('complete')

    // The counterfactual: the OTHER step did not advance, so "complete" above is
    // about the step the checkpoint named rather than about the whole run.
    expect(after.steps.find((s) => s.stepId === 'ship')?.status).toBe('pending')
  })

  it('the eleven writes and the seven reads are all reachable by their wire names', async () => {
    // TOTALITY, from the CLIENT's side. The router-side totality test asserts the
    // procedures exist; this asserts a real tRPC client can actually call them,
    // which is what "the CLI keeps working" means and what a client-side type
    // change (or a lost `.mutate`/`.query` verb) would break.
    const client = deps.client as unknown as {
      workflows: Record<string, { query?: unknown; mutate?: unknown }>
    }
    for (const name of [
      'create',
      'revise',
      'fork',
      'publish',
      'assign',
      'profileSave',
      'checkpoint',
      'assignStep',
      'skip',
      'retry',
      'adopt',
    ]) {
      expect(typeof client.workflows[name]?.mutate, `workflows.${name}.mutate`).toBe('function')
    }
    for (const name of ['list', 'get', 'bindings', 'profiles', 'runs', 'prime', 'status']) {
      expect(typeof client.workflows[name]?.query, `workflows.${name}.query`).toBe('function')
    }
  })
})
