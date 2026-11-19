/** One quiet screen mark. Its reserved slot never changes size when a reload lands. */
export function ScreenRefreshMark({ refreshing }: { refreshing: boolean }) {
  return (
    <span
      className="inline-flex size-3 shrink-0 items-center justify-center"
      role="status"
      aria-hidden={!refreshing}
      aria-label={refreshing ? 'Refreshing' : undefined}
      title={refreshing ? 'Refreshing' : undefined}
      data-screen-refresh={refreshing ? 'refreshing' : 'here'}
    >
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-text-dim"
        style={{ opacity: refreshing ? 0.7 : 0 }}
      />
    </span>
  )
}
