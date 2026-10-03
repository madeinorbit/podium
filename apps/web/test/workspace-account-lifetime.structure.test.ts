// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isPropertyAccessExpression,
  isStringLiteral,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
} from 'typescript'
import { describe, expect, it } from 'vitest'

const app = resolve(import.meta.dirname, '../src/app')
const parse = (file: string) => createSourceFile(file,
  readFileSync(resolve(app, file), 'utf8'), ScriptTarget.Latest, true, ScriptKind.TSX)
const walk = (node: Node, visit: (node: Node) => void): void => {
  visit(node)
  forEachChild(node, child => walk(child, visit))
}

describe('Workspace account closure lifetime', () => {
  it('keeps mount-stable drag callbacks in a module with only React runtime inputs', () => {
    const file = parse('workspace-tab-drag-intent.ts')
    const imports: string[] = [], dynamicImports: string[] = []
    walk(file, node => {
      if (isImportDeclaration(node) && !node.importClause?.isTypeOnly && isStringLiteral(node.moduleSpecifier))
        imports.push(node.moduleSpecifier.text)
      if (isCallExpression(node) && (node.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(node.expression) && node.expression.text === 'require')))
        dynamicImports.push(node.getText(file))
    })
    expect(imports).toEqual(['react'])
    expect(dynamicImports).toEqual([])
    const hook = file.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'useWorkspaceTabDragIntent')
    expect(hook && isFunctionDeclaration(hook) && hook.parameters.map(parameter => parameter.type?.getText(file)))
      .toEqual(['LoadWorkspaceTabDrag'])
  })

  it('does not cache a callback in the account-bearing Workspace render scope', () => {
    const file = parse('Workspace.tsx')
    const workspace = file.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'Workspace')
    expect(workspace).toBeDefined()
    const cacheHooks = new Set(['useCallback', 'useMemo'])
    for (const statement of file.statements) {
      if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'react') continue
      const bindings = statement.importClause?.namedBindings
      if (bindings && isNamedImports(bindings)) for (const binding of bindings.elements)
        if (cacheHooks.has((binding.propertyName ?? binding.name).text)) cacheHooks.add(binding.name.text)
    }
    const cached: string[] = []
    walk(workspace!, node => {
      if (!isCallExpression(node)) return
      const name = isIdentifier(node.expression) ? node.expression.text
        : isPropertyAccessExpression(node.expression) ? node.expression.name.text : null
      if (name && cacheHooks.has(name)) cached.push(node.getText(file))
    })
    expect(cached).toEqual([])
  })
})
