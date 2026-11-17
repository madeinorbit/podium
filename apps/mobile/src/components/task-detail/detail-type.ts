import { useWindowDimensions } from 'react-native'

const scaledSize = (scale: number) => (size: number) => Math.round(size * scale)

/** Keep first-line alignment while giving accessibility text most of the row. */
export function useDetailLayout() {
  const { fontScale } = useWindowDimensions()
  const scale = Math.max(1, fontScale)
  return {
    size: scaledSize(scale),
    accessorySize: scaledSize(Math.min(1.5, scale)),
    accessibility: scale > 1.35,
  }
}

/** Full text metrics, including the minimum height of a scaled input. */
export function useDetailSize() {
  return useDetailLayout().size
}
