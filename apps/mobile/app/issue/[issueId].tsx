import { Redirect, useLocalSearchParams } from 'expo-router'
import { MOBILE_HOME } from '../../src/lib/navigation'

/**
 * `/issue/[id]` is a DEEP-LINK TARGET, not a screen [POD-592].
 *
 * There is no second full-screen task page any more: the task inspector lives
 * in the Flight Deck's sheet, and the deck resolves any task to its mission
 * root. Notifications, POD-refs in chat and old bookmarks therefore all land on
 * the mission with that task in view, rather than on a flat page that shows
 * less than the sheet does.
 */
export default function IssueRoute() {
  const params = useLocalSearchParams<{ issueId: string | string[] }>()
  const raw = Array.isArray(params.issueId) ? params.issueId[0] : params.issueId
  if (!raw) return <Redirect href={MOBILE_HOME} />
  return <Redirect href={`/mission/${encodeURIComponent(raw)}`} />
}
