import { useWindowDimensions } from 'react-native'

/** Match the native deck rows' Dynamic Type sizing for non-text geometry. */
export function useDetailSize() {
  const { fontScale } = useWindowDimensions()
  const scale = Math.max(1, fontScale)
  return (size: number) => Math.round(size * scale)
}
