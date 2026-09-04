import { SymbolView } from 'expo-symbols'
import type { AppIcon } from './icons'

interface IconProps {
  as: AppIcon
  size: number
  color: string
}

export function Icon({ as, size, color }: IconProps) {
  return (
    <SymbolView
      name={as}
      size={size}
      tintColor={color}
      weight="regular"
      resizeMode="scaleAspectFit"
    />
  )
}
