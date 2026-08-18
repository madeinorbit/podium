/**
 * THE NEW TASK COMPOSER, REAL, IN A BROWSER (POD-1285).
 *
 * `bunx vite --config vite.newtask.config.ts` in apps/web, then drive
 * `e2e/pod1285-newtask-shots.ts`.
 */
import { createRoot } from 'react-dom/client'
import { NewIssueDialog } from '@/features/issues/NewIssueDialog'
import '@/index.css'
import '@/styles.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<NewIssueDialog onClose={() => {}} />)
