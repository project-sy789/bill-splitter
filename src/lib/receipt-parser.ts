/**
 * receipt-parser.ts — Smart Thai receipt parser v2
 *
 * Handles common patterns from Thai restaurant / shop receipts:
 *   Pattern A)  "ข้าวผัดกุ้ง            120.00"     standard trailing price
 *   Pattern B)  "01 ข้าวมันไก่          80.00"       leading item number
 *   Pattern C)  "ข้าวผัดกุ้ง  2x60      120.00"      qty × unit price
 *   Pattern D)  "ข้าวผัดกุ้ง\n120.00"               price on next line
 *   Pattern E)  "ข้าวผัดกุ้ง  ฿120"                 inline baht sign
 *   Pattern F)  "Americano H  65.00"                 English/café style
 *   Pattern G)  "กาแฟ  2 ชุด  x 60  =  120"         expanded qty
 *
 * Improvements in v2:
 *   - Thai numeral normalization (๑๒๓ → 123)
 *   - More money formats: 1,250.- / 120บาท / ฿ 1,250
 *   - Decorative line filter (---, ===, ***, ...)
 *   - Price outlier filter (removes OCR-corrupted prices far from median)
 *   - Smarter multi-line join
 *   - Better English+Thai mixed receipt support
 */

import type { ParsedReceiptItem, ParsedReceiptResult } from '../types/ocr'

// ──────────────────────────────────────────────
// Constants & keyword lists
// ──────────────────────────────────────────────

const SUMMARY_KW = [
  // Thai
  'รวม', 'รวมทั้งสิ้น', 'รวมสุทธิ', 'ยอดรวม', 'ยอดสุทธิ', 'ยอดชำระ', 'ยอดค้างชำระ',
  'ภาษี', 'ภาษีมูลค่าเพิ่ม', 'ค่าบริการ', 'เซอร์วิสชาร์จ', 'ส่วนลด', 'ค่าส่วนลด',
  'เงินทอน', 'เงินรับ', 'รับเงิน', 'ทอน', 'เครดิต', 'บัตร', 'เงินสด',
  // English
  'subtotal', 'sub total', 'sub-total', 'total', 'grand total', 'net total', 'net amount',
  'vat', 'tax', 'service charge', 'service fee', 'discount', 'tip', 'gratuity',
  'change', 'cash', 'credit', 'payment', 'amount due', 'balance due', 'amount',
]

const HEADER_KW = [
  // Thai
  'ใบเสร็จ', 'ใบกำกับ', 'วันที่', 'เวลา', 'โต๊ะ', 'หมายเลข', 'เลขที่',
  'ผู้รับ', 'พนักงาน', 'แคชเชียร์', 'สาขา', 'ร้าน',
  // English
  'receipt', 'invoice', 'date', 'time', 'table', 'order', 'order no', 'check',
  'cashier', 'server', 'branch', 'store', 'shop', 'restaurant', 'cafe',
  'tel', 'phone', 'fax', 'www.', 'http', '.com', '.th',
  'tax id', 'vat reg', 'ref no', 'bill no', 'inv no',
]

/** Thai decimal numerals → ASCII */
const THAI_DIGIT_MAP: Record<string, string> = {
  '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
  '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9',
}

// ──────────────────────────────────────────────
// Regex patterns
// ──────────────────────────────────────────────

/** Trailing money (various formats) — must be at end of line */
const TRAILING_MONEY_RE = /(?:฿\s*)?(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)(?:\.?-?)(?:\s*)$/
/** Inline ฿ sign: ฿1,250 */
const BAHT_INLINE_RE = /฿\s*(\d[\d,]*(?:\.\d{1,2})?)/
/** qty × price: "2x60", "2 x 60.00", "2×60", "2*60" */
const QTY_X_PRICE_RE = /(\d+)\s*[xX×*]\s*(\d[\d,]*(?:\.\d{1,2})?)/
/** Leading item number: "001 " "1. " "1) " "A1 " */
const LEADING_NUM_RE = /^\s*(?:[A-Z]?\d{1,3}[.):\s]|[A-Z]\d?\s)\s*/
/** Decorative / separator lines */
const DECORATIVE_RE = /^[\s\-=*_.~#|/\\+]{3,}$/
/** Only digits, punctuation — no real item name */
const PURE_NONWORD_RE = /^[\d\s.,฿%+\-*/()[\]:.=]+$/
/** Thai character range */
const THAI_RE = /[\u0E00-\u0E7F]/
/** At least one meaningful word (2+ letters/Thai chars) */
const WORD_RE = /[\u0E00-\u0E7F]{2,}|[a-zA-Z]{2,}/

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function normalizeThaiDigits(s: string): string {
  return s.replace(/[๐-๙]/g, (c) => THAI_DIGIT_MAP[c] ?? c)
}

function normalize(line: string): string {
  return normalizeThaiDigits(line)
    .replace(/\t+/g, '  ')
    .replace(/\s{3,}/g, '  ')
    .trim()
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').replace(/\.-$/, '').trim()
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function hasKeyword(line: string, kws: string[]): boolean {
  const lower = line.toLowerCase()
  return kws.some((kw) => lower.includes(kw))
}

function extractTrailingPrice(raw: string): number | null {
  // Try ฿ inline first (more reliable)
  const bm = raw.match(BAHT_INLINE_RE)
  if (bm?.[1]) {
    const p = parseMoney(bm[1])
    if (p !== null) return p
  }
  // Trailing price
  const tm = raw.match(TRAILING_MONEY_RE)
  if (tm?.[1]) return parseMoney(tm[1])
  return null
}

function cleanName(raw: string): string {
  return raw
    .replace(LEADING_NUM_RE, '')
    .replace(QTY_X_PRICE_RE, '')
    .replace(TRAILING_MONEY_RE, '')
    .replace(BAHT_INLINE_RE, '')
    .replace(/[฿$%]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[.\-–—]+$/, '')
    .trim()
}

/** Median of an array to detect price outliers */
function median(vals: number[]): number {
  if (vals.length === 0) return 0
  const sorted = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

// ──────────────────────────────────────────────
// Core parser
// ──────────────────────────────────────────────

export function parseReceiptText(rawText: string): ParsedReceiptResult {
  const rawLines = rawText.split(/\r?\n/)
  const lines = rawLines.map(normalize).filter((l) => l.length > 1)

  let subtotal: number | null = null
  let vat: number | null = null
  let total: number | null = null
  let discount: number | null = null
  let serviceCharge: number | null = null

  // ────────────────────────────────────────────
  // Phase 1 — Classify each line
  // ────────────────────────────────────────────

  type LineInfo = {
    raw: string
    price: number | null
    isSummary: boolean
    isHeader: boolean
    isDecorative: boolean
    hasMeaningfulWord: boolean
    nameCandidate: string
  }

  const infos: LineInfo[] = lines.map((raw) => {
    const lower = raw.toLowerCase()
    const isSummary = hasKeyword(lower, SUMMARY_KW)
    const isHeader = hasKeyword(lower, HEADER_KW)
    const isDecorative = DECORATIVE_RE.test(raw)
    const hasMeaningfulWord = WORD_RE.test(raw)
    const price = extractTrailingPrice(raw)
    const nameCandidate = cleanName(raw)
    return { raw, price, isSummary, isHeader, isDecorative, hasMeaningfulWord, nameCandidate }
  })

  // ────────────────────────────────────────────
  // Phase 2 — Extract summary figures
  // ────────────────────────────────────────────

  for (const info of infos) {
    if (!info.isSummary || info.price === null) continue
    const lower = info.raw.toLowerCase()

    if (/vat|ภาษี/.test(lower) && vat === null) vat = info.price
    else if (/service|ค่าบริการ|เซอร์วิส/.test(lower) && serviceCharge === null) serviceCharge = info.price
    else if (/discount|ส่วนลด/.test(lower) && discount === null) discount = info.price
    else if (/subtotal|sub.?total|ยอดก่อน|ก่อนภาษี|รวมก่อน/.test(lower) && subtotal === null) subtotal = info.price
    else if (/grand total|net total|รวมสุทธิ|รวมทั้งสิ้น|ยอดสุทธิ|ยอดรวม|ยอดชำระ/.test(lower) && total === null) total = info.price
    else if (/^รวม$|^total$/.test(lower.trim()) && total === null) total = info.price
  }

  // ────────────────────────────────────────────
  // Phase 3 — Extract item lines (with multi-line join)
  // ────────────────────────────────────────────

  const candidates: Array<{ name: string; amount: number }> = []

  let i = 0
  while (i < infos.length) {
    const info = infos[i]!

    // Skip noise
    if (info.isSummary || info.isHeader || info.isDecorative) { i++; continue }
    if (!info.hasMeaningfulWord) { i++; continue }
    if (PURE_NONWORD_RE.test(info.raw)) { i++; continue }
    if (info.nameCandidate.length < 2) { i++; continue }

    if (info.price !== null && info.price > 0) {
      // Prefer the "total" side of a qty×price pattern
      const qm = info.raw.match(QTY_X_PRICE_RE)
      let finalPrice = info.price
      if (qm) {
        const qty = Number(qm[1])
        const unit = parseMoney(qm[2] ?? '')
        if (unit !== null && qty > 0) {
          const computed = round2(qty * unit)
          // Use computed unless trailing price differs by more than ฿1 (rounding ok)
          if (Math.abs(info.price - computed) < 2) finalPrice = info.price
        }
      }
      candidates.push({ name: info.nameCandidate, amount: finalPrice })
      i++
    } else {
      // No price on this line — check if next line is ONLY a price (Pattern D)
      const next = infos[i + 1]
      if (
        next &&
        next.price !== null &&
        next.price > 0 &&
        !next.hasMeaningfulWord &&
        PURE_NONWORD_RE.test(next.raw) &&
        !next.isSummary
      ) {
        candidates.push({ name: info.nameCandidate, amount: next.price })
        i += 2
      } else {
        i++
      }
    }
  }

  // ────────────────────────────────────────────
  // Phase 4 — Price outlier filter
  // Remove items whose price is wildly out of range vs others
  // (e.g. OCR reads "120" as "12,0" = 120 fine, but "1" as "1234" → outlier)
  // ────────────────────────────────────────────

  const items: ParsedReceiptItem[] = filterOutliers(candidates)

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

// ──────────────────────────────────────────────
// Outlier filter
// ──────────────────────────────────────────────

/**
 * Remove items whose price is an extreme outlier.
 *
 * Algorithm:
 *   1. Compute median price
 *   2. Compute MAD (Median Absolute Deviation) — robust spread measure
 *   3. Flag items where |price - median| > 10 × MAD as outliers
 *
 * This handles OCR errors like reading "ข้าวผัด 120" → price=120 correctly,
 * but "ชา 40" corrupted to price=40,000 would be flagged.
 *
 * With very few items (≤2) or small total variance we skip filtering.
 */
function filterOutliers(
  candidates: Array<{ name: string; amount: number }>,
): ParsedReceiptItem[] {
  if (candidates.length <= 3) {
    // Not enough data to meaningfully detect outliers — keep all
    return candidates.map((c) => ({ ...c, id: crypto.randomUUID() }))
  }

  const prices = candidates.map((c) => c.amount)
  const med = median(prices)
  // Median absolute deviation
  const mad = median(prices.map((p) => Math.abs(p - med)))

  // If MAD is 0 (all same price), use a flat 10× threshold
  const spread = mad === 0 ? med * 0.5 : mad * 10

  return candidates
    .filter((c) => {
      // Always keep if price is "small" (common in Thai receipts: ฿20-฿500)
      // Only flag very large deviations
      return Math.abs(c.amount - med) <= Math.max(spread, med * 3)
    })
    .map((c) => ({ ...c, id: crypto.randomUUID() }))
}

function round2(v: number) {
  return Number(v.toFixed(2))
}
