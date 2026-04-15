import { useCallback, useRef, useState } from 'react'
import { createWorker } from 'tesseract.js'

import { runAiOcr } from '../lib/ai-ocr'
import { parseReceiptText } from '../lib/receipt-parser'
import type { OcrStatus, ParsedReceiptResult } from '../types/ocr'

interface OcrProgress {
  progress: number
  statusText: string
}

const OCR_TIMEOUT_MS = 120_000
const MAX_IMAGE_DIMENSION = 2000

async function downscaleImage(file: File): Promise<Blob> {
  const imageUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('โหลดรูปไม่สำเร็จ'))
      el.src = imageUrl
    })
    const ratio = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * ratio))
    const h = Math.max(1, Math.round(img.height * ratio))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob((b) => r(b), 'image/jpeg', 0.92))
    return blob ?? file
  } finally {
    URL.revokeObjectURL(imageUrl)
  }
}

export function useReceiptOcr() {
  const workerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null)
  const [status, setStatus] = useState<OcrStatus>('idle')
  const [progress, setProgress] = useState<OcrProgress>({ progress: 0, statusText: 'พร้อมใช้งาน' })
  const [results, setResults] = useState<ParsedReceiptResult[]>([])
  const [error, setError] = useState<string | null>(null)

  const getWorker = useCallback(async () => {
    if (workerRef.current) return workerRef.current
    setStatus('loading')
    setProgress({ progress: 5, statusText: 'กำลังโหลดระบบ OCR...' })
    const worker = await createWorker(['tha', 'eng'], 1, {
      logger: (msg) => {
        setProgress({
          progress: Math.round(5 + (msg.progress ?? 0) * 85),
          statusText: msg.status === 'recognizing text'
            ? 'กำลังอ่านข้อความ...'
            : msg.status === 'loading language traineddata'
            ? 'โหลดชุดภาษา...'
            : msg.status,
        })
      },
    })
    workerRef.current = worker
    return worker
  }, [])

  const terminate = useCallback(async () => {
    if (!workerRef.current) return
    await workerRef.current.terminate()
    workerRef.current = null
  }, [])

  /** Run OCR on a single file. Returns the parsed result or null on failure. */
  const runOcrOnFile = useCallback(
    async (file: File, apiKey?: string): Promise<ParsedReceiptResult | null> => {
      setError(null)
      setStatus('recognizing')
      setProgress({ progress: 0, statusText: 'เริ่มต้นการสแกน...' })

      try {
        if (apiKey) {
          // --- AI OCR path (GPT-4o Vision) ---
          const result = await runAiOcr(file, apiKey, (pct, text) => {
            setProgress({ progress: pct, statusText: text })
          })
          setProgress({ progress: 100, statusText: 'AI อ่านสำเร็จ ✓' })
          setStatus('completed')
          return result
        } else {
          // --- Tesseract fallback ---
          const worker = await getWorker()
          setProgress({ progress: 5, statusText: 'กำลังปรับขนาดภาพ...' })
          const optimized = await downscaleImage(file)
          const recognizePromise = worker.recognize(optimized)
          const timeoutPromise = new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error('หมดเวลา: OCR ใช้นานเกิน 2 นาที')), OCR_TIMEOUT_MS),
          )
          const recognized = await Promise.race([recognizePromise, timeoutPromise])
          const parsed = parseReceiptText(recognized.data.text)
          setProgress({ progress: 100, statusText: 'อ่านสำเร็จ ✓' })
          setStatus('completed')
          return parsed
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'สแกนไม่สำเร็จ'
        if (message.includes('timeout') || message.includes('หมดเวลา')) {
          await terminate()
        }
        setStatus('error')
        setError(message)
        return null
      }
    },
    [getWorker, terminate],
  )

  /**
   * Process multiple files and MERGE results into the list.
   * New items are appended to existing results.
   */
  const scanFiles = useCallback(
    async (files: File[], apiKey?: string) => {
      for (const file of files) {
        const result = await runOcrOnFile(file, apiKey)
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

  /** Merge all OCR results into a single flat item list */
  const mergedItems = results.flatMap((r) => r.items)

  /** Last scanned summary (vat/total from last slip) */
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
