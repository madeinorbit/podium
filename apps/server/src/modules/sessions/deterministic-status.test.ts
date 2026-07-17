import type { SessionMeta } from '@podium/protocol'
import { afterEach, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'
import type { IssueService } from '../issues/service'
import type { MessageDeliveryService } from '../messages/service'
import { SessionReadToolkit } from './read-toolkit'

const ISSUE = {
  id: 'iss_status',
  seq: 895,
  stage: 'in_progress',
  title: 'Deterministic session status',
  worktreePath: '/wt/status',
  defaultAgent: 'codex',
  defaultModel: 'issue-default-model',
  defaultEffort: 'low',
  panel: { todos: [], artifacts: [], deferred: [] },
}

const registries: SessionRegistry[] = []

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

it('captures spawn values instead of drifting issue defaults in row, meta, and status', async () => {
  // SessionStore boot applies the bundled migration chain to this fresh database.
  const store = new SessionStore(':memory:')
  const registry = new SessionRegistry(store)
  registries.push(registry)
  registry.modules.sessions.attachDaemon('local', () => {})

  const spawned = registry.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: ISSUE.worktreePath,
    issueId: ISSUE.id,
    model: 'spawn-selected-model',
    effort: 'high',
    forceUnknownModel: true,
  })

  expect(spawned).toMatchObject({
    agentId: spawned.sessionId,
    harness: 'codex',
    model: 'spawn-selected-model',
    effort: 'high',
  })

  const row = store.sessions.loadSessions().find((candidate) => candidate.id === spawned.sessionId)
  expect(row).toMatchObject({
    model: 'spawn-selected-model',
    effort: 'high',
    machineId: expect.any(String),
  })
  expect(row?.model).not.toBe(ISSUE.defaultModel)
  expect(row?.effort).not.toBe(ISSUE.defaultEffort)

  const meta = registry.modules.sessions
    .listSessions()
    .find((candidate) => candidate.sessionId === spawned.sessionId)
  expect(meta).toMatchObject({
    model: 'spawn-selected-model',
    effort: 'high',
    machineName: expect.any(String),
  })

  const toolkit = new SessionReadToolkit({
    listSessions: () => [meta as SessionMeta],
    issues: () =>
      ({
        resolveRef: () => ISSUE.id,
        getMeta: () => ISSUE,
        get: () => ISSUE,
        issueForCwd: () => ISSUE.id,
      }) as unknown as IssueService,
    messages: () => ({ deliveredUnacked: () => [] }) as unknown as MessageDeliveryService,
    events: { appendEvent: () => 1 },
    watermarks: {
      getRecapWatermark: () => null,
      setRecapWatermark: () => {},
    },
    repoOp: async () => ({ ok: true, output: '' }),
    readTranscript: async () => ({ items: [], hasMore: false }),
    now: () => '2026-07-17T22:00:00.000Z',
  })
  const status = await toolkit.status(spawned.sessionId, 'operator')
  expect(status).toMatchObject({
    model: 'spawn-selected-model',
    effort: 'high',
    machine: expect.any(String),
    draft: false,
    nativeSubagentCount: 0,
  })
  expect(status.model).not.toBe(ISSUE.defaultModel)
  expect(status.effort).not.toBe(ISSUE.defaultEffort)
})
