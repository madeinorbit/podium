import { StyleSheet, Text, type TextProps, useWindowDimensions } from 'react-native'
import { color } from '../../theme/theme'
import { useLiveInk } from '../../theme/use-live-ink'

/** Replace only the native text leaf when size changes. This invalidates a
 * retained Fabric measurement while folds and edit drafts stay mounted. */
export function DetailText(props: TextProps) {
  const { fontScale } = useWindowDimensions()
  const declared = StyleSheet.flatten(props.style)?.color
  const ink = useLiveInk((declared ?? color.body) as string)
  return (
    <Text key={fontScale} {...props} style={[props.style, declared != null && { color: ink }]} />
  )
}
