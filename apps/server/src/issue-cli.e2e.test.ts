import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runIssueCli } from '../../../scripts/issue-cli'
import { makeIssueClient } from './issue-client'
import { startServer } from './server'

describe('podium issue CLI ↔ live server (e2e)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-issue-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ port: 0 })
    baseUrl = `http://127.0.0.1:${server.port}`
  })
  afterAll(async () => {
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    delete process.env.PODIUM_STATE_DIR
  })

  it('create → ready → claim → close round-trips through the CLI', async () => {
    const client = makeIssueClient(baseUrl)
    const created = await runIssueCli(
      ['create', '--repoPath', '/repo', '--title', 'Wire the CLI', '--priority', '1'],
      client,
    )
    expect(created).toMatch(/created #\d+/)

    const ready = await runIssueCli(['ready', '--repoPath', '/repo'], client)
    expect(ready).toContain('Wire the CLI')

    // Resolve the id via the typed client, then claim + close through the CLI.
    const list = (await client.issues.list.query({ repoPath: '/repo' })) as Array<{ id: string }>
    const first = list[0]
    if (!first) throw new Error('expected at least one issue in list')
    const id = first.id
    expect(await runIssueCli(['claim', '--id', id, '--assignee', 'agent:test'], client)).toMatch(
      /claimed/,
    )
    expect(await runIssueCli(['close', '--id', id, '--reason', 'done'], client)).toMatch(/closed/)

    const stats = await runIssueCli(['stats', '--repoPath', '/repo'], client)
    expect(stats).toMatch(/closed: 1/)
  })
})
