import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { useMobileClient } from '../../src/client/MobileClientProvider'
import { TabBar } from '../../src/components/TabBar'

/** Tray keeps decisions first; Work mirrors the desktop sidebar's issue-first
 * navigation; Tasks is the full status board; Super Agent is chat-only. */
export default function TabsLayout() {
  const client = useMobileClient()
  const needsYou = groupSessions(withoutShells(client.sessions)).needsYou.length

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
      <Tabs.Screen name="superagent" options={{ title: 'Super Agent' }} />
    </Tabs>
  )
}
