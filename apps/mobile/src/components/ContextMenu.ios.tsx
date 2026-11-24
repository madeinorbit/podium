import { ContextMenu as NativeContextMenu, VStack } from '@expo/ui/swift-ui'
import { background, frame, padding, tint } from '@expo/ui/swift-ui/modifiers'
import { Children, type ComponentProps, isValidElement, type ReactNode } from 'react'
import { useWindowDimensions } from 'react-native'
import { useLayoutMargin } from '../hooks/useLayoutMargin'
import { color } from '../theme/theme'

/** UIKit snapshots menu rows; rebuild the interaction after a text-size change. */
export const ContextMenu = Object.assign(
  function ContextMenu({
    preview = false,
    ...props
  }: ComponentProps<typeof NativeContextMenu> & { preview?: boolean }) {
    const { width, fontScale } = useWindowDimensions()
    const margin = useLayoutMargin()
    const children = Children.toArray(props.children)
    const trigger = children.find(
      (child) => isValidElement(child) && child.type === NativeContextMenu.Trigger,
    )
    const hasPreview = children.some(
      (child) => isValidElement(child) && child.type === NativeContextMenu.Preview,
    )
    return (
      <NativeContextMenu
        key={fontScale}
        {...props}
        modifiers={[...(props.modifiers ?? []), tint(color.text)]}
      >
        {children}
        {preview && !hasPreview && isValidElement<{ children?: ReactNode }>(trigger) ? (
          <NativeContextMenu.Preview>
            <VStack
              modifiers={[
                padding({ horizontal: 12, vertical: 12 }),
                frame({ width: width - 2 * margin, alignment: 'leading' }),
                background(color.groupedCard),
              ]}
            >
              {trigger.props.children}
            </VStack>
          </NativeContextMenu.Preview>
        ) : null}
      </NativeContextMenu>
    )
  },
  {
    Trigger: NativeContextMenu.Trigger,
    Items: NativeContextMenu.Items,
    Preview: NativeContextMenu.Preview,
  },
)
