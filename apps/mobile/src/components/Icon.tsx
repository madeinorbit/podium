import { SymbolView } from 'expo-symbols'
import { useLiveInk } from '../theme/use-live-ink'
import type { AppIcon } from './icons'

interface IconProps {
  as: AppIcon
  size: number
  color: string
}

export function Icon({ as, size, color }: IconProps) {
  const tint = useLiveInk(color)
  return (
    <SymbolView
      name={as}
      size={size}
      tintColor={tint}
      weight="regular"
      resizeMode="scaleAspectFit"
    />
  )
}
