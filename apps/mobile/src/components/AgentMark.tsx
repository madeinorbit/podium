import type { AgentKind } from '@podium/model'
import { StyleSheet, Text, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { color, mono, radius } from '../theme/theme'
import { Icon } from './Icon'
import { type AppIcon, SquareTerminal } from './icons'

/**
 * HARNESS IDENTITY ON THE PHONE — the real brand marks, not initials.
 *
 * The phone used to draw a harness as a coloured square with a letter in it
 * (C, X, G, O, U). At 15px a letter reads as a placeholder: an initial is the
 * one thing about a brand that carries none of it, and it forces the GROUND to
 * do the identifying, which is why two harnesses ended up sharing the live-work
 * blue just to look different from each other. The desktop has drawn the actual
 * marks since POD-293 (apps/web/src/lib/icons/AgentIcons.tsx); these are the
 * SAME paths, ported to react-native-svg, so a harness looks like itself on
 * both screens.
 *
 * The marks are monochrome and take the chip's own ink, which is how Claude
 * Code comes out white on its terracotta ground and Grok near-black on its
 * white one: the ground carries the brand colour, the mark carries the shape.
 */

type MarkSpec = { viewBox: string; d: string }

/**
 * Harnesses with a mark of their own. A harness that is NOT here — the shell,
 * or a kind a newer machine in the fleet knows and this build does not — is
 * never given an invented logo; see {@link AgentMark}.
 */
const MARKS: Record<string, MarkSpec> = {
  'claude-code': {
    viewBox: '0 0 24 24',
    d: 'M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z',
  },
  codex: {
    viewBox: '0 0 256 260',
    d: 'M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z',
  },
  grok: {
    viewBox: '0 0 24 24',
    d: 'M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815',
  },
  opencode: {
    viewBox: '0 0 24 24',
    d: 'M16 6H8v12h8V6zm4 16H4V2h16v20z',
  },
  cursor: {
    viewBox: '0 0 24 24',
    d: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23',
  },
}

/**
 * Harnesses drawn from a platform glyph instead of a brand path — a shell is a
 * tool, not a brand, and inventing a logo for it would say otherwise. The
 * desktop gives it the same terminal square.
 *
 * A TABLE, not an `if (kind === 'shell')`: the harness axiom confines
 * comparisons on a harness literal to packages/harness, and a Record keyed by
 * harness is a lookup rather than a comparison (see the axiom's own note in
 * scripts/architecture-manifest.ts). Adding a harness stays a new row.
 */
const GLYPHS: Record<string, AppIcon> = {
  shell: SquareTerminal,
}

/**
 * The harness's mark at `size`, inked in `ink`.
 *
 * Three tiers, resolved in the order the desktop resolves them:
 *  - a branded harness gets its real mark;
 *  - a glyph harness gets its platform terminal square;
 *  - anything else — a harness this build has never heard of, which the wire
 *    can genuinely carry — keeps the initial it always drew. An unknown mark is
 *    worse than a letter, because it would claim a brand.
 */
export function AgentMark({
  kind,
  size,
  ink,
}: {
  kind: AgentKind | string | undefined
  size: number
  ink: string
}) {
  const spec = MARKS[kind ?? '']
  if (spec) {
    return (
      <Svg width={size} height={size} viewBox={spec.viewBox}>
        <Path d={spec.d} fill={ink} fillRule="evenodd" clipRule="evenodd" />
      </Svg>
    )
  }
  const Glyph = GLYPHS[kind ?? '']
  if (Glyph) return <Icon as={Glyph} size={size} color={ink} />
  return (
    <Text style={[styles.initial, { color: ink, fontSize: Math.max(7, Math.round(size * 0.82)) }]}>
      {kindTone(kind).ch}
    </Text>
  )
}

/** A mark is drawn at this fraction of its chip — the desktop's ratio. */
export const MARK_IN_CHIP = 0.66

/** The mark size for a chip of `size`, never below the 8px it stops reading at. */
export function markSize(chip: number): number {
  return Math.max(8, Math.round(chip * MARK_IN_CHIP))
}

/**
 * The harness square — the phone's icon for "what kind of thing is this".
 *
 * Lives here, beside the marks and the tones it composes, because the spine is
 * no longer the only surface that needs one: the chat and terminal headers
 * carry it too (POD-1355), and a header importing a private helper out of the
 * mission deck would be reaching through a screen to borrow its furniture.
 */
export function HarnessChip({
  kind,
  size = 20,
  dimmed = false,
}: {
  kind: AgentKind | string | undefined
  size?: number
  dimmed?: boolean
}) {
  const tone = kindTone(kind)
  return (
    <View
      style={[
        styles.chip,
        {
          width: size,
          height: size,
          borderRadius: size >= 20 ? radius.xs : 4,
          backgroundColor: tone.bg,
          opacity: dimmed ? 0.45 : 1,
        },
      ]}
    >
      <AgentMark kind={kind} size={markSize(size)} ink={tone.fg} />
    </View>
  )
}

/**
 * Per-harness chip tone — the GROUND a mark sits on, and the initial that still
 * stands in for a harness this build does not know.
 *
 * A Record keyed by harness, not a chain of `kind === 'claude-code'`: adding a
 * harness is adding a row, the same shape the desktop's `lib/agent-tone.ts`
 * settled on for the same reason. Only the two harnesses with a brand COLOUR of
 * their own wear one. Everything else reads on the neutral chip — the marks now
 * carry identity, so the tint no longer has to, which frees the live-work blue
 * to mean only "this one is moving" again.
 */
const NEUTRAL_TONE = { fg: color.text, bg: 'rgba(243,243,248,0.10)' }

export const KIND_TONE: Record<string, { fg: string; bg: string; ch: string }> = {
  'claude-code': { fg: '#ffffff', bg: color.claude, ch: 'C' },
  codex: { ...NEUTRAL_TONE, ch: 'X' },
  grok: { fg: '#09090b', bg: '#ffffff', ch: 'G' },
  opencode: { ...NEUTRAL_TONE, ch: 'O' },
  cursor: { ...NEUTRAL_TONE, ch: 'U' },
  shell: { fg: color.textFaint, bg: 'rgba(108,118,144,0.14)', ch: '$' },
}

export function kindTone(kind: AgentKind | string | undefined) {
  return KIND_TONE[kind ?? ''] ?? { fg: color.textDim, bg: 'rgba(154,154,168,0.14)', ch: '·' }
}

const styles = StyleSheet.create({
  initial: { ...mono(600), letterSpacing: 0.2 },
  chip: { alignItems: 'center', justifyContent: 'center' },
})
