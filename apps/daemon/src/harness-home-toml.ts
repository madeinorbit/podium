/**
 * The `toml-array-entry` home edit's text work (harness-session-posture §4.7):
 * append one string to an array in a TOML file the harness owns, and change
 * nothing else. Every other line, comment and blank line stays as it was.
 *
 * Not a TOML parser. A scanner that knows enough of the grammar to tell where
 * each table header and each key/value starts and ends, so an insertion lands
 * between statements or between array items, never inside a string or a
 * multi-line value. Anything it does not recognise ends the edit with a reason
 * and the file untouched: a user's config is never rewritten on a guess.
 */

/** The new body, `next: undefined` when the array already holds the value, or why it cannot be added. */
export type TomlPlan = { next: string | undefined } | { reason: string }

/**
 * The body with `value` appended to the array at `path` (a table path, then
 * the key: `['permission', 'allow']`). A missing key is added right after its
 * table's header; a missing table is added at the end of the file.
 */
export function planTomlArrayEntry(body: string, path: readonly string[], value: string): TomlPlan {
  if (path.length < 2) {
    return { reason: 'a toml-array-entry edit needs a table and a key; refusing to edit the root' }
  }
  const scanned = scanOrReason(body)
  if ('reason' in scanned) return scanned
  const statements = scanned.statements
  const table = path.slice(0, -1)
  const key = path[path.length - 1] as string
  const nl = body.includes('\r\n') ? '\r\n' : '\n'
  const item = tomlBasicString(value)

  const target = statements.find((s) => s.kind === 'pair' && samePath(s.path, path))
  if (target?.kind === 'pair') {
    if (target.value.kind !== 'array') {
      return { reason: `${dottedKey(path)} is not an array; left the file untouched` }
    }
    if (target.value.items.some((entry) => entry.text === value)) return { next: undefined }
    return { next: insertIntoArray(body, target.value, item, nl) }
  }

  // The table must be one a `[table]` header may open: not a value, not an
  // array of tables, and not already made by a dotted key outside it. And the
  // key must not already be a table of its own.
  for (const s of statements) {
    const conflict =
      (s.kind === 'pair' && isPrefix(s.path, table)) ||
      (s.kind === 'pair' && s.table.length < table.length && isPrefix(table, s.path)) ||
      (s.kind === 'array-header' && isPrefix(s.path, table)) ||
      isPrefix(path, s.path)
    if (conflict) {
      return {
        reason: `${dottedKey(table)} is written in a form this edit does not change (${dottedKey(s.path)}); left the file untouched`,
      }
    }
  }

  const line = `${dottedKey([key])} = [${item}]`
  const header = statements.find(
    (s): s is Extract<Statement, { kind: 'header' | 'array-header' }> =>
      s.kind === 'header' && samePath(s.path, table),
  )
  if (header) {
    const before = body.slice(0, header.lineEnd)
    const sep = before.endsWith('\n') ? '' : nl
    return { next: `${before}${sep}${line}${nl}${body.slice(header.lineEnd)}` }
  }
  const sep = body.length === 0 ? '' : body.endsWith('\n') ? nl : nl + nl
  return { next: `${body}${sep}[${dottedKey(table)}]${nl}${line}${nl}` }
}

/** Whether the array at `path` holds `value`. False for a body this scanner cannot read. */
export function tomlArrayHolds(body: string, path: readonly string[], value: string): boolean {
  const scanned = scanOrReason(body)
  if ('reason' in scanned) return false
  return scanned.statements.some(
    (s) =>
      s.kind === 'pair' &&
      samePath(s.path, path) &&
      s.value.kind === 'array' &&
      s.value.items.some((entry) => entry.text === value),
  )
}

/**
 * A TOML basic string. `"` and `\` are escaped, and so is every control
 * character TOML does not allow raw; everything else stays as it is.
 */
export function tomlBasicString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\t') out += '\\t'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f)
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

interface ArrayValue {
  kind: 'array'
  /** Offsets of `[` and `]`. */
  open: number
  close: number
  /** Each item's span; `text` is a one-line string item's decoded value. */
  items: { start: number; end: number; text: string | undefined }[]
  /** Offset of a comma after the last item, when there is one. */
  trailingComma: number | undefined
}

type Value = ArrayValue | { kind: 'string'; text: string } | { kind: 'other' }

type Statement =
  /** `[table]` or `[[table]]`; `lineEnd` is just past its line. */
  | { kind: 'header' | 'array-header'; path: string[]; lineEnd: number }
  /** `key = value`, with the key's full path and the table it sits in. */
  | { kind: 'pair'; path: string[]; table: string[]; value: Value }

class TomlScanError extends Error {}

function scanOrReason(body: string): { statements: Statement[] } | { reason: string } {
  try {
    return { statements: new Scanner(body).document() }
  } catch (err) {
    if (err instanceof TomlScanError) {
      return { reason: `not TOML this edit can read (${err.message}); left the file untouched` }
    }
    throw err
  }
}

class Scanner {
  private pos = 0

  constructor(private readonly src: string) {}

  document(): Statement[] {
    const out: Statement[] = []
    let table: string[] = []
    for (;;) {
      this.skipBlank()
      if (this.pos >= this.src.length) return out
      if (this.src.startsWith('[[', this.pos)) {
        this.pos += 2
        table = this.headerKey(']]')
        out.push({ kind: 'array-header', path: table, lineEnd: this.pos })
      } else if (this.src[this.pos] === '[') {
        this.pos += 1
        table = this.headerKey(']')
        out.push({ kind: 'header', path: table, lineEnd: this.pos })
      } else {
        const key = this.key()
        this.skipSpaces()
        this.expect('=')
        this.skipSpaces()
        const value = this.value()
        this.endLine()
        out.push({ kind: 'pair', path: [...table, ...key], table, value })
      }
    }
  }

  private headerKey(close: string): string[] {
    this.skipSpaces()
    const path = this.key()
    this.skipSpaces()
    this.expect(close)
    this.endLine()
    return path
  }

  /** A dotted key: bare or quoted parts joined by dots. */
  private key(): string[] {
    const parts = [this.keyPart()]
    for (;;) {
      const save = this.pos
      this.skipSpaces()
      if (this.src[this.pos] !== '.') {
        this.pos = save
        return parts
      }
      this.pos += 1
      this.skipSpaces()
      parts.push(this.keyPart())
    }
  }

  private keyPart(): string {
    const c = this.src[this.pos]
    if (c === '"' && !this.src.startsWith('"""', this.pos)) return this.basicString()
    if (c === "'" && !this.src.startsWith("'''", this.pos)) return this.literalString()
    const bare = /[A-Za-z0-9_-]+/y
    bare.lastIndex = this.pos
    const match = bare.exec(this.src)
    if (!match) this.fail('expected a key')
    this.pos += match[0].length
    return match[0]
  }

  private value(): Value {
    const c = this.src[this.pos]
    if (this.src.startsWith('"""', this.pos)) return this.multiline('"""')
    if (this.src.startsWith("'''", this.pos)) return this.multiline("'''")
    if (c === '"') return { kind: 'string', text: this.basicString() }
    if (c === "'") return { kind: 'string', text: this.literalString() }
    if (c === '[') return this.array()
    if (c === '{') return this.inlineTable()
    return this.bare()
  }

  private array(): ArrayValue {
    const open = this.pos
    this.pos += 1
    const items: ArrayValue['items'] = []
    let trailingComma: number | undefined
    for (;;) {
      this.skipBlank()
      if (this.src[this.pos] === ']') {
        const close = this.pos
        this.pos += 1
        return { kind: 'array', open, close, items, trailingComma }
      }
      const start = this.pos
      const item = this.value()
      items.push({ start, end: this.pos, text: item.kind === 'string' ? item.text : undefined })
      trailingComma = undefined
      this.skipBlank()
      if (this.src[this.pos] === ',') {
        trailingComma = this.pos
        this.pos += 1
      } else if (this.src[this.pos] !== ']') {
        this.fail('expected , or ] in an array')
      }
    }
  }

  private inlineTable(): Value {
    this.pos += 1
    for (;;) {
      this.skipBlank()
      if (this.src[this.pos] === '}') {
        this.pos += 1
        return { kind: 'other' }
      }
      this.key()
      this.skipSpaces()
      this.expect('=')
      this.skipSpaces()
      this.value()
      this.skipBlank()
      if (this.src[this.pos] === ',') this.pos += 1
      else if (this.src[this.pos] !== '}') this.fail('expected , or } in an inline table')
    }
  }

  /** A number, boolean or date: everything up to the next separator. */
  private bare(): Value {
    const token = /[A-Za-z0-9_+\-.:]+/y
    token.lastIndex = this.pos
    const match = token.exec(this.src)
    if (!match) this.fail('expected a value')
    this.pos += match[0].length
    // A date and a time may be separated by a space: `1979-05-27 07:32:00Z`.
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(match[0]) &&
      /^ \d/.test(this.src.slice(this.pos, this.pos + 2))
    ) {
      this.pos += 1
      return this.bare()
    }
    return { kind: 'other' }
  }

  private basicString(): string {
    this.pos += 1
    let out = ''
    for (;;) {
      const c = this.src[this.pos]
      if (c === undefined || c === '\n' || c === '\r') this.fail('unterminated string')
      if (c === '"') {
        this.pos += 1
        return out
      }
      if (c === '\\') out += this.escape()
      else {
        out += c
        this.pos += 1
      }
    }
  }

  private escape(): string {
    const c = this.src[this.pos + 1]
    this.pos += 2
    switch (c) {
      case 'b':
        return '\b'
      case 't':
        return '\t'
      case 'n':
        return '\n'
      case 'f':
        return '\f'
      case 'r':
        return '\r'
      case 'e':
        return '\x1b'
      case '"':
        return '"'
      case '\\':
        return '\\'
      case 'x':
        return this.hex(2)
      case 'u':
        return this.hex(4)
      case 'U':
        return this.hex(8)
      default:
        return this.fail('unknown escape in a string')
    }
  }

  private hex(digits: number): string {
    const text = this.src.slice(this.pos, this.pos + digits)
    const code = Number.parseInt(text, 16)
    if (!/^[0-9A-Fa-f]+$/.test(text) || text.length !== digits || code > 0x10ffff) {
      this.fail('bad escape in a string')
    }
    this.pos += digits
    return String.fromCodePoint(code)
  }

  private literalString(): string {
    const end = this.src.indexOf("'", this.pos + 1)
    const text = end < 0 ? undefined : this.src.slice(this.pos + 1, end)
    if (text === undefined || /[\r\n]/.test(text)) this.fail('unterminated string')
    this.pos = end + 1
    return text
  }

  /** A multi-line string, skipped whole. Up to two more quotes may close it. */
  private multiline(quotes: '"""' | "'''"): Value {
    this.pos += 3
    for (;;) {
      if (this.pos >= this.src.length) this.fail('unterminated multi-line string')
      if (quotes === '"""' && this.src[this.pos] === '\\') {
        this.pos += 2
        continue
      }
      if (this.src.startsWith(quotes, this.pos)) {
        this.pos += 3
        for (let extra = 0; extra < 2 && this.src[this.pos] === quotes[0]; extra++) this.pos += 1
        return { kind: 'other' }
      }
      this.pos += 1
    }
  }

  private skipSpaces(): void {
    while (this.src[this.pos] === ' ' || this.src[this.pos] === '\t') this.pos += 1
  }

  private skipComment(): void {
    if (this.src[this.pos] !== '#') return
    while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1
  }

  /** Spaces, comments and newlines: between statements, array items and inline-table pairs. */
  private skipBlank(): void {
    for (;;) {
      this.skipSpaces()
      this.skipComment()
      if (this.src.startsWith('\r\n', this.pos)) this.pos += 2
      else if (this.src[this.pos] === '\n') this.pos += 1
      else return
    }
  }

  /** The end of a statement: spaces, an optional comment, then a newline or the end. */
  private endLine(): void {
    this.skipSpaces()
    this.skipComment()
    if (this.src.startsWith('\r\n', this.pos)) this.pos += 2
    else if (this.src[this.pos] === '\n') this.pos += 1
    else if (this.pos < this.src.length) this.fail('expected the end of the line')
  }

  private expect(text: string): void {
    if (!this.src.startsWith(text, this.pos)) this.fail(`expected ${text}`)
    this.pos += text.length
  }

  private fail(what: string): never {
    const line = this.src.slice(0, this.pos).split('\n').length
    throw new TomlScanError(`${what} on line ${line}`)
  }
}

/**
 * Append `item` as the array's last item, in the array's own layout: on one
 * line, after the last item; across lines, on a line of its own before the
 * closing bracket, indented like the last item. A trailing comma is kept if
 * the array had one, and a comment after the last item stays where it is.
 */
function insertIntoArray(body: string, array: ArrayValue, item: string, nl: string): string {
  const last = array.items[array.items.length - 1]
  const comma = array.trailingComma
  const splice = (at: number, text: string, from: string = body) =>
    `${from.slice(0, at)}${text}${from.slice(at)}`

  if (!last && !/[\r\n]/.test(body.slice(array.open, array.close))) {
    return `${body.slice(0, array.open)}[${item}]${body.slice(array.close + 1)}`
  }
  const closeLine = body.lastIndexOf('\n', array.close - 1) + 1
  const closeAlone = closeLine > array.open && /^[ \t]*$/.test(body.slice(closeLine, array.close))
  if (!closeAlone) {
    if (!last) return splice(array.open + 1, item)
    return comma === undefined ? splice(last.end, `, ${item}`) : splice(comma + 1, ` ${item},`)
  }
  const indent = last ? leadingSpace(body, last.start) : `${leadingSpace(body, array.close)}  `
  const line = `${indent}${item}${comma !== undefined ? ',' : ''}${nl}`
  const withLine = splice(closeLine, line)
  return last && comma === undefined ? splice(last.end, ',', withLine) : withLine
}

/** The spaces and tabs that start the line holding `offset`. */
function leadingSpace(body: string, offset: number): string {
  const start = body.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(body.slice(start))?.[0] ?? ''
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i])
}

/** Whether `prefix` is `path` or a leading part of it. */
function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, i) => part === path[i])
}

/** A key path as TOML writes it: bare parts where allowed, quoted otherwise. */
function dottedKey(path: readonly string[]): string {
  return path
    .map((part) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : tomlBasicString(part)))
    .join('.')
}
