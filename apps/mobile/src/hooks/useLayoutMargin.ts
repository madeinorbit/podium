import { Platform, useWindowDimensions } from 'react-native'

/** The native phone bars use 20pt on wide iPhones and 16pt on compact phones. */
export function useLayoutMargin(): number {
  const { width, height } = useWindowDimensions()
  return Platform.OS === 'ios' && Math.min(width, height) >= 414 ? 20 : 16
}
