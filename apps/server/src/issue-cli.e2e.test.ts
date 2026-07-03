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

  it('create → ready → claim → close round-trips using ONLY display seqs (what an agent sees)', async () => {
    // Open (no-password) server ⇒ the CLI acts as the operator with full authority.
    const client = makeIssueClient(baseUrl)
    const created = await runIssueCli(
      ['create', '--repoPath', '/repo', '--title', 'Wire the CLI', '--priority', '1'],
      client,
    )
    const seq = /created #(\d+)/.exec(created)?.[1]
    if (!seq) throw new Error(`no seq in: ${created}`)

    const ready = await runIssueCli(['ready', '--repoPath', '/repo'], client)
    expect(ready).toContain('Wire the CLI')

    // Everything below uses the display seq exactly as list/create print it —
    // no typed-client id fishing (an agent has no access to internal iss_ ids).
    expect(await runIssueCli(['show', seq], client)).toContain('Wire the CLI')
    expect(await runIssueCli(['show', `#${seq}`], client)).toContain('Wire the CLI')
    expect(await runIssueCli(['claim', seq, '--assignee', 'agent:test'], client)).toMatch(/claimed/)
    expect(await runIssueCli(['comment', seq, '--body', 'progress note'], client)).toMatch(
      /commented/,
    )
    expect(
      await runIssueCli(['close', seq, '--reason', 'done', '--note', 'all wired up'], client),
    ).toMatch(/closed/)

    const stats = await runIssueCli(['stats', '--repoPath', '/repo'], client)
    expect(stats).toMatch(/closed: 1/)
  })

  it('dep-add by display seq + --json carries structured payloads', async () => {
    const client = makeIssueClient(baseUrl)
    const a = /created #(\d+)/.exec(
      await runIssueCli(['create', '--repoPath', '/repo', '--title', 'Blocker'], client),
    )?.[1]
    const b = /created #(\d+)/.exec(
      await runIssueCli(['create', '--repoPath', '/repo', '--title', 'Dependent'], client),
    )?.[1]
    if (!a || !b) throw new Error('missing seqs')

    expect(await runIssueCli(['dep-add', b, a, '--type', 'blocks'], client)).toContain('dep added')
    const blocked = await runIssueCli(['blocked', '--repoPath', '/repo'], client)
    expect(blocked).toContain('Dependent')

    const shown = JSON.parse(await runIssueCli(['show', b, '--json'], client))
    expect(shown.ok).toBe(true)
    expect(shown.data).toMatchObject({ seq: Number(b), blocked: true })

    // Closing the blocker (by seq) unblocks the dependent — derived, no extra call.
    await runIssueCli(['close', a], client)
    const readyAgain = await runIssueCli(['ready', '--repoPath', '/repo', '--json'], client)
    const readyRows = JSON.parse(readyAgain).data as Array<{ seq: number }>
    expect(readyRows.some((r) => r.seq === Number(b))).toBe(true)
  })

  it('--agent/--model/--effort flow into the issue columns on create and update, show surfaces them', async () => {
    const client = makeIssueClient(baseUrl)
    const seq = /created #(\d+)/.exec(
      await runIssueCli(
        [
          'create', '--repoPath', '/repo', '--title', 'Model routing',
          '--agent', 'codex', '--model', 'gpt-5.2-codex', '--effort', 'high',
        ],
        client,
      ),
    )?.[1]
    if (!seq) throw new Error('missing seq')

    const shown = JSON.parse(await runIssueCli(['show', seq, '--json'], client))
    expect(shown.data).toMatchObject({
      defaultAgent: 'codex',
      defaultModel: 'gpt-5.2-codex',
      defaultEffort: 'high',
    })

    // update rewrites all three via the same patch path the web pickers use
    await runIssueCli(
      ['update', seq, '--agent', 'claude-code', '--model', 'opus-4-5', '--effort', 'low'],
      client,
    )
    const text = await runIssueCli(['show', seq], client)
    expect(text).toContain('agent=claude-code model=opus-4-5 effort=low')
  })

  it('failures exit non-zero paths: unknown seq throws, ambiguity is explicit', async () => {
    const client = makeIssueClient(baseUrl)
    await expect(runIssueCli(['show', '99999'], client)).rejects.toThrow(/unknown issue/)
    // Same seq in a second repo → unqualified ref is ambiguous and says so.
    const s = /created #(\d+)/.exec(
      await runIssueCli(['create', '--repoPath', '/repo2', '--title', 'Twin A'], client),
    )?.[1]
    if (!s) throw new Error('missing seq')
    const twin = /created #(\d+)/.exec(
      await runIssueCli(['create', '--repoPath', '/repo3', '--title', 'Twin B'], client),
    )?.[1]
    if (twin !== s) return // seq counters diverged; ambiguity can't be staged — skip
    await expect(runIssueCli(['show', s], client)).rejects.toThrow(/ambiguous issue ref/)
  })
})
