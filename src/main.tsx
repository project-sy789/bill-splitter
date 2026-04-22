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
// In dev, aggressively clear old SW + caches so Vite can serve fresh assets.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (import.meta.env.PROD) {
      navigator.serviceWorker
        .register('/bill-splitter/sw.js', { scope: '/bill-splitter/' })
        .catch(() => { /* SW unavailable in this environment — safe to ignore */ })
      return
    }

    void (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((reg) => reg.unregister()))
        if ('caches' in window) {
          const keys = await caches.keys()
          await Promise.all(keys.map((key) => caches.delete(key)))
        }
      } catch {
        // Ignore dev cleanup failures; page should still render.
      }
    })()
  })
}
