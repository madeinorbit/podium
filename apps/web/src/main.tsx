import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const root = document.getElementById('root')
if (!root) throw new Error('Podium web root was not found')

createRoot(root).render(
  <StrictMode>
    <div>Podium</div>
  </StrictMode>,
)
