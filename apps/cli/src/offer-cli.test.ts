import { describe, expect, it, vi } from 'vitest'
import {
  type OfferClient,
  OfferCliError,
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
  it('collects repeated --action into an array while other flags are last-wins', () => {
    const parsed = parseOfferArgs([
      '--message',
      'Tests are red',
      '--action',
      'Fix them::Please fix the failing tests',
      '--action',
      'Show::Show the output',
    ])
    expect(parsed.command).toBeUndefined()
    expect(parsed.args.message).toBe('Tests are red')
    expect(parsed.actions).toEqual([
      'Fix them::Please fix the failing tests',
      'Show::Show the output',
    ])
  })

  it('reads a bare sub-command (clear)', () => {
    expect(parseOfferArgs(['clear']).command).toBe('clear')
  })

  it('splits an action on the FIRST :: so the prompt may contain ::', () => {
    expect(parseAction('Fix::do it')).toEqual({ label: 'Fix', prompt: 'do it' })
    expect(parseAction('Label::a::b')).toEqual({ label: 'Label', prompt: 'a::b' })
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
      ['--message', 'Tests are red', '--action', 'Fix::Please fix the failing tests'],
      c,
    )
    expect(c.offer.set.mutate).toHaveBeenCalledWith({
      message: 'Tests are red',
      actions: [{ label: 'Fix', prompt: 'Please fix the failing tests' }],
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
    expect(await runOfferCli(['--help'], client())).toContain('podium offer')
  })
})
