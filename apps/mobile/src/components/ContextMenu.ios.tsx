import { ContextMenu as NativeContextMenu } from '@expo/ui/swift-ui'
import type { ComponentProps } from 'react'
import { useWindowDimensions } from 'react-native'

/** UIKit snapshots the SwiftUI menu's rows when it builds the interaction.
 * Replace that interaction after a content-size change, without remounting
 * the list or its shared models. Ordinary record updates keep the host. */
export const ContextMenu = Object.assign(
  function ContextMenu(props: ComponentProps<typeof NativeContextMenu>) {
    const { fontScale } = useWindowDimensions()
    return <NativeContextMenu key={fontScale} {...props} />
  },
  {
    Trigger: NativeContextMenu.Trigger,
    Items: NativeContextMenu.Items,
    Preview: NativeContextMenu.Preview,
  },
)
