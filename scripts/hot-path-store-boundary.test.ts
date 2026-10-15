import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkHotPathStoreBoundary } from './check-boundaries'

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
      return []
    const path = join(root, entry.name)
    return entry.isDirectory() ? files(path) : /\.[cm]?tsx?$/.test(path) ? [path] : []
  })
}

describe('hot-path store import boundary', () => {
  it.each([
    ['apps/server/src/gateway/new-path.ts', "import type { SessionStore } from '../store'"],
    [
      'apps/server/src/modules/sessions/daemon-lifecycle.ts',
      "import { x } from '../../store/users'",
    ],
    [
      'apps/server/src/modules/messages/scheduler.ts',
      "export { x } from '@podium/server/store/messages'",
    ],
    ['apps/server/src/feed-visibility.ts', "const x = import('./store/grants')"],
  ])('refuses store dependencies from %s', (file, source) => {
    expect(checkHotPathStoreBoundary(file, source)).toHaveLength(1)
  })
  it('admits a named port and runs over every workspace', () => {
    expect(
      checkHotPathStoreBoundary(
        'apps/server/src/gateway/new.ts',
        "import type { FeedVisibilityStore } from '../hot-path-ports'",
      ),
    ).toEqual([])
    const violations = ['apps', 'packages', 'scripts']
      .flatMap(files)
      .flatMap((file) => checkHotPathStoreBoundary(file, readFileSync(file, 'utf8')))
    expect(violations).toEqual([])
  })
})
