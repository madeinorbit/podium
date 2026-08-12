import type { MachineWire } from '@podium/model'
import { useCallback, useRef, useState } from 'react'
import type { Store } from '@/app/store'

export type MachinePairingSetupInfo = Awaited<ReturnType<Store['trpc']['setup']['info']['query']>>

export interface MintMachinePairingOptions {
  copyAgentCredentials?: boolean
  podiumManaged?: boolean
}

export interface MachinePairingController {
  pairingCode: string | null
  joinCommand: string | null
  setupInfo: MachinePairingSetupInfo | null
  publicUrl: string | null
  error: string | null
  loading: boolean
  podiumManaged: boolean
  newMachine: MachineWire | null
  mint: (options?: MintMachinePairingOptions) => Promise<void>
  watchForNewMachine: () => void
  stopWatchingForNewMachine: () => void
  reset: () => void
}

export function findNewMachine(
  machines: readonly MachineWire[],
  baselineIds: ReadonlySet<string>,
  eligible: (machine: MachineWire) => boolean = () => true,
): MachineWire | null {
  return machines.find((machine) => !baselineIds.has(machine.id) && eligible(machine)) ?? null
}

/**
 * Route-neutral controller for pairing a machine.
 *
 * A mint reads setup info alongside the bearer code so every caller gets the
 * server URL and its complete one-line join command from the same operation.
 * New-machine detection compares the live fleet projection with a baseline
 * captured immediately before the user starts pairing.
 */
export function useMachinePairing({
  trpc,
  machines,
  isNewMachineEligible,
  initialPodiumManaged = true,
}: {
  trpc: Store['trpc']
  machines: readonly MachineWire[]
  isNewMachineEligible?: (machine: MachineWire) => boolean
  initialPodiumManaged?: boolean
}): MachinePairingController {
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [joinCommand, setJoinCommand] = useState<string | null>(null)
  const [setupInfo, setSetupInfo] = useState<MachinePairingSetupInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [podiumManaged, setPodiumManaged] = useState(initialPodiumManaged)
  const [baselineIds, setBaselineIds] = useState<ReadonlySet<string>>(() => new Set())
  const [watching, setWatching] = useState(false)
  const requestId = useRef(0)

  const mint = useCallback(
    async (options: MintMachinePairingOptions = {}): Promise<void> => {
      const managed = options.podiumManaged ?? podiumManaged
      const copyAgentCredentials = options.copyAgentCredentials ?? true
      const currentRequest = ++requestId.current
      setPodiumManaged(managed)
      setLoading(true)
      setError(null)
      try {
        const [pairing, info] = await Promise.all([
          trpc.machines.pairingCode.mutate({ copyAgentCredentials, podiumManaged: managed }),
          trpc.setup.info.query(),
        ])
        if (currentRequest !== requestId.current) return
        setPairingCode(pairing.code)
        setJoinCommand(pairing.joinCommand)
        setSetupInfo(info)
      } catch (cause) {
        if (currentRequest !== requestId.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (currentRequest === requestId.current) setLoading(false)
      }
    },
    [podiumManaged, trpc],
  )

  const watchForNewMachine = useCallback((): void => {
    setBaselineIds(new Set(machines.map((machine) => machine.id)))
    setWatching(true)
  }, [machines])

  const stopWatchingForNewMachine = useCallback((): void => {
    setWatching(false)
    setBaselineIds(new Set())
  }, [])

  const reset = useCallback((): void => {
    requestId.current += 1
    setPairingCode(null)
    setJoinCommand(null)
    setSetupInfo(null)
    setError(null)
    setLoading(false)
    setWatching(false)
    setBaselineIds(new Set())
  }, [])

  return {
    pairingCode,
    joinCommand,
    setupInfo,
    publicUrl: setupInfo?.publicUrl ?? null,
    error,
    loading,
    podiumManaged,
    newMachine: watching
      ? findNewMachine(machines, baselineIds, isNewMachineEligible)
      : null,
    mint,
    watchForNewMachine,
    stopWatchingForNewMachine,
    reset,
  }
}
