import { useNavigation } from 'expo-router'
import type { NativeStackNavigationProp } from 'expo-router/native-stack'
import type { ParamListBase } from 'expo-router/react-navigation'
import { useLayoutEffect, useState } from 'react'

/** Mount the UITextView after UIKit has finished laying out the new sheet.
 * Keep it mounted on later appearances, including native menu dismissal. */
export function useComposePresentation() {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>()
  const [presented, setPresented] = useState(false)
  useLayoutEffect(
    () =>
      navigation.addListener('transitionEnd', (event) => {
        if (!event.data.closing) setPresented(true)
      }),
    [navigation],
  )
  return presented
}
