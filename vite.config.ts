import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/bill-splitter/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Use our custom sw.js in public/ (copied to dist as-is)
      strategies: 'injectManifest',
      srcDir: 'public',
      filename: 'sw.js',
      injectManifest: {
        injectionPoint: undefined, // we manage our own cache logic
      },
      manifest: {
        name: 'หารบิล',
        short_name: 'หารบิล',
        description: 'แอปหารบิล สแกนสลิป + คำนวณ + แจ้งยอดโอน (ออฟไลน์ได้)',
        theme_color: '#7C3AED',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/bill-splitter/',
        scope: '/bill-splitter/',
        lang: 'th',
        icons: [
          {
            src: '/bill-splitter/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
