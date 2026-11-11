import { List, RNHostView, VStack } from '@expo/ui/swift-ui'
import {
  ignoreSafeArea,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  useScrollGeometryChange,
} from '@expo/ui/swift-ui/modifiers'
import { type ComponentProps, useLayoutEffect } from 'react'
import { View } from 'react-native'
import { useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { RootTabTitle } from './RootTabTitle'
import { useRootHeader } from './root-header-context'

/** SwiftUI keeps list gestures/virtualization; its geometry worklet feeds Reanimated. */
export function RootTabList({ children, modifiers = [], ...props }: ComponentProps<typeof List>) {
  const header = useRootHeader()
  const offset = header?.offset
  const initialOffset = useSharedValue<number | null>(null)
  // Lane/search changes replace the List, so its new first row starts expanded.
  useLayoutEffect(() => {
    if (offset) offset.value = 0
  }, [offset])
  const insets = useSafeAreaInsets()
  const geometry = useScrollGeometryChange((g) => {
    'worklet'
    if (!offset) return
    if (initialOffset.value === null) initialOffset.value = g.contentOffsetY
    offset.value = Math.max(0, g.contentOffsetY - initialOffset.value)
  })
  return (
    <List
      {...props}
      modifiers={[
        ...modifiers,
        ...(header
          ? [
              ignoreSafeArea({ regions: 'container', edges: 'top' }),
              ...(geometry ? [geometry] : []),
            ]
          : []),
      ]}
    >
      {header ? (
        <VStack
          modifiers={[
            listRowBackground('transparent'),
            listRowSeparator('hidden'),
            listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
          ]}
        >
          <RNHostView matchContents={{ vertical: true }}>
            <View style={{ paddingTop: insets.top }}>
              <RootTabTitle />
            </View>
          </RNHostView>
        </VStack>
      ) : null}
      {children}
    </List>
  )
}
