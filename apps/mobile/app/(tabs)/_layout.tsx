import { Tabs } from 'expo-router'
import { NativeTabs } from 'expo-router/unstable-native-tabs'
import type { ComponentProps } from 'react'
import { Platform } from 'react-native'
import { TabBar } from '../../src/components/TabBar'
import { MOBILE_TABS } from '../../src/lib/navigation'
import { color } from '../../src/theme/theme'

/** Work is home and mirrors the desktop sidebar's issue-first navigation;
 * Tasks is the full status board; Super Agent is chat-only; Pulse answers
 * whether there is room to start more work [POD-662]. */

/**
 * iOS gets the REAL UITabBar and the REAL iOS 26 Liquid Glass capsule — which
 * only exists while NOTHING sets a custom appearance on the tab items:
 * assigning any UITabBarAppearance opts UIKit out of the glass. Stock
 * react-native-screens assigns one unconditionally (patched to keep nil — see
 * the podium patches in react-native-screens/ios/tabs and expo-router's
 * appearance.ios.js), so this component must stay BARE: `tintColor` is safe
 * (plain UITabBar.tintColor), but adding iconColor/labelStyle/background
 * props would rebuild the appearance objects and kill the glass again.
 *
 * Web — and any platform without the native host — keeps the custom capsule
 * TabBar the PWA has always shipped.
 */
function IosNativeTabsLayout() {
  return (
    // `minimizeBehavior` is the iOS-26 Fitness-style bar shrink on scroll.
    // GLASS-SAFE (verified in react-native-screens 4.26.2 source): the native
    // side assigns `_controller.tabBarMinimizeBehavior` on the
    // UITabBarController directly and never constructs a UITabBarAppearance,
    // so it cannot re-trigger the appearance assignment that kills the Liquid
    // Glass capsule. UIKit drives it from its own content-scroll-view
    // discovery — the JS minimize plumbing plays no part on iOS.
    <NativeTabs tintColor={color.accentTint} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name={MOBILE_TABS[0].name}>
        <NativeTabs.Trigger.Icon sf="list.bullet.rectangle" />
        <NativeTabs.Trigger.Label>{MOBILE_TABS[0].title}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name={MOBILE_TABS[1].name}>
        <NativeTabs.Trigger.Icon sf="rectangle.split.3x1" />
        <NativeTabs.Trigger.Label>{MOBILE_TABS[1].title}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name={MOBILE_TABS[2].name}>
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" />
        {/* "Super", not "Super Agent": a quarter of a 393pt bar cannot hold
            two words, and the screen's own large title says "Superagent". */}
        <NativeTabs.Trigger.Label>{MOBILE_TABS[2].title}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name={MOBILE_TABS[3].name}>
        <NativeTabs.Trigger.Icon sf="waveform.path.ecg" />
        <NativeTabs.Trigger.Label>{MOBILE_TABS[3].title}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}

function CustomTabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...(props as unknown as ComponentProps<typeof TabBar>)} />}
      // `freezeOnBlur` suspends blurred tab scenes (react-freeze) so the three
      // tabs you are NOT looking at stop paying for every store publish. Real
      // on Android (react-native-screens Screen); a no-op on web, where the
      // navigator falls back to plain Views — web scenes stay mounted.
      screenOptions={{ headerShown: false, freezeOnBlur: true }}
    >
      <Tabs.Screen name={MOBILE_TABS[0].name} options={{ title: MOBILE_TABS[0].title }} />
      <Tabs.Screen name={MOBILE_TABS[1].name} options={{ title: MOBILE_TABS[1].title }} />
      {/* "Super", not "Super Agent" — see IosNativeTabsLayout.
          The accessibility label keeps the full name. */}
      <Tabs.Screen
        name={MOBILE_TABS[2].name}
        options={{ title: MOBILE_TABS[2].title, tabBarAccessibilityLabel: 'Super agent' }}
      />
      <Tabs.Screen
        name={MOBILE_TABS[3].name}
        options={{
          title: MOBILE_TABS[3].title,
          tabBarAccessibilityLabel: 'Pulse — capacity and usage',
        }}
      />
    </Tabs>
  )
}

export default function TabsLayout() {
  return Platform.OS === 'ios' ? <IosNativeTabsLayout /> : <CustomTabsLayout />
}
