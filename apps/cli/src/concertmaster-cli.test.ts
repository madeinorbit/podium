import { describe, expect, it, vi } from 'vitest'
import {
  ConcertmasterCliError,
  type ConcertmasterClient,
  helpText,
  runConcertmasterCli,
} from './concertmaster-cli'

function client(result: unknown = { ok: true, number: 4, settled: true }) {
  const submit = vi.fn(async (_envelope: { command: string; input: unknown }) => ({
    outcome: 'applied',
    result,
    receipt: { feedId: 'f', epoch: 'e', seq: 1 },
    replayed: false,
  }))
  const list = vi.fn(async (_input?: unknown) => ({
    asks: [
      { number: 2, kind: 'todo', title: 'Rotate key', status: 'open', askedAt: 't' },
      {
        number: 1,
        kind: 'decision',
        title: 'Ship?',
        options: ['Yes', 'No'],
        status: 'answered',
        answer: 'Yes',
        settledBy: 'user',
        askedAt: 't',
      },
    ],
  }))
  const value = {
    sync: { submit: { mutate: submit } },
    concertmaster: { list: { query: list } },
  } as unknown as ConcertmasterClient
  return { value, submit, list }
}
const io = { readStdin: async () => 'from stdin\n' }
const sentOf = (c: ReturnType<typeof client>) => c.submit.mock.calls[0]![0]

describe('podium concertmaster', () => {
  it('says a message, with artifacts in the order typed', async () => {
    const c = client()
    expect(
      await runConcertmasterCli(
        ['say', 'Done.\\nTwo left.', '--artifact', 'a.png', '--artifact', 'b.png'],
        c.value,
        io,
      ),
    ).toBe('said (2 artifacts)')
    expect(sentOf(c)).toMatchObject({
      command: 'concertmaster.say',
      input: { body: 'Done.\nTwo left.', artifacts: ['a.png', 'b.png'] },
    })
  })

  it('reads a message from stdin', async () => {
    const c = client()
    await runConcertmasterCli(['say', '-'], c.value, io)
    expect(sentOf(c).input).toEqual({ body: 'from stdin' })
  })

  it('opens an ask and prints its number', async () => {
    const c = client()
    expect(
      await runConcertmasterCli(
        ['ask', '--kind', 'decision', '--title', 'Ship?', '--option', 'Yes', '--option', 'No'],
        c.value,
        io,
      ),
    ).toBe('ask #4 opened')
    expect(sentOf(c).input).toEqual({ title: 'Ship?', kind: 'decision', options: ['Yes', 'No'] })
  })

  it('names an ask by number for resolve, retract and update', async () => {
    const c = client()
    expect(await runConcertmasterCli(['resolve', '#3', '--answer', 'Postgres'], c.value, io)).toBe(
      'ask #3 resolved',
    )
    expect(sentOf(c)).toMatchObject({
      command: 'concertmaster.resolve',
      input: { number: 3, answer: 'Postgres' },
    })
    await expect(runConcertmasterCli(['retract'], c.value, io)).rejects.toThrow(
      ConcertmasterCliError,
    )
    await expect(
      runConcertmasterCli(['update', '2', '--option', 'a', '--no-options'], c.value, io),
    ).rejects.toThrow(/not both/)
  })

  it('lists asks oldest first, settled ones with what they were settled with', async () => {
    const c = client()
    const out = await runConcertmasterCli(['list', '--all'], c.value, io)
    expect(c.list).toHaveBeenCalledWith({ show: 'all' })
    expect(out.split('\n')[0]).toBe('#1 [decision] Ship? — answered')
    expect(out).toContain('their answer: Yes')
    expect(out).toContain('#2 [todo] Rotate key')
  })

  it('refuses an unknown command and an unknown flag', async () => {
    const c = client()
    await expect(runConcertmasterCli(['shout', 'hi'], c.value, io)).rejects.toThrow(
      /unknown command/,
    )
    await expect(runConcertmasterCli(['say', 'hi', '--bogus'], c.value, io)).rejects.toThrow(
      ConcertmasterCliError,
    )
    expect(c.submit).not.toHaveBeenCalled()
  })

  it('documents every command the agent briefing names', () => {
    const help = helpText()
    for (const verb of ['say', 'ask', 'update', 'resolve', 'retract', 'list']) {
      expect(help).toContain(`  ${verb} `)
    }
  })
})
