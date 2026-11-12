import type { IssueReferenceModel } from '@podium/client-core/values'
import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, Text } from 'react-native'
import { usePoolRefChip } from '../client/use-inbox-data'
import { openPodiumTarget } from '../lib/podium-link'
import { color, font, mono, radius } from '../theme/theme'
import { Icon } from './Icon'
import { SquareTerminal } from './icons'
import { StageGlyph, UnknownRefGlyph } from './StageGlyph'

/**
 * A `POD-529` or `POD-529-A` mention inside chat, drawn as a CHIP (POD-2444):
 * the phone twin of the desktop's `a.ref-link`. The token sits in a
 * system-fill capsule at the control corner (6), led by the task's live stage
 * glyph, or a terminal glyph for a session. Its live stage is resolved HERE
 * (every markdown caller would otherwise have to know about issues) and also
 * announced in the accessibility label.
 *
 * Tapping opens the ref: an issue goes to the caller's handler when it has
 * one (the chat's task peek), otherwise, like every session ref, through the
 * shared Podium link activator, the same route a link to that task takes.
 */

interface RefChipProps {
  token: string
  refKind: 'issue' | 'session'
  prefix: string
  /** Issue refs only: replaces the default navigation (the chat's peek). */
  onPress?: ((ref: string) => void) | undefined
  /** What an unregistered prefix renders instead (default: the bare token). */
  fallback?: ReactNode
}

export function RefChip(props: RefChipProps) {
  const { known, model } = usePoolRefChip(props.token, props.refKind, props.prefix)
  return <RefChipView {...props} known={known} model={model} />
}

function openRef(token: string, refKind: 'issue' | 'session', onPress?: (ref: string) => void) {
  if (refKind === 'issue' && onPress) onPress(token)
  else
    openPodiumTarget(
      refKind === 'session' ? { kind: 'session', session: token } : { kind: 'issue', issue: token },
    )
}

function RefChipView({
  token,
  refKind,
  onPress,
  fallback,
  known,
  model,
}: RefChipProps & { known: boolean; model: IssueReferenceModel | null }) {
  // Not a ref, just text that happens to be shaped like one (`UTF-8`).
  if (!known) return <>{fallback ?? token}</>

  // A stage colour is a CLAIM about a task's state, so only a task we can see
  // gets one; an unresolved issue ref says so with the question ring, and a
  // session ref wears the terminal mark (POD-676: a gap claims nothing).
  const stage = refKind === 'issue' ? (model?.status ?? null) : null
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={
        model?.accessibleLabel ??
        (refKind === 'session' ? `Session ${token}` : `Task ${token} is unavailable`)
      }
      onPress={() => openRef(token, refKind, onPress)}
      hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
    >
      {refKind === 'session' ? (
        <Icon as={SquareTerminal} size={GLYPH} color={color.textDim} />
      ) : stage ? (
        <StageGlyph stage={stage} size={GLYPH} ground={color.surface} />
      ) : (
        <UnknownRefGlyph size={GLYPH} tint={color.textFaint} />
      )}
      <Text style={styles.token} numberOfLines={1} allowFontScaling>
        {token}
      </Text>
    </Pressable>
  )
}

const GLYPH = 11
const TOKEN_LEADING = font.small + 3

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingLeft: 4,
    paddingRight: 5,
    paddingVertical: 1,
    borderRadius: radius.control,
    backgroundColor: color.tertiaryFill,
    // iOS hangs an inline view's BOTTOM on the text baseline; dropping it by
    // the token's descent puts the token's baseline on the sentence's. The web
    // build aligns inline-flex by its first baseline already.
    transform: Platform.OS === 'web' ? undefined : [{ translateY: 4 }],
  },
  pressed: { backgroundColor: color.secondaryFill },
  token: {
    ...mono(500),
    color: color.text,
    fontSize: font.small,
    lineHeight: TOKEN_LEADING,
  },
})
