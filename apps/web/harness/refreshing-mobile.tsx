import { createContext, useRef } from 'react'
import { fixture } from './refreshing-state'

const noop = () => {}
export const useRouter = () => ({
  push: noop,
  back: noop,
  replace: noop,
  dismissTo: noop,
  canGoBack: () => true,
})
export const useLocalSearchParams = () => ({ missionId: 'root' })
export const useFocusEffect = noop
export const Stack = { Screen: () => null, SearchBar: () => null }
export const BottomTabBarHeightContext = createContext<number | undefined>(undefined)
export const useBooting = () => false
export const useConnected = () => false
export const useHub = () => ({ on: () => noop })
export const useMissionOpening = () => ({ screen: fixture.deck, resolved: true })
export const useMobileMemberRoster = () => undefined
export const useMemberRosterReader = useMobileMemberRoster
export const memberDisplayName = (_roster: unknown, _id: unknown, fallback?: string) =>
  fallback ?? 'Member'
const uiState = { get: () => null, set: noop, subscribe: () => noop }
export const useUiState = () => uiState
export const useIssueCloseGuard = () => () => false
export const useContentBottomInset = () => 34
export const useMinimizeTabBarOnScroll = () => ({})
export function useRefreshableTab() {
  return {
    listRef: useRef(null),
    refreshControl: undefined,
    refreshAccessibilityProps: {},
    refreshing: false,
    onRefresh: noop,
    connected: false,
  }
}
export const ActionSheet = () => null
export const IssueCloseSheet = () => null
export const StorageNoticeAlert = () => null
export const RefreshOffer = () => null
export const NotSavedMark = () => null
export const TaskFiltersSheet = () => null
export const WorkIssueMenu = () => null
export const ConfiguredIssueLaunchSheet = () => null
