/** Production web and graph modules cannot consume the retained wire kind. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory()
      ? files(path)
      : /\.tsx?$/.test(path) &&
          !/\.(test|spec|frontend-perf|probe)\./.test(path) &&
          !path.includes('/test-support/')
        ? [path]
        : []
  })
}
function oldIssueReads(source: string): string[] {
  // Ignore comments; even a type-only dependency can reintroduce the old shape.
  const code = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
  const legacyCollection =
    /\b(?:rows|row|collection|subscribeRows)\??\.?(?:<[^>]+>)?\(\s*['"]issues['"]/g
  const legacyKind =
    /\bread\(\s*['"]issue['"]|\b(?:replica|cache|kernel)\.(?:read|rows|row|collection|subscribeRows)\??\.?(?:<[^>]+>)?\(\s*['"]issue['"]|\bexitKind\(\s*['"]issue['"]/g
  const legacyStore = /\b(?:store|st|state|s)\.issues\b|getSnapshot\(\)\.issues\b/g
  return [legacyCollection, legacyKind, legacyStore].flatMap((pattern) =>
    [...code.matchAll(pattern)].map((match) => match[0]),
  )
}
describe('normalized issue reader boundary', () => {
  it('allows logical pool issue rows', () =>
    expect(oldIssueReads("pool.row('issue', id); source.row('issue', id)")).toEqual([]))
  it('has no old record reader in production web or client graph', () => {
    const hits = ['apps/web/src', 'packages/client-graph/src', 'packages/client-graph/diagnostics']
      .flatMap((root) => files(root))
      .flatMap((path) => oldIssueReads(readFileSync(path, 'utf8')).map((hit) => `${path}: ${hit}`))
    expect(hits).toEqual([])
  })
  it.each([
    "replica.rows('issues')",
    "cache.read('issue', id)",
    "otherCache.read('issue', id)",
    "replica.exitKind('issue', id)",
    "replica.row?.('issues', id)",
    'store.issues.find(x => x.id)',
  ])('refuses a planted reader: %s', (source) => expect(oldIssueReads(source)).not.toEqual([]))
})
