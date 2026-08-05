import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { useSessions } from '../../src/client/hooks'
import { TabBar } from '../../src/components/TabBar'

/** Tray keeps decisions first; Work mirrors the desktop sidebar's issue-first
 * navigation; Tasks is the full status board; Super Agent is chat-only. */
export default function TabsLayout() {
  const sessions = useSessions()
  const needsYou = groupSessions(withoutShells(sessions)).needsYou.length

  return (
    <Tabs
      tabBar={(props) => <TabBar {...(props as unknown as ComponentProps<typeof TabBar>)} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Tray', tabBarBadge: needsYou > 0 ? needsYou : undefined }}
      />
      <Tabs.Screen name="work" options={{ title: 'Work' }} />
      <Tabs.Screen name="issues" options={{ title: 'Tasks' }} />
      {/* "Super", not "Super Agent": a quarter of a 393pt bar cannot hold two
          words, and the screen's own section bar says "Super agent" [POD-402].
          The accessibility label keeps the full name. */}
      <Tabs.Screen
        name="superagent"
        options={{ title: 'Super', tabBarAccessibilityLabel: 'Super agent' }}
      />
    </Tabs>
  )
}
