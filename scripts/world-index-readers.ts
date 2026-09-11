/** Repository-symbol census, not a hot-path/file boundary. Method references count
 * even when extracted, bound, destructured, or passed through a Pick port. */
import ts from 'typescript'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

export const factMethods = {
  grants: ['listForResource', 'listForResources', 'loadWorldGrants'],
  messages: ['countPending', 'countPendingForSession', 'countQueued', 'loadWorldPending'],
  issues: ['getIssue', 'getIssues', 'listIssueRows', 'listIssueCwdRows', 'loadWorldIssuePaths'],
  users: ['get', 'read', 'roleOf', 'list', 'loadWorldUsers'],
  machines: ['getMachine', 'listMachines'],
} as const

export function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) return []
    const path = join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?tsx?$/.test(path) ? [path] : []
  })
}
export const productionSource = (file: string) =>
  !/\.(test|spec)\./.test(file) && !file.includes('/migrations/') && !file.includes('/fixtures/')

export function readerCensus(program: ts.Program): Record<string, number> {
  const checker = program.getTypeChecker()
  const sites: Record<string, number> = {}
  const methods = new Set<string>(Object.values(factMethods).flat())
  function factOf(symbol: ts.Symbol | undefined): string | undefined {
    for (const declaration of symbol?.declarations ?? []) {
      if (!ts.isMethodDeclaration(declaration)) continue
      const path = declaration.getSourceFile().fileName.replaceAll('\\', '/')
      for (const [fact, names] of Object.entries(factMethods)) {
        if (path.endsWith(`/store/${fact}.ts`) && (names as readonly string[]).includes(declaration.name.getText()))
          return `${fact}.${declaration.name.getText()}`
      }
    }
    return undefined
  }
  for (const ast of program.getSourceFiles()) {
    const file = relative(process.cwd(), ast.fileName).replaceAll('\\', '/')
    if (!/^(apps|packages|scripts)\//.test(file) || !productionSource(file) || file.includes('/node_modules/')) continue
    function record(node: ts.Node, fact: string) {
      let parent = node.parent
      let owner = '<module>'
      while (parent) {
        if ((ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name) {
          owner = parent.name.getText(ast)
          break
        }
        parent = parent.parent
      }
      const key = `${file} :: ${owner} :: ${fact}`
      sites[key] = (sites[key] ?? 0) + 1
    }
    function visit(node: ts.Node) {
      let symbol: ts.Symbol | undefined
      if (ts.isPropertyAccessExpression(node) && methods.has(node.name.text)) symbol = checker.getSymbolAtLocation(node.name)
      if (ts.isElementAccessExpression(node)) {
        const type = checker.getTypeAtLocation(node.expression)
        const arg = node.argumentExpression
        if (ts.isStringLiteralLike(arg)) symbol = type.getProperty(arg.text)
        else {
          // Computed repository access cannot silently evade the inventory.
          for (const property of type.getProperties()) {
            const fact = factOf(property)
            if (fact) record(node, `${fact} [dynamic access]`)
          }
        }
      }
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        symbol = checker.getTypeAtLocation(node.parent).getProperty((node.propertyName ?? node.name).getText(ast))
      }
      const fact = factOf(symbol)
      if (fact) record(node, fact)
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return Object.fromEntries(Object.entries(sites).sort(([a], [b]) => a.localeCompare(b)))
}

export function censusProgram(extra: string[] = []): ts.Program {
  return ts.createProgram([...['apps', 'packages', 'scripts'].flatMap(sourceFiles).filter(productionSource), ...extra, join(ts.getDefaultLibFilePath({}), '..', 'lib.es5.d.ts')], {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler, noResolve: true,
    skipLibCheck: true, noLib: true, allowJs: false,
  })
}
