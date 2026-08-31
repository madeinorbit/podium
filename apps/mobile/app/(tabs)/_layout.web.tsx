import { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { TabBar } from '../../src/components/TabBar'
import { MOBILE_TABS } from '../../src/lib/navigation'

/** The unsupported-bound web build keeps its existing floating tab bar. */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...(props as unknown as ComponentProps<typeof TabBar>)} />}
      // Web keeps the custom floating bar. Blurred native screens freeze in
      // the platform layout; the web navigator leaves scenes mounted.
      screenOptions={{ headerShown: false, freezeOnBlur: true }}
    >
      <Tabs.Screen name={MOBILE_TABS[0].name} options={{ title: MOBILE_TABS[0].title }} />
      <Tabs.Screen name={MOBILE_TABS[1].name} options={{ title: MOBILE_TABS[1].title }} />
      <Tabs.Screen
        name={MOBILE_TABS[2].name}
        options={{ title: MOBILE_TABS[2].title, tabBarAccessibilityLabel: 'Super agent' }}
      />
      <Tabs.Screen
        name={MOBILE_TABS[3].name}
        options={{
          title: MOBILE_TABS[3].title,
          tabBarAccessibilityLabel: 'Pulse, capacity and usage',
        }}
      />
    </Tabs>
  )
}
