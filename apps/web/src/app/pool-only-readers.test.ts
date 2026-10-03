import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { WORKSPACE_READER_FILES, LEGACY_READER_PATTERN, RETIRED_DISPATCH_PATTERN } from '../../harness/pool-only-reader-scope'

it('has zero workspace legacy readers and dispatchers', () => {
  const root = resolve(import.meta.dirname, '../../../..')
  const survivors = WORKSPACE_READER_FILES.flatMap(path => {
    const file = resolve(root, path)
    if (!existsSync(file)) return []
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(LEGACY_READER_PATTERN), ...source.matchAll(RETIRED_DISPATCH_PATTERN)]
      .map(match => ({ path, name: match[0] }))
  })
  expect(survivors).toEqual([])
  for (const path of ['lib/sidebar-data-layer.ts', 'lib/header-data-layer.ts', 'lib/chips-data-layer.ts', 'lib/pane-data-layer.ts', 'features/terminal/session-pane-data-layer.ts', 'features/issues/board-data-layer.ts'])
    expect(existsSync(resolve(root, 'apps/web/src', path)), path).toBe(false)
})
