/**
 * `podium interactions` (POD-2020) — the headless answering path.
 *
 * The claims: the enumeration renders provenance, the answer goes to the server
 * as INTENT (the server resolves it against the ask's own options), and a
 * settled ask exits 3 rather than 1 so a supervising loop that raced a human can
 * tell losing that race from a failure.
 */

import type { IssueTrpc } from '@podium/issue-client'
import type { PendingInteractionWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { EXIT_SETTLED, runInteractionsCommand } from './interactions-cli'

const permissionRow = (over: Partial<PendingInteractionWire> = {}): PendingInteractionWire =>
  ({
    id: 'ixn_1',
    sessionId: 'ses_1',
    kind: 'permission',
    payload: { v: 1, toolName: 'Bash', inputSummary: 'rm -rf build', canAlwaysAllow: false },
    askedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    source: 'hook',
    answerable: 'keystroke-emulated',
    status: 'asked',
    fingerprint: 'fp',
    ...over,
  }) as PendingInteractionWire

function client(handlers: {
  list?: (input: unknown) => unknown
  answer?: (input: unknown) => unknown
}): { trpc: IssueTrpc; calls: unknown[] } {
  const calls: unknown[] = []
  const proc = (fn?: (input: unknown) => unknown) => ({
    query: async (input?: unknown) => {
      calls.push(input)
      return fn?.(input) ?? []
    },
    mutate: async (input?: unknown) => {
      calls.push(input)
      return fn?.(input) ?? { ok: true }
    },
  })
  return {
    trpc: {
      interactions: {
        list: proc(handlers.list),
        forSession: proc(),
        answer: proc(handlers.answer),
      },
    } as unknown as IssueTrpc,
    calls,
  }
}

describe('podium interactions list', () => {
  it('renders one row per ask, with the tool and what it would do', async () => {
    const { trpc } = client({ list: () => [permissionRow()] })
    const r = await runInteractionsCommand(['list'], trpc)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain('ixn_1')
    expect(r.text).toContain('permission')
    expect(r.text).toContain('Bash: rm -rf build')
    expect(r.text).toContain('5m')
  })

  it('marks a classifier-sourced ask as scraped', async () => {
    // Provenance on the ROW, not in the docs: a scraped ask may be a duplicate
    // of one already answered, and answering it cannot prove what it acted on.
    const { trpc } = client({ list: () => [permissionRow({ source: 'screen-classifier' })] })
    const r = await runInteractionsCommand(['list'], trpc)
    expect(r.text).toContain('~scraped')
  })

  it('does not mark a hook-sourced ask', async () => {
    const { trpc } = client({ list: () => [permissionRow()] })
    expect((await runInteractionsCommand(['list'], trpc)).text).not.toContain('~scraped')
  })

  it('says plainly that nothing is blocked', async () => {
    const { trpc } = client({ list: () => [] })
    const r = await runInteractionsCommand(['list'], trpc)
    expect(r.text).toContain('nothing is blocked')
    expect(r.exitCode).toBe(0)
  })

  it('narrows to one session', async () => {
    const { trpc, calls } = client({ list: () => [] })
    await runInteractionsCommand(['list', '--session', 'ses_9'], trpc)
    expect(calls[0]).toEqual({ sessionId: 'ses_9' })
  })

  it('renders a question ask with its numbered options', async () => {
    const { trpc } = client({
      list: () => [
        permissionRow({
          kind: 'question',
          payload: {
            v: 1,
            questions: [
              {
                question: 'Which database?',
                multiSelect: false,
                previewLayout: false,
                options: [{ label: 'Postgres' }, { label: 'SQLite' }],
              },
            ],
          },
        } as Partial<PendingInteractionWire>),
      ],
    })
    const r = await runInteractionsCommand(['list'], trpc)
    expect(r.text).toContain('Which database? [1) Postgres 2) SQLite]')
  })

  it('--json emits the rows verbatim', async () => {
    const { trpc } = client({ list: () => [permissionRow()] })
    const r = await runInteractionsCommand(['list', '--json'], trpc)
    expect(JSON.parse(r.text)).toHaveLength(1)
  })
})

describe('podium interactions answer', () => {
  it('sends the free text as intent — resolution is the server’s', async () => {
    const { trpc, calls } = client({ answer: () => ({ ok: true }) })
    const r = await runInteractionsCommand(['answer', 'ixn_1', 'allow'], trpc)
    expect(calls[0]).toEqual({ id: 'ixn_1', text: 'allow' })
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain('answered ixn_1')
  })

  it('carries free text through to the server, which routes it to the Other row', async () => {
    // The end-to-end free-text path: the CLI sends INTENT and the server
    // resolves it against the ask's own options — an unmatched answer on a
    // question that drew an Other row is answered through that row, and one on a
    // preview-layout question is refused (POD-770). Both decisions are the
    // server's; the CLI's job is to relay the text unmangled and show the reason.
    const { trpc, calls } = client({ answer: () => ({ ok: true }) })
    const ok = await runInteractionsCommand(['answer', 'ixn_1', 'DuckDB'], trpc)
    expect(calls[0]).toEqual({ id: 'ixn_1', text: 'DuckDB' })
    expect(ok.exitCode).toBe(0)

    const refused = client({
      answer: () => ({
        ok: false,
        reason: 'unknown-interaction',
        detail:
          '"Which migration?" is drawn as a side-by-side preview dialog, which has no Other row',
      }),
    })
    const r = await runInteractionsCommand(['answer', 'ixn_2', 'Something else'], refused.trpc)
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain('no Other row')
  })

  it('surfaces the not-yet-supported refusal on a permission ask', async () => {
    // POD-707. The operator has to be told to go to the terminal, not left
    // believing the agent was unblocked.
    const { trpc } = client({
      answer: () => ({
        ok: false,
        reason: 'not-yet-supported',
        detail: 'answering a permission prompt by keystroke is not shipped (POD-707)',
      }),
    })
    const r = await runInteractionsCommand(['answer', 'ixn_1', 'allow'], trpc)
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain('POD-707')
  })

  it('joins an unquoted multi-word answer', async () => {
    const { trpc, calls } = client({ answer: () => ({ ok: true }) })
    await runInteractionsCommand(['answer', 'ixn_1', 'Use', 'Postgres'], trpc)
    expect(calls[0]).toEqual({ id: 'ixn_1', text: 'Use Postgres' })
  })

  it('keeps flags out of the answer text', async () => {
    const { trpc, calls } = client({ answer: () => ({ ok: true }) })
    await runInteractionsCommand(['answer', 'ixn_1', 'allow', '--json'], trpc)
    expect(calls[0]).toEqual({ id: 'ixn_1', text: 'allow' })
  })

  it('exits 3 on an already-answered ask — a no-op, not a failure', async () => {
    const { trpc } = client({ answer: () => ({ ok: false, reason: 'already-answered' }) })
    const r = await runInteractionsCommand(['answer', 'ixn_1', 'allow'], trpc)
    expect(r.exitCode).toBe(EXIT_SETTLED)
    expect(r.text).toContain('already answered')
  })

  it('exits 3 on an expired ask, and says which', async () => {
    const { trpc } = client({ answer: () => ({ ok: false, reason: 'expired' }) })
    const r = await runInteractionsCommand(['answer', 'ixn_1', 'allow'], trpc)
    expect(r.exitCode).toBe(EXIT_SETTLED)
    expect(r.text).toContain('already expired')
  })

  it('exits 1 and shows the server’s reason when the answer could not be resolved', async () => {
    const { trpc } = client({
      answer: () => ({
        ok: false,
        reason: 'unknown-interaction',
        detail: 'could not match "maybe" to the options: 1) Postgres, 2) SQLite',
      }),
    })
    const r = await runInteractionsCommand(['answer', 'ixn_1', 'maybe'], trpc)
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain('1) Postgres, 2) SQLite')
  })

  it('exits 1 when the answer was RECORDED but delivery failed', async () => {
    // The operator must not believe the agent was unblocked when it is still
    // sitting there.
    const { trpc } = client({
      answer: () => ({ ok: true, detail: 'delivery failed: session not running' }),
    })
    const r = await runInteractionsCommand(['answer', 'ixn_1', 'allow'], trpc)
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain('session not running')
  })

  it('refuses an answer with no id or no text', async () => {
    const { trpc } = client({})
    await expect(runInteractionsCommand(['answer'], trpc)).rejects.toThrow('interaction id')
    await expect(runInteractionsCommand(['answer', 'ixn_1'], trpc)).rejects.toThrow(
      'needs an answer',
    )
  })
})

describe('podium interactions help', () => {
  it('lists the answer forms per kind — the vocabulary is not guessable', async () => {
    const { trpc } = client({})
    const r = await runInteractionsCommand([], trpc)
    expect(r.text).toContain('permission')
    expect(r.text).toContain('full-resume')
    expect(r.exitCode).toBe(0)
  })

  it('refuses an unknown command', async () => {
    const { trpc } = client({})
    await expect(runInteractionsCommand(['frobnicate'], trpc)).rejects.toThrow('unknown command')
  })
})
