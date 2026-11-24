import type { observer } from 'mobx-react-lite'
import type { FunctionComponent } from 'react'
import { LOADING } from './worklist/rollup'

/** Keep a loading section's addressed reads observed. Its neighbours remain
 * mounted; when the batched load arrives MobX retries this section alone.
 * `loading` draws the section meanwhile (nothing by default).
 * Both are called as plain functions: an observer()/memo() result is an
 * object TypeScript still accepts, so it is refused here rather than at render. */
export function createIssueObserver(observe: typeof observer) {
  return function issueObserver<P extends object>(
    render: FunctionComponent<P>,
    loading?: FunctionComponent<P>,
  ) {
    if (typeof render !== 'function' || (loading && typeof loading !== 'function'))
      throw new TypeError('issueObserver needs plain function components, not observer()/memo()')
    const Section: FunctionComponent<P> = (props) => {
      try {
        return render(props)
      } catch (error) {
        if (error === LOADING) return loading ? loading(props) : null
        throw error
      }
    }
    Section.displayName = render.displayName ?? render.name
    return observe(Section)
  }
}
