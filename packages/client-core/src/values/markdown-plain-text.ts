import { marked, type Token, type Tokens } from 'marked'

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}
function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (raw, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw
    }
    return entities[entity] ?? raw
  })
}

function inline(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'html':
          return ''
        case 'br':
          return '\n'
        case 'codespan':
          return (token as Tokens.Codespan).text
        case 'image':
          return decode((token as Tokens.Image).text)
        default:
          return 'tokens' in token && token.tokens
            ? inline(token.tokens)
            : 'text' in token
              ? decode(token.text)
              : ''
      }
    })
    .join('')
}

function blocks(tokens: readonly Token[]): string {
  return tokens
    .map((token): string => {
      switch (token.type) {
        case 'space':
        case 'html':
        case 'def':
        case 'hr':
          return ''
        case 'code':
          return (token as Tokens.Code).text
        case 'blockquote':
          return blocks((token as Tokens.Blockquote).tokens)
        case 'list': {
          const list = token as Tokens.List
          return list.items
            .map((item, index) => {
              const marker = item.task
                ? item.checked
                  ? '☑'
                  : '☐'
                : list.ordered
                  ? `${Number(list.start) + index}.`
                  : '•'
              return `${marker} ${blocks(item.tokens).replace(/\n/g, '\n  ')}`
            })
            .join('\n')
        }
        case 'table': {
          const table = token as Tokens.Table
          return [table.header, ...table.rows]
            .map((row) => row.map((cell) => inline(cell.tokens)).join('\t'))
            .join('\n')
        }
        default:
          return 'tokens' in token && token.tokens
            ? inline(token.tokens)
            : 'text' in token
              ? decode(token.text)
              : ''
      }
    })
    .filter(Boolean)
    .join('\n\n')
}

/** Render the readable words for native selection and quotes, preserving code. */
export function markdownPlainText(markdown: string): string {
  return blocks(marked.lexer(markdown, { gfm: true, breaks: true }))
}
