import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationSummaryWire, TranscriptItem } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LlmClient } from '../../llm'
import { specBranchDiff } from '../../pspec-git'
import { SpecImportService } from './import-service'

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

async function settle(svc: SpecImportService, repoPath: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = svc.status({ repoPath })
    if (s.phase === 'done' || s.phase === 'error') return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('import did not settle')
}

describe('SpecImportService', () => {
  let repo: string
  let stateDir: string

  const conv = (id: string, sizeBytes: number): ConversationSummaryWire =>
    ({
      id,
      agentKind: 'claude-code',
      providerId: 'p1',
      projectPath: repo,
      podiumId: `pod-${id}`,
      sizeBytes,
      updatedAt: '2026-07-01T00:00:00Z',
      resume: { kind: 'native', value: id },
    }) as unknown as ConversationSummaryWire

  const items: TranscriptItem[] = [
    { id: '1', role: 'assistant', text: 'CSV or JSON exports?' },
    { id: '2', role: 'user', text: 'CSV with headers, always.' },
  ]

  const fakeLlm: LlmClient = {
    label: 'fake',
    complete: vi.fn(async (messages) => {
      const sys = messages[0]?.content ?? ''
      if (!sys.includes('maintain a living product spec')) {
        return {
          text: JSON.stringify([
            {
              featureArea: 'Exports',
              kind: 'decision',
              statement: 'Exports are CSV with headers.',
              quote: 'CSV with headers, always.',
              conversationId: 'pod-c1',
              date: '2026-07-01',
            },
          ]),
          toolCalls: [],
        }
      }
      return {
        text: JSON.stringify({
          ops: [
            {
              op: 'create',
              ref: 'n1',
              parent: 'SP-root',
              title: 'Exports',
              bodyHtml: '<p><strong>Decisions</strong></p><ul><li>CSV with headers (session pod-c1, 2026-07-01)</li></ul>',
            },
          ],
        }),
        toolCalls: [],
      }
    }),
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'spec-import-repo-'))
    stateDir = mkdtempSync(join(tmpdir(), 'spec-import-state-'))
    sh(repo, 'init', '-q', '-b', 'main')
    sh(repo, 'config', 'user.email', 't@example.com')
    sh(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'README.md'), 'hi')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-qm', 'init')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('imports decisions onto a spec-import branch and is incremental on rerun (llm mode)', async () => {
    const readItems = vi.fn(async () => items)
    const svc = new SpecImportService({
      repoRoots: () => [repo],
      conversationsFor: () => [conv('c1', 100)],
      readItems,
      llm: () => fakeLlm,
      stateDir: () => stateDir,
    })
    svc.start({ repoPath: repo, mode: 'llm' })
    await settle(svc, repo)
    const status = svc.status({ repoPath: repo })
    expect(status.phase).toBe('done')
    expect(status.branch).toMatch(/^spec-import\//)
    expect(status.applied).toBe(1)

    // The branch carries the new component; main's working tree is untouched.
    const diff = await specBranchDiff(repo, status.branch!)
    expect(diff.changes.some((c) => c.title === 'Exports' && c.changeKind === 'added')).toBe(true)
    expect(sh(repo, 'status', '--porcelain').trim()).toBe('')

    // Rerun with the same conversation: nothing new to process.
    svc.start({ repoPath: repo, mode: 'llm' })
    await settle(svc, repo)
    expect(svc.status({ repoPath: repo }).message).toContain('no new sessions')
    expect(readItems).toHaveBeenCalledTimes(1)
  })

  it('picks a fresh branch name when one exists for the day', async () => {
    const svc = new SpecImportService({
      repoRoots: () => [repo],
      conversationsFor: () => [conv('c2', 100)],
      readItems: async () => items,
      llm: () => fakeLlm,
      stateDir: () => stateDir,
    })
    svc.start({ repoPath: repo, mode: 'llm' })
    await settle(svc, repo)
    const status = svc.status({ repoPath: repo })
    expect(status.phase).toBe('done')
    expect(status.branch).toMatch(/^spec-import\/.*-2$/)
  })

  it('agent mode: prepares artifacts, runs the agent in an isolated worktree, keeps its commits', async () => {
    const agent = vi.fn(async (input: { cwd: string; prompt: string }) => {
      // The playbook must carry the task structure + prepared artifact paths.
      expect(input.prompt).toContain('SPEC IMPORT')
      expect(input.prompt).toContain('facts.json')
      expect(input.prompt).toContain('VERIFY')
      expect(input.prompt).toContain('subagent')
      // Simulate the agent writing a spec component and committing in its worktree.
      writeFileSync(
        join(input.cwd, 'pspec-agent-note.txt'),
        'agent was here',
      )
      sh(input.cwd, 'add', '.')
      sh(input.cwd, 'commit', '-qm', 'spec: import from session history [podium spec import]')
      return { ok: true, output: 'imported 1 fact' }
    })
    const svc = new SpecImportService({
      repoRoots: () => [repo],
      conversationsFor: () => [conv('c3', 100)],
      readItems: async () => items,
      llm: () => fakeLlm,
      agent,
      stateDir: () => stateDir,
    })
    svc.start({ repoPath: repo }) // agent is the default mode when wired
    await settle(svc, repo)
    const status = svc.status({ repoPath: repo })
    expect(status.phase).toBe('done')
    expect(agent).toHaveBeenCalledTimes(1)
    // Branch keeps the agent's commit; the worktree sandbox is gone.
    expect(sh(repo, 'log', '--oneline', `main..${status.branch!}`)).toContain('spec: import')
    // Facts + digests were persisted for the agent to read; the worktree sandbox is gone.
    const repoDir = readdirSync(stateDir).find((d) => d.includes('spec-import-repo'))
    expect(repoDir).toBeDefined()
    expect(existsSync(join(stateDir, repoDir!, 'worktree'))).toBe(false)
    expect(readdirSync(join(stateDir, repoDir!))).toEqual(
      expect.arrayContaining(['facts.json', 'digests', 'state.json']),
    )
  })

  it('prepare mode stops after artifacts, touching no branches', async () => {
    const svc = new SpecImportService({
      repoRoots: () => [repo],
      conversationsFor: () => [conv('c4', 100)],
      readItems: async () => items,
      llm: () => fakeLlm,
      stateDir: () => stateDir,
    })
    const before = sh(repo, 'branch', '--list').trim()
    svc.start({ repoPath: repo, mode: 'prepare' })
    await settle(svc, repo)
    const status = svc.status({ repoPath: repo })
    expect(status.phase).toBe('done')
    expect(status.message).toContain('prepared')
    expect(sh(repo, 'branch', '--list').trim()).toBe(before)
  })

  it('rejects unknown repo roots', () => {
    const svc = new SpecImportService({
      repoRoots: () => [],
      conversationsFor: () => [],
      readItems: async () => null,
      llm: () => fakeLlm,
      stateDir: () => stateDir,
    })
    expect(() => svc.start({ repoPath: repo })).toThrow(/known repository/)
  })
})
