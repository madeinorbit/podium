import type { FunctionComponent } from 'react'
import type { observer } from 'mobx-react-lite'
import { LOADING } from './worklist/rollup'

/** Keep a loading section's addressed reads observed. Its neighbours remain
 * mounted; when the batched load arrives MobX retries this section alone. */
export function createIssueObserver(observe: typeof observer) {
  return function issueObserver<P extends object>(render: FunctionComponent<P>) {
    const Section: FunctionComponent<P> = (props) => {
      try {
        return render(props)
      } catch (error) {
        if (error === LOADING) return null
        throw error
      }
    }
    Section.displayName = render.displayName ?? render.name
    return observe(Section)
  }
}
