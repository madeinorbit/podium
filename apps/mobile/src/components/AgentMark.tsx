import {
  parseServedDescriptors,
  resolveDescriptors,
} from '@podium/harness/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { AgentKind } from '@podium/model'
import { StyleSheet, Text, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { color, mono, radius } from '../theme/theme'
import { Icon } from './Icon'
import { type AppIcon, SquareTerminal } from './icons'

/**
 * HARNESS IDENTITY ON THE PHONE — the real brand marks, not initials
 * (POD-4475: marks and tones render from descriptors).
 *
 * The marks are monochrome and take the chip's own ink; the ground carries
 * the brand colour. The desktop draws the same paths
 * (`apps/web/src/lib/icons/AgentIcons.tsx`); a harness looks like itself on
 * both screens. Served descriptors overlay the bundled copy, so a newer
 * harness renders its own mark without a client change.
 */

function resolved(
  descriptors: readonly HarnessDescriptorWire[] | undefined,
): readonly HarnessDescriptorWire[] {
  return resolveDescriptors(parseServedDescriptors(descriptors ?? []))
}

function descriptorFor(
  kind: AgentKind | string | undefined,
  descriptors: readonly HarnessDescriptorWire[] | undefined,
): HarnessDescriptorWire | undefined {
  if (!kind) return undefined
  return resolved(descriptors).find((d) => d.kind === kind)
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
 *  - a harness with icon DATA (bundled or served) gets its real mark;
 *  - a glyph harness gets its platform terminal square;
 *  - anything else — no icon data at all — keeps an initial from its short
 *    label. An unknown mark is worse than a letter, because it would claim
 *    a brand.
 */
export function AgentMark({
  kind,
  size,
  ink,
  descriptors,
}: {
  kind: AgentKind | string | undefined
  size: number
  ink: string
  descriptors?: readonly HarnessDescriptorWire[]
}) {
  const data = descriptorFor(kind, descriptors)?.icon
  if (data && data.viewBox && data.d) {
    return (
      <Svg width={size} height={size} viewBox={data.viewBox}>
        <Path d={data.d} fill={ink} fillRule="evenodd" clipRule="evenodd" />
      </Svg>
    )
  }
  const Glyph = GLYPHS[kind ?? '']
  if (Glyph) return <Icon as={Glyph} size={size} color={ink} />
  return (
    <Text style={[styles.initial, { color: ink, fontSize: Math.max(7, Math.round(size * 0.82)) }]}>
      {kindTone(kind, descriptors).ch}
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
  descriptors,
}: {
  kind: AgentKind | string | undefined
  size?: number
  dimmed?: boolean
  descriptors?: readonly HarnessDescriptorWire[]
}) {
  const tone = kindTone(kind, descriptors)
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
      <AgentMark kind={kind} size={markSize(size)} ink={tone.fg} descriptors={descriptors} />
    </View>
  )
}

/**
 * Per-harness chip tone — the GROUND a mark sits on, and the initial that
 * stands in when no icon data exists.
 *
 * Read off descriptors, never a kind-keyed table: only harnesses with a
 * brand COLOUR of their own wear one (today Claude's terracotta and Grok's
 * light mark). Everything else reads on the neutral chip — the marks carry
 * identity now, so the tint no longer has to, which frees the live-work blue
 * to mean only "this one is moving" again. A shell keeps its tool grey; an
 * unknown harness without brand data reads dim with its short label's
 * initial.
 */
const NEUTRAL_TONE = { fg: color.text, bg: 'rgba(243,243,248,0.10)' }

/** A shell is a tool, not a brand: tool grey and `$`, via the glyph table
 *  above (a lookup, not a comparison — see its note). */
const SHELL_TONE = { fg: color.textFaint, bg: 'rgba(108,118,144,0.14)', ch: '$' }

export function kindTone(
  kind: AgentKind | string | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
): { fg: string; bg: string; ch: string } {
  if (kind && GLYPHS[kind]) return SHELL_TONE
  const found = descriptorFor(kind, descriptors)
  if (found?.brand) {
    return {
      fg: found.brand.fg,
      bg: found.brand.bg,
      ch: found.shortLabel.slice(0, 1).toUpperCase(),
    }
  }
  if (found) {
    return { ...NEUTRAL_TONE, ch: found.shortLabel.slice(0, 1).toUpperCase() }
  }
  return { fg: color.textDim, bg: 'rgba(154,154,168,0.14)', ch: '·' }
}

const styles = StyleSheet.create({
  initial: { ...mono(600), letterSpacing: 0.2 },
  chip: { alignItems: 'center', justifyContent: 'center' },
})
