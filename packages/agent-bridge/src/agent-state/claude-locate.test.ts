import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectSlug, locateClaudeSessionFile } from './claude-locate.js'

// The wrong-bucket bug (docs/spec/conversation-registry.md §1.1): Claude buckets
// transcripts by the cwd the conversation was CREATED under, while session.cwd is
// mutable — the locator must find the file regardless of the current cwd.
describe('locateClaudeSessionFile', () => {
  async function seedHome(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'podium-locate-'))
  }
  async function seedTranscript(home: string, cwd: string, id: string): Promise<string> {
    const dir = join(home, '.claude', 'projects', claudeProjectSlug(cwd))
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${id}.jsonl`)
    await writeFile(path, '{"type":"user"}\n')
    return path
  }

  it('resolves the exact current-cwd bucket when the file is there', async () => {
    const home = await seedHome()
    const path = await seedTranscript(home, '/repo/main', 'sess-1')
    expect(
      await locateClaudeSessionFile({ cwd: '/repo/main', resumeValue: 'sess-1', homeDir: home }),
    ).toBe(path)
  })

  it('sweeps other buckets when the session moved worktrees (the reported bug)', async () => {
    const home = await seedHome()
    // Created under the ORIGINAL worktree; Podium later restamped cwd to the new one.
    const path = await seedTranscript(home, '/repo/.claude/worktrees/old-spot', 'sess-2')
    expect(
      await locateClaudeSessionFile({
        cwd: '/repo/.claude/worktrees/new-spot',
        resumeValue: 'sess-2',
        homeDir: home,
      }),
    ).toBe(path)
  })

  it('finds the file even when the original worktree dir no longer exists', async () => {
    // The bucket outlives the worktree — only the DERIVATION from cwd breaks. The
    // sweep never consults the cwd at all, so a deleted origin dir is a non-event.
    const home = await seedHome()
    const path = await seedTranscript(home, '/gone/worktree', 'sess-3')
    expect(
      await locateClaudeSessionFile({ cwd: '/somewhere/else', resumeValue: 'sess-3', homeDir: home }),
    ).toBe(path)
  })

  it('prefers the newest file when the same id exists in two buckets', async () => {
    const home = await seedHome()
    const older = await seedTranscript(home, '/a', 'sess-4')
    const newer = await seedTranscript(home, '/b', 'sess-4')
    const past = new Date(Date.now() - 60_000)
    await utimes(older, past, past)
    expect(
      await locateClaudeSessionFile({ cwd: '/c', resumeValue: 'sess-4', homeDir: home }),
    ).toBe(newer)
  })

  it('returns null when the session exists nowhere (and when projects/ is absent)', async () => {
    const home = await seedHome()
    expect(
      await locateClaudeSessionFile({ cwd: '/x', resumeValue: 'missing', homeDir: home }),
    ).toBeNull()
    await seedTranscript(home, '/x', 'other')
    expect(
      await locateClaudeSessionFile({ cwd: '/x', resumeValue: 'missing', homeDir: home }),
    ).toBeNull()
  })
})
