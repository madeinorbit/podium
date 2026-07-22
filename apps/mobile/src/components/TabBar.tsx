import { Inbox, KanbanSquare, Rows3 } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, font, mono, radius, sans } from '../theme/theme'
import { Icon } from './Icon'

const ICONS: Record<string, typeof Inbox> = {
  index: Inbox,
  issues: KanbanSquare,
  sessions: Rows3,
}

/** Structural slice of react-navigation's BottomTabBarProps (the package is not
 *  directly importable under bun's isolated install; expo-router provides it). */
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
 * Carved bottom bar [POD-131, replaces the floating glass pill]: the darkest
 * tier (#050912) folded under the content with a hairline seam — surfaces are
 * carved into the chassis, not floated above it (DESIGN.md, The Carved Rule).
 * The active tab is lit Superade Yellow with a 1px top line; the Tray badge
 * is the needs-you count pill. Renders in normal layout flow, so screens never
 * have to guess a floating bar's height.
 */
export function TabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets()

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
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
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              })
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name)
            }}
            style={styles.tab}
          >
            {focused ? <View style={styles.activeLine} /> : null}
            <View>
              <Icon as={IconCmp} size={20} color={focused ? color.accent : color.textFaint} />
              {badge != null && badge !== 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{String(badge)}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.label, focused && styles.labelActive]}>{label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: color.bar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineBar,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingTop: 9,
    paddingBottom: 5,
    minHeight: 52,
  },
  activeLine: {
    position: 'absolute',
    top: 0,
    left: '28%',
    right: '28%',
    height: 1,
    backgroundColor: color.accent,
  },
  label: {
    ...sans(600),
    color: color.textFaint,
    fontSize: font.micro + 0.5,
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
    fontSize: 8.5,
  },
})
