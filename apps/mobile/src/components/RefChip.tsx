import { type IssueReferenceModel, resolveIssueReference } from '@podium/client-core/viewmodels'
import type { IssueWire } from '@podium/model'
import { useMemo } from 'react'
import { StyleSheet, Text } from 'react-native'
import { useIssues } from '../client/hooks'
import { alpha, mix } from '../theme/mix'
import { stageColor } from '../theme/stage'
import { color, font, mono } from '../theme/theme'
import { StageGlyph, UnknownRefGlyph } from './StageGlyph'

/**
 * A `POD-529` mention inside agent output, carrying the task's LIVE workflow
 * stage (POD-724 — the phone twin of the desktop's `a.ref-link` chip and the
 * terminal's stage-coloured underline).
 *
 * Before this the phone painted every ref one flat yellow-tinted token, which
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

/**
 * One resolution per (snapshot, token) instead of one per chip.
 *
 * `useIssues()` returns the same array for as long as the projection is
 * unchanged, so a transcript with forty mentions of the same task scans the
 * issue list once and every later chip is a map hit. Keyed weakly on the array
 * itself: when the projection changes — including when it SHRINKS under a
 * rescope — the old entry becomes unreachable rather than stale.
 */
const resolutions = new WeakMap<object, Map<string, IssueReferenceModel | null>>()

function resolveOnce(issues: readonly IssueWire[], token: string): IssueReferenceModel | null {
  let cache = resolutions.get(issues)
  if (!cache) {
    cache = new Map()
    resolutions.set(issues, cache)
  }
  const hit = cache.get(token)
  if (hit !== undefined) return hit
  const model = resolveIssueReference(token, issues)
  cache.set(token, model)
  return model
}

const prefixes = new WeakMap<object, ReadonlySet<string>>()

/**
 * The repo prefixes this operator can actually see.
 *
 * `anyRefMatcher` matches `UTF-8`, `ISO-8601` and `COVID-19` as eagerly as it
 * matches `POD-529` — the grammar cannot tell a repo prefix from any other two
 * to five capitals. The desktop settles it with a registered-prefix set and so
 * does this: a token whose prefix names no visible task stays prose. An empty
 * projection therefore chips nothing, which is the honest state during the
 * first moments of a cold boot rather than a wrong one.
 */
function knownPrefixes(issues: readonly IssueWire[]): ReadonlySet<string> {
  const hit = prefixes.get(issues)
  if (hit) return hit
  const set = new Set<string>()
  for (const issue of issues) if (issue.prefix) set.add(issue.prefix)
  prefixes.set(issues, set)
  return set
}

export function RefChip({
  token,
  refKind,
  prefix,
  onPress,
}: {
  /** The matched token exactly as it was written, e.g. `POD-529`. */
  token: string
  refKind: 'issue' | 'session'
  prefix: string
  /** Tap-to-peek. Session refs never receive one — see below. */
  onPress?: ((ref: string) => void) | undefined
}) {
  const issues = useIssues()
  const known = knownPrefixes(issues).has(prefix)
  const model = useMemo(
    () => (known && refKind === 'issue' ? resolveOnce(issues, token) : null),
    [issues, known, refKind, token],
  )

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
  const ground = mix(ink, 12, color.bg)

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
