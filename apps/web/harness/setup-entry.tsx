/**
 * THE ONBOARDING AGENT AND READY SCREENS, REAL, IN A BROWSER (POD-1225).
 *
 * `bunx vite --config vite.setup.config.ts` in apps/web, then open
 * `/setup-harness.html#agent` or `#first-task`.
 */
import { createRoot } from 'react-dom/client'
import { FirstTaskActivation } from '@/features/setup/FirstTaskActivation'
import '@/index.css'
import '@/styles.css'

const route = window.location.hash === '#first-task' ? 'first-task' : 'agent'
const root = document.getElementById('root')
if (root) {
  root.style.minHeight = '100vh'
  createRoot(root).render(
    <FirstTaskActivation route={route} onRouteChange={() => {}} onComplete={() => {}} />,
  )
}
