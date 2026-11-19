/** A real named-export screen, declared by the harness only after startup idle. */
import { UsageView } from '@/features/usage/UsageView'

export function UnvisitedScreen() {
  return <UsageView onClose={() => {}} />
}
