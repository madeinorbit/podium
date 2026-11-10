import { NativeTabs } from 'expo-router/unstable-native-tabs'
import { color } from '../../src/theme/theme'

/**
 * iOS tab bar: Work is home, Tasks the status board, Pulse the capacity read,
 * Settings a tab as in Apple's own apps, and the system search tab. Super is
 * desktop and web only, so its route is hidden here. No trigger keeps the bar
 * opaque at the scroll edge: content runs under the system glass.
 */
export default function TabsLayout() {
  return (
    <NativeTabs tintColor={color.accentTint} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="work">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'rectangle.split.3x1', selected: 'rectangle.split.3x1.fill' }}
          md="table_rows"
        />
        <NativeTabs.Trigger.Label>Work</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="issues">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'rectangle.3.group', selected: 'rectangle.3.group.fill' }}
          md="view_kanban"
        />
        <NativeTabs.Trigger.Label>Tasks</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="pulse">
        <NativeTabs.Trigger.Icon sf="waveform.path.ecg" md="activity_zone" />
        <NativeTabs.Trigger.Label>Pulse</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'gearshape', selected: 'gearshape.fill' }}
          md="settings"
        />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="superagent" hidden />
    </NativeTabs>
  )
}
