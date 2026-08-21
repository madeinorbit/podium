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
  const first = new URLSearchParams(location.search).get('first') !== '0'
  createRoot(root).render(<ColdStartComposer first={first} />)
}
