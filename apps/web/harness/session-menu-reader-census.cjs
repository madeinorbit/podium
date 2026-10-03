const { execFileSync } = require('node:child_process')
const { readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const ts = createRequire(process.cwd() + '/scripts/package.json')('typescript')

const baseline = '7f952ac170ef442e1825c16218979209bb38329f'
const guard = 'apps/web/src/lib/hooks/use-session-guard.ts'
const menu = 'apps/web/src/lib/SessionContextMenu.tsx'
const paths = [guard, menu]
const source = (path, before) =>
  before
    ? execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' })
    : readFileSync(path, 'utf8')
const tree = (path, before) =>
  ts.createSourceFile(path, source(path, before), ts.ScriptTarget.Latest, true)

function readers(before) {
  const counts = {
    legacyBodies: 0,
    storeSelectors: 0,
    legacyIssueChoices: 0,
    optionalPoolInputs: 0,
  }
  for (const path of paths) {
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith('useLegacy'))
        counts.legacyBodies++
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useStoreSelector'
      )
        counts.storeSelectors++
      if (ts.isIdentifier(node) && node.text === 'useReplicaIssues') counts.legacyIssueChoices++
      if (
        ts.isPropertySignature(node) &&
        node.name.getText() === 'poolInputs' &&
        node.questionToken
      )
        counts.optionalPoolInputs++
      ts.forEachChild(node, visit)
    }
    visit(tree(path, before))
  }
  return counts
}

function syntax(node) {
  if (ts.isParenthesizedExpression(node)) return syntax(node.expression)
  if (ts.isJsxText(node) && node.containsOnlyTriviaWhiteSpaces && /[\r\n]/.test(node.text))
    return null
  const children = []
  ts.forEachChild(node, (child) => {
    const value = syntax(child)
    if (value !== null) children.push(value)
  })
  const value =
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
      ? node.text
      : null
  return [node.kind, value, children]
}
function writerHash(path, name, before) {
  let body
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      body = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(tree(path, before))
  if (!body) throw new Error(`Missing writer contract: ${path}:${name}`)
  return createHash('sha256')
    .update(JSON.stringify(syntax(body)))
    .digest('hex')
}

const files = []
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__snapshots__') walk(path)
    } else if (/\.[jt]sx?$/.test(path) && !/\.(?:test|spec|browser)\./.test(path)) files.push(path)
  }
}
walk('apps/web/src')
const missingMenuInputs = [],
  missingGuardInputs = []
for (const path of files) {
  const current = tree(path, false)
  const visit = (node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === 'SessionContextMenu' &&
      !node.attributes.properties.some(
        (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === 'poolInputs',
      )
    )
      missingMenuInputs.push({
        path,
        line: current.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      })
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useSessionGuard' &&
      node.arguments.length < 3
    )
      missingGuardInputs.push({
        path,
        line: current.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      })
    ts.forEachChild(node, visit)
  }
  visit(current)
}
const writerContracts = [
  [guard, 'guardedDelete'],
  [guard, 'guardedEnd'],
  [guard, 'guardedArchive'],
  [menu, 'run'],
  [menu, 'handoff'],
].map(([path, name]) => {
  const before = writerHash(path, name, true),
    after = writerHash(path, name, false)
  return { path, name, before, after, unchanged: before === after }
})
const report = {
  baseline,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  before: readers(true),
  after: readers(false),
  missingMenuInputs,
  missingGuardInputs,
  writerContracts,
  scope:
    'Shared guard/menu implementations and every product caller under apps/web/src; synthetic test controls excluded.',
}
const output = process.argv.find((arg) => arg.endsWith('.json'))
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
if (
  !process.argv.includes('--record-before') &&
  (Object.values(report.after).some((value) => value !== 0) ||
    missingMenuInputs.length ||
    missingGuardInputs.length ||
    writerContracts.some((contract) => !contract.unchanged))
)
  process.exitCode = 1
