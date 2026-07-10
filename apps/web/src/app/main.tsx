import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginGate } from '@/features/setup/LoginGate'
import { SetupGate } from '@/features/setup/SetupGate'
import { AppShell } from './AppShell'
import '@/index.css'
import '@/styles.css'
import { ThemeProvider } from './theme'

const root = document.getElementById('root')
if (!root) throw new Error('Podium web root was not found')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <LoginGate>
        <SetupGate>
          <AppShell />
        </SetupGate>
      </LoginGate>
    </ThemeProvider>
  </StrictMode>,
)
