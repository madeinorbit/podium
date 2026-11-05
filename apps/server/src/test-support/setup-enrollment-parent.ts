import {
  ParentRequest,
  parentControlLink,
  setParentControlLink,
} from '@podium/runtime/parent-control'
import { confirmSetupEnrollment, prepareSetupEnrollment } from '@podium/runtime/setup-enrollment'

/** A fixture supervisor's private enrollment channel, confined to its own state. */
export function installSetupEnrollmentParent(stateDir: string) {
  const previous = parentControlLink()
  const actions: Array<'prepare' | 'confirm'> = []
  let connected = true
  setParentControlLink({
    open: () => connected,
    post: async () => {
      throw new Error('the setup fixture does not support parent effects')
    },
    request: async (requestId, raw) => {
      const request = ParentRequest.parse(raw)
      if (request.kind !== 'enrollment' || !request.enrollment)
        throw new Error('the setup fixture only supports enrollment requests')
      const enrollment = request.enrollment
      actions.push(enrollment.action)
      return {
        requestId,
        kind: 'enrollment',
        ok: true,
        completedAt: new Date().toISOString(),
        enrollment:
          enrollment.action === 'prepare'
            ? prepareSetupEnrollment(enrollment.agentExecution, false, stateDir)
            : confirmSetupEnrollment(
                enrollment.setupRequestId ?? '',
                enrollment.publicKey ?? '',
                stateDir,
              ),
      }
    },
  })
  return {
    actions,
    setConnected: (value: boolean) => {
      connected = value
    },
    dispose: () => setParentControlLink(previous),
  }
}
