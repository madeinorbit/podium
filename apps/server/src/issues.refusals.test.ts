import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asMutationId, firstAdminMemberId } from '@podium/model'
import { InMemoryOutboxStore, type OutboxRecord } from '@podium/sync/outbox'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../../../packages/client-core/src/api'
import { openKernelEngineOutbox } from '../../../packages/client-core/src/engine/kernel-outbox'
import type { StoreNotices } from '../../../packages/client-core/src/engine/types'
import { classifyRefusal } from '../../../packages/client-core/src/outbox'
import type { Replica } from '../../../packages/client-core/src/replica/replica'
import { resolvePrincipal } from './command-principal'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

// Step 0's boundary is the actual fetch adapter and the shipped client's
// classifier/submit adapter. No browser, pool, or second partition policy.
describe('definitive issue refusals (POD-5429)', () => {
  let registry: SessionRegistry

  beforeEach(async () => {
    registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    await registry.sessionStore.repos.addRepo('/repo', registry.sessionStore.hostMachineId)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await registry.dispose()
  })

  const seed = async () => {
    const issue = await registry.issues.create({
      repoPath: '/repo',
      title: 'subject',
      startNow: false,
    })
    if (issue.revision === undefined)
      throw new Error('a seeded issue must carry its server revision')
    return { ...issue, revision: issue.revision }
  }

  const projection = async (id: string) =>
    registry.issues.crud.store.projection(await registry.issues.crud.store.rowOrThrow(id))

  // The public delete/restore wrappers already accept repeated intents as
  // no-ops. Exercise a preparer's actual refusal through the common boundary
  // without changing that successful public contract.
  async function preparationRefusal(
    operation: () => Promise<unknown>,
    id: string,
    message: string,
  ) {
    const error = await operation().then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(Error)
    vi.spyOn(registry.issues.crud, 'update').mockRejectedValueOnce(error)
    await refuse('update', { id, patch: { title: 'refused' } }, message)
  }

  async function request(command: string, input: unknown) {
    const response = await fetchRequestHandler({
      endpoint: '/trpc',
      router: appRouter,
      req: new Request(`http://localhost/trpc/issues.${command}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      createContext: () =>
        ({
          registry,
          repos: {} as never,
          superagent: {} as never,
          capability: OPERATOR,
          principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
        }) as never,
    })
    return { status: response.status, body: await response.json() }
  }

  async function refuse(command: string, input: unknown, message: string) {
    const { status, body } = await request(command, input)
    const refusal = classifyRefusal(body.error)
    console.info(
      'refusal-count',
      JSON.stringify({ command, status, refusal: refusal?.kind ?? 'transient' }),
    )
    expect(status).toBe(409)
    expect(body.error).toMatchObject({ message, data: { code: 'CONFLICT', httpStatus: 409 } })
    expect(refusal).toEqual({ kind: 'conflict' })
  }

  it('refuses an already-deleted issue without writing another revision', async () => {
    const issue = await seed()
    await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
    const before = await registry.issues.crud.store.rowOrThrow(issue.id)
    await preparationRefusal(
      () => registry.issues.prepareSoftDelete(issue.id),
      issue.id,
      `issue ${issue.id} is already deleted`,
    )
    expect(await registry.issues.crud.store.rowOrThrow(issue.id)).toEqual(before)
  })

  it('refuses restoration of an issue that is not deleted', async () => {
    const issue = await seed()
    await preparationRefusal(
      () => registry.issues.prepareRestore(issue.id),
      issue.id,
      `issue ${issue.id} is not deleted`,
    )
    expect(await projection(issue.id)).toEqual(issue)
  })

  it('refuses an update to a soft-deleted issue before any shared or per-user write', async () => {
    const issue = await seed()
    await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
    const before = await registry.issues.crud.store.rowOrThrow(issue.id)
    await refuse(
      'update',
      { id: issue.id, patch: { title: 'must survive locally', pinned: true } },
      `issue ${issue.id} is deleted and cannot be updated`,
    )
    expect(await registry.issues.crud.store.rowOrThrow(issue.id)).toEqual(before)
    expect(registry.issues.crud.store.issueUserState(issue.id)?.pinnedAt ?? null).toBeNull()
  })

  it('refuses entering shipping through an ordinary update', async () => {
    const issue = await seed()
    await refuse(
      'update',
      { id: issue.id, patch: { stage: 'shipping' } },
      'shipping stage is system-owned and cannot be changed by an issue update',
    )
    expect(await projection(issue.id)).toEqual(issue)
  })

  it.each([
    'update',
    'applySuggestion',
    'dismissSuggestion',
    'start',
    'addSession',
    'addShell',
  ] as const)('refuses %s while shipping owns the issue', async (command) => {
    const issue = await seed()
    const row = await registry.issues.crud.store.draftOrThrow(issue.id)
    row.stage = 'shipping'
    row.suggestedStage = 'review'
    row.suggestedReason = 'keep this on refusal'
    await registry.issues.crud.store.persistRow(row)
    const before = await registry.issues.crud.store.rowOrThrow(issue.id)
    const messages = {
      update: 'shipping stage is system-owned and cannot be changed by an issue update',
      applySuggestion: 'shipping stage is system-owned and cannot apply an issue suggestion',
      dismissSuggestion: 'shipping stage is system-owned and cannot dismiss an issue suggestion',
      start: 'shipping stage is system-owned and cannot start issue work',
      addSession: 'shipping stage is system-owned and cannot add a session',
      addShell: 'shipping stage is system-owned and cannot add a session',
    }
    await refuse(
      command,
      command === 'update' ? { id: issue.id, patch: { title: 'refused' } } : { id: issue.id },
      messages[command],
    )
    expect(await registry.issues.crud.store.rowOrThrow(issue.id)).toEqual(before)
  })

  it('types the internal shipping-create guard (the public create schema has no stage)', async () => {
    await expect(
      registry.issues.create({
        repoPath: '/repo',
        title: 'x',
        startNow: false,
        stage: 'shipping',
      } as never),
    ).rejects.toMatchObject({
      name: 'IssueRefusal',
      message: 'shipping stage is system-owned and requires a ship order',
    })
  })

  it('types the internal shipping worktree guard', async () => {
    const issue = await seed()
    const row = await registry.issues.crud.store.draftOrThrow(issue.id)
    row.stage = 'shipping'
    await registry.issues.crud.store.persistRow(row)
    await preparationRefusal(
      () => registry.issues.ensureWorktree(issue.id),
      issue.id,
      'shipping stage is system-owned and cannot create an issue worktree',
    )
  })

  it('preserves public delete and restore no-op results exactly', async () => {
    const issue = await seed()
    const report = await registry.issues.get(issue.id)
    expect(await request('restore', { id: issue.id })).toEqual({
      status: 200,
      body: {
        result: { data: { issue: JSON.parse(JSON.stringify(report)), restoredSessionIds: [] } },
      },
    })
    const first = await request('delete', { id: issue.id })
    expect(first.status).toBe(200)
    expect(await request('delete', { id: issue.id })).toEqual(first)
  })

  it('keeps genuine faults as transient 500s', async () => {
    const issue = await seed()
    vi.spyOn(registry.issues.crud, 'update').mockRejectedValueOnce(
      new Error('database unavailable'),
    )
    const { status, body } = await request('update', { id: issue.id, patch: { title: 'retry' } })
    expect(status).toBe(500)
    expect(body.error.data.code).toBe('INTERNAL_SERVER_ERROR')
    expect(classifyRefusal(body.error)).toBeUndefined()
  })

  it('refuses a client-minted identity collision without overwriting the issue', async () => {
    const issue = await seed()
    await refuse(
      'create',
      { id: issue.id, repoPath: '/repo', title: 'collision', startNow: false },
      `refusing to reuse an existing issue id: ${issue.id}`,
    )
    expect(await projection(issue.id)).toEqual(issue)
  })

  it('refuses tucking unfinished work before touching per-user state', async () => {
    const issue = await seed()
    await refuse('setTucked', { id: issue.id, tucked: true }, `issue ${issue.id} is not finished`)
    expect(await projection(issue.id)).toEqual(issue)
  })

  it('refuses recording a repository root as an issue worktree', async () => {
    const issue = await seed()
    await preparationRefusal(
      () => registry.issues.update(issue.id, { worktreePath: '/repo' }),
      issue.id,
      'refusing worktree path /repo: a repository root cannot be recorded as an issue worktree',
    )
    expect(await projection(issue.id)).toEqual(issue)
  })

  it('refuses a colour on a sub-task', async () => {
    const parent = await seed()
    const child = await registry.issues.create({
      repoPath: '/repo',
      title: 'child',
      startNow: false,
      parentId: parent.id,
    })
    await refuse(
      'update',
      { id: child.id, patch: { color: 'blue' } },
      `colour belongs to top-level tasks: ${child.id} is a sub-task and takes its parent's colour`,
    )
    expect(await projection(child.id)).toEqual(child)
  })

  it('refuses a self-dependency', async () => {
    const issue = await seed()
    await refuse(
      'depAdd',
      { fromId: issue.id, toId: issue.id },
      'an issue cannot depend on itself (self-dep)',
    )
  })

  it('refuses dependency and containment cycles', async () => {
    const a = await seed()
    const b = await seed()
    await registry.issues.addDep(a.id, b.id)
    await refuse(
      'depAdd',
      { fromId: b.id, toId: a.id },
      `dependency ${b.id} -> ${a.id} would create a dependency cycle: ${b.id} -> ${a.id} -> ${b.id}`,
    )
    await registry.issues.reparent(b.id, a.id)
    await refuse(
      'reparent',
      { id: a.id, parentId: b.id },
      `reparent ${a.id} -> ${b.id} would create a containment cycle: ${a.id} -> ${b.id} -> ${a.id}`,
    )
  })

  it('refuses a missing panel item and incomplete artifact operations', async () => {
    const issue = await seed()
    await refuse(
      'panelApply',
      { id: issue.id, op: 'todo-done', index: 1 },
      'no item 1 (list has 0)',
    )
    await refuse('panelApply', { id: issue.id, op: 'artifact-add' }, 'artifact-add requires a path')
    await refuse(
      'panelApply',
      { id: issue.id, op: 'artifact-remove' },
      'artifact-remove requires an index',
    )
  })

  it('refuses shipping rehome before reading the destination or mutating ownership', async () => {
    const issue = await seed()
    const row = await registry.issues.crud.store.draftOrThrow(issue.id)
    row.stage = 'shipping'
    await registry.issues.crud.store.persistRow(row)
    await preparationRefusal(
      () =>
        registry.issues.rehome(issue.id, {
          repoPath: '/other',
          machineId: registry.sessionStore.hostMachineId,
          worktreePath: '/other/wt',
        }),
      issue.id,
      'shipping stage is system-owned and cannot rehome issue work',
    )
  })

  async function engine(input: object, expectedRevision?: number) {
    const inputs: unknown[] = []
    const api = {
      issues: {
        update: {
          mutate: async (wire: unknown) => {
            inputs.push(wire)
            const { body } = await request('update', wire)
            if (body.error)
              throw Object.assign(new Error(body.error.message), { data: body.error.data })
            return body.result.data
          },
        },
      },
    } as unknown as PodiumClientApi
    const user = firstAdminMemberId()
    const store = new InMemoryOutboxStore([
      {
        mutationId: asMutationId('refusal-proof'),
        command: { name: 'issues.update', version: 1, delivery: 'offline-eligible' },
        input,
        partitionKey: 'issue:subject',
        attribution: { actor: { kind: 'user', id: user }, onBehalfOf: user },
        state: 'queued',
        queuedAt: 1_000,
        attempts: 0,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      } satisfies OutboxRecord,
    ])
    let now = 5_000
    const create = await openKernelEngineOutbox({
      store,
      principal: user,
      api,
      now: () => now,
      onDegraded: (detail) => {
        throw detail
      },
    })
    const outbox = create({
      api,
      replica: {} as Replica,
      notices: { error: () => {}, info: () => {} } as unknown as StoreNotices,
      isOnline: () => true,
    })
    return {
      outbox,
      inputs,
      store,
      advance: () => {
        now += 60_001
      },
    }
  }

  it('a typed refusal settles after one POST; the legacy bare-error arm retries', async () => {
    const issue = await seed()
    const original = registry.issues.crud.update.bind(registry.issues.crud)
    for (const bareError of [true, false]) {
      if (bareError)
        vi.spyOn(registry.issues.crud, 'update').mockRejectedValue(
          new Error('shipping stage is system-owned'),
        )
      else vi.spyOn(registry.issues.crud, 'update').mockImplementation(original)
      const { outbox, inputs, store, advance } = await engine({
        id: issue.id,
        patch: { stage: 'shipping' },
      })
      try {
        await outbox.drain()
        advance()
        await outbox.drain()
        const records = await store.read()
        console.info(
          'retry-count',
          JSON.stringify({
            bareError,
            posts: inputs.length,
            pending: outbox.pending().length,
            state: records[0]?.state ?? 'retired',
          }),
        )
        expect(inputs).toHaveLength(bareError ? 2 : 1)
        expect(outbox.pending()).toHaveLength(bareError ? 1 : 0)
      } finally {
        outbox.dispose()
      }
    }
  })

  it('forwards an opt-in envelope revision and refuses its stale write', async () => {
    const issue = await seed()
    const base = issue.revision
    await registry.issues.update(issue.id, { title: 'accepted first' })
    // A recovery token lives on the envelope, independently of the command
    // input. Its current value must take precedence over a stale input copy.
    const { outbox, inputs } = await engine(
      { id: issue.id, patch: { title: 'stale recovery' } },
      base,
    )
    try {
      await outbox.drain()
      console.info(
        'revision-count',
        JSON.stringify({
          expectedRevision: base,
          wire: inputs[0],
          parked: outbox.deadLetters().length,
        }),
      )
      expect(inputs).toEqual([
        {
          id: issue.id,
          patch: { title: 'stale recovery' },
          mutationId: 'refusal-proof',
          expectedRevision: base,
        },
      ])
      expect(outbox.deadLetters()).toHaveLength(1)
      expect((await registry.issues.get(issue.id))?.title).toBe('accepted first')
    } finally {
      outbox.dispose()
    }
  })

  it('the envelope revision overrides an older input copy on recovery', async () => {
    const issue = await seed()
    await registry.issues.update(issue.id, { title: 'accepted first' })
    const current = await projection(issue.id)
    const { outbox, inputs } = await engine(
      { id: issue.id, patch: { title: 'recovered' }, expectedRevision: issue.revision },
      current.revision,
    )
    try {
      await outbox.drain()
      expect(inputs).toEqual([
        {
          id: issue.id,
          patch: { title: 'recovered' },
          mutationId: 'refusal-proof',
          expectedRevision: current.revision,
        },
      ])
      expect(outbox.deadLetters()).toEqual([])
      expect((await projection(issue.id)).title).toBe('recovered')
    } finally {
      outbox.dispose()
    }
  })

  it('keeps ordinary absolute intents token-free and preserves their exact accepted result', async () => {
    const issue = await seed()
    const { outbox, inputs } = await engine({ id: issue.id, patch: { title: 'latest intent' } })
    try {
      await outbox.drain()
      expect(inputs).toEqual([
        { id: issue.id, patch: { title: 'latest intent' }, mutationId: 'refusal-proof' },
      ])
      const accepted = await projection(issue.id)
      expect(accepted).toEqual({
        ...issue,
        title: 'latest intent',
        revision: issue.revision + 1,
        updatedAt: expect.any(String),
      })
      expect(outbox.pending()).toEqual([])
    } finally {
      outbox.dispose()
    }
  })

  it('bounds refusal row reads and projection derivations at 1x and 4x', async () => {
    const counts = []
    const issue = await seed()
    for (const size of [16, 64]) {
      while (registry.issues.crud.store.rows.size < size) await seed()
      const rows = registry.issues.crud.store.rows
      const read = vi.spyOn(rows, 'get')
      const derive = vi.spyOn(registry.issues.reports, 'get')
      const values = rows.values.bind(rows)
      let enumerated = 0
      const scan = vi.spyOn(rows, 'values').mockImplementation(function* () {
        for (const row of values()) {
          enumerated += 1
          yield row
        }
        return undefined
      })
      const { status } = await request('update', { id: issue.id, patch: { stage: 'shipping' } })
      counts.push({
        size,
        status,
        rowReads: read.mock.calls.length + enumerated,
        derivations: derive.mock.calls.length,
      })
      read.mockRestore()
      derive.mockRestore()
      scan.mockRestore()
    }
    console.info('work-count', JSON.stringify(counts))
    expect(counts.map((count) => count.status)).toEqual([409, 409])
    const [one, four] = counts
    if (!one || !four) throw new Error('the work probe must record both corpus scales')
    expect(one.rowReads).toBeGreaterThan(0)
    expect(four.rowReads / one.rowReads).toBeLessThanOrEqual(1)
    expect(counts.map((count) => count.derivations)).toEqual([0, 0])
  })
})

// Every remaining bare Error is an explicitly reviewed fault, not a user/state
// precondition. This catches a planted bare Error anywhere in the audited issue
// command/service layer, even when a dynamic scenario does not reach it.
it('the issue refusal audit admits only declared genuine bare-error sites', () => {
  const base = join(import.meta.dirname, 'modules/issues')
  const files = [
    'registry.ts',
    'authority-arbitration.ts',
    'conflict.ts',
    ...readdirSync(join(base, 'service'))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => `service/${name}`),
  ]
  const faults: Record<string, string[]> = {
    'service/core.ts': ['persist(', 'IssueStore read before init()'],
    'service/crud.ts': [
      'illegal shipping issue-stage transition',
      'shipping batch requires an affected issue',
      'shipping batch contains a duplicate issue',
      'terminal evidence needs the permanent artifact store.',
      'permanent issue artifact storage is unavailable',
      'prepareSoftDelete(',
      'prepareRestore(',
    ],
    'service/attention.ts': ['attachSession unavailable:'],
    'service/workflow.ts': ['ensured.output', 'worktree add failed:'],
    'registry.ts': ['mail sending is not wired on this server'],
    'authority-arbitration.ts': ['nested issue arbitration scopes are not supported'],
    'conflict.ts': [
      'issues exp-rev arbitration rejected with unexpected reason',
      'issues exp-rev arbitration rejected an omitted revision',
    ],
  }
  let remaining = 0
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(base, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const visit = (node: ts.Node) => {
      if (
        ts.isThrowStatement(node) &&
        node.expression &&
        ts.isNewExpression(node.expression) &&
        node.expression.expression.getText(source) === 'Error'
      ) {
        remaining += 1
        const message = node.expression.arguments?.[0]?.getText(source).replace(/^['"`]/, '') ?? ''
        expect(
          faults[file]?.some((prefix) => message.startsWith(prefix)),
          `${file}: undeclared bare Error: ${message}`,
        ).toBe(true)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  console.info('audit-count', JSON.stringify({ remainingFaults: remaining }))
})
