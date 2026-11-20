/** Machine content belongs to its daemon; only named install owners may use the server host. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export interface HostAccessException {
  /** Relative to apps/server/src; a trailing slash names a directory. */
  path: string
  reason: string
}

export const LOCAL_MACHINE_ALLOWLIST: readonly HostAccessException[] = [
  {
    path: 'migrations/',
    reason: 'Owns database files, backups, snapshots and schema verification.',
  },
  {
    path: 'modules/updates/',
    reason: 'Builds, signs, publishes and installs the server software.',
  },
  { path: 'modules/server-transfer/', reason: 'Snapshots and moves the server installation.' },
  { path: 'static-web.ts', reason: 'Serves the installed web bundle from disk.' },
  { path: 'web-bundle-stamp.ts', reason: 'Verifies the installed web bundle and build stamp.' },
  {
    path: 'enrollment-ledger-import.ts',
    reason: 'Imports the legacy state-directory enrollment ledger once.',
  },
  {
    path: 'fingerprint-key-import.ts',
    reason: 'Imports the legacy state-directory fingerprint key once.',
  },
  {
    path: 'installation-identity-import.ts',
    reason: 'Imports the legacy state-directory installation identity once.',
  },
  {
    path: 'settings-config-import.ts',
    reason: 'Imports the legacy state-directory settings file once.',
  },
  {
    path: 'enrollment-ledger.ts',
    reason: 'Owns the installation enrollment ledger in the state directory.',
  },
  {
    path: 'gateway/mobile-client-versions.ts',
    reason: 'Persists the installation mobile-client compatibility ledger.',
  },
  {
    path: 'modules/sessions/handoff-transfer.ts',
    reason: 'Stages temporary files for daemon-to-daemon handoff transfers.',
  },
  { path: 'server.ts', reason: 'Reads installation TLS files at the server composition root.' },
  {
    path: 'setup-enrollment.ts',
    reason: 'Labels the enrolled server installation with its hostname.',
  },
  {
    path: 'store/executor/harness.ts',
    reason: 'Creates and removes temporary databases for the executor test harness.',
  },
  {
    path: 'store/executor/lane-intent-audit.ts',
    reason: 'Writes the opt-in statement-intent test-lane report.',
  },
  {
    path: 'hub/import-boundary.ts',
    reason: 'Reads source files for the import-boundary test; has no production callers.',
  },
]

/** Exact readers retained by POD-7225; these must never become target-machine defaults. */
export const HOST_MACHINE_ALLOWLIST: readonly HostAccessException[] = [
  {
    path: 'server.ts',
    reason: 'Composes nullable installation identity, install features and maintenance.',
  },
  {
    path: 'relay.ts',
    reason: 'Injects installation identity into machine, update and server-move services.',
  },
  {
    path: 'store.ts',
    reason: 'Carries nullable installation identity and runs the legacy worktree import.',
  },
  {
    path: 'store/issues.ts',
    reason: 'Pins legacy worktree rows to their recorded host during the one-time backfill.',
  },
  {
    path: 'setup-enrollment.ts',
    reason: 'Refuses host enrollment when the installation has no machine.',
  },
  {
    path: 'identity/member-of-request.ts',
    reason: 'Disables same-machine sign-in facts without an installation machine.',
  },
  {
    path: 'identity/server-identity.ts',
    reason: 'Disables the same-machine identity policy without an installation machine.',
  },
  {
    path: 'modules/machines/service.ts',
    reason: 'Owns host enrollment, installation machine flags and install capabilities.',
  },
  {
    path: 'modules/instance/service.ts',
    reason: 'Reports fleet-only updates when there is no installation machine.',
  },
  {
    path: 'modules/instance/plain-family.ts',
    reason: 'Passes nullable installation identity into instance capabilities.',
  },
  {
    path: 'modules/fleet/handlers.ts',
    reason: 'Refuses a server move when there is no installation machine.',
  },
  {
    path: 'modules/fleet/server-move-effect.ts',
    reason: 'Refuses server-move effects when there is no installation machine.',
  },
  {
    path: 'modules/server-transfer/service.ts',
    reason: 'Moves the installation and refuses transfers without its source machine.',
  },
  {
    path: 'modules/updates/plain-family.ts',
    reason: 'Resolves an explicit own-install repair or reports it unavailable.',
  },
  {
    path: 'modules/updates/handlers.ts',
    reason: 'Targets the server installation for own-software update effects.',
  },
  {
    path: 'modules/updates/update-effect.ts',
    reason: 'Distinguishes installation updates from updates on remote machines.',
  },
  {
    path: 'modules/updates/effect-target.ts',
    reason: 'Builds an explicitly named installation update target.',
  },
  {
    path: 'modules/updates/dev-publisher-wiring.ts',
    reason: 'Excludes the publishing installation from remote update consumers.',
  },
  {
    path: 'modules/approvals/test-support.ts',
    reason: 'Seeds approval-test sessions on the fixture installation machine.',
  },
]

type Rule = 'local-machine' | 'host-machine'
export interface HostAccessFinding {
  rule: Rule
  file: string
  line: number
  access: string
}

export interface ServerSource {
  file: string
  source: string
}

function productionFile(file: string): boolean {
  return (
    /\.[cm]?[jt]sx?$/.test(file) &&
    !file.endsWith('.d.ts') &&
    !/\.(test|bench)\.[cm]?[jt]sx?$/.test(file) &&
    !file.split('/').some((part) => part === 'test-support' || part === 'testing') &&
    !file.startsWith('store/spike/')
  )
}

function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isAwaitExpression(node)
  )
    return unwrap(node.expression)
  return node
}

function member(node: ts.Node): { receiver: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(node))
    return { receiver: node.expression, name: node.name.text }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return { receiver: node.expression, name: node.argumentExpression.text }
  return undefined
}

function moduleName(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  )
    return node.moduleSpecifier.text
  if (
    ts.isExternalModuleReference(node) &&
    node.expression &&
    ts.isStringLiteralLike(node.expression)
  )
    return node.expression.text
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  )
    return node.arguments[0].text
  return undefined
}

function isRead(node: ts.Node): boolean {
  const parent = node.parent
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  )
    return isRead(parent)
  return (
    !(
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) && !ts.isDeleteExpression(parent)
  )
}

function identifierRead(node: ts.Identifier): boolean {
  const parent = node.parent
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ts.isBindingElement(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent)
  )
    return false
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === node
  )
    return false
  return isRead(node)
}

export function scanServerHostAccess(file: string, source: string): HostAccessFinding[] {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const findings: HostAccessFinding[] = []
  const osNamespaces = new Set<string>()
  const osNames = new Set(['homedir', 'tmpdir', 'hostname'])
  const hostNames = new Set(['hostMachine', 'hostMachineId'])
  const add = (node: ts.Node, rule: Rule, access: string) => {
    findings.push({
      rule,
      file,
      access,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
    })
  }
  // Resolve namespace imports and require/dynamic-import aliases before visiting uses.
  const osModule = (node: ts.Node) => moduleName(node)?.replace(/^node:/, '') === 'os'
  const osReceiver = (node: ts.Expression): boolean => {
    const expression = unwrap(node)
    return (
      (ts.isIdentifier(expression) && osNamespaces.has(expression.text)) || osModule(expression)
    )
  }
  const namespaces = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && osModule(node)) {
      if (node.importClause?.name) osNamespaces.add(node.importClause.name.text)
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) osNamespaces.add(bindings.name.text)
    }
    if (ts.isImportEqualsDeclaration(node) && osModule(node.moduleReference))
      osNamespaces.add(node.name.text)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      osReceiver(node.initializer)
    )
      osNamespaces.add(node.name.text)
    ts.forEachChild(node, namespaces)
  }
  namespaces(ast)
  const visit = (node: ts.Node): void => {
    // Declarations and type queries do not read a host at runtime.
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      return
    const imported = moduleName(node)?.replace(/^node:/, '')
    if (imported === 'fs' || imported === 'fs/promises' || imported === 'child_process')
      add(node, 'local-machine', `import ${imported}`)
    if (ts.isImportDeclaration(node) && imported === 'os') {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements)
          if (osNames.has((binding.propertyName ?? binding.name).text))
            add(binding, 'local-machine', `os.${(binding.propertyName ?? binding.name).text}`)
    }
    if (
      ts.isExportDeclaration(node) &&
      imported === 'os' &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    )
      for (const binding of node.exportClause.elements)
        if (osNames.has((binding.propertyName ?? binding.name).text))
          add(binding, 'local-machine', `os.${(binding.propertyName ?? binding.name).text}`)
    // Import bindings are declarations, not runtime host-machine reads.
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node)
    ) {
      if (ts.isImportEqualsDeclaration(node)) visit(node.moduleReference)
      return
    }
    const access = member(node)
    if (access) {
      const receiver = unwrap(access.receiver)
      if (
        ts.isIdentifier(receiver) &&
        receiver.text === 'Bun' &&
        ['file', 'write', 'spawn', 'spawnSync', '$'].includes(access.name)
      )
        add(node, 'local-machine', `Bun.${access.name}`)
      if (osNames.has(access.name) && osReceiver(receiver))
        add(node, 'local-machine', `os.${access.name}`)
      if (hostNames.has(access.name) && isRead(node)) add(node, 'host-machine', access.name)
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = node.propertyName ?? node.name
      const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined
      if (key && hostNames.has(key)) add(node, 'host-machine', key)
      const declaration = node.parent.parent
      if (
        key &&
        osNames.has(key) &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        osReceiver(declaration.initializer)
      )
        add(node, 'local-machine', `os.${key}`)
    }
    if (ts.isIdentifier(node) && hostNames.has(node.text) && identifierRead(node))
      add(node, 'host-machine', node.text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return findings
}

export function checkServerHostSources(
  sources: readonly ServerSource[],
  localAllowlist = LOCAL_MACHINE_ALLOWLIST,
  hostAllowlist = HOST_MACHINE_ALLOWLIST,
): string[] {
  const errors: string[] = []
  const lists = { 'local-machine': localAllowlist, 'host-machine': hostAllowlist }
  const used = new Set<HostAccessException>()
  for (const { file, source } of sources) {
    if (!productionFile(file)) continue
    for (const finding of scanServerHostAccess(file, source)) {
      const exception = lists[finding.rule].find((entry) =>
        entry.path.endsWith('/') ? file.startsWith(entry.path) : file === entry.path,
      )
      if (exception) used.add(exception)
      else
        errors.push(
          `apps/server/src/${file}:${finding.line}: [${finding.rule}] ${finding.access}; use the named machine's daemon or a record's machine id`,
        )
    }
  }
  for (const [rule, entries] of Object.entries(lists))
    for (const entry of entries) {
      if (!entry.reason.trim() || /[\r\n]/.test(entry.reason))
        errors.push(`${rule} allowlist: ${entry.path} needs a one-line reason`)
      if (!used.has(entry)) errors.push(`${rule} allowlist: unused entry ${entry.path}`)
    }
  return errors
}

export function checkServerHostAccess(
  root: string,
  localAllowlist = LOCAL_MACHINE_ALLOWLIST,
  hostAllowlist = HOST_MACHINE_ALLOWLIST,
): string[] {
  const sources: ServerSource[] = []
  const base = join(root, 'apps/server/src')
  const walk = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = prefix + entry.name
      if (entry.isDirectory()) {
        if (entry.name !== 'test-support' && entry.name !== 'testing' && file !== 'store/spike')
          walk(join(directory, entry.name), `${file}/`)
      } else if (entry.isFile() && productionFile(file))
        sources.push({ file, source: readFileSync(join(directory, entry.name), 'utf8') })
    }
  }
  walk(base)
  return checkServerHostSources(sources, localAllowlist, hostAllowlist)
}

/** Prove each refusal independently so another finding cannot mask a dead rule. */
export function probeServerHostAccess(): string[] {
  const file = 'modules/example/service.ts'
  const cases = [
    {
      name: 'node:fs import',
      source: "import { readFileSync } from 'node:fs'",
      expected: '[local-machine] import fs',
    },
    {
      name: 'homedir import',
      source: "import { homedir as home } from 'node:os'",
      expected: '[local-machine] os.homedir',
    },
    {
      name: 'Bun.spawn',
      source: "Bun.spawn(['git', 'status'])",
      expected: '[local-machine] Bun.spawn',
    },
    {
      name: 'hostMachineId read',
      source: 'const target = store.hostMachineId',
      expected: '[host-machine] hostMachineId',
    },
  ]
  const errors: string[] = []
  for (const sample of cases) {
    const found = checkServerHostSources([{ file, source: sample.source }], [], [])
    if (found.length !== 1 || !found[0]?.includes(sample.expected))
      errors.push(`probe missed ${sample.name}: ${JSON.stringify(found)}`)
  }
  const unused = checkServerHostSources(
    [{ file, source: 'export const safe = true' }],
    [{ path: 'missing.ts', reason: 'Deliberately absent probe entry.' }],
    [],
  )
  if (unused.length !== 1 || !unused[0]?.includes('unused entry missing.ts'))
    errors.push('probe missed an unused allowlist entry')
  return errors
}

if (import.meta.main) {
  const broken = probeServerHostAccess()
  if (broken.length) {
    for (const error of broken) console.error(error)
    console.error('Server host-access probe failed; the check is broken')
    process.exitCode = 2
  } else {
    console.log(
      'Server host-access probe: rejected node:fs, os.homedir, Bun.spawn, hostMachineId and an unused exception (5/5)',
    )
    if (!process.argv.includes('--probe')) {
      const errors = checkServerHostAccess(dirname(dirname(fileURLToPath(import.meta.url))))
      for (const error of errors) console.error(error)
      console.log(`Server host-access fence: ${errors.length} errors`)
      process.exitCode = errors.length ? 1 : 0
    }
  }
}
