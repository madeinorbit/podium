import { useLocalSearchParams } from 'expo-router'
import { SessionScreen } from '../../src/screens/SessionScreen'

export default function SessionRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>()
  return <SessionScreen sessionId={Array.isArray(sessionId) ? sessionId[0] : sessionId} />
}
