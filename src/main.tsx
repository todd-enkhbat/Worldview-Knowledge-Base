import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './workspace.css'
import './galaxy.css'
import App from './App.tsx'
import { EmailClipboard } from './workspace/EmailClipboard.tsx'
import { bootData } from './app/boot.ts'

void bootData()

if ('serviceWorker' in navigator && !('worldviewDesktop' in window)) {
  void navigator.serviceWorker.register('/share-inbox-worker.js').catch(() => {
    // Worldview works in browsers that decline background services.
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <EmailClipboard />
  </StrictMode>,
)
