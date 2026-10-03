import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rollup } from 'rollup'
import { dts } from 'rollup-plugin-dts'
import ts from 'typescript'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = resolve(packageRoot, '../..')
// Global-store payloads are shared across checkouts. Resolve workspace source
// in this checkout before following realpaths into a dependency's payload.
const paths: Record<string, string[]> = {}
for (const directory of readdirSync(resolve(packageRoot, '..'))) {
  const manifestPath = resolve(packageRoot, '..', directory, 'package.json')
  if (!ts.sys.fileExists(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    const target = typeof entry === 'string' ? entry
      : (entry as Record<string, string>)['@podium/source'] ?? (entry as Record<string, string>).types
    if (target) paths[manifest.name + (subpath === '.' ? '' : subpath.slice(1))] = [resolve(packageRoot, '..', directory, target)]
  }
}
const temporary = mkdtempSync(join(packageRoot, '.generated-'))
const imports = `import type * as Model from '@podium/model'
import type * as Protocol from '@podium/protocol'
import type * as TRPC from '@trpc/server'
import type { z } from 'zod'
`

try {
  const scopePath = join(temporary, 'scope.ts')
  writeFileSync(scopePath, imports)
  const configPath = '../../apps/server/tsconfig.json'
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '../../apps/server', {
    noCheck: true,
    incremental: false,
    preserveSymlinks: false,
    paths,
  })
  const routerPath = '../../apps/server/src/router.ts'
  const program = ts.createProgram([routerPath, scopePath], parsed.options)
  const checker = program.getTypeChecker()
  const routerSource = program.getSourceFile(routerPath)!
  const scope = program.getSourceFile(scopePath)!
  const routerSymbol = checker.getExportsOfModule(checker.getSymbolAtLocation(routerSource)!)
    .find(symbol => symbol.name === 'appRouter')
  if (!routerSymbol) throw new Error('Server appRouter export not found')
  const router = checker.getTypeOfSymbolAtLocation(routerSymbol, routerSource)
  const printer = ts.createPrinter()
  const publicTypes = new Map<ts.Type, string>()
  for (const statement of scope.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const binding = statement.importClause?.namedBindings
    if (!binding || !ts.isNamespaceImport(binding)) continue
    const module = checker.getSymbolAtLocation(statement.moduleSpecifier)!
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      if (!(symbol.flags & ts.SymbolFlags.Type)) continue
      if (symbol.declarations?.some(node =>
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.typeParameters?.length,
      )) continue
      const type = checker.getDeclaredTypeOfSymbol(symbol)
      if (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Union | ts.TypeFlags.Intersection)) {
        if (!publicTypes.has(type)) publicTypes.set(type, `${binding.name.text}.${exported.name}`)
      }
    }
  }

  function property(type: ts.Type, name: string): ts.Type {
    const symbol = type.getProperty(name)
    if (!symbol) throw new Error(`Missing tRPC type property ${name}`)
    return checker.getTypeOfSymbolAtLocation(symbol, routerSource)
  }

  function print(type: ts.Type): string {
    const named = publicTypes.get(type)
    if (named) return named
    if (type.isUnion()) return type.types.map(member => `(${print(member)})`).join(' | ')
    if (checker.isArrayType(type)) {
      return `Array<${print(checker.getTypeArguments(type as ts.TypeReference)[0]!)}>`
    }
    const node = checker.typeToTypeNode(type, scope,
      ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseFullyQualifiedType |
      ts.NodeBuilderFlags.UseStructuralFallback | ts.NodeBuilderFlags.InTypeAlias)
    if (!node) throw new Error('Could not emit tRPC type')
    return printer.printNode(ts.EmitHint.Unspecified, node, scope)
  }

  const sharedTypes = new Map<string, string>()
  function reference(type: ts.Type, name: string): string {
    const value = print(type)
    if (value.length < 120) return value
    const existing = sharedTypes.get(value)
    if (existing) return existing
    sharedTypes.set(value, name)
    return name
  }

  let procedureCount = 0
  function record(type: ts.Type, path: string[] = []): string {
    const fields = type.getProperties().map(symbol => {
      const value = checker.getTypeOfSymbolAtLocation(symbol, routerSource)
      let result: string
      if (value.getProperty('_def')) {
        const definition = property(value, '_def')
        if (definition.getProperty('type')) {
          const kind = checker.typeToString(property(definition, 'type'))
          const procedure = {
            '"query"': 'TRPCQueryProcedure',
            '"mutation"': 'TRPCMutationProcedure',
            '"subscription"': 'TRPCSubscriptionProcedure',
          }[kind]
          if (!procedure) throw new Error(`Unsupported tRPC procedure kind ${kind}`)
          const types = property(definition, '$types')
          const name = [...path, symbol.name].join('_').replace(/[^a-zA-Z0-9_]/g, '_')
          result = `TRPC.${procedure}<{ input: ${reference(property(types, 'input'), `Input_${name}`)}; output: ${reference(property(types, 'output'), `Output_${name}`)}; meta: unknown }>`
          procedureCount++
        } else {
          result = record(property(definition, 'record'), [...path, symbol.name])
        }
      } else {
        result = record(value, [...path, symbol.name])
      }
      return `${JSON.stringify(symbol.name)}: ${result}`
    })
    return `{\n${fields.join('\n')}\n}`
  }

  const definition = property(router, '_def')
  const rootTypes = property(property(definition, '_config'), '$types')
  const procedures = record(property(definition, 'record'))
  // Emit the instantiated procedure contracts, not backend context or the
  // helper generics used to infer them. ID brands remain the canonical zod
  // brands. Native TypeScript 7 checks parity against the live server router.
  const output = `${imports}
${[...sharedTypes].map(([value, name]) => `type ${name} = ${value}`).join('\n')}
export type AppRouter = TRPC.TRPCBuiltRouter<{
  ctx: object
  meta: object
  errorShape: ${print(property(rootTypes, 'errorShape'))}
  transformer: ${print(property(rootTypes, 'transformer'))}
}, ${procedures}>
export type RouterInputs = TRPC.inferRouterInputs<AppRouter>
export type RouterOutputs = TRPC.inferRouterOutputs<AppRouter>
`
  const entry = join(temporary, 'index.ts')
  writeFileSync(entry, output)
  // Emit once before bundling. Loading backend .ts files individually in the
  // declaration bundler would construct the entire server program repeatedly.
  const declarationRoot = join(temporary, 'declarations')
  const declarations = ts.createProgram([routerPath, entry], {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: repositoryRoot,
    outDir: declarationRoot,
  }, undefined, program)
  const emitted = declarations.emit()
  if (emitted.emitSkipped) throw new Error('API declaration emission failed')
  const declarationPaths = Object.fromEntries(Object.entries(paths).map(([name, targets]) => [
    name, targets.map(target => join(declarationRoot, target.slice(repositoryRoot.length)).replace(/\.tsx?$/, '.d.ts')),
  ]))
  const bundle = await rollup({
    input: join(declarationRoot, entry.slice(repositoryRoot.length)).replace(/\.ts$/, '.d.ts'),
    external: id => /^(?:@podium\/(?:model|protocol)(?:\/|$)|@trpc\/|zod(?:\/|$)|node:)/.test(id),
    plugins: [dts({
      tsconfig: '../../apps/server/tsconfig.json',
      respectExternal: true,
      // This is declaration emission through the JS API, not a second checker.
      compilerOptions: { noCheck: true, incremental: false, preserveSymlinks: false, paths: declarationPaths },
    })],
  })
  try {
    await bundle.write({
      file: 'src/index.d.ts',
      format: 'es',
      banner: '// Generated from apps/server/src/router.ts. Run bun run api:types. Do not edit.',
    })
  } finally {
    await bundle.close()
  }
  const emittedPath = join(packageRoot, 'src/index.d.ts')
  const emittedSource = ts.createSourceFile(emittedPath, readFileSync(emittedPath, 'utf8'), ts.ScriptTarget.Latest, true)
  const publicModules = new Set(['@podium/model', '@podium/protocol', '@trpc/server', 'zod'])
  function checkImports(node: ts.Node) {
    const specifier = ts.isImportDeclaration(node) ? node.moduleSpecifier
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined
    if (specifier && ts.isStringLiteral(specifier) && !publicModules.has(specifier.text)) {
      throw new Error(`Generated API retained a backend import: ${specifier.text}`)
    }
    ts.forEachChild(node, checkImports)
  }
  checkImports(emittedSource)
  console.log(`Generated ${procedureCount} tRPC procedure contracts`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
