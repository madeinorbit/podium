/** Only routing/profile platform adapters. No store or pool readers. */
import { useEffect } from 'react'
import type { IssueViewModel } from '@podium/client-core/replica'
import { Text, View } from 'react-native'

export const navigation: { routes: string[] } = { routes: [] }
const router = { push: (route: string) => navigation.routes.push(route), replace: (route: string) => navigation.routes.push(route),
  canGoBack: () => true, back() {} }
const profile = { id: 'synthetic', httpOrigin: 'http://offline.invalid', instanceId: 'synthetic', userId: 'operator' }
const profiles = [profile]
export const useRouter = () => router
export const useFocusEffect = (effect: () => void | (() => void)) => useEffect(effect, [effect])
export const useServerProfile = () => ({ profile, profiles, activation: 'verified' })
export const useContentBottomInset = () => 72
// These siblings have separate owners. Complete Inbox acceptance after
// POD-5356/POD-5370 lands must remove these reader stubs.
export const NewWorkButton = () => null
export const StorageNoticeAlert = () => null
export const RefreshOffer = () => null
// Native swipe animation is outside the reader proof; button decisions still
// execute the real ProposalScreeningScreen and its existing mutation owner.
export function ScreeningCard({ issue, parent }: { issue: IssueViewModel; parent?: IssueViewModel }) {
  return <View testID="screening-card" style={{ padding: 22, gap: 14, backgroundColor: '#242a37', borderRadius: 14 }}>
    <Text style={{ color: '#abb9d2' }}>{issue.displayRef} · P{issue.priority}</Text>
    <Text style={{ color: '#f1f1f2', fontSize: 23 }}>{issue.title}</Text>
    <Text style={{ color: '#d7d8dc' }}>{issue.description}</Text>
    <Text style={{ color: '#abb9d2' }}>{issue.brief}</Text>
    <Text>{parent?.title}</Text>
  </View>
}
