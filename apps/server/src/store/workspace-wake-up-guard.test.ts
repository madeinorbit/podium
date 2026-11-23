/**
 * NO NOTIFY INSIDE A WRITE TRANSACTION [POD-7292, POD-6954 design 4.2].
 *
 * A commit that contains `NOTIFY` takes Postgres's global notification lock, so the wake-up
 * sends its notifications after the commit, as their own statement, on a client that runs
 * nothing else. This guard holds the source to that: `LISTEN`, `NOTIFY` and `pg_notify`
 * appear in code (not comments) of one file only, the Postgres wake-up transport, and that
 * file opens no transaction. The runtime half (the store publishes from a post-commit
 * effect, never before the commit) is `workspace-wake-up.test.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../test-support/definition-census'

const TRANSPORT = 'apps/server/src/store/workspace-wake-up-pg.ts'
/** Upper-case statements only: `NOTIFY_SOCKET` and the word "notify" in names do not match. */
const STATEMENT = /pg_notify|\b(?:NOTIFY|LISTEN)\b/
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/

function sourceFiles(): string[] {
  const roots = ['apps', 'packages']
  const files: string[] = []
  for (const root of roots) {
    for (const app of readdirSync(join(REPO_ROOT, root))) {
      const src = join(root, app, 'src')
      let entries: string[]
      try {
        entries = readdirSync(join(REPO_ROOT, src), { recursive: true }) as string[]
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.includes('node_modules')) continue
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
        files.push(join(src, entry))
      }
    }
  }
  return files
}

function statementLines(file: string): string[] {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
    .split('\n')
    .filter((line) => !COMMENT.test(line) && STATEMENT.test(line))
}

describe('the workspace wake-up notify', () => {
  it('is named in code by the Postgres wake-up transport only', () => {
    const files = sourceFiles()
    expect(files).toContain(TRANSPORT)
    const naming = files.filter((file) => statementLines(file).length > 0)
    expect(naming).toEqual([TRANSPORT])
  })

  it('goes out on a client that never opens a transaction', () => {
    const code = readFileSync(join(REPO_ROOT, TRANSPORT), 'utf8')
      .split('\n')
      .filter((line) => !COMMENT.test(line))
      .join('\n')
    expect(code).not.toMatch(/\bBEGIN\b|\.begin\(|\.reserve\(|\bSAVEPOINT\b|\bCOMMIT\b/i)
    // The notify and the listen are the only statements the file sends.
    expect(statementLines(TRANSPORT).filter((line) => /pg_notify|`LISTEN /.test(line))).toEqual([
      expect.stringContaining('SELECT pg_notify($1, ids.id)'),
      expect.stringContaining('`LISTEN ${WAKE_UP_CHANNEL}`'),
    ])
  })
})
