import { requireNativeView } from 'expo'
import { Text, type ViewProps } from 'react-native'
import { useContentActive } from '../lib/visible-content'
import { caretStyle } from './streaming-caret-style'

const NativeBlink = requireNativeView<ViewProps & { active: boolean }>(
  'PodiumListRow',
  'PodiumBlinkView',
)

/** iOS: the caret's 1 to 0.25 breathing as one Core Animation opacity loop
 * shared by every visible caret; the app computes no frame. Same gate as the
 * RN loop: visible, uncovered, foreground content with Reduce Motion off. */
export function CaretMotion({ reduceMotion }: { reduceMotion: boolean }) {
  const active = useContentActive() && !reduceMotion
  return (
    <NativeBlink active={active} pointerEvents="none" testID="streaming-caret-blink">
      <Text testID="streaming-caret" style={caretStyle}>
        ▋
      </Text>
    </NativeBlink>
  )
}
