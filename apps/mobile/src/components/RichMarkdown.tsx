import { codeBlockIdentity } from '@podium/client-core/code-highlight'
import { parseAnyRef, soleRefToken } from '@podium/protocol'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { LinearGradient } from 'expo-linear-gradient'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Image,
  Text as NativeText,
  Platform,
  ScrollView,
  type StyleProp,
  StyleSheet,
  type TextProps,
  type TextStyle,
  useWindowDimensions,
  View,
} from 'react-native'
import { useCodeHighlight } from '../hooks/useCodeHighlight'
import {
  type MarkdownTableCell,
  type MarkdownToken,
  parseMarkdown,
  safeExternalUrl,
  safeLinkUrl,
  splitPodiumRefs,
} from '../lib/markdown'
import { followPodiumLink } from '../lib/podium-link'
import { selectableProps } from '../lib/selectable'
import { proseColor } from '../theme/syntax'
import { color, font, leading, mono, radius, sans, space } from '../theme/theme'
import { useLiveInk } from '../theme/use-live-ink'
import { HighlightedCode } from './HighlightedCode'
import { Icon } from './Icon'
import { ImageLightbox } from './ImageLightbox'
import { Check, Copy } from './icons'
import { PressableScale } from './PressableScale'
import { RefChip } from './RefChip'

/** Refresh cached attributed-text ink without remounting the reading surface. */
function Text({ style, ...props }: TextProps) {
  const declared = StyleSheet.flatten(style)?.color
  const ink = useLiveInk((declared ?? color.body) as string)
  return <NativeText {...props} style={[style, declared != null && { color: ink }]} />
}

interface RichMarkdownProps {
  text: string
  textStyle?: StyleProp<TextStyle>
  onRefPress?: (ref: string) => void
  /** Native text selection on the prose (default true). The iOS transcript
   *  turns it off: its message context menu owns copy and Select Text, and a
   *  selectable Text raises a second system edit menu on long-press. */
  selectable?: boolean
}

interface RenderContext {
  textStyle?: StyleProp<TextStyle>
  onRefPress?: (ref: string) => void
  selectable: boolean
  fontScale?: number
}

function plainText(token: MarkdownToken): string {
  if (token.text !== undefined) return token.text
  return token.raw ?? ''
}

/** A Podium address opens the screen it names; everything else goes to the OS
 *  (POD-1606). `safeLinkUrl` rejects executable and data schemes first. */
function followLink(href: string | undefined): void {
  const safe = safeLinkUrl(href)
  if (safe) followPodiumLink(safe)
}

function renderText(text: string, ctx: RenderContext, key: string): ReactNode[] {
  return splitPodiumRefs(text).map((part) =>
    part.kind === 'ref' ? (
      <RefChip
        key={`${key}:ref:${part.offset}`}
        token={part.ref}
        refKind={part.refKind}
        prefix={part.prefix}
        onPress={ctx.onRefPress}
        // An issue ref peeks through the caller's handler when there is one;
        // a session ref (and an issue ref with no handler) opens through the
        // shared link activator inside the chip (POD-2444).
      />
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
      case 'paragraph':
      case 'heading':
      case 'blockquote':
        return renderInline(token.tokens ?? [], ctx, tokenKey)
      case 'list':
        return (token.items ?? []).flatMap((item, itemIndex) =>
          renderInline(item.tokens ?? [], ctx, `${tokenKey}:item:${itemIndex}`),
        )
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
      case 'codespan': {
        // `POD-13` in backticks is how agents write refs, so a span holding
        // ONLY a ref is the chip, as on desktop; a ref quoted inside a longer
        // span (a command, a path) stays literal code (POD-2444).
        const code = plainText(token)
        const literal = (
          <Text key={tokenKey} style={styles.inlineCode}>
            {code}
          </Text>
        )
        const ref = soleRefToken(code)
        const parsed = ref ? parseAnyRef(ref) : null
        if (!ref || !parsed) return literal
        // An unregistered prefix (`UTF-8`) keeps its code face.
        return (
          <RefChip
            key={tokenKey}
            token={ref}
            refKind={parsed.kind}
            prefix={parsed.prefix}
            onPress={ctx.onRefPress}
            fallback={literal}
          />
        )
      }
      case 'link': {
        const safe = safeLinkUrl(token.href)
        return (
          <Text
            key={tokenKey}
            accessibilityRole={safe ? 'link' : undefined}
            style={safe ? styles.link : undefined}
            onPress={safe ? () => followLink(token.href) : undefined}
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
            onPress={() => followLink(safe)}
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
  fitSingleWordHeading = false,
}: {
  tokens: MarkdownToken[]
  ctx: RenderContext
  style?: StyleProp<TextStyle>
  fitSingleWordHeading?: boolean
}) {
  return (
    <Text
      selectable={ctx.selectable}
      style={[styles.body, ctx.textStyle, style]}
      numberOfLines={fitSingleWordHeading ? 1 : undefined}
      adjustsFontSizeToFit={fitSingleWordHeading}
      minimumFontScale={0.85}
      ellipsizeMode="tail"
    >
      {renderInline(tokens, ctx, 'inline')}
    </Text>
  )
}

/** Copy for a code block (desktop `code-copy`): the glyph turns into a check
 *  for a moment so the tap reads as done, with a success haptic. */
function CopyCodeButton({ source }: { source: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Copied' : 'Copy code'}
      hitSlop={8}
      onPress={() => {
        void Clipboard.setStringAsync(source)
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
        setCopied(true)
      }}
      style={styles.codeCopy}
    >
      <Icon as={copied ? Check : Copy} size={14} color={color.textMicro} />
    </PressableScale>
  )
}

/** A Markdown image the agent linked, drawn inline at the column's width (the
 *  desktop shows it in place too). Tap opens it full screen; an image that
 *  fails to load falls back to its text link. */
function MarkdownImage({ url, alt }: { url: string; alt: string }) {
  const [aspect, setAspect] = useState(4 / 3)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const label = alt || 'Image'
  if (failed) {
    return (
      <Text
        accessibilityRole="link"
        accessibilityLabel={alt || 'Open image'}
        style={[styles.body, styles.link]}
        onPress={() => followLink(url)}
      >
        {alt ? `[image: ${alt}]` : '[open image]'}
      </Text>
    )
  }
  return (
    <>
      <PressableScale
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${label}`}
        onPress={() => setOpen(true)}
        scaleTo={0.99}
        style={styles.imageFrame}
      >
        <Image
          source={{ uri: url }}
          accessibilityLabel={label}
          resizeMode="cover"
          style={[styles.image, { aspectRatio: aspect }]}
          onLoad={(event) => {
            const { width, height } = event.nativeEvent.source ?? {}
            if (width && height) setAspect(Math.max(0.5, Math.min(3, width / height)))
          }}
          onError={() => setFailed(true)}
        />
      </PressableScale>
      <ImageLightbox
        visible={open}
        source={{ uri: url }}
        label={label}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/** The images of a paragraph that holds nothing else (`![alt](url)` on its own
 *  line, the way agents share a screenshot), or null when it has prose too or
 *  any image is not a safe external URL. Those keep the inline text link. */
function standaloneImages(
  tokens: readonly MarkdownToken[] | undefined,
): { url: string; alt: string }[] | null {
  if (!tokens?.length) return null
  const images: { url: string; alt: string }[] = []
  for (const token of tokens) {
    const blank = token.type === 'br' || (token.type === 'text' && !plainText(token).trim())
    if (blank) continue
    const url = token.type === 'image' ? safeExternalUrl(token.href) : undefined
    if (!url) return null
    images.push({ url, alt: token.text ?? '' })
  }
  return images.length > 0 ? images : null
}

function CodeBlock({ token, selectable }: { token: MarkdownToken; selectable: boolean }) {
  const language = token.lang?.trim().split(/\s+/)[0]
  const source = plainText(token).replace(/\n$/, '')
  const lines = source.split('\n')
  const diff = language?.toLowerCase() === 'diff' || language?.toLowerCase() === 'patch'
  const highlighted = useCodeHighlight(source, language, !diff)
  return (
    <View style={styles.codeFrame}>
      <View style={styles.codeBar}>
        {language ? <Text style={styles.codeLanguage}>{language}</Text> : null}
        <CopyCodeButton source={source} />
      </View>
      <ScrollView
        testID="code-scroller"
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        style={styles.codeScroller}
        contentContainerStyle={styles.codeContent}
      >
        <Text selectable={selectable} style={styles.codeText}>
          {diff ? (
            lines.map((line, index) => {
              const lineStyle =
                line.startsWith('+') && !line.startsWith('+++')
                  ? styles.diffAdd
                  : line.startsWith('-') && !line.startsWith('---')
                    ? styles.diffDel
                    : line.startsWith('@@')
                      ? styles.diffHunk
                      : undefined
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: parsed code lines are immutable and positional
                <Text key={`${index}:${line}`} style={lineStyle}>
                  {line}
                  {index < lines.length - 1 ? '\n' : ''}
                </Text>
              )
            })
          ) : (
            <HighlightedCode tokens={highlighted} />
          )}
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

/**
 * Agent replies are full of tables, and on a phone they are almost always wider
 * than the screen. The scroller was already here — what was missing was any
 * sign of it [POD-366]: the table simply ran off the edge mid-word and read as
 * clipped. A fade on the cut edge says "there is more this way", and clears
 * once you reach the end.
 */
function MarkdownTable({ token, ctx }: { token: MarkdownToken; ctx: RenderContext }) {
  const header = token.header ?? []
  const rows = token.rows ?? []
  const [overflow, setOverflow] = useState(false)
  const [atEnd, setAtEnd] = useState(false)
  const atEndRef = useRef(false)
  const viewport = useRef(0)
  const content = useRef(0)
  const measure = () => setOverflow(content.current > viewport.current + 1)

  return (
    <View style={styles.tableScroller}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        scrollEventThrottle={64}
        onLayout={(e) => {
          viewport.current = e.nativeEvent.layout.width
          measure()
        }}
        onContentSizeChange={(w) => {
          content.current = w
          measure()
        }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
          const nextAtEnd = contentOffset.x + layoutMeasurement.width >= contentSize.width - 2
          if (nextAtEnd === atEndRef.current) return
          atEndRef.current = nextAtEnd
          setAtEnd(nextAtEnd)
        }}
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
      {overflow && !atEnd ? (
        <LinearGradient
          pointerEvents="none"
          colors={[color.clear, color.bg]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.tableFade}
        />
      ) : null}
    </View>
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
  const itemId = useId()
  return tokens.map((token, index) => {
    const key = codeBlockIdentity(itemId, index)
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
            fitSingleWordHeading={/^\S+$/.test((token.text ?? '').trim())}
          />
        )
      }
      case 'paragraph':
      case 'text': {
        const images = standaloneImages(token.tokens)
        if (images) {
          return (
            <View key={key} style={[styles.images, !compact && styles.paragraph]}>
              {images.map((image, imageIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: parsed markdown is immutable and positional
                <MarkdownImage key={`${imageIndex}:${image.url}`} url={image.url} alt={image.alt} />
              ))}
            </View>
          )
        }
        return (
          <View key={key} style={compact ? undefined : styles.paragraph}>
            <Inline tokens={token.tokens ?? []} ctx={ctx} />
          </View>
        )
      }
      case 'code':
        return <CodeBlock key={key} token={token} selectable={ctx.selectable} />
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
                <Text style={[styles.listMarker, { width: 24 * Math.max(1, ctx.fontScale ?? 1) }]}>
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
            <Text selectable={ctx.selectable} style={[styles.body, ctx.textStyle]}>
              {renderText(plainText(token), ctx, key)}
            </Text>
          </View>
        ) : null
    }
  })
}

/** Text-only markdown leaves for a note subject inside its single-line label. */
export function RichMarkdownInline({ text, onRefPress }: RichMarkdownProps) {
  const tokens = useMemo(() => parseMarkdown(text), [text])
  const ctx = { onRefPress, selectable: false }
  return renderInline(tokens, ctx, 'subject')
}

/** Native GFM transcript renderer. The native shell retains scrolling and interactions. */
export function RichMarkdown({
  text,
  textStyle,
  onRefPress,
  selectable = true,
}: RichMarkdownProps) {
  const { fontScale } = useWindowDimensions()
  const tokens = useMemo(() => parseMarkdown(text), [text])
  const ctx = useMemo(
    () => ({ textStyle, onRefPress, selectable, fontScale }),
    [onRefPress, selectable, textStyle, fontScale],
  )
  // The web shell disables selection app-wide so long-pressing a card cannot
  // raise iOS's magnifier; agent prose opts back in [POD-366, patch-web-html].
  return (
    <View key={fontScale} style={styles.root} {...(selectable ? selectableProps : undefined)}>
      <Blocks tokens={tokens} ctx={ctx} />
    </View>
  )
}

const headingStyles = StyleSheet.create({
  1: { fontSize: font.title, ...Platform.select({ web: { lineHeight: leading(font.title) } }) },
  2: { fontSize: font.heading, ...Platform.select({ web: { lineHeight: leading(font.heading) } }) },
  3: { fontSize: font.heading, ...Platform.select({ web: { lineHeight: leading(font.heading) } }) },
})

const styles = StyleSheet.create({
  root: { minWidth: 0, width: '100%', maxWidth: '100%', flexGrow: 0, flexShrink: 0 },
  body: {
    ...sans(400),
    // Keep UIKit label adaptation, including Increase Contrast, for reading text.
    color: color.body,
    fontSize: 16,
    // Native prose follows the scaled font's intrinsic metrics. Recreate the
    // blocks when the text size changes so a retained AX5 measurement cannot
    // leave empty space before the next block after returning to default.
    ...Platform.select({ web: { lineHeight: 24 } }),
  },
  paragraph: { marginVertical: 4, minWidth: 0, maxWidth: '100%' },
  // UIKit primary label can already be black/white: emphasis adds weight there.
  strong: { ...sans(600), color: color.text },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through', color: color.textDim },
  link: { color: color.info, textDecorationLine: 'underline' },
  inlineCode: {
    ...mono(400),
    // POD-725: a change of ink and face, never a boxed chip.
    color: proseColor('code-inline'),
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
  list: { marginVertical: space.xs, gap: 4, flexGrow: 0 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', minWidth: 0 },
  listMarker: {
    ...mono(500),
    color: color.textDim,
    width: 24,
    fontSize: 16,
    ...Platform.select({ web: { lineHeight: 24 } }),
  },
  listBody: { flex: 1, minWidth: 0 },
  codeFrame: {
    alignSelf: 'stretch',
    maxWidth: '100%',
    backgroundColor: color.surface,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.card,
    marginVertical: space.sm,
    overflow: 'hidden',
  },
  // Language leading, Copy trailing — no fake window chrome (iOS draws none).
  codeBar: {
    height: 28,
    paddingHorizontal: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  codeLanguage: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
  },
  codeCopy: {
    marginLeft: 'auto',
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  images: { gap: space.sm },
  imageFrame: {
    alignSelf: 'stretch',
    borderRadius: radius.card,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  image: { width: '100%', maxHeight: 360 },
  codeText: {
    flexShrink: 0,
    ...mono(400),
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small),
    padding: space.md,
  },
  codeScroller: { width: '100%' },
  codeContent: { flexDirection: 'row', flexGrow: 1, alignItems: 'flex-start' },
  diffAdd: { color: '#22c55e', backgroundColor: 'rgba(34, 197, 94, 0.08)' },
  diffDel: { color: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.08)' },
  diffHunk: { color: '#06b6d4' },
  tableScroller: { marginVertical: space.sm },
  tableFade: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 28,
  },
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
  tableText: { fontSize: font.small, lineHeight: leading(font.small) },
  tableHeaderText: { ...sans(600), color: color.text },
})
