/**
 * receipt-parser.ts — Smart Thai receipt parser v3
 *
 * Real-world receipt patterns supported:
 *
 * 7-Eleven app screenshot:
 *   "1  รัมโบ้บีกเปาไส้หมูแดด      30.00"  → item ✓
 *   "1  ภาภกรัชอปหน้าร้าน          0.00N"  → skip (zero)
 *   "ยอดสุทธิ  2 ชิ้น              109.00"  → summary ✓
 *   "ทรูมินมีวอเล็ท               109.00"  → payment ✓
 *   "TID#20260415..."                        → skip ✓
 *
 * ONEDEE CAFE printed receipt:
 *   "IC ข้าวเหนียวดำเปียก(ราคา  1  119.00" → item ✓
 *   "ยอดรวม                       189.00"  → summary ✓
 *   "ทั้งหมด                    ฿189.00"  → total ✓
 *   "เงินสด                      ฿500.00"  → payment ✓
 *   "เงินทอน                     ฿311.00"  → payment ✓
 *
 * Cafe Damour POS receipt:
 *   "อเมริกาโน่เย็น       1    60.00 VD"   → item ✓ (strip VD)
 *   "[N] I-ชาเขียวนม[IGT] 1    65.00 VD"  → item ✓ (strip tags)
 *   "Max Card Plus 50%          -30.00"     → discount ✓
 *   "SubTotal              4   269.00"      → summary ✓
 *   "Vatable                    124.30"     → summary ✓
 */

import type { ParsedReceiptItem, ParsedReceiptResult } from '../types/ocr'

// ──────────────────────────────────────────────
// Keyword lists
// ──────────────────────────────────────────────

const SUMMARY_KW = [
  // Thai — totals
  'รวม', 'รวมทั้งสิ้น', 'รวมสุทธิ', 'ยอดรวม', 'ยอดสุทธิ', 'ยอดชำระ', 'ยอดค้างชำระ',
  'ทั้งหมด', 'สุทธิ',
  // Thai — taxes & fees
  'ภาษี', 'ภาษีมูลค่าเพิ่ม', 'ค่าบริการ', 'เซอร์วิสชาร์จ', 'ส่วนลด', 'ค่าส่วนลด',
  // Thai — payment
  'เงินทอน', 'เงินรับ', 'รับเงิน', 'เงินสด', 'ทอน', 'บัตร', 'เครดิต', 'เดบิต',
  // Thai — wallets / payment methods
  'วอเล็ท', 'wallet', 'ทรูมันนี่', 'ทรูมิน', 'ทรูวอ', 'rabbit', 'โอน', 'qr', 'พร้อมเพย์',
  // English — totals
  'subtotal', 'sub total', 'sub-total', 'total', 'grand total', 'net total', 'net amount',
  // English — taxes
  'vat', 'tax', 'vatable', 'vat included', 'service charge', 'service fee',
  // English — discounts
  'discount', 'card plus', 'max card', 'member', 'loyalty', 'promotion', 'promo',
  // English — payment
  'tip', 'gratuity', 'change', 'cash', 'credit', 'debit', 'payment',
  'amount due', 'balance due', 'amount paid',
]

const HEADER_KW = [
  // Thai
  'ใบเสร็จ', 'ใบกำกับ', 'วันที่', 'เวลา', 'โต๊ะ', 'หมายเลข', 'เลขที่', 'รหัส',
  'ผู้รับ', 'พนักงาน', 'แคชเชียร์', 'สาขา', 'ร้าน', 'ประเภท', 'ชื่อพนักงาน',
  'รายการสินค้า', 'สินค้า',
  // English
  'receipt', 'invoice', 'tax invoice', 'date', 'time', 'table', 'order', 'check',
  'cashier', 'server', 'branch', 'store', 'shop', 'restaurant', 'cafe', 'company',
  'tel', 'phone', 'fax', 'www.', 'http', '.com', '.th',
  'tax id', 'vat reg', 'ref no', 'bill no', 'inv no', 'staff', 'shop', 'take away',
  'qty', 'description', 'item', 'powered by',
]

/** Lines starting with transaction/reference IDs — always skip */
const TX_ID_RE = /^(?:tid#|r#|bid#|ref#|txn#|trn#|\*\s*ศูนย์)/i

/** Thai decimal numerals → ASCII */
const THAI_DIGIT_MAP: Record<string, string> = {
  '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
  '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9',
}

// ──────────────────────────────────────────────
// Regex patterns
// ──────────────────────────────────────────────

/**
 * Extract trailing price.
 * Supports:
 *   - "120.00"         standard
 *   - "60.00 VD"       POS tag suffix (up to 3 uppercase letters)
 *   - "0.00N"          digit immediately followed by letter
 *   - "1,250.-"        dash-terminated
 *   - "-30.00"         negative (discounts)
 */
const TRAILING_MONEY_RE =
  /(?:฿\s*)?(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)\s*[A-Za-z]{0,3}\.?\-?\s*$/

/** Inline ฿: ฿189.00 */
const BAHT_INLINE_RE = /฿\s*(\d[\d,]*(?:\.\d{1,2})?)/

/** qty × price: "2x60", "2 x 60.00", "2×60" */
const QTY_X_PRICE_RE = /(\d+)\s*[xX×*]\s*(\d[\d,]*(?:\.\d{1,2})?)/

/** Leading item number or quantity: "001 " "1. " "1) " "A1 " */
const LEADING_NUM_RE = /^\s*(?:[A-Z]?\d{1,3}[.):\s]|[A-Z]\d?\s)\s*/

/** Bracket tags: [N], [IGT], [IES], [IMP] */
const BRACKET_TAG_RE = /\[[^\]]{0,6}\]/g

/** Parenthetical POS codes at the end: (ราคาปกติ, Flavor: กะทิ) */
const PAREN_FLAVOR_RE = /\([^)]{0,60}\)\s*$/

/** Decorative / separator */
const DECORATIVE_RE = /^[\s\-=*_.~#|/\\+]{3,}$/

/** Only digits, punctuation — no real item name */
const PURE_NONWORD_RE = /^[\d\s.,฿%+\-*/()[\]:.=]+$/

/** Thai character range */
const THAI_RE = /[\u0E00-\u0E7F]/

/** At least 2 meaningful characters */
const WORD_RE = /[\u0E00-\u0E7F]{2,}|[a-zA-Z]{2,}/

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function normalizeLine(line: string): string {
  return line
    .replace(/[๐-๙]/g, (c) => THAI_DIGIT_MAP[c] ?? c)
    .replace(/\t+/g, '  ')
    .replace(/\s{3,}/g, '  ')
    .trim()
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').replace(/\.-$/, '').replace(/[A-Za-z]+$/, '').trim()
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function hasKeyword(line: string, kws: string[]): boolean {
  const lower = line.toLowerCase()
  return kws.some((kw) => lower.includes(kw))
}

function extractTrailingPrice(raw: string): number | null {
  // Try ฿ inline first (very reliable)
  const bm = raw.match(BAHT_INLINE_RE)
  if (bm?.[1]) {
    const p = parseMoney(bm[1])
    if (p !== null) return p
  }
  // Trailing price (handles VD, N suffix etc.)
  const tm = raw.match(TRAILING_MONEY_RE)
  if (tm?.[1]) return parseMoney(tm[1])
  return null
}

function cleanName(raw: string): string {
  return raw
    .replace(BRACKET_TAG_RE, '')         // [N], [IGT], [IES]
    .replace(PAREN_FLAVOR_RE, '')        // (ราคาปกติ, Flavor: กะทิ)
    .replace(LEADING_NUM_RE, '')         // leading item number
    .replace(QTY_X_PRICE_RE, '')        // 2x60
    .replace(TRAILING_MONEY_RE, '')     // trailing price + suffix
    .replace(BAHT_INLINE_RE, '')        // inline ฿
    .replace(/[฿$%]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[.\-–—]+$/, '')
    .trim()
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0
  const sorted = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

// ──────────────────────────────────────────────
// Core parser
// ──────────────────────────────────────────────

export function parseReceiptText(rawText: string): ParsedReceiptResult {
  const rawLines = rawText.split(/\r?\n/)
  const lines = rawLines.map(normalizeLine).filter((l) => l.length > 1)

  let subtotal: number | null = null
  let vat: number | null = null
  let total: number | null = null
  let discount: number | null = null
  let serviceCharge: number | null = null

  // ── Phase 1: classify lines ──

  type LineInfo = {
    raw: string
    price: number | null        // null if no price found
    isSummary: boolean
    isHeader: boolean
    isDecorative: boolean
    isTxId: boolean             // TID#, R# etc.
    isNegativePrice: boolean    // discount lines
    hasMeaningfulWord: boolean
    nameCandidate: string
  }

  const infos: LineInfo[] = lines.map((raw) => {
    const lower = raw.toLowerCase()
    const isSummary = hasKeyword(lower, SUMMARY_KW)
    const isHeader = hasKeyword(lower, HEADER_KW)
    const isDecorative = DECORATIVE_RE.test(raw)
    const isTxId = TX_ID_RE.test(raw)
    const price = extractTrailingPrice(raw)
    const isNegativePrice = price !== null && price < 0
    const hasMeaningfulWord = WORD_RE.test(raw)
    const nameCandidate = cleanName(raw)

    return { raw, price, isSummary, isHeader, isDecorative, isTxId, isNegativePrice, hasMeaningfulWord, nameCandidate }
  })

  // ── Phase 2: extract summary totals ──

  for (const info of infos) {
    if (!info.isSummary || info.price === null) continue
    if (info.isNegativePrice) { discount = (discount ?? 0) + Math.abs(info.price); continue }

    const lower = info.raw.toLowerCase()
    if (/vat(?!\s*included)|ภาษี/.test(lower) && vat === null) vat = info.price
    else if (/service|ค่าบริการ|เซอร์วิส/.test(lower) && serviceCharge === null) serviceCharge = info.price
    else if (/discount|ส่วนลด|card plus|max card/.test(lower) && discount === null) discount = info.price
    else if (/subtotal|sub.?total|ยอดก่อน|ก่อนภาษี|รวมก่อน/.test(lower) && subtotal === null) subtotal = info.price
    else if (/grand total|net total|รวมสุทธิ|รวมทั้งสิ้น|ยอดสุทธิ|ยอดรวม|ยอดชำระ|ทั้งหมด/.test(lower) && total === null) total = info.price
    else if (/^(?:รวม|total)$/.test(lower.trim()) && total === null) total = info.price
  }

  // ── Phase 3: extract item lines ──

  const candidates: Array<{ name: string; amount: number }> = []
  let i = 0

  while (i < infos.length) {
    const info = infos[i]!

    // Skip non-item lines
    if (info.isSummary || info.isHeader || info.isDecorative || info.isTxId) { i++; continue }
    if (!info.hasMeaningfulWord) { i++; continue }
    if (PURE_NONWORD_RE.test(info.raw)) { i++; continue }
    if (info.nameCandidate.length < 2) { i++; continue }
    if (!WORD_RE.test(info.nameCandidate)) { i++; continue }

    const price = info.price

    // Negative price → skip (already handled as discount in Phase 2)
    if (price !== null && price < 0) { i++; continue }

    // Zero price → skip (free promo items, OCR artifacts like 0.00N)
    if (price !== null && price === 0) { i++; continue }

    if (price !== null && price > 0) {
      // Handle qty×price pattern
      let finalPrice = price
      const qm = info.raw.match(QTY_X_PRICE_RE)
      if (qm) {
        const qty = Number(qm[1])
        const unit = parseMoney(qm[2] ?? '')
        if (unit !== null && qty > 0) {
          const computed = round2(qty * unit)
          if (Math.abs(price - computed) < 2) finalPrice = price // trailing wins
        }
      }
      candidates.push({ name: info.nameCandidate, amount: finalPrice })
      i++
    } else {
      // No price — check if next line is price-only (Pattern D)
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

  // ── Phase 4: outlier filter ──

  const items = filterOutliers(candidates)

  if (total === null && items.length > 0) {
    total = round2(items.reduce((s, it) => s + it.amount, 0))
  }

  return { rawText, lines, items, summary: { subtotal, vat, total } }
}

// ──────────────────────────────────────────────
// Outlier filter — MAD-based
// ──────────────────────────────────────────────

function filterOutliers(
  candidates: Array<{ name: string; amount: number }>,
): ParsedReceiptItem[] {
  if (candidates.length <= 3) {
    return candidates.map((c) => ({ ...c, id: crypto.randomUUID() }))
  }

  const prices = candidates.map((c) => c.amount)
  const med = median(prices)
  const mad = median(prices.map((p) => Math.abs(p - med)))
  const spread = mad === 0 ? med * 0.5 : mad * 10

  return candidates
    .filter((c) => Math.abs(c.amount - med) <= Math.max(spread, med * 3))
    .map((c) => ({ ...c, id: crypto.randomUUID() }))
}

function round2(v: number) {
  return Number(v.toFixed(2))
}
