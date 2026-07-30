import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginGate } from '@/features/setup/LoginGate'
import { SetupGate } from '@/features/setup/SetupGate'
import { MotionDemo } from '@/lib/motion/MotionDemo'
import { AppShell } from './AppShell'
import '@/index.css'
import '@/styles.css'
import { redirectPhoneToMobileApp } from './mobile-entry-redirect'
import { ThemeProvider } from './theme'

const root = document.getElementById('root')
if (!root) throw new Error('Podium web root was not found')
const params = new URLSearchParams(window.location.search)
const showMotionDemo = params.get('e2e') === '1' && params.get('motion-demo') === '1'

// A phone reaching the desktop shell means a cached service worker beat the
// server's redirect to it (POD-359) — send it on before mounting anything.
if (!redirectPhoneToMobileApp()) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        {showMotionDemo ? (
          <MotionDemo />
        ) : (
          <LoginGate>
            <SetupGate>
              <AppShell />
            </SetupGate>
          </LoginGate>
        )}
      </ThemeProvider>
    </StrictMode>,
  )
}
