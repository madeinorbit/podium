import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { useMobileClient } from '../../src/client/MobileClientProvider'
import { TabBar } from '../../src/components/TabBar'

export default function TabsLayout() {
  const client = useMobileClient()
  const needsYou = groupSessions(withoutShells(client.sessions)).needsYou.length

  return (
    <Tabs
      tabBar={(props) => <TabBar {...(props as unknown as ComponentProps<typeof TabBar>)} />}
      screenOptions={{
        headerShown: false,
        // The floating bar overlays content; screens pad their own scroll ends.
        sceneStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Inbox', tabBarBadge: needsYou > 0 ? needsYou : undefined }}
      />
      <Tabs.Screen name="sessions" options={{ title: 'Sessions' }} />
      <Tabs.Screen name="agent" options={{ title: 'Superagent' }} />
      <Tabs.Screen name="issues" options={{ title: 'Issues' }} />
    </Tabs>
  )
}
