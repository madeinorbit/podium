import { BlurView } from 'expo-blur'
import { CircleDot, Inbox, Rows3, Sparkles } from 'lucide-react-native'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, elevation, font, mono, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'

const ICONS: Record<string, typeof Inbox> = {
  index: Inbox,
  sessions: Rows3,
  agent: Sparkles,
  issues: CircleDot,
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
 * Floating glass tab bar — inset from the edges, blurred, with a soft pill
 * behind the active tab and an amber badge dot for needs-you count.
 */
export function TabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets()

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, space.md) }]}
    >
      <BlurView intensity={40} tint="dark" style={[styles.bar, elevation.raised]}>
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
              <View style={[styles.tabInner, focused && styles.tabInnerActive]}>
                <View>
                  <Icon as={IconCmp} size={21} color={focused ? color.accent : color.textFaint} />
                  {badge != null && badge !== 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{String(badge)}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[styles.label, focused && styles.labelActive]}>{label}</Text>
              </View>
            </Pressable>
          )
        })}
      </BlurView>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  bar: {
    flexDirection: 'row',
    marginHorizontal: space.lg,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineBar,
    backgroundColor: 'rgba(10, 10, 14, 0.92)',
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(18px)' } as object) : null),
  },
  tab: {
    flex: 1,
  },
  tabInner: {
    alignItems: 'center',
    gap: 3,
    borderRadius: radius.lg,
    paddingVertical: 7,
    paddingHorizontal: space.sm,
  },
  tabInnerActive: {
    backgroundColor: color.accentSoft,
  },
  label: {
    ...sans(600),
    color: color.textFaint,
    fontSize: font.tiny,
    letterSpacing: 0.2,
  },
  labelActive: {
    color: color.accent,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: radius.full,
    backgroundColor: color.needsYou,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    ...mono(700),
    color: color.onAccent,
    fontSize: 9,
  },
})
