import type { ParsedReceiptItem, ParsedReceiptResult } from '../types/ocr'

const MONEY_REGEX = /(-?\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})|-?\d+(?:[.,]\d{1,2})?)/g

const SUMMARY_KEYWORDS = {
  subtotal: ['subtotal', 'sub total', 'ยอดก่อน', 'ก่อนภาษี', 'รวมก่อน'],
  vat: ['vat', 'tax', 'ภาษี', 'มูลค่าเพิ่ม'],
  total: ['total', 'grand total', 'net total', 'amount due', 'รวมสุทธิ', 'รวมทั้งสิ้น', 'รวม'],
}

function normalizeLine(line: string): string {
  return line
    .replace(/฿/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim()
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function extractLastMoneyValue(line: string): number | null {
  const matches = [...line.matchAll(MONEY_REGEX)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]?.[0]
  return last ? parseMoney(last) : null
}

function hasAnyKeyword(line: string, keywords: string[]): boolean {
  const lower = line.toLowerCase()
  return keywords.some((keyword) => lower.includes(keyword))
}

function isSummaryLine(line: string): boolean {
  return (
    hasAnyKeyword(line, SUMMARY_KEYWORDS.subtotal) ||
    hasAnyKeyword(line, SUMMARY_KEYWORDS.vat) ||
    hasAnyKeyword(line, SUMMARY_KEYWORDS.total)
  )
}

function sanitizeItemName(line: string): string {
  return line
    .replace(MONEY_REGEX, '')
    .replace(/[xX]\s*\d+$/, '')
    .replace(/[\s.]+$/g, '')
    .trim()
}

export function parseReceiptText(rawText: string): ParsedReceiptResult {
  const lines = rawText
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((line) => line.length > 0)

  let subtotal: number | null = null
  let vat: number | null = null
  let total: number | null = null

  const items: ParsedReceiptItem[] = []

  for (const line of lines) {
    const amount = extractLastMoneyValue(line)
    const lower = line.toLowerCase()

    if (amount !== null) {
      if (hasAnyKeyword(lower, SUMMARY_KEYWORDS.subtotal)) {
        subtotal = amount
        continue
      }

      if (hasAnyKeyword(lower, SUMMARY_KEYWORDS.vat)) {
        vat = amount
        continue
      }

      if (hasAnyKeyword(lower, SUMMARY_KEYWORDS.total)) {
        total = amount
        continue
      }
    }

    if (amount === null || isSummaryLine(line)) continue

    const name = sanitizeItemName(line)
    if (!name || name.length < 2) continue

    items.push({
      id: crypto.randomUUID(),
      name,
      amount,
    })
  }

  if (total === null && items.length > 0) {
    total = Number(items.reduce((sum, item) => sum + item.amount, 0).toFixed(2))
  }

  return {
    rawText,
    lines,
    items,
    summary: {
      subtotal,
      vat,
      total,
    },
  }
}
