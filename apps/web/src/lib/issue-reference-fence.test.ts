// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))

/** Keep the server resolver available for CLI/server users, while rejecting
 * query access (including aliases) anywhere in the shipped client code. */
function requireLocalReferences(source: string, path: string): void {
  if (/\bresolveRefs\s*(?:(?:\?\.|\.)\s*query\b|\[\s*['"]query['"]\s*\]|\()/.test(source))
    throw new Error(`${path}: issue references must resolve from the local replica`)
}

function sources(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(path) && !/\.(?:test|spec|vitest)\./.test(path) ? [path] : []
  })
}

describe('client issue reference network fence', () => {
  it('rejects server lookup access in shipped client sources', () => {
    const paths = ['apps/web/src', 'apps/mobile/src', 'packages/client-core/src',
      'packages/client-graph/src', 'packages/client-graph/diagnostics'].flatMap(sources)
    expect(paths.length).toBeGreaterThan(100)
    for (const path of paths) requireLocalReferences(readFileSync(join(root, path), 'utf8'), path)
  })

  it('rejects a planted server call and a query alias in the chip provider', () => {
    const path = 'apps/web/src/app/pool-screens.ts'
    const source = readFileSync(join(root, path), 'utf8')
    for (const planted of [
      'runtime.access.trpc.issues.resolveRefs.query({ refs })',
      'const lookup = api.issues.resolveRefs.query; lookup({ refs })',
      'api.issues.resolveRefs["query"]({ refs })',
    ]) expect(() => requireLocalReferences(`${source}\n${planted}`, path))
      .toThrow('issue references must resolve from the local replica')
  })
})
