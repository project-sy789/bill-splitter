/**
 * gemini-ocr.ts — Calls the Cloudflare Workers proxy to run Gemini Vision OCR.
 *
 * The proxy keeps the GEMINI_API_KEY hidden server-side.
 * If the proxy returns 429 (rate limited) or fails, the caller should
 * fall back to Tesseract.js.
 */

import type { ParsedReceiptResult } from '../types/ocr'

// ── Config ────────────────────────────────────────────────────────────────────

// Update this URL after deploying your Cloudflare Worker:
//   wrangler deploy --cwd worker
// The URL will be printed in the deploy output.
export const GEMINI_PROXY_URL =
  (import.meta.env.VITE_GEMINI_PROXY_URL as string | undefined) ??
  '' // Empty = disabled; will fall through to Tesseract

// ── Custom errors ─────────────────────────────────────────────────────────────

export class GeminiRateLimitError extends Error {
  constructor() {
    super('Gemini quota exceeded')
    this.name = 'GeminiRateLimitError'
  }
}

export class GeminiDisabledError extends Error {
  constructor() {
    super('Gemini proxy URL not configured')
    this.name = 'GeminiDisabledError'
  }
}

// ── File → base64 ─────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      // Strip "data:<mime>;base64," prefix
      resolve(dataUrl.split(',')[1] ?? '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Sends the receipt image to the Cloudflare Workers proxy,
 * which calls Gemini Vision and returns structured receipt data.
 *
 * @throws {GeminiDisabledError}  if no proxy URL is configured
 * @throws {GeminiRateLimitError} if the proxy returns 429 (Gemini quota hit)
 * @throws {Error}                for other network/parse failures
 */
export async function scanWithGemini(file: File): Promise<ParsedReceiptResult> {
  if (!GEMINI_PROXY_URL) {
    throw new GeminiDisabledError()
  }

  const imageBase64 = await fileToBase64(file)
  const mimeType = file.type || 'image/jpeg'

  const endpoints = [
    GEMINI_PROXY_URL,
    `${GEMINI_PROXY_URL.replace(/\/$/, '')}/ocr`,
  ]

  let lastError: unknown = null
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, mimeType }),
      })

      if (res.status === 429) {
        throw new GeminiRateLimitError()
      }

      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Proxy error ${res.status}: ${err}`)
      }

      const result = await res.json() as ParsedReceiptResult
      return result
    } catch (err) {
      lastError = err
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Gemini proxy request failed')
}
