import { type ReactNode, useMemo } from 'react'
import {
  Linking,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
} from 'react-native'
import {
  type MarkdownTableCell,
  type MarkdownToken,
  parseMarkdown,
  safeExternalUrl,
  splitPodiumRefs,
} from '../lib/markdown'
import { color, font, mono, radius, sans, space } from '../theme/theme'

interface RichMarkdownProps {
  text: string
  textStyle?: StyleProp<TextStyle>
  onRefPress?: (ref: string) => void
}

interface RenderContext {
  textStyle?: StyleProp<TextStyle>
  onRefPress?: (ref: string) => void
}

function plainText(token: MarkdownToken): string {
  if (token.text !== undefined) return token.text
  return token.raw ?? ''
}

function openExternal(href: string | undefined): void {
  const safe = safeExternalUrl(href)
  if (safe) void Linking.openURL(safe)
}

function renderText(text: string, ctx: RenderContext, key: string): ReactNode[] {
  return splitPodiumRefs(text).map((part) =>
    part.kind === 'ref' && ctx.onRefPress ? (
      <Text
        key={`${key}:ref:${part.offset}`}
        accessibilityRole="link"
        style={styles.refLink}
        onPress={() => ctx.onRefPress?.(part.ref)}
        suppressHighlighting
      >
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  )
}

function renderInline(
  tokens: readonly MarkdownToken[],
  ctx: RenderContext,
  key: string,
): ReactNode[] {
  return tokens.map((token, index) => {
    const tokenKey = `${key}:${index}`
    switch (token.type) {
      case 'strong':
        return (
          <Text key={tokenKey} style={styles.strong}>
            {renderInline(token.tokens ?? [], ctx, tokenKey)}
          </Text>
        )
      case 'em':
        return (
          <Text key={tokenKey} style={styles.em}>
            {renderInline(token.tokens ?? [], ctx, tokenKey)}
          </Text>
        )
      case 'del':
        return (
          <Text key={tokenKey} style={styles.del}>
            {renderInline(token.tokens ?? [], ctx, tokenKey)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={tokenKey} style={styles.inlineCode}>
            {plainText(token)}
          </Text>
        )
      case 'link': {
        const safe = safeExternalUrl(token.href)
        return (
          <Text
            key={tokenKey}
            accessibilityRole={safe ? 'link' : undefined}
            style={safe ? styles.link : undefined}
            onPress={safe ? () => openExternal(token.href) : undefined}
            suppressHighlighting
          >
            {renderInline(token.tokens ?? [], ctx, tokenKey)}
          </Text>
        )
      }
      case 'image': {
        const safe = safeExternalUrl(token.href)
        if (!safe) {
          return renderText(token.text ? `[image: ${token.text}]` : '[image]', ctx, tokenKey)
        }
        return (
          <Text
            key={tokenKey}
            accessibilityRole="link"
            accessibilityLabel={token.text || 'Open image'}
            style={styles.link}
            onPress={() => openExternal(safe)}
          >
            {token.text ? `[image: ${token.text}]` : '[open image]'}
          </Text>
        )
      }
      case 'br':
        return '\n'
      case 'escape':
      case 'text':
        return token.tokens?.length
          ? renderInline(token.tokens, ctx, tokenKey)
          : renderText(plainText(token), ctx, tokenKey)
      case 'html':
        return /^<br\s*\/?\s*>$/i.test(token.raw ?? '') ? '\n' : null
      default:
        return renderText(plainText(token), ctx, tokenKey)
    }
  })
}

function Inline({
  tokens,
  ctx,
  style,
}: {
  tokens: MarkdownToken[]
  ctx: RenderContext
  style?: StyleProp<TextStyle>
}) {
  return (
    <Text selectable style={[styles.body, ctx.textStyle, style]}>
      {renderInline(tokens, ctx, 'inline')}
    </Text>
  )
}

function CodeBlock({ token }: { token: MarkdownToken }) {
  const language = token.lang?.trim().split(/\s+/)[0]
  const lines = plainText(token).replace(/\n$/, '').split('\n')
  const diff = language === 'diff' || language === 'patch'
  return (
    <View style={styles.codeFrame}>
      <View style={styles.codeBar}>
        <View style={styles.codeDot} />
        <View style={styles.codeDot} />
        <View style={styles.codeDot} />
        {language ? <Text style={styles.codeLanguage}>{language}</Text> : null}
      </View>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
        <Text selectable style={styles.codeText}>
          {lines.map((line, index) => {
            const lineStyle = diff
              ? line.startsWith('+') && !line.startsWith('+++')
                ? styles.diffAdd
                : line.startsWith('-') && !line.startsWith('---')
                  ? styles.diffDel
                  : line.startsWith('@@')
                    ? styles.diffHunk
                    : undefined
              : undefined
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: parsed code lines are immutable and positional
              <Text key={`${index}:${line}`} style={lineStyle}>
                {line}
                {index < lines.length - 1 ? '\n' : ''}
              </Text>
            )
          })}
        </Text>
      </ScrollView>
    </View>
  )
}

function TableCell({ cell, ctx }: { cell: MarkdownTableCell; ctx: RenderContext }) {
  const align = cell.align ?? 'left'
  return (
    <View style={[styles.tableCell, cell.header && styles.tableHeaderCell]}>
      <Inline
        tokens={cell.tokens}
        ctx={ctx}
        style={[styles.tableText, cell.header && styles.tableHeaderText, { textAlign: align }]}
      />
    </View>
  )
}

function MarkdownTable({ token, ctx }: { token: MarkdownToken; ctx: RenderContext }) {
  const header = token.header ?? []
  const rows = token.rows ?? []
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      style={styles.tableScroller}
      contentContainerStyle={styles.table}
      accessibilityLabel={`Markdown table, ${header.length} columns and ${rows.length} rows`}
    >
      <View>
        <View style={styles.tableRow}>
          {header.map((cell, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parsed table cells are immutable and positional
            <TableCell key={`header:${index}`} cell={cell} ctx={ctx} />
          ))}
        </View>
        {rows.map((row, rowIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parsed table rows are immutable and positional
          <View key={`row:${rowIndex}`} style={styles.tableRow}>
            {row.map((cell, cellIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: parsed table cells are immutable and positional
              <TableCell key={`cell:${rowIndex}:${cellIndex}`} cell={cell} ctx={ctx} />
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function Blocks({
  tokens,
  ctx,
  compact = false,
}: {
  tokens: readonly MarkdownToken[]
  ctx: RenderContext
  compact?: boolean
}) {
  return tokens.map((token, index) => {
    const key = `${token.type}:${index}`
    switch (token.type) {
      case 'space':
        return null
      case 'heading': {
        const depth = Math.min(Math.max(token.depth ?? 3, 1), 3) as 1 | 2 | 3
        return (
          <Inline
            key={key}
            tokens={token.tokens ?? []}
            ctx={ctx}
            style={[styles.heading, headingStyles[depth]]}
          />
        )
      }
      case 'paragraph':
      case 'text':
        return (
          <View key={key} style={compact ? undefined : styles.paragraph}>
            <Inline tokens={token.tokens ?? []} ctx={ctx} />
          </View>
        )
      case 'code':
        return <CodeBlock key={key} token={token} />
      case 'blockquote':
        return (
          <View key={key} style={styles.blockquote}>
            <Blocks
              tokens={token.tokens ?? []}
              ctx={{ ...ctx, textStyle: [ctx.textStyle, styles.quoteText] }}
              compact
            />
          </View>
        )
      case 'hr':
        return <View key={key} style={styles.hr} />
      case 'list': {
        const ordered = token.ordered === true
        const start = typeof token.start === 'number' ? token.start : Number(token.start) || 1
        return (
          <View key={key} style={styles.list}>
            {(token.items ?? []).map((item, itemIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: parsed list items are immutable and positional
              <View key={`item:${itemIndex}`} style={styles.listItem}>
                <Text style={styles.listMarker}>
                  {item.task ? (item.checked ? '☑' : '☐') : ordered ? `${start + itemIndex}.` : '•'}
                </Text>
                <View style={styles.listBody}>
                  <Blocks tokens={item.tokens ?? []} ctx={ctx} compact />
                </View>
              </View>
            ))}
          </View>
        )
      }
      case 'table':
        return <MarkdownTable key={key} token={token} ctx={ctx} />
      case 'html':
        return null
      default:
        return plainText(token) ? (
          <View key={key} style={compact ? undefined : styles.paragraph}>
            <Text selectable style={[styles.body, ctx.textStyle]}>
              {renderText(plainText(token), ctx, key)}
            </Text>
          </View>
        ) : null
    }
  })
}

/** Native GFM transcript renderer. The native shell retains scrolling and interactions. */
export function RichMarkdown({ text, textStyle, onRefPress }: RichMarkdownProps) {
  const tokens = useMemo(() => parseMarkdown(text), [text])
  const ctx = useMemo(() => ({ textStyle, onRefPress }), [onRefPress, textStyle])
  return (
    <View style={styles.root}>
      <Blocks tokens={tokens} ctx={ctx} />
    </View>
  )
}

const headingStyles = StyleSheet.create({
  1: { fontSize: font.heading + 3, lineHeight: 24 },
  2: { fontSize: font.heading + 1, lineHeight: 22 },
  3: { fontSize: font.heading, lineHeight: 21 },
})

const styles = StyleSheet.create({
  root: { minWidth: 0 },
  body: { ...sans(400), color: color.body, fontSize: font.body, lineHeight: 21 },
  paragraph: { marginVertical: 4 },
  strong: { ...sans(600), color: color.text },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through', color: color.textDim },
  link: { color: color.info, textDecorationLine: 'underline' },
  refLink: {
    ...mono(500),
    color: color.accentTint,
    backgroundColor: color.accentSoft,
    textDecorationLine: 'none',
  },
  inlineCode: {
    ...mono(400),
    color: color.text,
    backgroundColor: color.surface,
    fontSize: font.small,
  },
  heading: { ...sans(600), color: color.text, marginTop: space.md, marginBottom: space.xs },
  quoteText: { color: color.textDim, fontStyle: 'italic' },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: color.borderStrong,
    paddingLeft: space.md,
    marginVertical: space.sm,
  },
  hr: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
    marginVertical: space.md,
  },
  list: { marginVertical: space.xs, gap: 3 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', minWidth: 0 },
  listMarker: { ...mono(500), color: color.textDim, width: 24, lineHeight: 21 },
  listBody: { flex: 1, minWidth: 0 },
  codeFrame: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.md,
    marginVertical: space.sm,
    overflow: 'hidden',
  },
  codeBar: {
    height: 27,
    paddingHorizontal: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  codeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.borderStrong },
  codeLanguage: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
    marginLeft: 'auto',
  },
  codeText: {
    ...mono(400),
    color: color.body,
    fontSize: font.small,
    lineHeight: 18,
    padding: space.md,
  },
  diffAdd: { color: '#22c55e', backgroundColor: 'rgba(34, 197, 94, 0.08)' },
  diffDel: { color: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.08)' },
  diffHunk: { color: '#06b6d4' },
  tableScroller: { marginVertical: space.sm },
  table: { borderTopWidth: 1, borderLeftWidth: 1, borderColor: color.border },
  tableRow: { flexDirection: 'row' },
  tableCell: {
    width: 132,
    minHeight: 31,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: color.border,
    justifyContent: 'center',
  },
  tableHeaderCell: { backgroundColor: color.surface },
  tableText: { fontSize: font.small, lineHeight: 17 },
  tableHeaderText: { ...sans(600), color: color.text },
})
