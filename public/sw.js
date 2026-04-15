const CACHE_NAME = 'bill-splitter-v1'
const PRECACHE_URLS = [
  '/bill-splitter/',
  '/bill-splitter/index.html',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// Network-first for navigations, cache-first for assets
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Skip non-GET and cross-origin requests
  if (request.method !== 'GET' || !url.origin.includes(self.location.origin)) return

  if (request.mode === 'navigate') {
    // Network-first for HTML
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone()
          caches.open(CACHE_NAME).then((c) => c.put(request, clone))
          return res
        })
        .catch(() => caches.match('/bill-splitter/index.html'))
    )
  } else {
    // Cache-first for assets (JS, CSS, images, Tesseract WASM etc.)
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((res) => {
            // Cache successful responses for static assets
            if (res.ok && (url.pathname.match(/\.(js|css|wasm|png|svg|json)$/))) {
              caches.open(CACHE_NAME).then((c) => c.put(request, res.clone()))
            }
            return res
          })
      )
    )
  }
})
