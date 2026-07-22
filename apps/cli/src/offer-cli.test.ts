import { describe, expect, it, vi } from 'vitest'
import {
  OfferCliError,
  type OfferClient,
  parseAction,
  parseOfferArgs,
  runOfferCli,
} from './offer-cli'

function client(over?: Partial<Record<'set' | 'clear', unknown>>): OfferClient {
  const proc = (result: unknown) => ({
    mutate: vi.fn(async () => result),
    query: vi.fn(async () => result),
  })
  return {
    offer: {
      set: proc(over?.set ?? { ok: true }),
      clear: proc(over?.clear ?? { ok: true, cleared: true }),
    },
  } satisfies OfferClient
}

describe('podium offer CLI (argv shape)', () => {
  it('collects repeated --action/--action-input in argv order while other flags are last-wins', () => {
    const parsed = parseOfferArgs([
      '--message',
      'Tests are red',
      '--action',
      'Fix them::Please fix the failing tests',
      '--action-input',
      'Send back::Revise per this feedback:',
      '--action',
      'Show::Show the output',
    ])
    expect(parsed.command).toBeUndefined()
    expect(parsed.args.message).toBe('Tests are red')
    expect(parsed.actions).toEqual([
      { token: 'Fix them::Please fix the failing tests', input: false },
      { token: 'Send back::Revise per this feedback:', input: true },
      { token: 'Show::Show the output', input: false },
    ])
  })

  it('collects repeated --artifact in argv order [POD-120]', () => {
    const parsed = parseOfferArgs([
      '--message',
      'Shots ready',
      '--artifact',
      'e2e/before.png',
      '--action',
      'Ship::Merge it',
      '--artifact',
      'e2e/after.png',
    ])
    expect(parsed.artifacts).toEqual(['e2e/before.png', 'e2e/after.png'])
    expect(parsed.actions).toEqual([{ token: 'Ship::Merge it', input: false }])
  })

  it('reads a bare sub-command (clear)', () => {
    expect(parseOfferArgs(['clear']).command).toBe('clear')
  })

  it('splits an action on the FIRST :: so the prompt may contain ::', () => {
    expect(parseAction('Fix::do it')).toEqual({ label: 'Fix', prompt: 'do it' })
    expect(parseAction('Label::a::b')).toEqual({ label: 'Label', prompt: 'a::b' })
  })

  it('marks an --action-input token with input: true', () => {
    expect(parseAction('Send back::Revise:', true)).toEqual({
      label: 'Send back',
      prompt: 'Revise:',
      input: true,
    })
  })

  it('rejects an action with no separator or an empty half', () => {
    expect(() => parseAction('no separator')).toThrow(OfferCliError)
    expect(() => parseAction('::prompt only')).toThrow(OfferCliError)
    expect(() => parseAction('label only::')).toThrow(OfferCliError)
  })
})

describe('podium offer CLI (behavior)', () => {
  it('sets an offer with parsed actions', async () => {
    const c = client()
    const out = await runOfferCli(
      [
        '--message',
        'Tests are red',
        '--action',
        'Fix::Please fix the failing tests',
        '--action-input',
        'Send back::Revise per this feedback:',
      ],
      c,
    )
    expect(c.offer.set.mutate).toHaveBeenCalledWith({
      message: 'Tests are red',
      actions: [
        { label: 'Fix', prompt: 'Please fix the failing tests' },
        { label: 'Send back', prompt: 'Revise per this feedback:', input: true },
      ],
    })
    expect(out).toContain('offer set')
  })

  it('sets a message-only offer (no actions)', async () => {
    const c = client()
    await runOfferCli(['--message', 'Heads up: deploy is queued'], c)
    expect(c.offer.set.mutate).toHaveBeenCalledWith({
      message: 'Heads up: deploy is queued',
      actions: [],
    })
  })

  it('passes --artifact paths through to offer.set, omitting the key when none [POD-120]', async () => {
    const c = client()
    await runOfferCli(
      ['--message', 'Shots ready', '--artifact', 'e2e/after.png', '--artifact', '/abs/doc.md'],
      c,
    )
    expect(c.offer.set.mutate).toHaveBeenCalledWith({
      message: 'Shots ready',
      actions: [],
      artifacts: ['e2e/after.png', '/abs/doc.md'],
    })
    const c2 = client()
    await runOfferCli(['--message', 'No evidence'], c2)
    expect(c2.offer.set.mutate).toHaveBeenCalledWith({ message: 'No evidence', actions: [] })
  })

  it('rejects more than 6 artifacts and an empty artifact path [POD-120]', async () => {
    const many = ['--message', 'm']
    for (let i = 0; i < 7; i++) many.push('--artifact', `a${i}.png`)
    await expect(runOfferCli(many, client())).rejects.toThrow(/at most 6/)
    await expect(runOfferCli(['--message', 'm', '--artifact', '  '], client())).rejects.toThrow(
      /empty path/,
    )
  })

  it('clears via the clear sub-command', async () => {
    const c = client()
    const out = await runOfferCli(['clear'], c)
    expect(c.offer.clear.mutate).toHaveBeenCalled()
    expect(c.offer.set.mutate).not.toHaveBeenCalled()
    expect(out).toContain('cleared')
  })

  it('requires a message when setting', async () => {
    await expect(runOfferCli([], client())).rejects.toThrow(OfferCliError)
  })

  it('rejects more than 6 actions', async () => {
    const args = ['--message', 'm']
    for (let i = 0; i < 7; i++) args.push('--action', `L${i}::P${i}`)
    await expect(runOfferCli(args, client())).rejects.toThrow(/at most 6/)
  })

  it('rejects an unknown flag', async () => {
    await expect(runOfferCli(['--message', 'm', '--bogus', 'x'], client())).rejects.toThrow(
      /unknown flag/,
    )
  })

  it('emits JSON when --json is set', async () => {
    const out = await runOfferCli(['--message', 'm', '--json'], client())
    expect(JSON.parse(out)).toMatchObject({ ok: true, command: 'set' })
  })

  it('renders help', async () => {
    const help = await runOfferCli(['--help'], client())
    expect(help).toContain('podium offer')
    expect(help).toContain('put the best')
    expect(help).toContain('interactive HTML')
    expect(help).toContain('first 3 items')
  })
})
