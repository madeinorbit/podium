import { StyleSheet, Text, View } from 'react-native'
import { color } from '../../theme/theme'
import { Glass } from '../Glass'
import { Icon } from '../Icon'
import { PressableScale } from '../PressableScale'
import { type ComposeSheetHeaderProps, ComposeStartButton } from './ComposeStartButton'

/** Web/Android fallback. iOS uses native navigation bar items in the sibling. */
export function ComposeSheetHeader(props: ComposeSheetHeaderProps) {
  return (
    <View style={styles.bar}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        onPress={props.onCancel}
        style={styles.round}
      >
        <Glass interactive style={styles.round}>
          <Icon as="xmark" size={20} color={color.text} />
        </Glass>
      </PressableScale>
      <Text style={styles.title}>New Task</Text>
      <ComposeStartButton {...props} />
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    height: 68,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontWeight: '600', fontSize: 17, color: color.text },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
