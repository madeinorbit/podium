import { StyleSheet, Text, View } from 'react-native'
import { issueColorHex, issueSquareFg } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, mono } from '../theme/theme'
import { BrailleSpinner, CountPill } from './StatusGlyphs'

/** The square language's states — mirrors the web IdSquare: `working`/
 *  `waiting`/`done` wear the solid grey border (live work), `queued`/`idle`
 *  the dashed dimmed resting look. */
export type IdSquareState = 'working' | 'waiting' | 'done' | 'queued' | 'idle'

export interface IdSquareBadge {
  kind: 'waiting' | 'working' | 'done'
  count?: number
}

export interface IdSquareIssue {
  seq: number
  displayRef?: string
  linearIdentifier?: string
  color?: string | null
}

/** Split the display identifier into the square's two stacked lines. Twin of
 *  the web's idSquareLabel — "POD-78" → POD / 78, bare seq → # / 42. */
export function idSquareLabel(issue: IdSquareIssue): {
  prefix: string
  number: string
  full: string
} {
  const identifier = issue.linearIdentifier?.trim() || issue.displayRef?.trim()
  const match = identifier?.match(/^(.+?)[-_\s]+(\d+)$/)
  if (identifier && match?.[1] && match[2]) {
    return { prefix: match[1].toUpperCase(), number: match[2], full: identifier }
  }
  return { prefix: '#', number: String(issue.seq), full: `#${issue.seq}` }
}

/**
 * The issue identity square — native twin of apps/web IdSquare. Fixed
 * geometry per size tier: 26px rows (mono 6.5px), 18px headers (mono 4.5px).
 * Text that small is unreadable on 1x screens but exists as identity texture,
 * exactly like the comps; the row title carries the readable name.
 */
export function IdSquare({
  issue,
  state,
  size = 26,
  selected = false,
  badge = null,
  ringColor = color.surface,
}: {
  issue: IdSquareIssue
  state: IdSquareState
  size?: 18 | 22 | 26
  selected?: boolean
  badge?: IdSquareBadge | null
  /** The surface the corner badge punches out of. */
  ringColor?: string
}) {
  const label = idSquareLabel(issue)
  const hex = issueColorHex(issue.color)
  const resting = state === 'queued' || state === 'idle'
  const fontSize = size >= 26 ? 6.5 : size >= 22 ? 5.5 : 4.5
  const borderRadius = size >= 26 ? 7 : size >= 22 ? 6 : 5

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius,
          backgroundColor: hex ?? color.elevated,
          opacity: resting && !selected ? 0.65 : 1,
        },
        hex
          ? null
          : resting
            ? styles.restingBorder
            : { borderWidth: 1, borderColor: selected ? '#c8d2e0' : '#8d8d9a' },
        selected
          ? {
              boxShadow: `0 0 0 2px ${hex ? alpha(hex, 0.35) : 'rgba(148,163,184,0.3)'}`,
            }
          : null,
        styles.square,
      ]}
    >
      <Text
        style={[
          mono(600),
          styles.line,
          { fontSize, color: hex ? issueSquareFg(hex) : squareInk(selected, resting) },
        ]}
        numberOfLines={1}
      >
        {label.prefix}
      </Text>
      <Text
        style={[
          mono(600),
          styles.line,
          { fontSize, color: hex ? issueSquareFg(hex) : squareInk(selected, resting) },
        ]}
        numberOfLines={1}
      >
        {label.number}
      </Text>
      {badge ? (
        <View style={[styles.badge, { borderColor: ringColor }]}>
          {badge.kind === 'waiting' ? (
            <CountPill count={badge.count ?? 0} size={13} />
          ) : badge.kind === 'working' ? (
            <View style={styles.workingBadge}>
              <BrailleSpinner size={7} />
            </View>
          ) : (
            <View style={styles.workingBadge}>
              <Text style={[mono(700), styles.doneGlyph]}>✓</Text>
            </View>
          )}
        </View>
      ) : null}
    </View>
  )
}

function squareInk(selected: boolean, resting: boolean): string {
  if (selected) return '#e8edf5'
  return resting ? '#8d8d9a' : '#c5c5d0'
}

const styles = StyleSheet.create({
  square: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  restingBorder: {
    borderWidth: 1,
    borderColor: color.textFaint,
    borderStyle: 'dashed',
  },
  line: {
    lineHeight: undefined,
    includeFontPadding: false,
  } as object,
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    borderWidth: 2,
    borderRadius: 999,
  },
  workingBadge: {
    minWidth: 13,
    height: 13,
    borderRadius: 999,
    backgroundColor: '#0c1f18',
    borderWidth: 1,
    borderColor: color.working,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 1,
  },
  doneGlyph: {
    color: color.success,
    fontSize: 7,
  },
})
