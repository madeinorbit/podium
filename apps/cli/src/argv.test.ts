import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  declareFlags,
  flagsFromZodShape,
  flagTable,
  nearestFlag,
  parseFlags,
  tryParseFlags,
  UnknownFlagError,
  withUnknownFlagAs,
} from './argv'

const decl = declareFlags({
  known: ['ttl', 'note', 'wait', 'json'],
  booleans: ['wait', 'json'],
})

describe('parseFlags', () => {
  it('reads --flag value, --flag=value, booleans and positionals', () => {
    const parsed = parseFlags(['merge:main', '--ttl', '10m', '--note=stuck', '--wait'], decl, {
      usage: 'podium lock acquire',
    })
    expect(parsed.args).toEqual({ ttl: '10m', note: 'stuck', wait: true })
    expect(parsed.positionals).toEqual(['merge:main'])
  })

  it('rejects an undeclared flag, naming the flag as it was typed', () => {
    expect(() => parseFlags(['x', '--ttlx', '1s'], decl, { usage: 'podium lock acquire' })).toThrow(
      UnknownFlagError,
    )
    try {
      parseFlags(['x', '--ttlx', '1s'], decl, { usage: 'podium lock acquire' })
    } catch (err) {
      expect((err as UnknownFlagError).flag).toBe('--ttlx')
      expect((err as UnknownFlagError).message).toContain('unknown flag --ttlx')
    }
  })

  it('points at the nearest declared flag when there is a near miss', () => {
    try {
      parseFlags(['x', '--ttlx', '1s'], decl, { usage: 'podium lock acquire' })
      expect.unreachable('expected an unknown-flag error')
    } catch (err) {
      expect((err as UnknownFlagError).suggestion).toBe('--ttl')
      expect((err as UnknownFlagError).message).toContain('did you mean --ttl?')
      expect((err as UnknownFlagError).message).toContain('podium lock acquire --help')
    }
  })

  it('offers no suggestion when nothing declared is close', () => {
    try {
      parseFlags(['--zaphod'], decl, { usage: 'podium lock acquire' })
      expect.unreachable('expected an unknown-flag error')
    } catch (err) {
      expect((err as UnknownFlagError).suggestion).toBeUndefined()
      expect((err as UnknownFlagError).message).not.toContain('did you mean')
    }
  })

  it('rejects an undeclared flag spelled with = too', () => {
    expect(() => parseFlags(['--ttlx=1s'], decl, { usage: 'podium lock acquire' })).toThrow(
      /unknown flag --ttlx/,
    )
  })

  it('does not let a boolean flag swallow the next token', () => {
    const parsed = parseFlags(['--wait', 'dev/mw'], decl, { usage: 'podium lock acquire' })
    expect(parsed.args).toEqual({ wait: true })
    expect(parsed.positionals).toEqual(['dev/mw'])
  })

  it('camel-cases kebab flags but reports an unknown one in the spelling typed', () => {
    const camel = declareFlags({ known: ['outsideScope'], booleans: ['outsideScope'] })
    expect(parseFlags(['--outside-scope'], camel, { usage: 'podium issue list' }).args).toEqual({
      outsideScope: true,
    })
    try {
      parseFlags(['--outside-scop'], camel, { usage: 'podium issue list' })
      expect.unreachable('expected an unknown-flag error')
    } catch (err) {
      expect((err as UnknownFlagError).flag).toBe('--outside-scop')
      expect((err as UnknownFlagError).suggestion).toBe('--outside-scope')
    }
  })

  it('keeps raw kebab keys when asked, and suggests in that spelling', () => {
    const raw = declareFlags({ known: ['expect-response', 'body'], booleans: ['expect-response'] })
    const parsed = parseFlags(['--expect-response', '--body', 'hi'], raw, {
      usage: 'podium mail send',
      keys: 'raw',
    })
    expect(parsed.args).toEqual({ 'expect-response': true, body: 'hi' })
    try {
      parseFlags(['--expect-respons'], raw, { usage: 'podium mail send', keys: 'raw' })
      expect.unreachable('expected an unknown-flag error')
    } catch (err) {
      expect((err as UnknownFlagError).suggestion).toBe('--expect-response')
    }
  })

  it('records every occurrence in argv order so repeatable flags keep their order', () => {
    const repeat = declareFlags({ known: ['action', 'action-input'], booleans: [] })
    const parsed = parseFlags(
      ['--action', 'Merge::go', '--action-input', 'Send back::why', '--action', 'Hold::wait'],
      repeat,
      { usage: 'podium offer', keys: 'raw' },
    )
    expect(parsed.occurrences.map((o) => `${o.key}=${String(o.value)}`)).toEqual([
      'action=Merge::go',
      'action-input=Send back::why',
      'action=Hold::wait',
    ])
  })

  it('accepts a declared short alias and rejects an undeclared one', () => {
    const shorts = declareFlags({
      known: ['follow'],
      booleans: ['follow'],
      shorts: { f: 'follow' },
    })
    expect(parseFlags(['-f'], shorts, { usage: 'podium logs' }).args).toEqual({ follow: true })
    expect(() => parseFlags(['-x'], shorts, { usage: 'podium logs' })).toThrow(/unknown flag -x/)
  })

  it('leaves a lone dash and a negative number as positionals', () => {
    const shorts = declareFlags({ known: ['follow'], booleans: ['follow'] })
    expect(parseFlags(['-', '-12'], shorts, { usage: 'podium logs' }).positionals).toEqual([
      '-',
      '-12',
    ])
  })
})

describe('flagsFromZodShape', () => {
  const schema = z.strictObject({
    id: z.string(),
    ttl: z.union([z.string(), z.number()]).optional(),
    force: z.boolean().optional(),
    recursive: z.boolean().default(false),
    // The CLI's tri-state spelling: `--pinned`, `--pinned true`, `--pinned=false`.
    pinned: z
      .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
      .optional(),
  })

  it('declares every key in the shape as a flag', () => {
    expect([...flagsFromZodShape(schema).known].sort()).toEqual([
      'force',
      'id',
      'pinned',
      'recursive',
      'ttl',
    ])
  })

  it('classifies boolean-typed keys as value-less, through optional and default wrappers', () => {
    expect([...flagsFromZodShape(schema).booleans].sort()).toEqual(['force', 'recursive'])
  })

  it('does not classify a string-or-number key as a boolean', () => {
    expect(flagsFromZodShape(schema).booleans.has('ttl')).toBe(false)
  })

  it('leaves a key that also accepts "true"/"false" as a VALUE flag', () => {
    // Classifying it value-less would make `--pinned false` mean pinned=true —
    // the flag would set exactly what the author asked it to clear.
    expect(flagsFromZodShape(schema).booleans.has('pinned')).toBe(false)
    const parsed = parseFlags(['--pinned', 'false'], flagsFromZodShape(schema), {
      usage: 'podium issue update',
    })
    expect(parsed.args).toEqual({ pinned: 'false' })
  })

  it('adds the dispatcher-owned global flags it is given', () => {
    const withGlobals = flagsFromZodShape(schema, {
      known: ['json', 'help'],
      booleans: ['json', 'help'],
    })
    expect(withGlobals.known.has('json')).toBe(true)
    expect(withGlobals.booleans.has('help')).toBe(true)
  })
})

describe('nearestFlag', () => {
  it('finds a one-character typo', () => {
    expect(nearestFlag('ttlx', ['ttl', 'note'])).toBe('--ttl')
  })

  it('finds a transposition', () => {
    expect(nearestFlag('brnach', ['branch', 'note'])).toBe('--branch')
  })

  it('returns nothing when the typed flag resembles nothing declared', () => {
    expect(nearestFlag('zaphod', ['ttl', 'note'])).toBeUndefined()
  })

  it('does not suggest a short flag for a long typo', () => {
    expect(nearestFlag('ttlxyz', ['id'])).toBeUndefined()
  })
})

describe('tryParseFlags', () => {
  const spec = declareFlags({ known: ['channel'], booleans: [] })

  it('returns the parse when every flag is declared', () => {
    const r = tryParseFlags(['--channel', 'edge'], spec, { usage: 'podium update' })
    expect(r.error).toBeUndefined()
    expect(r.args).toEqual({ channel: 'edge' })
  })

  it('returns the unknown-flag message instead of throwing, for plan-returning callers', () => {
    const r = tryParseFlags(['--chanel', 'edge'], spec, { usage: 'podium update' })
    expect(r.error).toMatch(/unknown flag --chanel \(did you mean --channel\?\)/)
    expect(r.args).toEqual({})
  })
})

describe('an open declaration', () => {
  it('accepts anything, for the moment before an unknown COMMAND is named', () => {
    // `podium lock bogus --ttl 1m` must be told its command does not exist, not
    // that `--ttl` is an unknown flag on a command that does not exist either.
    const open = declareFlags({ known: [], open: true })
    expect(parseFlags(['--ttl', '1m', '--wait'], open, { usage: 'podium lock' }).args).toEqual({
      ttl: '1m',
      wait: true,
    })
  })
})

describe('flagTable', () => {
  const flagsFor = flagTable(declareFlags({ known: [], booleans: ['json'] }), {
    send: { known: ['to', 'body'], booleans: ['expect-response'] },
    inbox: { known: ['issue'] },
    show: {},
  })

  it('gives each command its own flags plus the shared globals', () => {
    expect([...flagsFor('send').known].sort()).toEqual(['body', 'expect-response', 'json', 'to'])
    expect([...flagsFor('inbox').known].sort()).toEqual(['issue', 'json'])
    expect([...flagsFor('show').known].sort()).toEqual(['json'])
  })

  it('keeps one command’s flags off another', () => {
    expect(() =>
      parseFlags(['--to', 'x'], flagsFor('inbox'), { usage: 'podium mail inbox' }),
    ).toThrow(/unknown flag --to/)
  })

  it('is open for a command it has never heard of, so the COMMAND is what gets named', () => {
    expect(flagsFor('bogus').open).toBe(true)
  })
})

describe('withUnknownFlagAs', () => {
  class ToolError extends Error {}

  it('re-throws an unknown flag as the tool’s own error type, message intact', () => {
    const spec = declareFlags({ known: ['ttl'] })
    try {
      withUnknownFlagAs(
        (m) => new ToolError(m),
        () => parseFlags(['--ttlx', '1s'], spec, { usage: 'podium lock acquire' }),
      )
      expect.unreachable('expected the tool error')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError)
      expect((err as Error).message).toContain('unknown flag --ttlx (did you mean --ttl?)')
    }
  })

  it('lets every other error through untouched', () => {
    const boom = new RangeError('boom')
    expect(() =>
      withUnknownFlagAs(
        (m) => new ToolError(m),
        () => {
          throw boom
        },
      ),
    ).toThrow(boom)
  })
})
