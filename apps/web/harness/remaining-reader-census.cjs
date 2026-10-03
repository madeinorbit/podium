const { execFileSync } = require('node:child_process')
const { readFileSync, existsSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const ts = createRequire(process.cwd() + '/scripts/package.json')('typescript')
const baseline = 'fba57c0c8fd01c24c2a9258d4a734961e76fdf80'
const paths = [
  'apps/web/src/features/chat/use-chat-context.ts',
  'apps/web/src/features/chat/MessageNotices.tsx',
  'apps/web/src/features/chat/PendingInteractionBar.tsx',
  'apps/web/src/features/machines/OutboxRecovery.tsx',
  'apps/web/src/features/superagent/use-superagent-inputs.ts',
  'apps/web/src/features/superagent/useIssueEvents.ts',
  'apps/web/src/features/workflows/readers.ts',
  'apps/web/src/lib/use-persisted-ui-state.ts',
  'apps/web/src/app/automation-readers.ts',
  'apps/web/src/app/command-launch-data.ts',
  'apps/web/src/app/shell-data.ts',
  'apps/web/src/app/density.tsx',
  'apps/web/src/features/settings/readers.ts',
]
const switches = [
  'features/chat/chat-context-data-layer.ts',
  'features/chat/notice-data-layer.ts',
  'features/superagent/data-layer.ts',
  'features/workflows/data-layer.ts',
  'features/settings/data-layer.ts',
  'lib/preferences-data-layer.ts',
  'lib/automations-data-layer.ts',
  'lib/command-launch-data-layer.ts',
  'app/shell-pool-screen.ts',
].map((path) => 'apps/web/src/' + path)

function count(path, source) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const result = { legacyBodies: 0, dispatchers: 0, storeSelectors: 0, sliceDerivations: 0 }
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.body &&
      node.name &&
      /^(?:useLegacy|Legacy[A-Z]|legacyChatRead)/.test(node.name.text)
    )
      result.legacyBodies++
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (/DataLayer$/.test(node.expression.text)) result.dispatchers++
      if (node.expression.text === 'useStoreSelector' || node.expression.text === 'useSlice')
        result.storeSelectors++
      if (node.expression.text === 'recordSliceDerivation') result.sliceDerivations++
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return result
}
const rows = paths.map((path) => ({
  path,
  before: count(path, execFileSync('git', ['show', baseline + ':' + path], { encoding: 'utf8' })),
  after: count(path, readFileSync(path, 'utf8')),
}))
const totals = (phase) =>
  rows.reduce((sum, row) => {
    for (const [key, value] of Object.entries(row[phase])) sum[key] = (sum[key] ?? 0) + value
    return sum
  }, {})
const remainingSwitches = switches
  .filter(existsSync)
  .filter((path) => /\bwebPoolSwitch\s*\(/.test(readFileSync(path, 'utf8')))
function writerHash(path, name, source) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  let body
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node.body
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      body = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!body) throw new Error(`Missing writer contract: ${path}:${name}`)
  // Formatting may add parentheses and trailing commas. Hash syntax structure,
  // identifiers and literal values so that a setter or payload change still fails.
  function syntax(node) {
    if (ts.isParenthesizedExpression(node)) return syntax(node.expression)
    const children = []
    ts.forEachChild(node, (child) => { children.push(syntax(child)) })
    const value = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ||
      ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : null
    return [node.kind, value, children]
  }
  return createHash('sha256').update(JSON.stringify(syntax(body))).digest('hex')
}
const writerContracts = [
  ['apps/web/src/lib/use-persisted-ui-state.ts', 'usePersistedUiState'],
  ['apps/web/src/features/settings/readers.ts', 'usePoolPreference'],
  ['apps/web/src/features/settings/readers.ts', 'parseSettingsText'],
  ['apps/web/src/features/settings/readers.ts', 'serializeSettingsText'],
  ['apps/web/src/app/density.tsx', 'PoolDensityProvider'],
  ['apps/web/src/app/density.tsx', 'parseDensity'],
  ['apps/web/src/app/density.tsx', 'serializeDensity'],
].map(([path, name]) => {
  const before = writerHash(path, name, execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' }))
  const after = writerHash(path, name, readFileSync(path, 'utf8'))
  return { path, name, before, after, unchanged: before === after }
})
const report = {
  baseline,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  before: totals('before'),
  after: totals('after'),
  remainingSwitches,
  rows,
  writerContracts,
  scope:
    'Product remaining-screen reader implementations. Pure fixture/private-replay reference policies are not runtime readers.',
}
const output = process.argv[2]
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
if (Object.values(report.after).some((value) => value !== 0) || remainingSwitches.length || writerContracts.some(check => !check.unchanged))
  process.exitCode = 1
