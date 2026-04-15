/**
 * receipt-parser.ts — Smart Thai receipt parser
 *
 * Handles common patterns from Thai restaurant / shop receipts:
 *   Pattern A)  "ข้าวผัดกุ้ง            120.00"
 *   Pattern B)  "01 ข้าวมันไก่          80.00"    (leading item number)
 *   Pattern C)  "ข้าวผัดกุ้ง  2x60      120.00"   (qty × unit)
 *   Pattern D)  "ข้าวผัดกุ้ง\n120.00"             (price on next line)
 *   Pattern E)  "ข้าวผัดกุ้ง  ฿120"
 */

import type { ParsedReceiptItem, ParsedReceiptResult } from '../types/ocr'

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

/** Keywords that indicate a *summary* line — skip these as items */
const SUMMARY_KW = [
  // Thai
  'รวม', 'รวมทั้งสิ้น', 'รวมสุทธิ', 'ยอดรวม', 'ยอดสุทธิ', 'ยอดชำระ',
  'ภาษี', 'ภาษีมูลค่าเพิ่ม', 'ค่าบริการ', 'เซอร์วิสชาร์จ', 'ส่วนลด',
  'เงินทอน', 'เงินรับ', 'รับเงิน', 'ทอน', 'เครดิต', 'บัตร',
  // English
  'subtotal', 'sub total', 'total', 'grand total', 'net total',
  'vat', 'tax', 'service charge', 'service', 'discount', 'tip',
  'change', 'cash', 'credit', 'payment', 'amount due',
]

/** Keywords that indicate a *header/footer* line */
const HEADER_KW = [
  // Thai
  'ใบเสร็จ', 'ใบกำกับ', 'วันที่', 'เวลา', 'โต๊ะ', 'ที่', 'หมายเลข',
  'ชื่อ', 'ผู้รับ', 'พนักงาน', 'แคชเชียร์', 'สาขา',
  // English
  'receipt', 'invoice', 'date', 'time', 'table', 'order', 'cashier',
  'server', 'branch', 'tel', 'phone', 'fax', 'www', 'http',
  'tax id', 'vat reg', 'ref', 'no.', '#',
]

/** Regex: trailing money value (last number on a line) */
const TRAILING_MONEY_RE = /(?:฿\s*)?(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)(?:\s*)$/

/** Regex: Thai baht symbol inline */
const BAHT_INLINE_RE = /฿\s*(\d[\d,]*(?:\.\d{1,2})?)/

/** Regex: quantity × price  e.g. "2x60", "2 x 60.00", "2×60" */
const QTY_X_PRICE_RE = /(\d+)\s*[xX×]\s*(\d[\d,]*(?:\.\d{1,2})?)/

/** Regex: leading item number e.g. "001 " "1. " "1) " */
const LEADING_NUM_RE = /^\s*\d{1,3}[.):\s]\s*/

/** Regex: only digits/spaces/punctuation (no real word chars) */
const NO_WORD_RE = /^[\d\s.,฿%+\-*/()[\]]+$/

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function normalize(line: string): string {
  return line
    .replace(/\t+/g, '  ')   // tabs → spaces
    .replace(/\s{3,}/g, '  ') // collapse long runs of spaces
    .replace(/฿/g, '฿')      // normalise Baht sign (sometimes OCR garbles it)
    .trim()
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim()
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Returns true if line contains any word from a keyword list */
function hasKeyword(line: string, keywords: string[]): boolean {
  const lower = line.toLowerCase()
  return keywords.some((kw) => lower.includes(kw))
}

/** Remove leading item numbers and clean up */
function cleanName(raw: string): string {
  return raw
    .replace(LEADING_NUM_RE, '')
    .replace(TRAILING_MONEY_RE, '')
    .replace(QTY_X_PRICE_RE, '')           // remove "2x60"
    .replace(/[฿$%]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[.\-–—]+$/, '')
    .trim()
}

// ──────────────────────────────────────────────
// Core parser
// ──────────────────────────────────────────────

export function parseReceiptText(rawText: string): ParsedReceiptResult {
  const rawLines = rawText.split(/\r?\n/)
  const lines = rawLines.map(normalize).filter((l) => l.length > 0)

  let subtotal: number | null = null
  let vat: number | null = null
  let total: number | null = null
  let discount: number | null = null
  let serviceCharge: number | null = null

  const items: ParsedReceiptItem[] = []

  // ── Phase 1: classify and extract summary values ──
  // We do two passes: first build a price map, then pick items

  type LineInfo = {
    raw: string
    price: number | null
    isSummary: boolean
    isHeader: boolean
    hasThaiChar: boolean
    nameCandidate: string
  }

  const thaiRangeRe = /[\u0E00-\u0E7F]/
  const latinWordRe = /[a-zA-Z]{2,}/

  const lineInfos: LineInfo[] = lines.map((raw) => {
    const lower = raw.toLowerCase()
    const isSummary = hasKeyword(lower, SUMMARY_KW)
    const isHeader = hasKeyword(lower, HEADER_KW)
    const hasThaiChar = thaiRangeRe.test(raw)

    // Try ฿ inline first
    let price: number | null = null
    const bahtMatch = raw.match(BAHT_INLINE_RE)
    if (bahtMatch?.[1]) {
      price = parseMoney(bahtMatch[1])
    }
    // Then trailing number
    if (price === null) {
      const trailMatch = raw.match(TRAILING_MONEY_RE)
      if (trailMatch?.[1]) {
        price = parseMoney(trailMatch[1])
      }
    }

    const nameCandidate = cleanName(raw)

    return { raw, price, isSummary, isHeader, hasThaiChar, nameCandidate }
  })

  // ── Phase 2: Extract summary totals ──
  for (const info of lineInfos) {
    if (!info.isSummary || info.price === null) continue
    const lower = info.raw.toLowerCase()

    if (/vat|ภาษี/.test(lower) && vat === null) {
      vat = info.price
    } else if (/service|ค่าบริการ|เซอร์วิส/.test(lower) && serviceCharge === null) {
      serviceCharge = info.price
    } else if (/discount|ส่วนลด/.test(lower) && discount === null) {
      discount = info.price
    } else if (/subtotal|sub total|ยอดก่อน|ก่อนภาษี|รวมก่อน/.test(lower) && subtotal === null) {
      subtotal = info.price
    } else if (/grand total|net total|รวมสุทธิ|รวมทั้งสิ้น|ยอดสุทธิ|ยอดรวม/.test(lower) && total === null) {
      total = info.price
    } else if (/^รวม$|^total$/.test(lower.trim()) && total === null) {
      total = info.price
    }
  }

  // ── Phase 3: Extract items ──
  let i = 0
  while (i < lineInfos.length) {
    const info = lineInfos[i]!

    // Skip summary / header lines
    if (info.isSummary || info.isHeader) { i++; continue }

    // Skip lines that are only numbers / punctuation
    if (NO_WORD_RE.test(info.raw)) { i++; continue }

    // Skip very short lines (≤ 2 chars after cleaning)
    if (info.nameCandidate.length < 2) { i++; continue }

    // Must have either Thai chars or at least 2 Latin letters
    if (!info.hasThaiChar && !latinWordRe.test(info.raw)) { i++; continue }

    if (info.price !== null && info.price > 0) {
      // Check qty × price pattern and prefer the total (trailing)
      const qtyMatch = info.raw.match(QTY_X_PRICE_RE)
      let finalPrice = info.price
      if (qtyMatch) {
        const qty = Number(qtyMatch[1])
        const unitPrice = parseMoney(qtyMatch[2] ?? '')
        if (unitPrice !== null && qty > 0) {
          finalPrice = round2(qty * unitPrice)
          // Override with trailing total if it's non-zero and different
          const trailing = lineInfos[i]?.price
          if (trailing && Math.abs(trailing - finalPrice) < 1) {
            finalPrice = trailing
          }
        }
      }

      items.push({ id: crypto.randomUUID(), name: info.nameCandidate, amount: finalPrice })
      i++
    } else {
      // No price on this line — check if next line IS just a price (Pattern D)
      const next = lineInfos[i + 1]
      if (
        next &&
        next.price !== null &&
        next.price > 0 &&
        !next.hasThaiChar &&
        !next.isSummary &&
        NO_WORD_RE.test(next.raw)
      ) {
        items.push({ id: crypto.randomUUID(), name: info.nameCandidate, amount: next.price })
        i += 2 // consume both lines
      } else {
        i++
      }
    }
  }

  // If no grand total found, sum items
  if (total === null && items.length > 0) {
    total = round2(items.reduce((s, it) => s + it.amount, 0))
  }

  return {
    rawText,
    lines,
    items,
    summary: { subtotal, vat, total },
  }
}

function round2(v: number) {
  return Number(v.toFixed(2))
}
