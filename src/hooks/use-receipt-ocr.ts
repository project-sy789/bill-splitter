/**
 * use-receipt-ocr.ts
 *
 * Tesseract-only OCR hook with:
 * - Image preprocessing (grayscale → contrast boost → binarize)
 * - Better Tesseract config (LSTM, receipt-optimised PSM)
 * - Multiple-file queue (results merged)
 */

import { useCallback, useRef, useState } from 'react'
import { createWorker } from 'tesseract.js'

import { parseReceiptText } from '../lib/receipt-parser'
import type { OcrStatus, ParsedReceiptResult } from '../types/ocr'

interface OcrProgress {
  progress: number
  statusText: string
}

const OCR_TIMEOUT_MS = 120_000
const MAX_DIM = 2400 // upsample small images for better accuracy

// ──────────────────────────────────────────────
// Image preprocessing
// ──────────────────────────────────────────────

/**
 * Preprocess receipt image for better Tesseract accuracy:
 * 1. Scale up if too small (receipts need ≥ 300 DPI equivalent)
 * 2. Convert to grayscale
 * 3. Boost contrast
 * 4. Binarize with adaptive threshold (Otsu approximation)
 */
async function preprocessImage(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('โหลดภาพไม่สำเร็จ'))
      el.src = url
    })

    const { width: origW, height: origH } = img

    // Scale: upscale if small, downscale if huge
    const maxSide = Math.max(origW, origH)
    const ratio = maxSide < MAX_DIM ? Math.min(MAX_DIM / maxSide, 3) : Math.min(MAX_DIM / maxSide, 1)
    const w = Math.round(origW * ratio)
    const h = Math.round(origH * ratio)

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, w, h)

    const imageData = ctx.getImageData(0, 0, w, h)
    const data = imageData.data

    // ── Step 1: Grayscale + contrast ──
    const gray = new Uint8Array(w * h)
    for (let p = 0; p < w * h; p++) {
      const r = data[p * 4]!
      const g = data[p * 4 + 1]!
      const b = data[p * 4 + 2]!
      // Luminance
      gray[p] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    }

    // ── Step 2: Contrast stretch (min-max normalization) ──
    let minV = 255, maxV = 0
    for (let p = 0; p < gray.length; p++) {
      if (gray[p]! < minV) minV = gray[p]!
      if (gray[p]! > maxV) maxV = gray[p]!
    }
    const range = maxV - minV || 1
    for (let p = 0; p < gray.length; p++) {
      gray[p] = Math.round(((gray[p]! - minV) / range) * 255)
    }

    // ── Step 3: Adaptive binarize (local mean threshold) ──
    // Block size for local mean (larger = better for varied lighting)
    const BLOCK = Math.max(16, Math.round(Math.min(w, h) / 20))
    const binary = new Uint8Array(w * h)

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - BLOCK)
        const x1 = Math.min(w - 1, x + BLOCK)
        const y0 = Math.max(0, y - BLOCK)
        const y1 = Math.min(h - 1, y + BLOCK)

        let sum = 0, count = 0
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            sum += gray[yy * w + xx]!
            count++
          }
        }
        const localMean = sum / count
        // Pixel is "text" (dark) if below local mean - small constant
        binary[y * w + x] = gray[y * w + x]! < localMean - 8 ? 0 : 255
      }
    }

    // ── Write back to canvas ──
    for (let p = 0; p < w * h; p++) {
      const v = binary[p]!
      data[p * 4] = v
      data[p * 4 + 1] = v
      data[p * 4 + 2] = v
      data[p * 4 + 3] = 255
    }
    ctx.putImageData(imageData, 0, 0)

    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/png'), // PNG = lossless, better for OCR
    )
    return blob ?? file
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ──────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────

export function useReceiptOcr() {
  const workerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null)
  const [status, setStatus] = useState<OcrStatus>('idle')
  const [progress, setProgress] = useState<OcrProgress>({ progress: 0, statusText: 'พร้อมใช้งาน' })
  const [results, setResults] = useState<ParsedReceiptResult[]>([])
  const [error, setError] = useState<string | null>(null)

  const getWorker = useCallback(async () => {
    if (workerRef.current) return workerRef.current

    setStatus('loading')
    setProgress({ progress: 3, statusText: 'โหลดระบบ OCR...' })

    const worker = await createWorker(['tha', 'eng'], 1, {
      logger: (msg) => {
        const pct = Math.round(5 + (msg.progress ?? 0) * 85)
        let text = msg.status
        if (msg.status === 'loading language traineddata') text = 'โหลดชุดภาษา...'
        else if (msg.status === 'initializing api') text = 'เริ่มต้นระบบ...'
        else if (msg.status === 'recognizing text') text = 'กำลังอ่านข้อความ...'
        setProgress({ progress: pct, statusText: text })
      },
    })

    // Tesseract parameters optimised for receipts:
    // PSM 6 = "Assume a single uniform block of text" — good for receipt columns
    // OEM 1 = LSTM neural net only (most accurate)
    await worker.setParameters({
      tessedit_pageseg_mode: '6' as unknown as number,
      // Keep digits and common receipt chars
      tessedit_char_whitelist: '',
      // Preserve interword spaces (Thai needs this)
      preserve_interword_spaces: '1',
    })

    workerRef.current = worker
    return worker
  }, [])

  const terminate = useCallback(async () => {
    if (!workerRef.current) return
    await workerRef.current.terminate()
    workerRef.current = null
  }, [])

  const runOcrOnFile = useCallback(
    async (file: File): Promise<ParsedReceiptResult | null> => {
      setError(null)
      setStatus('recognizing')
      setProgress({ progress: 0, statusText: 'เตรียมภาพ...' })

      try {
        setProgress({ progress: 8, statusText: 'ปรับคุณภาพภาพ...' })
        const processedImage = await preprocessImage(file)

        const worker = await getWorker()

        setProgress({ progress: 15, statusText: 'กำลังอ่านใบเสร็จ...' })

        const recognizePromise = worker.recognize(processedImage)
        const timeoutPromise = new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error('หมดเวลา: OCR ใช้นานเกิน 2 นาที')), OCR_TIMEOUT_MS),
        )

        const recognized = await Promise.race([recognizePromise, timeoutPromise])
        setProgress({ progress: 92, statusText: 'แปลงผลลัพธ์...' })

        const parsed = parseReceiptText(recognized.data.text)
        setProgress({ progress: 100, statusText: `อ่านสำเร็จ — พบ ${parsed.items.length} รายการ ✓` })
        setStatus('completed')
        return parsed
      } catch (err) {
        const message = err instanceof Error ? err.message : 'สแกนไม่สำเร็จ'
        if (message.includes('หมดเวลา')) await terminate()
        setStatus('error')
        setError(message)
        return null
      }
    },
    [getWorker, terminate],
  )

  /** Scan multiple files — results are merged (appended) */
  const scanFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const result = await runOcrOnFile(file)
        if (result) {
          setResults((prev) => [...prev, result])
        }
      }
    },
    [runOcrOnFile],
  )

  const reset = useCallback(() => {
    setStatus('idle')
    setProgress({ progress: 0, statusText: 'พร้อมใช้งาน' })
    setResults([])
    setError(null)
  }, [])

  const mergedItems = results.flatMap((r) => r.items)
  const lastSummary = results.length > 0 ? results[results.length - 1]?.summary : null

  return {
    status,
    progress,
    results,
    mergedItems,
    lastSummary,
    error,
    scanFiles,
    reset,
    terminate,
    isBusy: status === 'loading' || status === 'recognizing',
  }
}
