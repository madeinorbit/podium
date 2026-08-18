/**
 * THE CRASH SCREEN, REAL, IN A BROWSER (POD-1298).
 *
 * `AppErrorPage` takes plain props and reads no store, so it renders here
 * exactly as it ships — real `<details>`, real `styles.css`, real `group-open`
 * variant. The question this harness answers is whether the disclosure LOOKS
 * like a control at rest and turns when it opens, which no jsdom test can see.
 *
 * `?bare=1` renders the same page with the chevron stripped back out — the
 * positive control, reproducing the label the crash screen shipped with. If the
 * two shots look the same, the harness is blind and its verdict means nothing.
 */
import { createRoot } from 'react-dom/client'
import { AppErrorPage } from '@/app/AppErrorPage'
import '@/index.css'
import '@/styles.css'

const DETAIL = `TypeError: Cannot read properties of undefined (reading 'kind')
    at SessionRow (SessionRow.tsx:118:21)
    at renderWithHooks (react-dom.js:11121:18)`

const bare = new URLSearchParams(window.location.search).has('bare')

createRoot(document.getElementById('root') as HTMLElement).render(
  <div data-bare={bare ? '1' : '0'}>
    <AppErrorPage
      title="The interface stopped. Your agents did not."
      detail={DETAIL}
      onRetry={() => {}}
      retryLabel="Try rendering again"
      win={{ location: { reload: () => {}, href: '/' } }}
    />
  </div>,
)

// The control: pull the chevron out of the DOM after mount, leaving the label
// exactly as bare as it was before this issue. React commits after this module
// finishes, and a single rAF landed before the commit on the first run — so
// keep taking it out until it stops coming back.
if (bare) {
  window.setInterval(() => document.querySelector('summary svg')?.remove(), 16)
}
