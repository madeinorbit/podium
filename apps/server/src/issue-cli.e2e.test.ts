import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIssueClient } from '@podium/issue-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authCliMain } from '../../cli/src/auth-cli'
import { runIssueCli } from '../../cli/src/issue-cli'
import { makeOperatorIssueClient } from '../../cli/src/operator-client'
import { startServer } from './server'

const priorStateDir = process.env.PODIUM_STATE_DIR!

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
    process.env.PODIUM_STATE_DIR = priorStateDir
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
          'create',
          '--repoPath',
          '/repo',
          '--title',
          'Model routing',
          '--agent',
          'codex',
          '--model',
          'gpt-5.2-codex',
          '--effort',
          'high',
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

/**
 * POD-1376. The operator path on a PASSWORD-PROTECTED instance, end to end: the real
 * server with its real auth guard, the real `podium auth` command, and the real
 * `podium issue` client-selection helper.
 *
 * Before this, `podium issue <anything>` on such an instance failed on every call — reads
 * and writes alike — with "Unable to transform response from server", because the guard's
 * 401 body is not a tRPC envelope. Both halves of the fix are asserted here: the error now
 * names the auth failure, and a minted credential makes the same call work.
 */
describe('podium issue CLI ↔ password-protected server (e2e)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-issue-auth-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    // The instance password is the FIRST ADMIN's credential row since POD-1554, not
    // auth.json, so this is set BEFORE boot: applyEnvFirstAdminPassword writes it as
    // the server assembles, which is the headless deploy seam a VPS uses.
    process.env.PODIUM_PASSWORD = 'hunter2'
    server = await startServer({ port: 0 })
    baseUrl = `http://127.0.0.1:${server.port}`
  })
  afterAll(async () => {
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    delete process.env.PODIUM_STATE_DIR
    delete process.env.PODIUM_PASSWORD
  })

  it('reports an uncredentialed call as an auth failure, not a transform error', async () => {
    const client = makeOperatorIssueClient(baseUrl)
    const call = runIssueCli(['stats', '--repoPath', '/repo'], client)
    await expect(call).rejects.toThrow(/HTTP 401/)
    await expect(call).rejects.toThrow(/podium auth mint-session/)
    await expect(call).rejects.not.toThrow(/transform/i)
  })

  it('works once `podium auth mint-session` has run — reads AND writes', async () => {
    const printed: string[] = []
    await authCliMain(['mint-session'], {
      print: (line) => printed.push(line),
      printErr: () => {},
    })
    expect(printed).toHaveLength(1)

    // A FRESH client, exactly as the next `podium issue` invocation would build one:
    // nothing is passed between the two commands but the cached credential.
    const client = makeOperatorIssueClient(baseUrl)
    const created = await runIssueCli(
      ['create', '--repoPath', '/repo', '--title', 'Promote the proposed lane'],
      client,
    )
    expect(created).toMatch(/created #\d+/)
    expect(await runIssueCli(['stats', '--repoPath', '/repo'], client)).toMatch(/open|total|1/)
  })

  it('stops working again once the break-glass class is revoked', async () => {
    await authCliMain(['revoke-sessions'], { print: () => {}, printErr: () => {} })
    await expect(
      runIssueCli(['stats', '--repoPath', '/repo'], makeOperatorIssueClient(baseUrl)),
    ).rejects.toThrow(/HTTP 401/)
  })
})
