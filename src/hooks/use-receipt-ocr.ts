import { useCallback, useRef, useState } from 'react'
import { createWorker } from 'tesseract.js'

import { parseReceiptText } from '../lib/receipt-parser'
import type { OcrStatus, ParsedReceiptResult } from '../types/ocr'

interface OcrProgress {
  progress: number
  statusText: string
}

const OCR_TIMEOUT_MS = 90_000
const MAX_IMAGE_DIMENSION = 1800

async function downscaleImage(file: File): Promise<Blob> {
  const imageUrl = URL.createObjectURL(file)

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('โหลดรูปไม่สำเร็จ'))
      el.src = imageUrl
    })

    const width = img.width
    const height = img.height

    const ratio = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height))
    const targetWidth = Math.max(1, Math.round(width * ratio))
    const targetHeight = Math.max(1, Math.round(height * ratio))

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) return file

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((output) => resolve(output), 'image/jpeg', 0.9)
    })

    return blob ?? file
  } finally {
    URL.revokeObjectURL(imageUrl)
  }
}

export function useReceiptOcr() {
  const workerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null)
  const [status, setStatus] = useState<OcrStatus>('idle')
  const [progress, setProgress] = useState<OcrProgress>({ progress: 0, statusText: 'Idle' })
  const [result, setResult] = useState<ParsedReceiptResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const getWorker = useCallback(async () => {
    if (workerRef.current) return workerRef.current

    setStatus('loading')

    const worker = await createWorker(['tha', 'eng'], 1, {
      logger: (msg) => {
        setProgress({
          progress: Math.round((msg.progress ?? 0) * 100),
          statusText: msg.status,
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

  const cancelOcr = useCallback(async () => {
    await terminate()
    setStatus('idle')
    setProgress({ progress: 0, statusText: 'Cancelled' })
    setError('ยกเลิก OCR แล้ว')
  }, [terminate])

  const runOcr = useCallback(
    async (file: File) => {
      setError(null)
      setResult(null)
      setStatus('recognizing')
      setProgress({ progress: 0, statusText: 'Preparing OCR...' })

      try {
        const worker = await getWorker()

        setProgress({ progress: 5, statusText: 'Optimizing image...' })
        const optimizedImage = await downscaleImage(file)

        const recognizePromise = worker.recognize(optimizedImage)
        const timeoutPromise = new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('OCR timeout: ใช้เวลานานเกิน 90 วินาที')), OCR_TIMEOUT_MS)
        })

        const recognized = await Promise.race([recognizePromise, timeoutPromise])
        const parsed = parseReceiptText(recognized.data.text)

        setResult(parsed)
        setStatus('completed')
        setProgress((prev) => ({ ...prev, progress: 100, statusText: 'OCR completed' }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'OCR failed unexpectedly'
        if (message.includes('timeout')) {
          await terminate()
        }
        setStatus('error')
        setError(message)
      }
    },
    [getWorker, terminate],
  )

  const reset = useCallback(() => {
    setStatus('idle')
    setProgress({ progress: 0, statusText: 'Idle' })
    setResult(null)
    setError(null)
  }, [])

  return {
    status,
    progress,
    result,
    error,
    runOcr,
    reset,
    terminate,
    cancelOcr,
  }
}
