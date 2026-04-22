export interface ParsedReceiptItem {
  id: string
  name: string
  amount: number
}

export interface ParsedReceiptSummary {
  subtotal: number | null
  vat: number | null
  serviceCharge: number | null
  billDiscount: number | null
  discount: number | null
  total: number | null
}

export interface ParsedReceiptResult {
  id?: string
  rawText: string
  lines: string[]
  items: ParsedReceiptItem[]
  summary: ParsedReceiptSummary
  /** true when receipt explicitly states prices already include VAT (e.g. "VAT INCLUDED") */
  vatIncluded: boolean
  customName?: string
  modelUsed?: string
}

export type OcrStatus = 'idle' | 'loading' | 'recognizing' | 'completed' | 'error'

export type OcrSource = 'gemini' | 'tesseract' | 'fallback' | null
