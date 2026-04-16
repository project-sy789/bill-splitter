export interface ParsedReceiptItem {
  id: string
  name: string
  amount: number
}

export interface ParsedReceiptSummary {
  subtotal: number | null
  vat: number | null
  total: number | null
}

export interface ParsedReceiptResult {
  rawText: string
  lines: string[]
  items: ParsedReceiptItem[]
  summary: ParsedReceiptSummary
  /** true when receipt explicitly states prices already include VAT (e.g. "VAT INCLUDED") */
  vatIncluded: boolean
  customName?: string
}

export type OcrStatus = 'idle' | 'loading' | 'recognizing' | 'completed' | 'error'
