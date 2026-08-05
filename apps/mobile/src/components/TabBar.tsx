import { BlurView } from 'expo-blur'
import * as Haptics from 'expo-haptics'
import { BottomTabBarHeightCallbackContext } from 'expo-router/build/react-navigation/bottom-tabs'
import { Inbox, KanbanSquare, MessagesSquare, Rows3 } from 'lucide-react-native'
import { useContext } from 'react'
import { type LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { emitTabReselect } from '../lib/tab-reselect'
import { color, font, mono, radius, sans } from '../theme/theme'
import { Icon } from './Icon'

const ICONS: Record<string, typeof Inbox> = {
  index: Inbox,
  work: Rows3,
  issues: KanbanSquare,
  superagent: MessagesSquare,
}

/** Gap between the capsule and the screen edges it floats over. */
const INSET = 12

/**
 * Structural slice of react-navigation's BottomTabBarProps (the package is not
 * directly importable under bun's isolated install; expo-router provides it).
 */
interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] }
  descriptors: Record<
    string,
    {
      options: {
        title?: string
        tabBarBadge?: string | number
        tabBarAccessibilityLabel?: string
      }
    }
  >
  navigation: {
    emit(e: { type: string; target?: string; canPreventDefault: true }): {
      defaultPrevented: boolean
    }
    navigate(name: string): void
  }
}

/**
 * Floating glass capsule, over the content [POD-420].
 *
 * The previous version floated visually but still took its height out of the
 * layout, which is the arrangement iOS left behind: an opaque bar owns a strip
 * of the screen, the list ends at its top edge mid-card, and the safe-area band
 * below it is dead pixels. What ships today — iOS 26's tab bar, and what
 * `expo-router/unstable-native-tabs` gets for free from UITabBarController on a
 * native build — is the opposite: the bar consumes NO layout height, the
 * content runs full-bleed underneath it, and the bar is translucent so you can
 * see what you are scrolling past.
 *
 * This is the web build, where native tabs do not exist, so the behaviour is
 * reproduced directly:
 *
 *  - the dock is absolutely positioned and `box-none`, so it neither takes
 *    space nor swallows taps aimed at the content beside the capsule;
 *  - the capsule is a BlurView (backdrop-filter in Safari) over a navy scrim,
 *    rather than the flat #050912 that made content vanish at its edge;
 *  - its measured height goes back to the navigator through
 *    `BottomTabBarHeightCallbackContext`, which is how react-navigation feeds
 *    `useBottomTabBarHeight()`. Screens pad their scrollers by it (see
 *    ../hooks/useTabBarInset) so the last row still clears the bar.
 *
 * Deliberately NOT included: minimize-on-scroll. On iOS 26 that is opt-in
 * (`tabBarMinimizeBehavior`), not the default tab bar, and it would couple this
 * component to every screen's scroll handler.
 *
 * The active tab is a Superade Yellow chip; the Tray badge is the needs-you
 * count pill.
 */
export function TabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets()
  const onHeightChange = useContext(BottomTabBarHeightCallbackContext)

  // The navigator starts from an estimate and corrects on this measurement;
  // reporting it is what makes the floating bar safe to scroll under.
  const handleLayout = (e: LayoutChangeEvent) => onHeightChange?.(e.nativeEvent.layout.height)

  return (
    <View
      style={[styles.dock, { paddingBottom: Math.max(insets.bottom, INSET) }]}
      onLayout={handleLayout}
      pointerEvents="box-none"
    >
      <BlurView intensity={32} tint="dark" style={styles.capsule}>
        {/* Navy over the blur: Safari's backdrop-filter alone barely reads on a
            near-black canvas, and the tabs need a stable ground to sit on. */}
        <View style={styles.scrim} pointerEvents="none" />
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key]
          const label = typeof options.title === 'string' ? options.title : route.name
          const focused = state.index === index
          const IconCmp = ICONS[route.name] ?? Inbox
          const badge = options.tabBarBadge
          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityState={focused ? { selected: true } : {}}
              accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
              onPress={() => {
                // Selection feedback, not impact: switching tabs is a picker, and
                // iOS reserves the softer tick for exactly this [POD-366].
                if (Platform.OS !== 'web') {
                  Haptics.selectionAsync().catch(() => {})
                }
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                })
                if (event.defaultPrevented) return
                // Re-tapping the focused tab scrolls its list to the top rather
                // than doing nothing, which is what it used to do.
                if (focused) emitTabReselect(route.name)
                else navigation.navigate(route.name)
              }}
              style={styles.tab}
            >
              <View style={[styles.chip, focused && styles.chipActive]}>
                <View>
                  <Icon as={IconCmp} size={20} color={focused ? color.accent : color.textDim} />
                  {badge != null && badge !== 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{String(badge)}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[styles.label, focused && styles.labelActive]} numberOfLines={1}>
                  {label}
                </Text>
              </View>
            </Pressable>
          )
        })}
      </BlurView>
    </View>
  )
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: INSET,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'stretch',
    padding: 5,
    borderRadius: 28,
    // The blur is drawn by the child layer, so the radius has to clip it.
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.5)',
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(5, 9, 18, 0.6)',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    // 44pt of tappable height even though the chip drawn inside is shorter.
    minHeight: 46,
  },
  chip: {
    // Hugs its label rather than filling the cell: a quarter-width block of
    // Superade Yellow is a bigger claim on attention than "you are here".
    alignSelf: 'center',
    maxWidth: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 5,
    borderRadius: 20,
  },
  chipActive: {
    backgroundColor: color.accentSoft,
  },
  label: {
    ...sans(600),
    // A step brighter than the old `textFaint`: the inactive tabs now sit over
    // moving content instead of a flat bar, and had stopped being readable.
    color: color.textDim,
    fontSize: font.micro,
  },
  labelActive: {
    color: color.accent,
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -11,
    minWidth: 15,
    height: 15,
    borderRadius: radius.full,
    backgroundColor: color.needsYou,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    ...mono(700),
    color: color.onAccent,
    fontSize: font.micro,
  },
})
