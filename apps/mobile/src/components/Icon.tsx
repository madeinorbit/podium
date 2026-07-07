import { type ComponentType, createElement } from 'react'

interface IconProps {
  as: ComponentType<any>
  size: number
  color: string
}

export function Icon({ as, size, color }: IconProps) {
  return createElement(as, { size, color })
}
