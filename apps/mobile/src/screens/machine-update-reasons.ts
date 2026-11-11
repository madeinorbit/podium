import type { MachineTargetUnavailableReasons } from '@podium/client-core/values'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import type { MachineWire } from '@podium/model'
import { useFocusEffect } from 'expo-router'
import { useCallback } from 'react'
import { demoEnabled } from '../client/demoData'
import { useTrpc } from '../client/hooks'
import { followPhoneRequest } from '../client/visible-request'

/** Only the transient explanations are request answers; machine facts stay in the pool. */
export class MachineUpdateReasons extends RequestAnswer<MachineTargetUnavailableReasons> {
  read(
    read: () => Promise<readonly Pick<MachineWire, 'id' | 'targetUnavailableReason'>[]>,
  ): Promise<void> {
    return this.load(read, false, (machines) =>
      Object.fromEntries(
        machines.map((machine) => [machine.id, machine.targetUnavailableReason ?? null]),
      ),
    )
  }
}

/** Match the web update view: ask machines.list only while this view is visible. */
export function useMachineUpdateReasons(request: MachineUpdateReasons | null): void {
  const trpc = useTrpc()
  const demo = demoEnabled()
  useFocusEffect(
    useCallback(() => {
      if (!request || demo) return
      const stop = followPhoneRequest(() => {
        if (!request.loading) void request.read(() => trpc.machines.list.query())
      })
      return () => {
        stop()
        request.close()
      }
    }, [request, trpc, demo]),
  )
}
