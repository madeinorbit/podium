import { describe, expect, it } from 'vitest'
import {
  describeShape,
  foldSummary,
  formatByteSize,
  inspectJsonDocument,
  withSourceLineEnding,
} from './json-document'

describe('inspectJsonDocument — formatting', () => {
  it('re-indents a minified document two spaces at a time', () => {
    const doc = inspectJsonDocument('{"a":1,"b":[1,2],"c":{"d":null}}')
    expect(doc.fault).toBeNull()
    expect(doc.formatted).toBe(
      [
        '{',
        '  "a": 1,',
        '  "b": [',
        '    1,',
        '    2',
        '  ],',
        '  "c": {',
        '    "d": null',
        '  }',
        '}',
      ].join('\n'),
    )
  })

  it('keeps empty containers on one line', () => {
    expect(inspectJsonDocument('{"a":{},"b":[]}').formatted).toBe(
      ['{', '  "a": {},', '  "b": []', '}'].join('\n'),
    )
  })

  it('copies literals through verbatim — no round trip through JS values', () => {
    // Every one of these changes under JSON.stringify(JSON.parse(x)): the integer
    // exceeds Number's exact range, the trailing zero and the exponent are
    // normalised away, and the escape is rewritten. A formatter that edits values
    // is not one you can safely point at a file you are about to save.
    const source = '{"id":12345678901234567890,"a":1.50,"b":1e3,"s":"\\u00e9 \\/ ok"}'
    const doc = inspectJsonDocument(source)
    expect(doc.formatted).toContain('"id": 12345678901234567890')
    expect(doc.formatted).toContain('"a": 1.50')
    expect(doc.formatted).toContain('"b": 1e3')
    expect(doc.formatted).toContain('"s": "\\u00e9 \\/ ok"')
  })

  it('keeps both halves of a duplicated key', () => {
    expect(inspectJsonDocument('{"a":1,"a":2}').formatted).toBe(
      ['{', '  "a": 1,', '  "a": 2', '}'].join('\n'),
    )
  })

  it('reads a scalar document', () => {
    expect(inspectJsonDocument('"hello"').shape).toEqual({ kind: 'string' })
    expect(inspectJsonDocument('42').shape).toEqual({ kind: 'number' })
    expect(inspectJsonDocument('true').shape).toEqual({ kind: 'boolean' })
    expect(inspectJsonDocument(' null ').shape).toEqual({ kind: 'null' })
  })

  it('counts the members of the root', () => {
    expect(inspectJsonDocument('{"a":1,"b":2}').shape).toEqual({ kind: 'object', count: 2 })
    expect(inspectJsonDocument('[1,2,3]').shape).toEqual({ kind: 'array', count: 3 })
    expect(inspectJsonDocument('[]').shape).toEqual({ kind: 'array', count: 0 })
  })

  it('knows when there is nothing to format', () => {
    expect(inspectJsonDocument('{\n  "a": 1\n}\n').formattedAlready).toBe(true)
    expect(inspectJsonDocument('{"a": 1}').formattedAlready).toBe(false)
  })

  it('preserves the source’s trailing newline when formatting', () => {
    expect(withSourceLineEnding('{"a":1}\n', '{\n  "a": 1\n}')).toBe('{\n  "a": 1\n}\n')
    expect(withSourceLineEnding('{"a":1}', '{\n  "a": 1\n}')).toBe('{\n  "a": 1\n}')
  })
})

describe('inspectJsonDocument — faults', () => {
  it('names an empty file rather than calling it broken', () => {
    expect(inspectJsonDocument('   \n ').fault).toMatchObject({ kind: 'empty' })
    expect(inspectJsonDocument('   \n ').formatted).toBeNull()
  })

  it('names the three near-misses people actually write', () => {
    expect(inspectJsonDocument('{\n  // hi\n  "a": 1\n}').fault).toMatchObject({
      kind: 'comment',
      line: 2,
      column: 3,
    })
    // Reported AT the comma, not at the brace that tripped over it.
    expect(inspectJsonDocument('{"a": 1,}').fault).toMatchObject({
      kind: 'trailing-comma',
      line: 1,
      column: 8,
    })
    expect(inspectJsonDocument('[\n  1,\n]').fault).toMatchObject({
      kind: 'trailing-comma',
      line: 2,
      column: 4,
    })
    expect(inspectJsonDocument("{'a': 1}").fault).toMatchObject({ kind: 'quote' })
  })

  it('points at the line and column where the document goes wrong', () => {
    const fault = inspectJsonDocument('{\n  "a": 1\n  "b": 2\n}').fault
    expect(fault?.kind).toBe('syntax')
    expect(fault?.line).toBe(3)
    expect(fault?.column).toBe(3)
    expect(fault?.message).toContain("','")
  })

  it('rejects the literals JSON does not have', () => {
    expect(inspectJsonDocument('{"a": undefined}').fault?.kind).toBe('syntax')
    expect(inspectJsonDocument('{"a": NaN}').fault?.kind).toBe('syntax')
    expect(inspectJsonDocument('{"a": 01}').fault?.message).toContain('leading zero')
    expect(inspectJsonDocument('{"a": .5}').fault).not.toBeNull()
  })

  it('catches an unclosed string at the quote that opened it', () => {
    const fault = inspectJsonDocument('{"a": "oops}').fault
    expect(fault?.message).toContain('never closed')
    expect(fault?.column).toBe(7)
  })

  it('refuses content after the top-level value', () => {
    expect(inspectJsonDocument('{"a":1} {"b":2}').fault?.message).toContain('after the top-level')
  })

  it('refuses a document that stops mid-value', () => {
    expect(inspectJsonDocument('{"a":').fault).not.toBeNull()
    expect(inspectJsonDocument('[1,2').fault).not.toBeNull()
  })

  it('accepts the whole escape vocabulary and rejects the rest', () => {
    expect(inspectJsonDocument('"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u1A2b"').fault).toBeNull()
    expect(inspectJsonDocument('"\\x41"').fault?.message).toContain('escape')
    expect(inspectJsonDocument('"\\u12"').fault?.message).toContain('hexadecimal')
  })
})

describe('fold summaries', () => {
  it('counts the members of a folded body', () => {
    expect(foldSummary('{', '\n  "a": 1,\n  "b": 2\n')).toBe('2 keys')
    expect(foldSummary('[', '\n  1\n')).toBe('1 item')
    expect(foldSummary('[', '1,2,3,4')).toBe('4 items')
  })

  it('ignores commas that live inside strings or nested containers', () => {
    expect(foldSummary('{', '"a": "x,y,z", "b": [1, 2, 3], "c": {"d": 1, "e": 2}')).toBe('3 keys')
    expect(foldSummary('[', '"a \\", b"')).toBe('1 item')
  })

  it('declines rather than scan a body too large to be worth counting', () => {
    expect(foldSummary('[', `1${',1'.repeat(50_000)}`)).toBeNull()
    expect(foldSummary('{', '   \n  ')).toBeNull()
  })

  it('groups the digits of a long collection', () => {
    expect(foldSummary('[', '1'.repeat(1).concat(',1'.repeat(1233)))).toBe('1,234 items')
  })
})

describe('shape and size wording', () => {
  it('says what the root is', () => {
    expect(describeShape({ kind: 'object', count: 12 })).toBe('Object · 12 keys')
    expect(describeShape({ kind: 'array', count: 1 })).toBe('Array · 1 item')
    expect(describeShape({ kind: 'object', count: 0 })).toBe('Empty object')
    expect(describeShape({ kind: 'number' })).toBe('Number')
  })

  it('sizes a file in the shell’s short form', () => {
    expect(formatByteSize(640)).toBe('640 B')
    expect(formatByteSize(1024)).toBe('1 KB')
    expect(formatByteSize(12_698)).toBe('12.4 KB')
    expect(formatByteSize(2_202_010)).toBe('2.1 MB')
  })
})
