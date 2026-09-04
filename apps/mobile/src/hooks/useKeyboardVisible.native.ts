import { useKeyboardState } from 'react-native-keyboard-controller'

export function useKeyboardVisible(): boolean {
  return useKeyboardState((state) => state.isVisible)
}
