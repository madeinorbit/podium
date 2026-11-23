import { View } from 'react-native'
import { adaptiveColor, color } from '../../theme/theme'
import { Glass } from '../Glass'
import { Icon } from '../Icon'
import { PressableScale } from '../PressableScale'
import { ComposeMenu, type ComposeMenuItem } from './ComposeMenu'

export interface ComposeSheetHeaderProps {
  hasPrompt: boolean
  busy: boolean
  canStart: boolean
  canSave: boolean
  saveReason?: string
  onCancel: () => void
  onStart: () => void
  onSave: () => void
}

export function composeStartItems(props: ComposeSheetHeaderProps): ComposeMenuItem[] {
  return [
    {
      id: 'start',
      label: 'Start Task',
      symbol: 'arrow.up',
      disabled: !props.canStart,
      onPress: props.onStart,
    },
    {
      id: 'save',
      label: 'Save to Backlog',
      symbol: 'tray.and.arrow.down',
      subtitle: props.saveReason,
      disabled: !props.canSave,
      onPress: props.onSave,
    },
  ]
}

export function ComposeStartButton(props: ComposeSheetHeaderProps) {
  const tinted = props.hasPrompt && props.canStart
  return (
    <ComposeMenu
      label="Start options"
      items={composeStartItems(props)}
      onPrimaryAction={() => {
        if (props.canStart) props.onStart()
      }}
      disabled={props.busy}
      style={{ width: 44, height: 44 }}
    >
      {(onPress, onLongPress) => {
        const content = (
          <Glass
            interactive
            tintColor={
              tinted ? adaptiveColor('#a8762a', '#d9b477', '#81591b', '#e1c392') : undefined
            }
            style={styles.round}
          >
            <Icon
              as="arrow.up"
              size={22}
              color={
                tinted
                  ? adaptiveColor('#ffffff', '#16171a', '#ffffff', '#16171a')
                  : props.canStart
                    ? color.text
                    : color.textMicro
              }
            />
          </Glass>
        )
        return onPress ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Start Task"
            accessibilityHint="Hold for Save to Backlog"
            accessibilityState={{ disabled: !props.canStart }}
            aria-disabled={!props.canStart}
            onPress={onPress}
            onLongPress={onLongPress}
            style={styles.round}
          >
            {content}
          </PressableScale>
        ) : (
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel="Start Task"
            accessibilityHint="Hold for Save to Backlog"
            accessibilityState={{ disabled: !props.canStart }}
            aria-disabled={!props.canStart}
            style={styles.round}
          >
            {content}
          </View>
        )
      }}
    </ComposeMenu>
  )
}

const styles = {
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
}
