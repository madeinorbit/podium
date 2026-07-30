/**
 * Convert superagent markdown to Telegram MarkdownV2 [spec:SP-5d81].
 * Ported from Hermes gateway/platforms/telegram.py (format_message pipeline).
 */

/** Characters MarkdownV2 requires escaped outside code spans. */
const MDV2_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g

export function escapeTelegramMarkdownV2(text: string): string {
  return text.replace(MDV2_ESCAPE_RE, '\\$1')
}

/** Strip MarkdownV2 escapes and formatting markers for plain-text fallback. */
export function stripTelegramMarkdownV2(text: string): string {
  let cleaned = text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1')
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1')
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1')
  cleaned = cleaned.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
  cleaned = cleaned.replace(/~([^~]+)~/g, '$1')
  cleaned = cleaned.replace(/\|\|([^|]+)\|\|/g, '$1')
  return cleaned
}

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$/

function isTableRow(line: string): boolean {
  const stripped = line.trim()
  return Boolean(stripped) && stripped.includes('|')
}

function splitMarkdownTableRow(line: string): string[] {
  let stripped = line.trim()
  if (stripped.startsWith('|')) stripped = stripped.slice(1)
  if (stripped.endsWith('|')) stripped = stripped.slice(0, -1)
  return stripped.split('|').map((cell) => cell.trim())
}

function renderTableBlockForTelegram(tableBlock: string[]): string {
  if (tableBlock.length < 3) return tableBlock.join('\n')

  const headers = splitMarkdownTableRow(tableBlock[0]!)
  if (headers.length < 2) return tableBlock.join('\n')

  const firstDataRow =
    tableBlock.length > 2 ? splitMarkdownTableRow(tableBlock[2]!) : []
  const hasRowLabelCol = firstDataRow.length === headers.length + 1

  const renderedGroups: string[] = []
  for (let index = 0; index < tableBlock.length - 2; index++) {
    const row = tableBlock[index + 2]!
    const cells = splitMarkdownTableRow(row)
    let heading: string
    let dataCells: string[]
    if (hasRowLabelCol) {
      heading = cells[0] && cells[0] !== '' ? cells[0]! : `Row ${index + 1}`
      dataCells = cells.slice(1)
    } else {
      heading = cells.find((cell) => cell !== '') ?? `Row ${index + 1}`
      dataCells = [...cells]
    }

    if (dataCells.length < headers.length) {
      dataCells.push(...Array(headers.length - dataCells.length).fill(''))
    } else if (dataCells.length > headers.length) {
      dataCells = dataCells.slice(0, headers.length)
    }

    const bullets: string[] = []
    for (let h = 0; h < headers.length; h++) {
      const header = headers[h]!
      const value = dataCells[h] ?? ''
      if (!hasRowLabelCol && value === heading) continue
      bullets.push(`• ${header}: ${value}`)
    }

    renderedGroups.push([`**${heading}**`, ...bullets].join('\n'))
  }

  return renderedGroups.join('\n\n')
}

/** Rewrite GFM pipe tables into Telegram-friendly row groups. */
export function wrapMarkdownTables(text: string): string {
  if (!text.includes('|') || !text.includes('-')) return text

  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const stripped = line.trimStart()

    if (stripped.startsWith('```')) {
      inFence = !inFence
      out.push(line)
      i++
      continue
    }
    if (inFence) {
      out.push(line)
      i++
      continue
    }

    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR_RE.test(lines[i + 1]!)
    ) {
      const tableBlock = [line, lines[i + 1]!]
      let j = i + 2
      while (j < lines.length && isTableRow(lines[j]!)) {
        tableBlock.push(lines[j]!)
        j++
      }
      out.push(renderTableBlockForTelegram(tableBlock))
      i = j
      continue
    }

    out.push(line)
    i++
  }

  return out.join('\n')
}

/** Convert standard markdown to Telegram MarkdownV2. */
export function formatTelegramMarkdown(content: string): string {
  if (!content) return content

  const placeholders: Record<string, string> = {}
  let counter = 0

  const ph = (value: string): string => {
    const key = `\x00PH${counter}\x00`
    counter++
    placeholders[key] = value
    return key
  }

  let text = wrapMarkdownTables(content)

  text = text.replace(/(```(?:[^\n]*\n)?[\s\S]*?```)/g, (raw) => {
    const openEnd = raw.indexOf('\n', 3) >= 0 ? raw.indexOf('\n') + 1 : 3
    const opening = raw.slice(0, openEnd)
    const body = raw.slice(openEnd, -3)
    return ph(opening + body.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '```')
  })

  text = text.replace(/(`[^`]+`)/g, (m) => ph(m.replace(/\\/g, '\\\\')))

  text = text.replace(
    /\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
    (_m, display: string, url: string) => {
      const escapedDisplay = escapeTelegramMarkdownV2(display)
      const escapedUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)')
      return ph(`[${escapedDisplay}](${escapedUrl})`)
    },
  )

  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, inner: string) => {
    const cleaned = inner.trim().replace(/\*\*(.+?)\*\*/g, '$1')
    return ph(`*${escapeTelegramMarkdownV2(cleaned)}*`)
  })

  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner: string) =>
    ph(`*${escapeTelegramMarkdownV2(inner)}*`),
  )

  text = text.replace(/\*([^*\n]+)\*/g, (_m, inner: string) =>
    ph(`_${escapeTelegramMarkdownV2(inner)}_`),
  )

  text = text.replace(/~~(.+?)~~/g, (_m, inner: string) =>
    ph(`~${escapeTelegramMarkdownV2(inner)}~`),
  )

  text = text.replace(/\|\|(.+?)\|\|/g, (_m, inner: string) =>
    ph(`||${escapeTelegramMarkdownV2(inner)}||`),
  )

  text = text.replace(/^((?:\*\*)?>{1,3}) (.+)$/gm, (_m, prefix: string, body: string) => {
    if (prefix.startsWith('**') && body.endsWith('||')) {
      return ph(`${prefix} ${escapeTelegramMarkdownV2(body.slice(0, -2))}||`)
    }
    return ph(`${prefix} ${escapeTelegramMarkdownV2(body)}`)
  })

  text = escapeTelegramMarkdownV2(text)

  for (const key of Object.keys(placeholders).reverse()) {
    text = text.replace(key, placeholders[key]!)
  }

  const codeSplit = text.split(/(```[\s\S]*?```|`[^`]+`)/)
  const safeParts: string[] = []
  for (let idx = 0; idx < codeSplit.length; idx++) {
    const seg = codeSplit[idx]!
    if (idx % 2 === 1) {
      safeParts.push(seg)
      continue
    }
    safeParts.push(
      seg.replace(/[(){}]/g, (ch, offset) => {
        if (offset > 0 && seg[offset - 1] === '\\') return ch
        if (ch === '(' && offset > 0 && seg[offset - 1] === ']') return ch
        if (ch === ')') {
          const before = seg.slice(0, offset)
          if (before.includes('](http') || before.includes('](')) {
            let depth = 0
            for (let j = offset - 1; j >= Math.max(offset - 2000, 0); j--) {
              if (seg[j] === '(') {
                depth--
                if (depth < 0) {
                  if (j > 0 && seg[j - 1] === ']') return ch
                  break
                }
              } else if (seg[j] === ')') {
                depth++
              }
            }
          }
        }
        return '\\' + ch
      }),
    )
  }
  return safeParts.join('')
}

/** Escape chunk counter suffix ` (n/m)` for MarkdownV2. */
export function escapeChunkCounterSuffix(chunk: string): string {
  return chunk.replace(/ \((\d+)\/(\d+)\)$/, ' \\($1/$2\\)')
}

/** True when a Telegram API error is a MarkdownV2 parse failure. */
export function isTelegramMarkdownParseError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err && 'description' in err
        ? String((err as { description: unknown }).description)
        : String(err)
  const lower = message.toLowerCase()
  const status =
    err instanceof Error && 'status' in err
      ? (err as Error & { status?: number }).status
      : undefined
  return (
    (status === 400 || lower.includes("can't parse")) &&
    (lower.includes('parse') || lower.includes('markdown'))
  )
}