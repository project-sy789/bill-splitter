/**
 * use-receipt-ocr.ts — Tesseract OCR hook with fast image preprocessing
 *
 * Image preprocessing uses:
 *   - CSS canvas filter (GPU) for grayscale + contrast boost → O(1) time
 *   - Otsu global threshold (1979) for binarization → O(n) time
 *
 * Previously used a 4-nested-loop adaptive threshold (O(n × block²))
 * which froze the browser for 30+ seconds on normal phone photos.
 */

import { useCallback, useRef, useState, useMemo } from 'react'
import { PSM, createWorker } from 'tesseract.js'

import { parseReceiptText } from '../lib/receipt-parser'
import {
  scanWithGemini,
  GeminiRateLimitError,
  GEMINI_PROXY_URL,
} from '../lib/gemini-ocr'
import type { OcrStatus, ParsedReceiptResult } from '../types/ocr'

interface OcrProgress {
  progress: number
  statusText: string
}

const OCR_TIMEOUT_MS = 120_000
const OCR_FALLBACK_MODES = [PSM.SINGLE_BLOCK, PSM.SPARSE_TEXT, PSM.AUTO]

// ──────────────────────────────────────────────
// Image preprocessing (fast)
// ──────────────────────────────────────────────

async function preprocessImage(file: File, aggressive = false): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('โหลดภาพไม่สำเร็จ'))
      el.src = url
    })

    const { width: origW, height: origH } = img
    const longestSide = Math.max(origW, origH)

    const TARGET = aggressive ? 1800 : 1600
    const scale = longestSide < TARGET ? Math.min(TARGET / longestSide, aggressive ? 2.5 : 2) : TARGET / longestSide

    const w = Math.max(1, Math.round(origW * scale))
    const h = Math.max(1, Math.round(origH * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!

    ctx.filter = aggressive
      ? 'grayscale(1) contrast(2.1) brightness(1.08)'
      : 'grayscale(1) contrast(1.8) brightness(1.05)'
    ctx.drawImage(img, 0, 0, w, h)
    ctx.filter = 'none'

    const imageData = ctx.getImageData(0, 0, w, h)
    const data = imageData.data
    const total = w * h

    const hist = new Float64Array(256)
    for (let p = 0; p < total; p++) hist[data[p * 4]!]++

    let sum = 0
    for (let i = 0; i < 256; i++) sum += i * hist[i]!

    let sumB = 0, wB = 0, maxVar = 0, threshold = aggressive ? 140 : 128
    for (let t = 0; t < 256; t++) {
      wB += hist[t]!
      if (wB === 0) continue
      const wF = total - wB
      if (wF === 0) break
      sumB += t * hist[t]!
      const mB = sumB / wB
      const mF = (sum - sumB) / wF
      const between = wB * wF * (mB - mF) ** 2
      if (between > maxVar) { maxVar = between; threshold = t }
    }

    for (let p = 0; p < total; p++) {
      const v = data[p * 4]! > threshold ? 255 : 0
      data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v
      data[p * 4 + 3] = 255
    }
    ctx.putImageData(imageData, 0, 0)

    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/png'),
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
  const [lastSource, setLastSource] = useState<'gemini' | 'tesseract' | null>(null)

  const getWorker = useCallback(async (psm: PSM = PSM.SINGLE_BLOCK) => {
    if (workerRef.current) {
      await workerRef.current.setParameters({
        tessedit_pageseg_mode: psm,
        preserve_interword_spaces: '1',
      })
      return workerRef.current
    }

    setStatus('loading')
    setProgress({ progress: 3, statusText: 'โหลดระบบ OCR...' })

    const worker = await createWorker(['tha', 'eng'], 1, {
      logger: (msg) => {
        const pct = Math.round(20 + (msg.progress ?? 0) * 70)
        let text = msg.status
        if (msg.status === 'loading language traineddata') text = 'โหลดชุดภาษา...'
        else if (msg.status === 'initializing api') text = 'เริ่มต้นระบบ...'
        else if (msg.status === 'recognizing text') text = 'กำลังอ่านข้อความ...'
        setProgress({ progress: pct, statusText: text })
      },
    })

    await worker.setParameters({
      tessedit_pageseg_mode: psm,
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

      // ── 1. Try Gemini Vision first (if proxy configured) ──────────────────
      if (GEMINI_PROXY_URL) {
        try {
          setProgress({ progress: 10, statusText: '🤖 กำลังอ่านด้วย AI (Gemini)...' })
          const geminiResult = await scanWithGemini(file)
          setProgress({ progress: 100, statusText: `🤖 AI อ่านสำเร็จ — พบ ${geminiResult.items.length} รายการ ✓` })
          setStatus('completed')
          setLastSource('gemini')
          return geminiResult
        } catch (err) {
          if (err instanceof GeminiRateLimitError) {
            setProgress({ progress: 12, statusText: '⚠️ AI เต็ม กำลังสลับไป OCR ปกติ...' })
          } else {
            console.warn('[OCR] Gemini failed, falling back to Tesseract:', err)
            setProgress({ progress: 12, statusText: '⚠️ AI ล้มเหลว กำลังสลับไป OCR ปกติ...' })
          }
        }
      }

      // ── 2. Tesseract fallback ─────────────────────────────────────────────
      try {
        setProgress({ progress: 15, statusText: 'ปรับคุณภาพภาพ...' })
        const processedImage = await preprocessImage(file)

        setProgress({ progress: 25, statusText: 'กำลังโหลดระบบอ่านตัวอักษร...' })

        let best: ParsedReceiptResult | null = null
        let bestCount = -1
        let lastError: unknown = null

        for (const psm of OCR_FALLBACK_MODES) {
          for (const aggressive of [false, true]) {
            try {
              setProgress({ progress: 30, statusText: `กำลังอ่านใบเสร็จ (${psm}${aggressive ? ', enhanced' : ''})...` })
              const worker = await getWorker(psm)
              const imageForPass = aggressive ? await preprocessImage(file, true) : processedImage
              const recognizePromise = worker.recognize(imageForPass)
              const timeoutPromise = new Promise<never>((_, reject) =>
                window.setTimeout(() => reject(new Error('หมดเวลา: OCR ใช้นานเกิน 2 นาที')), OCR_TIMEOUT_MS),
              )

              const recognized = await Promise.race([recognizePromise, timeoutPromise])
              const parsed = parseReceiptText(recognized.data.text)
              if (parsed.items.length > bestCount) {
                best = parsed
                bestCount = parsed.items.length
              }
              if (parsed.items.length >= 7) break
            } catch (err) {
              lastError = err
            }
          }
          if (bestCount >= 7) break
        }

        if (best) {
          setProgress({ progress: 100, statusText: `อ่านสำเร็จ — พบ ${best.items.length} รายการ ✓` })
          setStatus('completed')
          setLastSource('tesseract')
          return best
        }

        throw lastError instanceof Error ? lastError : new Error('OCR ไม่สำเร็จ')
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
    setLastSource(null)
  }, [])

  const mergedItems = useMemo(() => {
    return results.flatMap((r, i) => r.items.map(it => ({ ...it, billId: `ocr-${i}` })))
  }, [results])
  
  const lastSummary = results.length > 0 ? results[results.length - 1]?.summary : null

  return {
    status,
    progress,
    results,
    mergedItems,
    lastSummary,
    error,
    lastSource,
    scanFiles,
    reset,
    terminate,
    isBusy: status === 'loading' || status === 'recognizing',
    setResults,
  }
}
