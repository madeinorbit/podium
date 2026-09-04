/**
 * THE COLD-START COMPOSER, REAL, IN A BROWSER (POD-1203).
 *
 * `bunx vite --config vite.coldstart.config.ts` in apps/web, then
 * `bunx tsx e2e/pod1203-coldstart-shots.ts`.
 */
import { createRoot } from 'react-dom/client'
import { ColdStartComposer } from '@/features/setup/ColdStartComposer'
import '@/index.css'
import '@/styles.css'

const root = document.getElementById('root')
if (root) {
  root.style.height = '100vh'
  root.style.display = 'flex'
  const params = new URLSearchParams(location.search)
  /**
   * THE THEME IS PART OF THE SHIPPING STYLESHEET (POD-1669).
   *
   * Every colour in styles.css hangs off `[data-theme="podium"]`, with `.dark`
   * choosing the appearance — the shell writes both onto <html> in
   * `app/theme.tsx`, and this harness never did. The stylesheet still loaded, so
   * the shots LOOKED plausible: a page of shadcn's stock fallbacks, no bar
   * tone, no rims, no amber on Launch. Bleached, and bleached is the one failure
   * mode a screenshot cannot report on its own. `?theme=light` is the paper
   * appearance the operator's own window is in; dark stays the default.
   */
  document.documentElement.setAttribute('data-theme', 'podium')
  document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
  const first = params.get('first') !== '0'
  createRoot(root).render(<ColdStartComposer first={first} />)
}
