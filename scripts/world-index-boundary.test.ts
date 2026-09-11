import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { checkWorldIndexBoundary } from './check-boundaries'

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
      return []
    const path = join(root, entry.name)
    return entry.isDirectory() ? files(path) : /\.[cm]?tsx?$/.test(path) ? [path] : []
  })
}

describe('world index import boundary', () => {
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
    expect(checkWorldIndexBoundary(file, source)).toHaveLength(1)
  })
  it('admits the read-only capability and runs over every workspace', () => {
    expect(
      checkWorldIndexBoundary(
        'apps/server/src/gateway/new.ts',
        "import type { WorldIndexReader } from '../modules/world-index'",
      ),
    ).toEqual([])
    const violations = ['apps', 'packages', 'scripts']
      .flatMap(files)
      .flatMap((file) => checkWorldIndexBoundary(file, readFileSync(file, 'utf8')))
    expect(violations).toEqual([])
  })
})

it('every owned fact-table mutation in the repository reaches committed.write', () => {
  const owned = new Set(['machines', 'grants', 'issues', 'users', 'messagesTable', 'messages'])
  const sites: Record<string, number> = {}
  for (const file of ['apps', 'packages', 'scripts'].flatMap(files)) {
    if (
      /\.(test|spec)\./.test(file) ||
      file.includes('/migrations/') ||
      file.includes('/fixtures/')
    )
      continue
    const source = readFileSync(file, 'utf8')
    // Avoid parsing files that cannot contain the builder mutation shape.
    if (!/\.(?:insert|update|delete)\(/.test(source)) continue
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['insert', 'update', 'delete'].includes(node.expression.name.text) &&
        node.expression.expression.getText(ast) === 'this.db' &&
        node.arguments[0] &&
        owned.has(node.arguments[0].getText(ast))
      ) {
        let parent: ts.Node | undefined = node.parent
        while (
          parent &&
          !(
            ts.isCallExpression(parent) && parent.expression.getText(ast) === 'this.committed.write'
          )
        )
          parent = parent.parent
        expect(
          parent,
          `${file}: ${node.getText(ast)} must publish inside its write transaction`,
        ).toBeDefined()
        sites[file] = (sites[file] ?? 0) + 1
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  expect(sites).toEqual({
    'apps/server/src/store/grants.ts': 3,
    'apps/server/src/store/issues.ts': 6,
    'apps/server/src/store/machines.ts': 12,
    'apps/server/src/store/messages.ts': 14,
    'apps/server/src/store/users.ts': 2,
  })
})
