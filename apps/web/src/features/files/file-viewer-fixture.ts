/** Synthetic services on the fixture's existing runtime; no server or second owner. */
import { HTML_MODE_MAP_KEY, JSON_MODE_MAP_KEY, MD_MODE_MAP_KEY } from '@podium/client-core/ui-state'
import { type FileScope, tabIdFor } from '@podium/client-core/values'
import { asMachineId } from '@podium/model/browser'
import { createHeaderFixture } from '../../../test/header-fixture'
import type { FileViewerPreference } from './file-viewer-check'

export const VIEWER_SCOPE: FileScope = {
  kind: 'worktree',
  root: '/synthetic/project',
  machineId: asMachineId('host-one'),
}
export const VIEWER_FILES = [
  { path: '/synthetic/project/index.html', mapKey: HTML_MODE_MAP_KEY },
  { path: '/synthetic/project/data.json', mapKey: JSON_MODE_MAP_KEY },
  { path: '/synthetic/project/notes.md', mapKey: MD_MODE_MAP_KEY },
] as const
export const VIEWER_TABS: readonly FileViewerPreference[] = VIEWER_FILES.map(
  ({ path, mapKey }) => ({ mapKey, tabId: tabIdFor(VIEWER_SCOPE, path) }),
)
export const VIEWER_DIFF = '@@ -1 +1 @@\n-old contents\n+new contents\n'

export function createFileViewerFixture(count = 12, sessionCount = count) {
  const fixture = createHeaderFixture(count, sessionCount)
  const calls = {
    read: [] as Record<string, unknown>[],
    write: [] as Record<string, unknown>[],
    list: [] as Record<string, unknown>[],
    git: [] as Record<string, unknown>[],
  }
  const read = async (args: Record<string, unknown>) => {
    calls.read.push(args)
    const path = String(args.path)
    return {
      ok: true,
      path,
      baseHash: 'original',
      content: path.endsWith('.html')
        ? '<h1>File preview</h1>'
        : path.endsWith('.json')
          ? '{"ready":true}'
          : path.endsWith('.csv')
            ? 'name,value\nready,true\n'
            : '# File preview\n\nSaved through the existing owner.\n',
    }
  }
  Object.assign(fixture.api, {
    files: {
      read: { query: read },
      write: {
        mutate: async (args: Record<string, unknown>) => {
          calls.write.push(args)
          return { ok: true, baseHash: 'saved' }
        },
      },
      list: {
        query: async (args: Record<string, unknown>) => {
          calls.list.push(args)
          return { ok: true, path: args.path, entries: [{ name: 'notes.md', isDir: false }] }
        },
      },
      search: { query: async () => ({ paths: ['notes.md'] }) },
    },
    git: {
      status: {
        query: async (args: Record<string, unknown>) => {
          calls.git.push(args)
          return { ok: true, output: '## main\n M changed.ts\n?? untracked.txt\n' }
        },
      },
      log: {
        query: async (args: Record<string, unknown>) => {
          calls.git.push(args)
          return {
            ok: true,
            output: 'abc1234\tabc1234ffff\t2026-10-01T09:00:00Z\tSynthetic\tSaved change\n',
          }
        },
      },
      commitFiles: {
        query: async (args: Record<string, unknown>) => {
          calls.git.push(args)
          return { ok: true, output: 'M\tchanged.ts\n' }
        },
      },
      diffFile: {
        query: async (args: Record<string, unknown>) => {
          calls.git.push(args)
          return { ok: true, output: VIEWER_DIFF }
        },
      },
      commitDiffFile: {
        query: async (args: Record<string, unknown>) => {
          calls.git.push(args)
          return { ok: true, output: VIEWER_DIFF }
        },
      },
    },
  })
  return { ...fixture, calls }
}
