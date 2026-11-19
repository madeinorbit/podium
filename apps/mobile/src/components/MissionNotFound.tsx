import { useConnected } from '../client/hooks'
import { EmptyState } from './ui'

/**
 * A mission opening that settled without its mission. Online that is the
 * answer: there is no such mission. Offline it only says this phone does not
 * hold it, so it says that instead of claiming the mission is gone (POD-7176;
 * POD-541's rule for a task the cache lacks).
 */
export function MissionNotFound({ fill }: { fill?: boolean }) {
  const connected = useConnected()
  return connected ? (
    <EmptyState fill={fill} title="Mission not found." />
  ) : (
    <EmptyState
      fill={fill}
      title="Not available offline"
      body="This phone has not loaded this mission yet. It opens once the connection is back."
    />
  )
}
