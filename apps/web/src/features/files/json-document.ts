/**
 * JSON, re-indented from its own bytes.
 *
 * The one-liner every formatter reaches for is `JSON.stringify(JSON.parse(text),
 * null, 2)`, and it is the wrong tool for a file the user may then SAVE: the round
 * trip goes through JavaScript's numbers and strings, so `12345678901234567890`
 * comes back as `12345678901234567000`, `1.50` as `1.5`, `1e3` as `1000`, and a
 * duplicate key silently loses its first value. This scanner walks the source and
 * copies every literal through VERBATIM, so the only thing formatting changes is
 * whitespace — the pretty view is the same document, and Format is a safe edit.
 *
 * The scanner is also what reports where invalid JSON goes wrong. Engine parse
 * messages are not portable (V8 appends `at position 42`, JavaScriptCore does
 * not), and none of them name the three mistakes people actually make: a trailing
 * comma, a comment, a single-quoted string. Ours do.
 */

/** What the top-level value turned out to be. */
export type JsonRootKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export interface JsonShape {
  readonly kind: JsonRootKind
  /** Member count — objects and arrays only. */
  readonly count?: number
}

/** Why the document is not JSON. The named kinds are the near-misses worth
 *  wording differently: a `.json` file full of comments is a JSONC file, not a
 *  typo, and saying so is more use than "unexpected token". */
export type JsonFaultKind = 'empty' | 'comment' | 'quote' | 'trailing-comma' | 'syntax'

export interface JsonFault {
  readonly kind: JsonFaultKind
  /** A sentence, already in the shell's voice — safe to render as-is. */
  readonly message: string
  /** Offset into the source, for putting a cursor on it. */
  readonly position: number
  readonly line: number
  readonly column: number
}

export interface JsonDocument {
  /** The pretty rendering, or null when the source is not valid JSON. */
  readonly formatted: string | null
  readonly shape: JsonShape | null
  readonly fault: JsonFault | null
  /** The file already reads exactly as the pretty rendering — nothing to format. */
  readonly formattedAlready: boolean
}

const INDENT = '  '
const SINGLE_QUOTE = 'JSON strings use double quotes, never single quotes.'

class JsonScanFault extends Error {
  constructor(
    readonly kind: JsonFaultKind,
    message: string,
    readonly position: number,
  ) {
    super(message)
    this.name = 'JsonScanFault'
  }
}

/** Read one JSON document, formatted as we go. */
export function inspectJsonDocument(text: string): JsonDocument {
  if (text.trim() === '') {
    return {
      formatted: null,
      shape: null,
      fault: { kind: 'empty', message: 'This file is empty.', position: 0, line: 1, column: 1 },
      formattedAlready: false,
    }
  }
  try {
    const { formatted, shape } = scan(text)
    return { formatted, shape, fault: null, formattedAlready: text.trim() === formatted }
  } catch (cause) {
    if (!(cause instanceof JsonScanFault)) throw cause
    return {
      formatted: null,
      shape: null,
      fault: {
        kind: cause.kind,
        message: cause.message,
        position: cause.position,
        ...lineColumn(text, cause.position),
      },
      formattedAlready: false,
    }
  }
}

/** Apply the source's trailing-newline convention to a formatted rendering, so
 *  formatting a file never silently adds or drops the final newline. */
export function withSourceLineEnding(source: string, formatted: string): string {
  return source.endsWith('\n') ? `${formatted}\n` : formatted
}

function scan(src: string): { formatted: string; shape: JsonShape } {
  let i = 0
  const out: string[] = []

  const fault = (kind: JsonFaultKind, message: string, at: number = i): JsonScanFault =>
    new JsonScanFault(kind, message, Math.min(at, src.length))
  const digit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
  const found = (c: string | undefined): string =>
    c === undefined ? 'the end of the file' : JSON.stringify(c)

  /** Whitespace is also where a comment would sit, which makes this the one place
   *  that can name the JSONC mistake precisely. */
  const skipWs = (): void => {
    for (;;) {
      const c = src[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++
        continue
      }
      if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*'))
        throw fault('comment', 'JSON has no comments.')
      return
    }
  }

  const string = (): string => {
    const start = i
    i++ // opening quote
    for (;;) {
      const c = src[i]
      if (c === undefined || c === '\n')
        throw fault('syntax', 'This string is never closed.', start)
      if (c === '"') {
        i++
        return src.slice(start, i)
      }
      if (c === '\\') {
        const esc = src[i + 1]
        if (esc === undefined) throw fault('syntax', 'This string is never closed.', start)
        if (esc === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6)))
            throw fault('syntax', 'A \\u escape needs four hexadecimal digits after it.')
          i += 6
          continue
        }
        if (!'"\\/bfnrt'.includes(esc))
          throw fault('syntax', `\\${esc} is not an escape JSON knows.`)
        i += 2
        continue
      }
      if (c < ' ') throw fault('syntax', 'A control character inside a string has to be escaped.')
      i++
    }
  }

  const number = (): string => {
    const start = i
    if (src[i] === '-') i++
    if (src[i] === '0') {
      i++
      if (digit(src[i])) throw fault('syntax', 'A number may not carry a leading zero.', start)
    } else if (digit(src[i])) {
      while (digit(src[i])) i++
    } else {
      throw fault('syntax', 'A number needs at least one digit.')
    }
    if (src[i] === '.') {
      i++
      if (!digit(src[i])) throw fault('syntax', 'A decimal point needs a digit after it.')
      while (digit(src[i])) i++
    }
    if (src[i] === 'e' || src[i] === 'E') {
      i++
      if (src[i] === '+' || src[i] === '-') i++
      if (!digit(src[i])) throw fault('syntax', 'An exponent needs at least one digit.')
      while (digit(src[i])) i++
    }
    return src.slice(start, i)
  }

  const keyword = (word: string, kind: JsonRootKind): JsonShape | null => {
    if (!src.startsWith(word, i)) return null
    i += word.length
    out.push(word)
    return { kind }
  }

  const object = (indent: string): JsonShape => {
    const inner = indent + INDENT
    i++ // '{'
    skipWs()
    if (src[i] === '}') {
      i++
      out.push('{}')
      return { kind: 'object', count: 0 }
    }
    out.push('{')
    let count = 0
    // Where the last separator was, so a trailing comma is reported AT the comma
    // rather than at the brace that tripped over it.
    let comma = -1
    for (;;) {
      skipWs()
      if (src[i] === '}')
        throw fault(
          'trailing-comma',
          'A trailing comma promises another key.',
          comma < 0 ? i : comma,
        )
      if (src[i] === "'") throw fault('quote', SINGLE_QUOTE)
      if (src[i] !== '"')
        throw fault('syntax', `An object key is a double-quoted string; found ${found(src[i])}.`)
      out.push(count === 0 ? `\n${inner}` : `,\n${inner}`)
      out.push(string())
      skipWs()
      if (src[i] !== ':') throw fault('syntax', `A key is followed by ':'; found ${found(src[i])}.`)
      i++
      out.push(': ')
      value(inner)
      count++
      skipWs()
      if (src[i] === ',') {
        comma = i
        i++
        continue
      }
      if (src[i] === '}') {
        i++
        out.push(`\n${indent}}`)
        return { kind: 'object', count }
      }
      throw fault('syntax', `This object wants ',' or '}' next; found ${found(src[i])}.`)
    }
  }

  const array = (indent: string): JsonShape => {
    const inner = indent + INDENT
    i++ // '['
    skipWs()
    if (src[i] === ']') {
      i++
      out.push('[]')
      return { kind: 'array', count: 0 }
    }
    out.push('[')
    let count = 0
    let comma = -1
    for (;;) {
      skipWs()
      if (src[i] === ']')
        throw fault(
          'trailing-comma',
          'A trailing comma promises another element.',
          comma < 0 ? i : comma,
        )
      out.push(count === 0 ? `\n${inner}` : `,\n${inner}`)
      value(inner)
      count++
      skipWs()
      if (src[i] === ',') {
        comma = i
        i++
        continue
      }
      if (src[i] === ']') {
        i++
        out.push(`\n${indent}]`)
        return { kind: 'array', count }
      }
      throw fault('syntax', `This array wants ',' or ']' next; found ${found(src[i])}.`)
    }
  }

  function value(indent: string): JsonShape {
    skipWs()
    const c = src[i]
    if (c === '{') return object(indent)
    if (c === '[') return array(indent)
    if (c === '"') {
      out.push(string())
      return { kind: 'string' }
    }
    if (c === '-' || digit(c)) {
      out.push(number())
      return { kind: 'number' }
    }
    const literal =
      keyword('true', 'boolean') ?? keyword('false', 'boolean') ?? keyword('null', 'null')
    if (literal) return literal
    if (c === "'") throw fault('quote', SINGLE_QUOTE)
    throw fault('syntax', `A value should start here; found ${found(c)}.`)
  }

  const shape = value('')
  skipWs()
  if (i < src.length) throw fault('syntax', 'There is more content after the top-level value ends.')
  return { formatted: out.join(''), shape }
}

function lineColumn(src: string, position: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let n = 0; n < position; n++) {
    if (src.charCodeAt(n) === 10) {
      line++
      lineStart = n + 1
    }
  }
  return { line, column: position - lineStart + 1 }
}

/** Counting a folded body means scanning it, so a folded 5MB array would pay for
 *  the summary nobody asked for. Past this, the fold keeps the plain ellipsis. */
const FOLD_SUMMARY_LIMIT = 64 * 1024

/**
 * What a collapsed object or array should say in place of its members. CodeMirror
 * folds the INSIDE of the brackets, so this text lands between a visible `{` and
 * `}` — `{ 12 keys }` — and `opener` is the character just before the fold.
 */
export function foldSummary(opener: string, body: string): string | null {
  if (body.length > FOLD_SUMMARY_LIMIT) return null
  let depth = 0
  let separators = 0
  let inString = false
  let hasContent = false
  for (let n = 0; n < body.length; n++) {
    const c = body[n]
    if (inString) {
      if (c === '\\') n++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      hasContent = true
    } else if (c === '{' || c === '[') {
      depth++
      hasContent = true
    } else if (c === '}' || c === ']') {
      depth--
    } else if (c === ',' && depth === 0) {
      separators++
    } else if (c !== ' ' && c !== '\n' && c !== '\t' && c !== '\r') {
      hasContent = true
    }
  }
  if (!hasContent) return null
  const count = separators + 1
  return `${groupDigits(count)} ${memberNoun(opener, count)}`
}

/**
 * The fold placeholder for one collapsed range, read straight off the editor's
 * document. Takes the doc structurally so this module stays free of CodeMirror,
 * and checks the range's LENGTH before slicing — a folded 5MB array should not
 * allocate 5MB to decide the summary is too expensive to compute.
 */
export function foldPlaceholderText(
  doc: { sliceString(from: number, to: number): string },
  from: number,
  to: number,
): string | null {
  if (to - from > FOLD_SUMMARY_LIMIT) return null
  return foldSummary(doc.sliceString(Math.max(0, from - 1), from), doc.sliceString(from, to))
}

/** `12 keys` / `1 item` — the words the shape strip and the fold placeholder share. */
export function describeShape(shape: JsonShape): string {
  if (shape.kind === 'object' || shape.kind === 'array') {
    const count = shape.count ?? 0
    const noun = memberNoun(shape.kind === 'object' ? '{' : '[', count)
    const head = shape.kind === 'object' ? 'Object' : 'Array'
    return count === 0 ? `Empty ${head.toLowerCase()}` : `${head} · ${groupDigits(count)} ${noun}`
  }
  return { string: 'String', number: 'Number', boolean: 'Boolean', null: 'Null' }[shape.kind]
}

function memberNoun(opener: string, count: number): string {
  const one = opener === '{' ? 'key' : 'item'
  return count === 1 ? one : `${one}s`
}

/** Thousands separators without a locale in the loop — the same string everywhere. */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Byte size in the shell's short form: `640 B`, `12.4 KB`, `2.1 MB`. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${round1(bytes / 1024)} KB`
  return `${round1(bytes / (1024 * 1024))} MB`
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString()
}
