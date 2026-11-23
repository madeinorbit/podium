import type { SessionId } from '@podium/model'

export type SpawnPlaceholderEvent =
  | {
      readonly type: 'painted'
      readonly overlays: readonly import('../command-reducers').PendingOverlay[]
      readonly sessionId: SessionId
      readonly prompt?: string
    }
  | { readonly type: 'removed'; readonly ids: readonly string[] }
