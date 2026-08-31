import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const census = vi.hoisted(() => ({
  root: '',
  hiddenProject: '',
  forcedProjectSymlink: '',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (path: Parameters<typeof actual.readdir>[0], options: { withFileTypes: true }) => {
      const entries = await actual.readdir(path, options)
      if (String(path) !== census.root) return entries
      return entries
        .filter((entry) => entry.name !== census.hiddenProject)
        .map((entry) =>
          entry.name === census.forcedProjectSymlink
            ? { ...entry, isDirectory: () => true }
            : entry,
        )
    },
  }
})

import { locateGrokChatHistory } from './grok-locate.js'

describe('current Grok authority symlink confinement', () => {
  it('rejects in-root file and project symlinks through public root scanning', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-symlink-'))
    const transcriptRoot = join(home, 'transcripts')
    const realProject = join(transcriptRoot, 'real-project')
    const fileLinkProject = join(transcriptRoot, 'file-link-project')
    const projectLink = join(transcriptRoot, 'project-link')
    const target = join(realProject, 'sess-in-root.jsonl')
    await mkdir(realProject, { recursive: true })
    await mkdir(fileLinkProject, { recursive: true })
    await writeFile(target, '{}\n')
    await symlink(target, join(fileLinkProject, 'sess-in-root.jsonl'))
    await symlink(realProject, projectLink)
    census.root = transcriptRoot
    census.hiddenProject = 'real-project'
    census.forcedProjectSymlink = 'project-link'

    await expect(
      locateGrokChatHistory({
        cwd: '/repo',
        sessionId: 'sess-in-root',
        homeDir: home,
        transcriptRoot,
      }),
    ).resolves.toBeNull()
  })
})
