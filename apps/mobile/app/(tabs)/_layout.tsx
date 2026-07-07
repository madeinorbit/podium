import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { Tabs } from 'expo-router'
import { CircleDot, Inbox, Rows3, Sparkles } from 'lucide-react-native'
import { useMobileClient } from '../../src/client/MobileClientProvider'
import { Icon } from '../../src/components/Icon'
import { color, font } from '../../src/theme/theme'

export default function TabsLayout() {
  const client = useMobileClient()
  const needsYou = groupSessions(withoutShells(client.sessions)).needsYou.length

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: color.bgRaised,
          borderTopColor: color.border,
        },
        tabBarActiveTintColor: color.accent,
        tabBarInactiveTintColor: color.textFaint,
        tabBarLabelStyle: { fontSize: font.tiny, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Inbox',
          tabBarIcon: ({ color: tint, size }) => (
            <Icon as={Inbox} size={size} color={String(tint)} />
          ),
          tabBarBadge: needsYou > 0 ? needsYou : undefined,
          tabBarBadgeStyle: { backgroundColor: color.needsYou, color: color.accentText },
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color: tint, size }) => (
            <Icon as={Rows3} size={size} color={String(tint)} />
          ),
        }}
      />
      <Tabs.Screen
        name="agent"
        options={{
          title: 'Superagent',
          tabBarIcon: ({ color: tint, size }) => (
            <Icon as={Sparkles} size={size} color={String(tint)} />
          ),
        }}
      />
      <Tabs.Screen
        name="issues"
        options={{
          title: 'Issues',
          tabBarIcon: ({ color: tint, size }) => (
            <Icon as={CircleDot} size={size} color={String(tint)} />
          ),
        }}
      />
    </Tabs>
  )
}
