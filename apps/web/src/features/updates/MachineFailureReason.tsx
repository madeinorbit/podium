export interface FailureReason {
  code?: string
  message: string
  source: 'machine' | 'coordinator'
  at: number
}

export function MachineFailureReason({ reason }: { reason?: FailureReason }) {
  if (!reason) return null
  return (
    <span className="block max-w-[48ch] whitespace-normal text-left">
      <span className="block text-warning">{reason.message}</span>
      <span className="block text-muted-foreground">
        {reason.source === 'machine' ? 'reported by the machine' : 'inferred by the coordinator'}
      </span>
    </span>
  )
}
