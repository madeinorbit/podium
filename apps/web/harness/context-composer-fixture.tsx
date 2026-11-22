import type { SessionModel } from '@podium/client-graph/models'
import { createRef, useRef, useState } from 'react'
import { ChatComposer } from '@/features/chat/ChatComposer'
import type { MailReply } from '@/features/chat/mail-reply'
import { SessionComposerControls } from '@/features/chat/SessionComposerControls'
import type { UseAttachmentsResult } from '@/features/chat/use-attachments'

const noop = () => {}
const attachments: UseAttachmentsResult = {
  attachments: [],
  dragOver: false,
  fileInputRef: createRef<HTMLInputElement>(),
  openFilePicker: noop,
  processFiles: async () => {},
  remove: noop,
  clear: noop,
  clearReady: noop,
  uploading: false,
  ready: () => ({ paths: [], legacyPaths: [], refs: [], tags: [], draftArtifacts: [] }),
  dropHandlers: { onDragOver: noop, onDragLeave: noop, onDrop: noop },
  onPaste: noop,
  onFileInputChange: noop,
}

/** Both shipping foot rows and their actual textarea/button event routing. */
export function ContextComposerFixture({
  session,
  compact = false,
  onSend = noop,
  onInterrupt = noop,
  reply,
}: {
  session: SessionModel
  compact?: boolean
  onSend?: () => void
  onInterrupt?: () => void
  reply?: MailReply
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  return (
    <ChatComposer
      reply={reply}
      taRef={taRef}
      draft={draft}
      onDraftChange={setDraft}
      deliverable
      placeholder="Message the agent…"
      compact={compact}
      isMobile={false}
      onSend={onSend}
      voice={{ supported: false, listening: false, toggle: noop } as never}
      attachments={attachments}
      turnRunning
      canInterrupt
      onInterrupt={onInterrupt}
      interruptError={null}
      offer={null}
      onOfferAction={async () => {}}
      onOfferDismiss={async () => {}}
      session={undefined}
      turnError={null}
      transcriptFreshness={null}
      offlineAsOf={null}
      autoFocusKey={session.id}
      transcriptSettled
      modelControl={<SessionComposerControls session={session} />}
    />
  )
}
