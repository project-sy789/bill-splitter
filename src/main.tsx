import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register service worker for PWA / offline support only in production.
// In dev, unregister any previously cached SW so Vite can serve fresh assets.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (import.meta.env.PROD) {
      navigator.serviceWorker
        .register('/bill-splitter/sw.js', { scope: '/bill-splitter/' })
        .catch(() => { /* SW unavailable in this environment — safe to ignore */ })
    } else {
      navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((reg) => reg.unregister()))
    }
  })
}
