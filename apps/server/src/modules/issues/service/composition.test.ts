import { readFileSync } from 'node:fs'
import { asSessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../../../store'
import { type IssueDeps, IssueService } from '.'
import { DEFAULT_ISSUE_REPORT_VISIBILITY } from './reads'
import { issueTestPlumbing } from './test-plumbing'

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

describe('issue tracker capability composition', () => {
  it('exposes all capability interfaces over the same live store', () => {
    const deps: IssueDeps = {
      store: new SessionStore(':memory:'),
      listSessions: () => [],
      getSettings: () =>
        normalizeSettings({
          gitWorkflow: {
            defaultParentBranch: '',
            mergeStyle: 'ff-only',
            autoRebaseBeforeMerge: true,
          },
          sessionDefaults: { agent: 'claude-code' },
        }),
      spawnSession: () => ({ sessionId: asSessionId('composition-test') }),
      repoOp: async () => ({ ok: true, output: '' }),
      ...issueTestPlumbing(),
    }
    const tracker = new IssueService(deps)
    expect(tracker.crud).toBe(tracker.hierarchy)
    expect(tracker.hierarchy).toBe(tracker.commentsMail)
    expect(tracker.commentsMail).toBe(tracker.attention)
    expect(tracker.attention).toBe(tracker.gitWorkflow)
    expect(tracker.gitWorkflow).toBe(tracker.reports)

    expect(tracker.reports.list()).toEqual([])
    const created = tracker.crud.create({ repoPath: '/repo', title: 'one store', startNow: false })
    expect(tracker.reports.get(created.id)?.title).toBe('one store')
    deps.store.close()
  })

  it('has zero IssueService class-inheritance layers and constructs one store', () => {
    const files = [
      'core.ts',
      'reads.ts',
      'crud.ts',
      'hierarchy.ts',
      'mail.ts',
      'attention.ts',
      'workflow.ts',
      'index.ts',
    ]
    const service = files.map((file) => source(file)).join('\n')
    expect(service).not.toMatch(/class\s+\w+\s+extends\s+Issue/)
    expect(service.match(/new IssueStore\(/g)).toHaveLength(1)
  })

  it('binds command handlers to capabilities, never the compatibility service', () => {
    const registry = source('../registry.ts')
    expect(registry).not.toContain('ctx.issues')
    expect(registry).not.toMatch(/import type \{[^}]*IssueService[^}]*\} from ['"]\.\/service['"]/s)
    for (const capability of [
      'ctx.crud',
      'ctx.hierarchy',
      'ctx.commentsMail',
      'ctx.attention',
      'ctx.gitWorkflow',
      'ctx.reports',
    ]) {
      expect(registry).toContain(capability)
    }
  })

  it('defaults every unresolved report leak policy closed', () => {
    expect(DEFAULT_ISSUE_REPORT_VISIBILITY).toEqual({
      crossBoundaryEdges: 'hide',
      counts: 'visible-only',
      tree: 'visible-only',
      graph: 'visible-only',
      doctor: 'visible-only',
      refAllocation: 'opaque',
    })
  })
})
