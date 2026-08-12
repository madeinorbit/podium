#!/usr/bin/env bun

/** Mechanical migration for POD-1937's measured `ts-string` population.
 *
 * The entity-id audit owns discovery and brand inference. This script changes
 * only the leading `string` token at those exact file/line/key sites and adds
 * the corresponding model type import. Boundary sites are excluded by an
 * attached `UNBRANDED` decision before this is run.
 *
 * Usage:
 *   bun scripts/brand-ts-id-members.ts --brand Conversation,Automation --write
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entityIdSites } from './entity-id-audit'
import { loadContext } from './rearch-audit'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function modelImportFor(file: string): string {
  if (!file.startsWith('packages/model/src/')) return '@podium/model'
  const specifier = relative(dirname(file), 'packages/model/src/ids/brands')
  return specifier.startsWith('.') ? specifier : './' + specifier
}
const argv = process.argv.slice(2)
const write = argv.includes('--write')
const repairImports = argv.includes('--repair-imports')
const markForeign = argv.includes('--mark-foreign')
const brandArg = argv.includes('--brand') ? argv[argv.indexOf('--brand') + 1] : undefined
const selectedBrands = brandArg ? new Set(brandArg.split(',').filter(Boolean)) : undefined

if (!write) {
  console.error('refusing a dry run that looks like a migration; pass --write explicitly')
  process.exit(2)
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function addModelImports(source: string, names: readonly string[]): string {
  const needed = [...new Set(names)].filter(
    (name) =>
      !new RegExp(
        `import(?:\\s+type)?\\s*\\{[^}]*\\b(?:type\\s+)?${escapeRegex(name)}\\b[^}]*\\}\\s*from\\s*['\"]@podium/model['\"]`,
      ).test(source),
  )
  if (needed.length === 0) return source

  const typeImport = /import\s+type\s*\{([^}]*)\}\s*from\s*(['"])@podium\/model\2/
  const typed = source.match(typeImport)
  if (typed?.index !== undefined) {
    const body = typed[1] ?? ''
    const replacement = body.includes('\n')
      ? typed[0].replace(/\}\s*from/, `${needed.map((name) => `  ${name},`).join('\n')}\n} from`)
      : typed[0].replace(/\}/, `${body.trim() ? ', ' : ''}${needed.join(', ')} }`)
    return source.slice(0, typed.index) + replacement + source.slice(typed.index + typed[0].length)
  }

  const valueImport = /import\s*\{([^}]*)\}\s*from\s*(['"])@podium\/model\2/
  const valued = source.match(valueImport)
  if (valued?.index !== undefined) {
    const body = valued[1] ?? ''
    const additions = needed.map((name) => `type ${name}`)
    const replacement = body.includes('\n')
      ? valued[0].replace(/\}\s*from/, `${additions.map((name) => `  ${name},`).join('\n')}\n} from`)
      : valued[0].replace(/\}/, `${body.trim() ? ', ' : ''}${additions.join(', ')} }`)
    return source.slice(0, valued.index) + replacement + source.slice(valued.index + valued[0].length)
  }

  const declaration = `import type { ${needed.join(', ')} } from '@podium/model'\n`
  const firstImport = source.search(/^import\s/m)
  return firstImport >= 0
    ? source.slice(0, firstImport) + declaration + source.slice(firstImport)
    : declaration + source
}

function normalizeNamedImport(statement: string): string {
  const parsed = statement.match(
    /^import(\s+type)?\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\3$/,
  )
  if (!parsed) return statement
  const [, typeOnly = '', body = '', quote, module] = parsed
  const specifiers = body
    .split(',')
    .map((specifier) => specifier.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const multiline = body.includes('\n') && specifiers.length > 1
  const normalizedBody = multiline
    ? `\n${specifiers.map((specifier) => `  ${specifier},`).join('\n')}\n`
    : ` ${specifiers.join(', ')} `
  return `import${typeOnly} {${normalizedBody}} from ${quote}${module}${quote}`
}

const selectedIdTypes = [
  'MachineId',
  'IssueId',
  'UserId',
  'MutationId',
  'RepoId',
  'AutomationId',
  'ArtifactId',
  'SessionId',
  'ThreadId',
  'AccountId',
  'ConversationId',
] as const

const providerAccountFiles = new Set([
  'apps/daemon/src/quota-codex.ts',
  'apps/server/src/codex-auth.ts',
  'apps/server/src/login-catalog.ts',
  'packages/harness/src/manifest.ts',
  'packages/harness/src/manifests/codex.ts',
])

function foreignReason(site: ReturnType<typeof entityIdSites>[number]): string | undefined {
  if (site.brand === 'Conversation')
    return "the harness-native conversation id, not Podium's stable ConversationId"
  if (site.brand === 'Account' && providerAccountFiles.has(site.file))
    return 'a provider account id, not a server-minted Podium AccountId'
  if (
    site.brand === 'Thread' &&
    (site.file.startsWith('packages/harness/') ||
      site.file === 'apps/daemon/src/durable-headless.ts' ||
      site.file === 'apps/daemon/src/headless-drivers.ts')
  )
    return 'a provider/harness-native thread id, not a Podium messaging ThreadId'
  if (site.brand !== 'Session') return undefined
  if (site.file.startsWith('packages/harness/')) {
    const sourceLine = readFileSync(join(REPO_ROOT, site.file), 'utf8').split('\n')[site.line - 1]
    if (sourceLine?.includes('codexPodiumSessionMarker')) return undefined
    return 'a provider/harness-native session id, not a Podium SessionId'
  }
  if (
    site.file.startsWith('packages/transcript/') ||
    site.file === 'apps/daemon/src/durable-headless.ts' ||
    /^(?:providerSessionId|harnessSessionId|terminalSessionId|nextProviderSessionId|fromProviderSessionId|toProviderSessionId|newSessionId|knownSessionId)$/.test(
      site.key,
    )
  )
    return 'a provider/harness-native session id, not a Podium SessionId'
  return undefined
}

if (markForeign) {
  const foreignSites = entityIdSites(loadContext(REPO_ROOT)).filter(
    (site) => site.form === 'ts-string' && !site.excused && foreignReason(site) !== undefined,
  )
  if (foreignSites.length !== 83)
    throw new Error(`expected 83 foreign TypeScript id members, found ${foreignSites.length}`)
  const byForeignFile = new Map<string, typeof foreignSites>()
  for (const site of foreignSites) {
    const sites = byForeignFile.get(site.file) ?? []
    sites.push(site)
    byForeignFile.set(site.file, sites)
  }
  for (const [file, fileSites] of byForeignFile) {
    const path = join(REPO_ROOT, file)
    const lines = readFileSync(path, 'utf8').split('\n')
    const byLine = new Map(fileSites.map((site) => [site.line, site]))
    for (const [line, site] of [...byLine].sort(([left], [right]) => right - left)) {
      const sourceLine = lines[line - 1]
      if (sourceLine === undefined) throw new Error(`${file}:${line}: line is absent`)
      const indent = sourceLine.match(/^\s*/)?.[0] ?? ''
      lines.splice(
        line - 1,
        0,
        `${indent}/** UNBRANDED BY DECISION: ${foreignReason(site)}. */`,
      )
    }
    writeFileSync(path, lines.join('\n'))
  }
  console.log(`marked ${foreignSites.length} foreign TypeScript id members`)
  process.exit(0)
}

if (repairImports) {
  const changed = spawnSync('git', ['diff', '--name-only', '--', '*.ts', '*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (changed.status !== 0) throw new Error(changed.stderr || 'git diff --name-only failed')
  let repaired = 0
  for (const file of changed.stdout.split('\n').filter(Boolean)) {
    const path = join(REPO_ROOT, file)
    const modelModule = modelImportFor(file)
    const originalSource = readFileSync(path, 'utf8')
    let source = originalSource
    const names: string[] = []
    source = source.replace(
      /import\s*\{[^}]*\}\s*from\s*(['"])([^'"]+)\1/g,
      (statement, _quote: string, module: string) => {
        if (module === modelModule) return normalizeNamedImport(statement)
        let fixed = statement
        for (const name of selectedIdTypes) {
          const inserted = new RegExp(`\\s+type\\s+${name}\\s*,`)
          if (!inserted.test(fixed)) continue
          fixed = fixed.replace(inserted, '')
          names.push(name)
          repaired++
        }
        return fixed === statement ? statement : normalizeNamedImport(fixed)
      },
    )
    source = source.replace(
      /import\s*\{[^},\n]+\n\}\s*from\s*(['"])[^'"]+\1/g,
      normalizeNamedImport,
    )
    if (names.length > 0) {
      if (modelModule !== '@podium/model')
        source = source.replace(`from '${modelModule}'`, "from '@podium/model'")
      source = addModelImports(source, names)
      if (modelModule !== '@podium/model')
        source = source.replace("from '@podium/model'", `from '${modelModule}'`)
    }
    source = source.replace(
      /import(?:\s+type)?\s*\{[^}]*\}\s*from\s*(['"])@podium\/model\1/g,
      normalizeNamedImport,
    )
    if (source !== originalSource) writeFileSync(path, source)
  }
  console.log(`repaired ${repaired} misplaced model type imports`)
  process.exit(0)
}

const sites = entityIdSites(loadContext(REPO_ROOT)).filter(
  (site) =>
    site.form === 'ts-string' &&
    !site.excused &&
    (selectedBrands === undefined || selectedBrands.has(site.brand)),
)

const byFile = new Map<string, typeof sites>()
for (const site of sites) {
  const list = byFile.get(site.file) ?? []
  list.push(site)
  byFile.set(site.file, list)
}

let changedSites = 0
const outputs = new Map<string, string>()
for (const [file, fileSites] of byFile) {
  const path = join(REPO_ROOT, file)
  let source = readFileSync(path, 'utf8')
  const lineStarts = [0]
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') lineStarts.push(index + 1)
  }

  const edits: { start: number; end: number; replacement: string; label: string }[] = []
  const imported: string[] = []
  const seenOnLine = new Map<string, number>()
  for (const site of fileSites) {
    const lineStart = lineStarts[site.line - 1]
    const lineEnd = lineStarts[site.line] ?? source.length
    if (lineStart === undefined) throw new Error(`${file}:${site.line}: line is absent`)
    const key = escapeRegex(site.key)
    const declaration = new RegExp(`(?:['\"]${key}['\"]|\\b${key}\\b)\\??[ \\t]*:[ \\t\\n]*`, 'g')
    const occurrenceKey = `${site.line}:${site.key}`
    const occurrence = seenOnLine.get(occurrenceKey) ?? 0
    seenOnLine.set(occurrenceKey, occurrence + 1)
    declaration.lastIndex = lineStart
    let match: RegExpExecArray | null = null
    for (let index = 0; index <= occurrence; index++) match = declaration.exec(source)
    if (!match || match.index >= lineEnd) {
      throw new Error(
        `${file}:${site.line}: cannot find occurrence ${occurrence + 1} of ${site.key}`,
      )
    }
    const rhs = match.index + match[0].length
    const raw = source.slice(rhs)
    const stringType = raw.match(/^(\|?\s*)string\b/)
    if (!stringType) throw new Error(`${file}:${site.line}: RHS no longer starts with string`)
    const start = rhs + (stringType[1]?.length ?? 0)
    const name = `${site.brand}Id`
    edits.push({ start, end: start + 'string'.length, replacement: name, label: `${file}:${site.line}` })
    imported.push(name)
  }

  edits.sort((left, right) => right.start - left.start)
  for (const edit of edits) {
    if (source.slice(edit.start, edit.end) !== 'string') {
      throw new Error(`${edit.label}: overlapping or stale edit`)
    }
    source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end)
    changedSites++
  }
  const modelModule = modelImportFor(file)
  if (modelModule !== '@podium/model')
    source = source.replace(`from '${modelModule}'`, "from '@podium/model'")
  source = addModelImports(source, imported)
  if (modelModule !== '@podium/model')
    source = source.replace("from '@podium/model'", `from '${modelModule}'`)
  outputs.set(path, source)
}

// Preflight every site before writing any file, so a stale line cannot leave a
// half-applied migration behind.
for (const [path, source] of outputs) writeFileSync(path, source)

console.log(`branded ${changedSites} TypeScript id members in ${byFile.size} files`)
