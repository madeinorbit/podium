/**
 * FIRST FLIGHTS, MOMENT 3, PHOTOGRAPHED (POD-2198).
 *
 * The shipping `ChatComposer` and the shipping `useAskAnythingTip`, under a
 * real `TipHost`, in the chat surface's wrapper. The session starts `working`
 * and goes `idle` a moment later, which is the trigger; the tip then anchors
 * to the composer well. `?theme=dark` for the dark appearance.
 */
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import type { AgentPhase } from '@podium/model/browser'
import type { useVoiceInput } from '@podium/terminal-client-react'
import { observer } from 'mobx-react-lite'
import { createRef, type JSX, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { askAnythingAnchor, useAskAnythingTip } from '@/features/chat/ask-anything-tip'
import { ChatComposer } from '@/features/chat/ChatComposer'
import type { UseAttachmentsResult } from '@/features/chat/use-attachments'
import { TipHost } from '@/features/tips'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')

const attachments: UseAttachmentsResult = {
  attachments: [],
  dragOver: false,
  fileInputRef: createRef<HTMLInputElement>(),
  openFilePicker: () => {},
  processFiles: async () => {},
  remove: () => {},
  clear: () => {},
  clearReady: () => {},
  uploading: false,
  ready: () => ({ paths: [], legacyPaths: [], refs: [], tags: [], draftArtifacts: [] }),
  dropHandlers: { onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {} },
  onPaste: () => {},
  onFileInputChange: () => {},
}
const voice = { supported: false, listening: false, toggle: () => {} } as unknown as ReturnType<
  typeof useVoiceInput
>
const SESSION = 'sess_2198'

const Chat = observer(function Chat(): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const [phase, setPhase] = useState<AgentPhase>('working')
  useEffect(() => {
    const t = setTimeout(() => setPhase('idle'), 400)
    return () => clearTimeout(t)
  }, [])
  useAskAnythingTip({
    sessionId: SESSION,
    phase,
    viewing: true,
    taskChat: true,
    onExample: (text) => {
      setDraft(draft.trim() ? `${draft}\n${text}` : text)
      taRef.current?.focus()
    },
  })
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col justify-end gap-4 overflow-hidden px-[22px] pb-6 text-sm leading-6">
        <div className="self-end rounded-[12px] bg-muted px-3.5 py-2">
          Make the login form remember the email.
        </div>
        <p className="max-w-[640px]">
          Done. The login form now keeps the last email in local storage and fills it in on the next
          visit. I added a test for the round trip and the lean gate is green.
        </p>
      </div>
      <ChatComposer
        taRef={taRef}
        draft={draft}
        onDraftChange={setDraft}
        deliverable
        placeholder="Message the agent…"
        compact={false}
        isMobile={false}
        onSend={() => setDraft('')}
        voice={voice}
        attachments={attachments}
        turnRunning={phase === 'working'}
        canInterrupt={false}
        onInterrupt={() => {}}
        offer={null}
        onOfferAction={async () => {}}
        onOfferDismiss={async () => {}}
        session={undefined}
        turnError={null}
        transcriptFreshness={null}
        offlineAsOf={null}
        autoFocusKey={SESSION}
        tipAnchor={askAnythingAnchor(SESSION)}
        transcriptSettled={false}
      />
    </div>
  )
})

createRoot(document.getElementById('root') as HTMLElement).render(
  <TipHost log={new MemoryTipLog()}>
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Chat />
    </div>
  </TipHost>,
)
