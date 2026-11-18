import type { Href, ImperativeRouter } from 'expo-router'
import { INTERNAL_SLOT_NAME } from 'expo-router/build/constants'
import type {
  NavigationContainerRef,
  NavigationState,
  ParamListBase,
  PartialState,
} from 'expo-router/react-navigation'

/** These routes are presented by the native root layout, above its card stack. */
export const ROOT_SHEET_ROUTES = ['new-issue', 'launch/[issueId]', 'inspect/[issueId]'] as const

export function isRootSheetRoute(name: string): boolean {
  return ROOT_SHEET_ROUTES.some((sheet) => sheet === name)
}

type RootNavigation = Pick<NavigationContainerRef<ParamListBase>, 'getRootState' | 'dispatch'>

/** Expo's container mounts app/_layout inside its __root route, above the app Stack. */
export function appStackState(
  state: NavigationState | PartialState<NavigationState> | undefined,
): NavigationState | PartialState<NavigationState> | undefined {
  let current = state
  while (current) {
    const slot = current.routes.find((route) => route.name === INTERNAL_SLOT_NAME)
    if (!slot) return current
    current = slot.state
  }
  return undefined
}

function isRootScreen(href: Href): boolean {
  const path = typeof href === 'string' ? href : href.pathname
  return /^\/(?:session|issue|mission)\//.test(path)
}

/**
 * A card opened from a sheet belongs above the page that presented the sheet.
 * Dismiss the root's presented routes, then let Expo Router resolve the href.
 * Reading at dispatch keeps retained link handlers on the current stack.
 */
export function rootScreenRouter(
  router: ImperativeRouter,
  navigation: RootNavigation | undefined,
): ImperativeRouter {
  const open = (
    method: 'push' | 'replace',
    href: Href,
    options?: Parameters<ImperativeRouter['push']>[1],
  ) => {
    const state = isRootScreen(href) ? appStackState(navigation?.getRootState()) : undefined
    const routes = state?.routes.filter((route) => !isRootSheetRoute(route.name))
    if (state?.key && routes?.length && routes.length !== state.routes.length) {
      // Retain card keys and nested tab state, including cards that an older
      // link already pushed above a sheet. A pop-to-tabs would erase history.
      navigation?.dispatch({
        type: 'RESET',
        target: state.key,
        payload: { ...state, routes, index: routes.length - 1 },
      })
      // Replacing a sheet must not replace the issue/mission underneath it.
      method = 'push'
    }
    if (options === undefined) router[method](href)
    else router[method](href, options)
  }
  return {
    ...router,
    push: (href, options) => open('push', href, options),
    replace: (href, options) => open('replace', href, options),
  }
}
