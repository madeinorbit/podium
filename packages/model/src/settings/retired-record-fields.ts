import { z } from 'zod'

// LEGACY(remove-after: 2027-02): drop gitWorkflow.mergeStyle and sidebar.groupByRepo from pre-redesign cached/server records; removing this rejects those records.
export function withoutRetiredSettingsFields<S extends z.AnyZodObject>(schema: S) {
  return z.preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const next = { ...value } as Record<string, unknown>
    delete next['gitWorkflow.mergeStyle']
    delete next['sidebar.groupByRepo']
    return next
  }, schema)
}
