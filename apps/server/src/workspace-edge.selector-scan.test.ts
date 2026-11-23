/**
 * NO HANDLER READS A WORKSPACE FROM THE REQUEST (POD-7309 criterion 4, review
 * F5). The workspace edge (workspace-edge.ts) reads the selector and binds the
 * request; everything behind it reads the bound workspace. This scan keeps it
 * so across the server and the packages it serves requests with. A file of
 * its own, so the edge's store-backed tests keep their store shard.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('no handler reads a workspace from the request (criterion 4, review F5)', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  /** Every place the server reads requests: the server and the packages it serves them with. */
  const SCANNED = [
    'apps/server/src',
    'packages/sync/src',
    'packages/identity/src',
    'packages/commands/src',
    'packages/protocol/src',
  ]
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        return name === 'test-support' || name === 'testing' || name === 'node_modules'
          ? []
          : sources(path)
      }
      return name.endsWith('.ts') && !name.includes('.test.') && !name.endsWith('.d.ts')
        ? [path]
        : []
    })
  const files = SCANNED.flatMap((dir) => sources(join(repo, dir))).map((path) => ({
    path: relative(repo, path),
    text: readFileSync(path, 'utf8'),
  }))
  const readers = (pattern: RegExp) =>
    files
      .filter((file) => pattern.test(file.text))
      .map((file) => file.path)
      .sort()

  /**
   * A selector read: the headers by name or by the edge's constants, the query
   * by `searchParams`, `c.req.query`, `c.req.queries` or the parsed query
   * object, and the path parameter.
   */
  const SELECTOR_READ = new RegExp(
    [
      'Podium-Workspace',
      'podium-workspace',
      'WORKSPACE_(?:ID_HEADER|HEADER|QUERY)\\b',
      '(?:searchParams\\.(?:get|getAll|has)|\\.queries|\\.query|\\.param)\\(\\s*[\'"]workspace[\'"]',
      '\\.query\\(\\)\\s*(?:\\.workspace\\b|\\[)',
    ].join('|'),
  )

  it('reads the selector only at the edge', () => {
    expect(readers(SELECTOR_READ)).toEqual([
      // The artifact route compares its path segment with the BOUND
      // workspace, so a request bound to one workspace that names another is
      // not found; it never selects one.
      'apps/server/src/file-artifact-route.ts',
      'apps/server/src/workspace-edge.ts',
    ])
  })

  /** A request schema with a field that names a workspace. */
  const WORKSPACE_INPUT = /\b(?:workspace|workspaceId|workspaceSlug|tenant|tenantId)\??\s*:\s*z\b/

  it('lets no request input name a workspace, except the listed ones', () => {
    expect(readers(WORKSPACE_INPUT)).toEqual([
      // The janitor's change-log prune observation. The maintenance service
      // compares it with its own store's workspace and refuses any other
      // (modules/maintenance/service.ts); it never selects a workspace.
      'packages/protocol/src/maintenance.ts',
      // The join and pairing envelopes the server WRITES for a device to read;
      // no server route parses them from a request.
      'packages/protocol/src/pairing.ts',
    ])
  })
})
