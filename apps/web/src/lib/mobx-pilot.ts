import { debugFlagEnabled, MOBX_SIDEBAR_KEY, type UiState } from '@podium/client-core/ui-state'

/** Converted screens share the existing device setting and keep independent URL
 * overrides. Call from each screen's startup latch, once UI state is available. */
export function mobxPilotEnabled(
  ui: Pick<UiState, 'get'>,
  params: URLSearchParams | undefined,
  queryKey: string,
): boolean {
  const value = params?.get(queryKey)
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return debugFlagEnabled(ui, MOBX_SIDEBAR_KEY)
}
