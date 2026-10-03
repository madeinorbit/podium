import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'
// This runner configuration stays JavaScript so importing the Vite plugins
// does not add their ambient types to the application's TypeScript program.
import base from '../../../vite.sidebar-pool-perf.config.ts'

export default mergeConfig(base, {
  plugins: [{ name: 'superagent-owned-boundary', enforce: 'pre', transform(_code, id) {
    if (!id.endsWith('/src/features/chat/ChatView.tsx')) return
    // Child conversation migration is POD-5173. Use a fixed child to isolate
    // this screen's reader work; the actual parent and provider remain real.
    return `export function ChatView({sessionId, initialTurnRunning}) {
      return <div data-testid="embedded-chat" data-session={sessionId} data-running={String(initialTurnRunning)} className="flex flex-1 flex-col justify-end p-4">
        <p className="mb-4 text-sm text-muted-foreground">Existing session conversation</p><textarea aria-label="Delegate a task" placeholder="Delegate a task…" className="rounded border p-3" />
      </div>
    }`
  } }],
  build: { rollupOptions: { input: fileURLToPath(new URL('./acceptance.browser.html', import.meta.url)) } },
})
