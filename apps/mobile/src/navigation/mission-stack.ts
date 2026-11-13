import type { NavigationState } from 'expo-router/react-navigation'

export const MISSION_CHAT = 'mission/[missionId]'
export const MISSION_DECK = 'mission/[missionId]/details'

/** Insert the return screen without replacing the mounted chat or its history. */
export function missionStack(
  state: NavigationState,
  chatKey: string,
  missionId: string,
  sessionId: string | undefined,
): NavigationState {
  const index = state.routes.findIndex((route) => route.key === chatKey)
  if (index < 0 || state.routes[index]?.name !== MISSION_CHAT) return state
  const previous = state.routes[index - 1]
  const previousParams = previous?.params as { missionId?: string; sessionId?: string } | undefined
  const params = { missionId, ...(sessionId ? { sessionId } : {}) }
  if (previous?.name === MISSION_DECK && previousParams?.missionId === missionId) {
    if (previousParams?.sessionId === sessionId) return state
    const routes = [...state.routes]
    routes[index - 1] = { ...previous, params }
    return { ...state, routes }
  }
  const routes = [...state.routes]
  const underneath = index === 0 ? [{ key: `work-${chatKey}`, name: '(tabs)' }] : []
  routes.splice(index, 0, ...underneath, {
    key: `deck-${chatKey}`,
    name: MISSION_DECK,
    params,
  })
  return { ...state, routes, index: state.index + underneath.length + 1 }
}
