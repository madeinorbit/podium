import { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { TabBar } from '../../src/components/TabBar'
import { MOBILE_TABS } from '../../src/lib/navigation'

/** Work is home and mirrors the desktop sidebar's issue-first navigation;
 * Tasks is the full status board; Super Agent is chat-only. */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...(props as unknown as ComponentProps<typeof TabBar>)} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name={MOBILE_TABS[0].name} options={{ title: MOBILE_TABS[0].title }} />
      <Tabs.Screen name={MOBILE_TABS[1].name} options={{ title: MOBILE_TABS[1].title }} />
      {/* "Super", not "Super Agent": a quarter of a 393pt bar cannot hold two
          words, and the screen's own section bar says "Super agent" [POD-402].
          The accessibility label keeps the full name. */}
      <Tabs.Screen
        name={MOBILE_TABS[2].name}
        options={{ title: MOBILE_TABS[2].title, tabBarAccessibilityLabel: 'Super agent' }}
      />
    </Tabs>
  )
}
