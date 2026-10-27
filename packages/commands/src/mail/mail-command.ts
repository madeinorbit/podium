/**
 * MAIL AN AGENT SENT, READ BACK OUT OF ITS OWN SHELL [POD-2146].
 *
 * An agent mails with the CLI, so its chat holds `podium mail send …` as a
 * shell command. This module recognises the three commands a mail card is
 * built from — a send, a reply and an inbox read — and the lines the CLI
 * prints for them. One pure copy, so the client compute path and any adapter
 * read commands the same way.
 *
 * The command is matched as the command that RUNS: `echo 'podium mail send'`,
 * a grep for it, or a send chained with other work stay ordinary shell rows. A
 * leading `cd <dir> &&` is allowed; the body is never parsed for the card (a
 * heredoc or `$(cat …)` would defeat that), only its first line as a preview
 * when it is a plain literal. The card fetches the real body by id.
 */

export type MailCommand =
  | {
      op: 'send'
      /** The recipient as a principal label (`issue:POD-12`, `session:<id>`). */
      to: string
      /** First line of a literal `--body`, for the folded card. */
      preview?: string
    }
  | { op: 'reply'; replyTo: string; preview?: string }
  | { op: 'inbox' }

interface Word {
  text: string
  /** Built from `$(…)`, backticks or `$VAR`: its text is not what ran. */
  dynamic: boolean
}

type Separator = '&&' | '||' | ';' | '|' | '&' | '\n'

/** Split `command` into simple commands of words, the way a shell would far
 *  enough to tell them apart. Null for anything it cannot follow (an open
 *  quote). A heredoc's body ends the scan: it is input, not commands. */
function simpleCommands(command: string): { words: Word[]; sep?: Separator }[] | null {
  const out: { words: Word[]; sep?: Separator }[] = []
  let words: Word[] = []
  let word: Word | null = null
  let heredoc = false
  const push = (): void => {
    if (word) words.push(word)
    word = null
  }
  const cut = (sep: Separator): void => {
    push()
    out.push({ words, sep })
    words = []
  }
  const at = (): Word => {
    word ??= { text: '', dynamic: false }
    return word
  }
  /** The end of a `$(…)` opened at `i`, quotes inside it included. */
  const closeParen = (i: number): number => {
    let depth = 0
    for (let j = i; j < command.length; j++) {
      const c = command[j]
      if (c === '\\') j++
      else if (c === "'") {
        j = command.indexOf("'", j + 1)
        if (j < 0) return -1
      } else if (c === '(') depth++
      else if (c === ')' && --depth === 0) return j
    }
    return -1
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    const next = command[i + 1]
    if (c === ' ' || c === '\t') push()
    else if (c === '\\') {
      if (next === '\n') i++
      else if (next !== undefined) {
        at().text += next
        i++
      }
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return null
      at().text += command.slice(i + 1, end)
      i = end
    } else if (c === '"') {
      const w = at()
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]
        if (d === '\\' && j + 1 < command.length) w.text += command[++j]
        else if (d === '$' && command[j + 1] === '(') {
          const end = closeParen(j + 1)
          if (end < 0) return null
          w.dynamic = true
          j = end
        } else {
          if (d === '$' || d === '`') w.dynamic = true
          w.text += d
        }
      }
      if (j >= command.length) return null
      i = j
    } else if (c === '$' && next === '(') {
      const end = closeParen(i + 1)
      if (end < 0) return null
      at().dynamic = true
      i = end
    } else if (c === '\n') {
      if (heredoc) {
        push()
        break
      }
      cut('\n')
    } else if ((c === '&' || c === '|') && next === c) {
      cut(c === '&' ? '&&' : '||')
      i++
    } else if (
      c === ';' ||
      c === '|' ||
      (c === '&' && !/[<>]$/.test((word as Word | null)?.text ?? ''))
    ) {
      cut(c as Separator)
    } else {
      if (c === '<' && next === '<') heredoc = true
      if (c === '$' || c === '`') at().dynamic = true
      at().text += c
    }
  }
  push()
  out.push({ words })
  return out.filter((segment) => segment.words.length > 0)
}

/** Flags that never take a value, across `podium mail` and `podium issue mail`. */
const BOOLEAN_FLAGS = new Set(['json', 'outside-scope', 'help', 'expect-response'])

function readArgs(words: Word[]): { flags: Map<string, Word>; positionals: Word[] } {
  const flags = new Map<string, Word>()
  const positionals: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Word
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(w.text)
    if (!m?.[1]) {
      positionals.push(w)
      continue
    }
    if (m[2] !== undefined) flags.set(m[1], { text: m[2], dynamic: w.dynamic })
    else if (BOOLEAN_FLAGS.has(m[1])) flags.set(m[1], { text: '', dynamic: false })
    else {
      const value = words[++i]
      if (value) flags.set(m[1], value)
    }
  }
  return { flags, positionals }
}

const PREVIEW_MAX = 140

function preview(body: Word | undefined): string | undefined {
  if (!body || body.dynamic) return undefined
  const line = body.text
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.replace(/\s+/g, ' ')
    .trim()
  if (!line) return undefined
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line
}

/** The recipient a `--to` names, as the server labels principals: an issue ref
 *  or `#seq` is `issue:…`, anything else a session id. */
export function mailRecipientLabel(to: string): string {
  if (/^[A-Za-z]{2,5}-\d+$/.test(to)) return `issue:${to.toUpperCase()}`
  if (/^#\d+$/.test(to)) return `issue:${to}`
  return /^[a-z]+:/.test(to) ? to : `session:${to}`
}

/** What a shell command does with Podium mail, or null when it is not one of
 *  the mail commands a card is built from. */
export function classifyMailCommand(command: string): MailCommand | null {
  const segments = simpleCommands(command)
  if (!segments || segments.length === 0) return null
  const last = segments[segments.length - 1] as { words: Word[] }
  // Only `cd <dir> &&` may come first; anything else is other work too.
  for (const segment of segments.slice(0, -1)) {
    if (segment.sep !== '&&' || segment.words.length !== 2 || segment.words[0]?.text !== 'cd')
      return null
  }
  const [bin, ...rest] = last.words.map((w) => w.text)
  if (!bin || !/^(?:\S*\/)?podium$/.test(bin)) return null
  const issue = rest[0] === 'issue'
  if (rest[issue ? 1 : 0] !== 'mail') return null
  const sub = rest[issue ? 2 : 1]
  const { flags, positionals } = readArgs(last.words.slice(issue ? 4 : 3))
  if (flags.has('help')) return null
  const body = preview(flags.get('body'))
  const withPreview = body ? { preview: body } : {}
  switch (sub) {
    case 'send': {
      const to = issue ? positionals[0] : flags.get('to')
      if (!to || to.dynamic || to.text === '') return null
      return { op: 'send', to: mailRecipientLabel(to.text), ...withPreview }
    }
    case 'reply': {
      const id = positionals[0]
      if (issue || !id || id.dynamic || !/^msg_\S+$/i.test(id.text)) return null
      return { op: 'reply', replyTo: id.text, ...withPreview }
    }
    case 'inbox':
      return { op: 'inbox' }
    default:
      return null
  }
}

/** The message a send or reply created, from what the CLI printed: its id and,
 *  when the line names one, the recipient's label. */
export function parseMailSent(output: string): { id: string; to?: string } | null {
  const json = /^\s*\{/.test(output) ? jsonData(output) : undefined
  if (json && typeof json === 'object' && 'id' in json && typeof json.id === 'string') {
    return { id: json.id, ...('to' in json && typeof json.to === 'string' ? { to: json.to } : {}) }
  }
  const mail = /^(?:sent|replied) (msg_\S+)(?: to (\S+))?/im.exec(output)
  if (mail?.[1]) return { id: mail[1], ...(mail[2] ? { to: mail[2] } : {}) }
  const issue = /^mail (?:DELIVERED to|QUEUED for) (\S+) \((msg_[^)\s]+)\)/im.exec(output)
  if (issue?.[1] && issue[2]) return { id: issue[2], to: mailRecipientLabel(issue[1]) }
  return null
}

/** How many notes an inbox read printed, or undefined when its output is not
 *  an inbox listing. */
export function countInboxNotes(output: string): number | undefined {
  const json = /^\s*\{/.test(output) ? jsonData(output) : undefined
  if (Array.isArray(json)) return json.length
  const text = output.trim()
  if (text === '(no messages)' || text === '(no mail)') return 0
  // `podium mail inbox`: "<id> <from> -> <to>"; `podium issue mail inbox`:
  // "* <id> <from> <at>" (a star for unread), the body indented below it.
  const rows = text.match(/^(?:msg_\S+ \S+ -> \S+|[* ] msg_\S+ \S+ \d{4}-\d\d-\d\dT\S+)/gim)
  return rows ? rows.length : undefined
}

function jsonData(output: string): unknown {
  try {
    const parsed: unknown = JSON.parse(output)
    return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : undefined
  } catch {
    return undefined
  }
}
