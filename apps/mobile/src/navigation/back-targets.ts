/**
 * Where "back" goes, and what it is called, for screens pushed on the root
 * stack over the tabs [POD-2527].
 */

/** The tab bar's own names for its routes (app/(tabs)/_layout.ios.tsx). */
const TAB_TITLES: Record<string, string> = {
  work: 'Work',
  issues: 'Tasks',
  pulse: 'Pulse',
  settings: 'Settings',
  superagent: 'Super',
}

/**
 * The title the root stack gives its tabs route, which is what iOS names the
 * back button of every screen pushed over the tabs (VoiceOver, the long-press
 * menu). It follows the tab the user came from, so a chat opened from Tasks
 * goes back to "Tasks", not "Work". Before the tabs navigator reports a
 * focused route, the app is on its first tab, Work.
 */
export function tabsBackTitle(focusedRouteName: string | undefined): string {
  const tab = focusedRouteName?.split('/')[0]
  return (tab && TAB_TITLES[tab]) || 'Work'
}

/**
 * On the mission's flight deck page, a back or pop that would leave the screen
 * pages to the chat instead, as the edge swipe on that page does. Any other
 * removal (a link replacing the screen, a reset) goes through unchanged.
 */
export function deckBackReturnsToChat(action: { type: string }): boolean {
  return action.type === 'GO_BACK' || action.type === 'POP'
}
