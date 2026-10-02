import { createContext } from 'react'
import type { ComponentProps, ComponentType } from 'react'
import type { SessionContextMenu } from '@/lib/SessionContextMenu'

/** Only the mission pane supplies an addressed menu component. */
export const MissionSessionMenu = createContext<ComponentType<ComponentProps<typeof SessionContextMenu>> | null>(null)
