import { NativeTabs } from 'expo-router/unstable-native-tabs'
import { color } from '../../src/theme/theme'

/** Android tab bar (iOS has `_layout.ios.tsx`). Work is home and mirrors the
 * desktop sidebar's issue-first navigation; Tasks is the full status board;
 * Super Agent is chat-only; Pulse answers whether there is room to start more
 * work [POD-662]; Settings is a tab. */
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
      <NativeTabs.Trigger name="superagent">
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'bubble.left.and.bubble.right',
            selected: 'bubble.left.and.bubble.right.fill',
          }}
          md="forum"
        />
        <NativeTabs.Trigger.Label>Super</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="pulse">
        <NativeTabs.Trigger.Icon sf="waveform.path.ecg" md="activity_zone" />
        <NativeTabs.Trigger.Label>Pulse</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
