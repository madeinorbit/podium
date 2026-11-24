import { useLocalSearchParams, useRouter } from 'expo-router'
import { HeaderHeightContext } from 'expo-router/react-navigation'
import { use } from 'react'
import { Platform } from 'react-native'
import { useIssueModel } from '../client/use-issue-model'
import { ConfiguredIssueLaunchSheet } from '../components/ConfiguredIssueLaunchSheet'

/** The task to launch comes from the route; the page under the sheet keeps it loaded. */
export function LaunchAgentScreen() {
  const params = useLocalSearchParams<{ issueId: string | string[] }>()
  const raw = Array.isArray(params.issueId) ? params.issueId[0] : params.issueId
  const issue = useIssueModel(raw ? decodeURIComponent(raw) : undefined)
  const router = useRouter()
  const headerHeight = use(HeaderHeightContext) ?? 0
  return (
    <ConfiguredIssueLaunchSheet
      issue={issue ?? null}
      onClose={() => router.back()}
      topInset={Platform.OS === 'ios' ? headerHeight : 0}
    />
  )
}
