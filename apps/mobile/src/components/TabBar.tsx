import * as Haptics from 'expo-haptics'
import { Inbox, KanbanSquare, MessagesSquare, Rows3 } from 'lucide-react-native'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
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

/** Gap between the capsule and the screen edges it floats off. */
const INSET = 12
/** Clearance under the capsule, on top of the safe-area inset. */
const LIFT = 6

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
 * Floating carved capsule [POD-402, supersedes the edge-to-edge bar of POD-131].
 *
 * POD-131 replaced a floating glass pill with a bar folded flat into the bottom
 * of the chassis, on the Carved Rule. What that rule is against is surfaces that
 * hover with no relationship to what is under them — and iOS 26 moved system tab
 * bars off the screen edge for a reason this app had a concrete case of:
 * anything you tap in the last ~34pt wakes the home indicator, which then sits
 * lit across your navigation. So the geometry moves and the material does not.
 * Still the darkest tier (#050912) under a hairline seam, but cut as a capsule
 * sitting in a trough of canvas rather than welded to the edge.
 *
 * (The indicator was worse than geometry alone explains: the export that shipped
 * had lost `viewport-fit=cover`, so every safe-area inset read 0 and the bar sat
 * flush on the physical edge. Fixed separately, same issue.)
 *
 * Renders in normal layout flow — this outer View reserves capsule + lift +
 * safe area, so screens keep getting a bottom that is theirs and no list has to
 * know a bar is floating over it. Nothing scrolls underneath, either: the
 * capsule is opaque, so content passing behind it would be cut off at a rounded
 * edge rather than diffusing under glass.
 *
 * The active tab is a filled Superade Yellow chip; the Tray badge is the
 * needs-you count pill.
 */
export function TabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets()

  return (
    <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, INSET) + LIFT }]}>
      <View style={styles.capsule}>
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
                  <Icon as={IconCmp} size={20} color={focused ? color.accent : color.textFaint} />
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
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  dock: {
    backgroundColor: color.bg,
    paddingHorizontal: INSET,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'stretch',
    padding: 5,
    borderRadius: 28,
    backgroundColor: color.bar,
    borderWidth: StyleSheet.hairlineWidth,
    // The quieter tier: `hairlineBar` is sized for a single seam against
    // content, and drawn all the way round a capsule it reads as an outline.
    borderColor: color.hairline,
    // The shadow reads as the trough the capsule is set into, not as a card
    // lifted off a page: tight, dark, and almost directly beneath.
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
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
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 5,
    borderRadius: 20,
  },
  chipActive: {
    backgroundColor: color.accentSoft,
  },
  label: {
    ...sans(600),
    color: color.textFaint,
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
