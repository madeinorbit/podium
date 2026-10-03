import { type IssueReferenceModel } from '@podium/client-core/viewmodels'

import { StyleSheet, Text } from 'react-native'
import { usePoolRefChip } from '../client/use-inbox-data'
import { alpha } from '../theme/mix'
import { stageColor } from '../theme/stage'
import { color, font, mono } from '../theme/theme'
import { StageGlyph, UnknownRefGlyph } from './StageGlyph'

/**
 * A `POD-529` mention inside agent output, carrying the task's LIVE workflow
 * stage (POD-724 — the phone twin of the desktop's `a.ref-link` chip and the
 * terminal's stage-coloured underline).
 *
 * Before this the phone painted every ref one flat accent-tinted token, which
 * made the transcript's most common cross-reference the one place where state
 * was invisible: a ref to a task that shipped last week looked exactly like a
 * ref to the task the agent is failing on right now. The stage colours and the
 * glyph geometry come from ../theme/stage and ./StageGlyph — the same tables
 * the desktop and the terminals read — so a fourth surface cannot drift the way
 * the terminals did in POD-583.
 *
 * Resolution is done HERE rather than threaded down from a screen: every caller
 * that renders markdown would otherwise have to know about issues, and a caller
 * that forgot would silently paint stage-less chips.
 */

interface RefChipProps {
  token: string
  refKind: 'issue' | 'session'
  prefix: string
  onPress?: ((ref: string) => void) | undefined
}

export function RefChip(props: RefChipProps) {
  const { known, model } = usePoolRefChip(props.token, props.refKind, props.prefix)
  return <RefChipView {...props} known={known} model={model} />
}

function RefChipView({
  token,
  refKind,
  onPress,
  known,
  model,
}: RefChipProps & { known: boolean; model: IssueReferenceModel | null }) {
  // Not a ref, just text that happens to be shaped like one.
  if (!known) return <>{token}</>

  // A stage colour is a CLAIM about a task's state, so it is only ever made
  // about a task we can see. An issue ref with no live row (a replica page that
  // has not arrived, a row this principal cannot see, a task that is gone) and
  // every session ref stay muted — POD-676: a gap must not announce a task as
  // something it is not, and it must never borrow the brand accent to do it.
  const stage = model?.stage ?? null
  const ink = refKind === 'issue' ? stageColor(stage) : color.textDim
  // The done glyph punches its check out of the surface behind it; the chip's
  // own tint is that surface, so the check reads as a hole rather than a stroke.
  const ground = color.surface

  return (
    <Text
      accessibilityRole={onPress ? 'link' : 'text'}
      accessibilityLabel={
        model?.accessibleLabel ??
        (refKind === 'session' ? `Session ${token}` : `Task ${token} is unavailable`)
      }
      style={[
        styles.chip,
        {
          color: ink,
          backgroundColor: alpha(ink, 0.12),
          textDecorationColor: alpha(ink, 0.65),
        },
        // Dashed under a backlog ref, solid under everything else — the same
        // pairing the terminal underline and the dashed backlog glyph use.
        stage === 'backlog' && styles.chipDashed,
      ]}
      onPress={onPress ? () => onPress(token) : undefined}
      suppressHighlighting
    >
      {stage ? (
        <>
          <StageGlyph stage={stage} size={11} ground={ground} />
          {/* A hair of air between glyph and token; padding on inline text is
              not honoured on every target, a space always is. */}{' '}
        </>
      ) : refKind === 'issue' ? (
        // Unresolved, and it says so (POD-676). A session ref gets nothing: it
        // is not a task whose state we failed to learn, so a question mark
        // would be claiming a gap that is not there.
        <>
          <UnknownRefGlyph size={11} tint={ink} />{' '}
        </>
      ) : null}
      {token}
    </Text>
  )
}

const styles = StyleSheet.create({
  chip: {
    ...mono(500),
    fontSize: font.small,
    // The underline the desktop chip cannot have (dotted underlines rasterize
    // differently across its two engines); on the phone there is one text
    // engine, so the ref can carry both the tint and the underline.
    textDecorationLine: 'underline',
    borderRadius: 4,
    paddingHorizontal: 3,
  },
  chipDashed: {
    textDecorationStyle: 'dashed',
  },
})
