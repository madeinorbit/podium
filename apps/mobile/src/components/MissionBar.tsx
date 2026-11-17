import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { observer } from 'mobx-react-lite'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useLayoutMargin } from '../hooks/useLayoutMargin'
import { color, font, leading, sans, space } from '../theme/theme'
import { useLiveInk } from '../theme/use-live-ink'
import { Icon } from './Icon'
import type { AppIcon } from './icons'
import { DeckGauge, type DeckVitals, DeckVitalsLine, deckVitals } from './MissionGauge'
import { PressableScale } from './PressableScale'

/** Reads as "a page opens from the right", the way Files and Notes show a trailing panel. */
const OpensFromRight: AppIcon = {
  ios: 'sidebar.right',
  android: 'right_panel_open',
  web: 'right_panel_open',
}

/** "8/14 · 1 needs you · 3 working · 2 up next", zero parts left out. */
export function deckVitalsLabel(vitals: DeckVitals): string {
  return [
    `${vitals.done}/${vitals.total}`,
    vitals.needsYou > 0 ? `${vitals.needsYou} needs you` : null,
    vitals.working > 0 ? `${vitals.working} working` : null,
    vitals.upNext > 0 ? `${vitals.upNext} up next` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The flight deck's vital signs under the chat's nav bar: the counts line, the
 * desktop's segmented gauge along the bottom edge, and a trailing panel symbol.
 * A tap pages to the deck, which also sits one swipe to the right.
 */
export const MissionBar = observer(function MissionBar({
  full,
  onOpen,
}: {
  full: FullDeck
  onOpen: () => void
}) {
  const loadingInk = useLiveInk(color.textDim)
  const { fontScale } = useWindowDimensions()
  const layoutMargin = useLayoutMargin()
  const vitals = deckVitals(full)
  const reading = vitals ? deckVitalsLabel(vitals) : 'Task counts are loading'
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Flight deck, ${reading}`}
      accessibilityHint="Opens the flight deck. You can also swipe left."
      testID="mission-bar"
      onPress={onOpen}
      scaleTo={1}
      haptic={false}
      style={({ pressed }) => [
        styles.bar,
        { paddingHorizontal: layoutMargin },
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.counts}>
        {vitals ? (
          // The native scroll edge binds to this 40pt strip. Drop lower-priority
          // counts as type grows; the full reading remains in the button label.
          <DeckVitalsLine
            vitals={vitals}
            numberOfLines={1}
            maxFontSizeMultiplier={BAR_MAX_SCALE}
            showUpNext={fontScale <= BAR_MAX_SCALE}
            showProgress={
              fontScale < BAR_STATUS_ONLY_SCALE || (vitals.needsYou === 0 && vitals.working === 0)
            }
          />
        ) : (
          <Text
            style={
              loadingInk === color.textDim
                ? styles.loading
                : [styles.loading, { color: loadingInk }]
            }
            numberOfLines={1}
            maxFontSizeMultiplier={BAR_MAX_SCALE}
          >
            Loading tasks…
          </Text>
        )}
      </View>
      <Icon as={OpensFromRight} size={16} color={color.textDim} />
      {vitals ? (
        <View style={styles.edge}>
          <DeckGauge vitals={vitals} height={3} />
        </View>
      ) : null}
    </PressableScale>
  )
})

const BAR_MAX_SCALE = 1.35
/** At double text size, give the line to needs-you/working when either exists. */
const BAR_STATUS_ONLY_SCALE = 2

const styles = StyleSheet.create({
  // Transparent over Glass: the chat scrolls under the bar and the nav bar's
  // scroll edge effect, never under an opaque strip.
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 40,
    // Override the native press target floor so the scroll edge stays at 40pt.
    minHeight: 40,
  },
  pressed: { opacity: 0.6 },
  counts: { flex: 1, minWidth: 0 },
  loading: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  edge: { position: 'absolute', left: 0, right: 0, bottom: 0 },
})
