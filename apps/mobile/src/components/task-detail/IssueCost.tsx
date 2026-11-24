import { TaskCostModel } from '@podium/client-graph/task-cost-model'
import { useEffect, useMemo } from 'react'
import { AppState } from 'react-native'
import { useTrpc } from '../../client/hooks'
import { issueObserver as observer } from '../../client/issue-observer'
import { useProjectionFocus } from '../../client/projection-focus'
import { CostReading } from './CostReading'

/** The desktop cost request owner, scoped to one detail opening and visible
 * only while this route is focused and the app is in the foreground. */
export const IssueCost = observer(function IssueCost({ issueId }: { issueId: string }) {
  const trpc = useTrpc()
  const focused = useProjectionFocus()
  const model = useMemo(
    () => new TaskCostModel((input) => trpc.cost.taskComparison.query(input), issueId, false),
    [trpc, issueId],
  )
  useEffect(() => {
    model.open()
    return () => model.close()
  }, [model])
  useEffect(() => {
    const visibility = () =>
      model.setVisible(
        focused &&
          (AppState.currentState == null || AppState.currentState === 'active') &&
          (typeof document === 'undefined' || document.visibilityState !== 'hidden'),
      )
    const subscription = AppState.addEventListener('change', visibility)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
    visibility()
    return () => {
      subscription.remove()
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', visibility)
      model.setVisible(false)
    }
  }, [model, focused])
  return <CostReading model={model} />
})
