import { vi } from 'vitest'

// Standalone row layout fixtures have no message feed or StoreProvider.
// Attachment identity and live updates are covered with the real pool in
// ChatBlockView.attachments.test.tsx.
vi.mock('../use-chat-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../use-chat-context')>()),
  useChatItemMessage: () => undefined,
}))
