import type { UiState } from '@podium/client-core/ui-state'
import { webPoolSwitch } from '@/lib/mobx-pilot'

const chat = webPoolSwitch('mobxChatContext', 'mobxChatContextCheck')
export function initializeChatContextDataLayer(ui: Pick<UiState, 'get'>): void { chat.initialize(ui) }
export function chatContextDataLayer(): 'legacy' | 'pool' { return chat.layer() }
export function chatContextCheckRequested(): boolean { return chat.checkRequested() }
