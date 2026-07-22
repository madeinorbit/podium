import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { useMobileClient } from '../../src/client/MobileClientProvider'
import { TabBar } from '../../src/components/TabBar'

/**
 * Three tabs [POD-131]: Tray (the global decision queue + the superagent's
 * standing composer), Tasks (the board/MAP), Agents (the session roster).
 * The superagent conversation is a pushed route (/superagent), not a tab —
 * the composer on Tray is its one-shot entry.
 */
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
      <Tabs.Screen name="issues" options={{ title: 'Tasks' }} />
      <Tabs.Screen name="sessions" options={{ title: 'Agents' }} />
    </Tabs>
  )
}
