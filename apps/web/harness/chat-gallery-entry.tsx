// Shipping attachment and viewer components in the real transcript's materials.
// bunx vite --config harness/vite.chat-gallery.config.ts --port 55744
// /harness/chat-gallery.html?count=1|2|3|6&theme=light|dark&width=390|740
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { asSessionId } from '@podium/model'
import { ArrowUp, Copy, Paperclip, Quote } from 'lucide-react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ItemAttachments } from '@/features/chat/ChatUploadThumb'
import { type ChatImagePreview, ImageLightbox } from '@/features/chat/ImageLightbox'
import '@/index.css'
import '@/styles.css'
import './chat-gallery.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const count = Math.min(12, Math.max(1, Number(params.get('count') ?? 3)))
const names = [
  'podium-current.png',
  'claude-code.png',
  'codex.png',
  'podium-detail.png',
  'claude-detail.png',
  'codex-detail.png',
]
const paths = Array.from({ length: count }, (_, i) => `/gallery/${names[i % names.length]}`)

function App() {
  const [preview, setPreview] = useState<ChatImagePreview | string | null>(null)
  return (
    <main className="gallery-harness" style={{ width: `${params.get('width') ?? 780}px` }}>
      <header className="gallery-harness-header">
        <strong>Transcript presentation</strong>
        <span>Chat</span>
      </header>
      <div className="gallery-harness-feed">
        <div className="gallery-harness-date">Today, 11:03</div>
        <div className="transcript-row">
          <div className="transcript-body transcript-you">
            <div className="transcript-you-bubble">
              <div className="transcript-you-body">
                <div className="chat-md">
                  <p>
                    I’ve attached the current view, along with how Claude Code and Codex handle it.
                  </p>
                  <p>Make some new design suggestions for this.</p>
                </div>
                <ItemAttachments
                  sessionId={asSessionId('gallery-proof')}
                  attachments={[]}
                  paths={paths}
                  tags={[]}
                  cwd="/gallery"
                  httpOrigin={location.origin}
                  openFile={() => {}}
                  onOpenImage={(src, items, index = 0) =>
                    setPreview(items ? { items, index } : src)
                  }
                />
              </div>
            </div>
            <div className="gallery-harness-meta">
              <span>11:03</span>
              <Copy size={12} aria-hidden="true" />
              <Quote size={12} aria-hidden="true" />
            </div>
          </div>
        </div>
        <div className="gallery-harness-answer">
          <span>Podium</span>
          <p>I’ll compare the references and put together a cleaner layout for the transcript.</p>
          <div className="gallery-harness-meta">
            <span>11:04</span>
            <Copy size={12} aria-hidden="true" />
          </div>
        </div>
      </div>
      <div className="gallery-harness-composer">
        <span>Message the agent…</span>
        <div>
          <span>GPT-6.1-Sol · Max</span>
          <div>
            <Paperclip size={17} aria-hidden="true" />
            <ArrowUp size={18} aria-hidden="true" />
          </div>
        </div>
      </div>
      <ImageLightbox src={preview} onClose={() => setPreview(null)} />
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing gallery harness root')
createRoot(root).render(<App />)
