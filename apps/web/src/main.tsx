import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './AppShell'
import { SetupGate } from './SetupGate'
import './index.css'
import './styles.css'
import { ThemeProvider } from './theme'

const root = document.getElementById('root')
if (!root) throw new Error('Podium web root was not found')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <SetupGate>
        <AppShell />
      </SetupGate>
    </ThemeProvider>
  </StrictMode>,
)
