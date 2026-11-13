import { Stack } from 'expo-router/stack'
import { View } from 'react-native'
import { color } from '../../theme/theme'
import { type ComposeSheetHeaderProps, ComposeStartButton } from './ComposeStartButton'

/** UIKit owns the bar, the close item and its iOS 26 glass. */
export function ComposeSheetHeader(props: ComposeSheetHeaderProps) {
  return (
    <>
      <Stack.Screen
        options={{
          title: 'New Task',
          headerShown: true,
          headerLargeTitleEnabled: false,
          headerBackVisible: false,
          headerTransparent: true,
          headerShadowVisible: false,
          headerTitleStyle: { color: color.text },
        }}
      />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Cancel" onPress={props.onCancel} />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.View hidesSharedBackground>
          <View style={{ width: 44, height: 44 }}>
            <ComposeStartButton {...props} />
          </View>
        </Stack.Toolbar.View>
      </Stack.Toolbar>
    </>
  )
}
