import { AUTO, modelOptions } from '@podium/client-core/agent-models'
import type { MachineModel } from '@podium/client-graph'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { HarnessAgent } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import { useModelCatalogState } from '@/lib/use-model-catalog'
import { useSettingsAuthorizedMachines } from '../readers'

/** Read each authorized machine's own catalog. Offline machines retain their
 * last report; wait for pending checks before naming unavailable machines. */
const MachineModelWarning = observer(function MachineModelWarning({
  machines, index, harness, model, descriptors, missing = [], loading = false,
}: {
  machines: readonly MachineModel[]
  index: number
  harness: HarnessAgent
  model: string
  descriptors?: readonly HarnessDescriptorWire[]
  missing?: readonly string[]
  loading?: boolean
}) {
  const machine = machines[index]!
  const { catalog, status } = useModelCatalogState(machine.id)
  const reported = catalog[harness]
  const names = reported?.length && !modelOptions(harness, reported, descriptors).some((option) => option.value === model)
    ? [...missing, machine.name] : missing
  const pending = loading || status === 'loading'
  if (index + 1 < machines.length) return (
    <MachineModelWarning
      key={machines[index + 1]!.id}
      machines={machines}
      index={index + 1}
      harness={harness}
      model={model}
      descriptors={descriptors}
      missing={names}
      loading={pending}
    />
  )
  return !pending && names.length > 0 ? (
    <span className="block text-warning" role="status">Not offered on {names.join(', ')}</span>
  ) : null
})

export const ModelAvailabilityWarning = observer(function ModelAvailabilityWarning({
  harness, model, descriptors,
}: {
  harness: HarnessAgent
  model: string
  descriptors?: readonly HarnessDescriptorWire[]
}) {
  const machines = useSettingsAuthorizedMachines()
  if (!model || model === AUTO || machines.length === 0) return null
  return <MachineModelWarning key={machines[0]!.id} machines={machines} index={0} harness={harness} model={model} descriptors={descriptors} />
})
