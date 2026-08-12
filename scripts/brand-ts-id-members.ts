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

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entityIdSites } from './entity-id-audit'
import { loadContext } from './rearch-audit'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const write = argv.includes('--write')
const brandArg = argv.includes('--brand') ? argv[argv.indexOf('--brand') + 1] : undefined
const selectedBrands = brandArg ? new Set(brandArg.split(',').filter(Boolean)) : undefined

if (!write) {
  console.error('refusing a dry run that looks like a migration; pass --write explicitly')
  process.exit(2)
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

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function addModelImports(source: string, names: readonly string[]): string {
  const needed = [...new Set(names)].filter(
    (name) =>
      !new RegExp(
        `import(?:\\s+type)?\\s*\\{[\\s\\S]*?\\b(?:type\\s+)?${escapeRegex(name)}\\b[\\s\\S]*?\\}\\s*from\\s*['\"]@podium/model['\"]`,
      ).test(source),
  )
  if (needed.length === 0) return source

  const typeImport = /import\s+type\s*\{([\s\S]*?)\}\s*from\s*(['"])@podium\/model\2/
  const typed = source.match(typeImport)
  if (typed?.index !== undefined) {
    const body = typed[1] ?? ''
    const replacement = body.includes('\n')
      ? typed[0].replace(/\}\s*from/, `${needed.map((name) => `  ${name},`).join('\n')}\n} from`)
      : typed[0].replace(/\}/, `${body.trim() ? ', ' : ''}${needed.join(', ')} }`)
    return source.slice(0, typed.index) + replacement + source.slice(typed.index + typed[0].length)
  }

  const valueImport = /import\s*\{([\s\S]*?)\}\s*from\s*(['"])@podium\/model\2/
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
  for (const site of fileSites) {
    const lineStart = lineStarts[site.line - 1]
    const lineEnd = lineStarts[site.line] ?? source.length
    if (lineStart === undefined) throw new Error(`${file}:${site.line}: line is absent`)
    const key = escapeRegex(site.key)
    const declaration = new RegExp(`(?:['\"]${key}['\"]|\\b${key}\\b)\\??[ \\t]*:[ \\t\\n]*`, 'g')
    declaration.lastIndex = lineStart
    const match = declaration.exec(source)
    if (!match || match.index >= lineEnd) {
      throw new Error(`${file}:${site.line}: cannot find declaration for ${site.key}`)
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
  source = addModelImports(source, imported)
  outputs.set(path, source)
}

// Preflight every site before writing any file, so a stale line cannot leave a
// half-applied migration behind.
for (const [path, source] of outputs) writeFileSync(path, source)

console.log(`branded ${changedSites} TypeScript id members in ${byFile.size} files`)
