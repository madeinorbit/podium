import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './AppShell'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Podium web root was not found')

createRoot(root).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
