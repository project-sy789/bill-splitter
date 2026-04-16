/**
 * bill-splitter-proxy — Cloudflare Worker
 *
 * Routes:
 *   POST /ocr   { imageBase64: string, mimeType: string }
 *               → ParsedReceiptResult JSON
 *               ← 429 if Gemini quota exceeded
 *
 * Env vars (secrets):
 *   GEMINI_API_KEY  — set via: wrangler secret put GEMINI_API_KEY
 *
 * CORS:
 *   Only allows requests from ALLOWED_ORIGIN (configured in wrangler.toml)
 */

export interface Env {
  GEMINI_API_KEY: string
  ALLOWED_ORIGIN: string
}

// ── Types mirrored from frontend ──────────────────────────────────────────────

interface ParsedReceiptItem {
  id: string
  name: string
  amount: number
}

interface ParsedReceiptResult {
  rawText: string
  lines: string[]
  items: ParsedReceiptItem[]
  summary: {
    subtotal: number | null
    vat: number | null
    total: number | null
  }
  vatIncluded: boolean
}

// ── Gemini helper ─────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.0-flash'
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

const RECEIPT_PROMPT = `คุณเป็นผู้เชี่ยวชาญในการอ่านใบเสร็จไทยและต่างประเทศ

วิเคราะห์ใบเสร็จในรูปภาพนี้อย่างละเอียด แล้ว **ตอบเป็น JSON เท่านั้น** ตามรูปแบบด้านล่าง ห้ามมีข้อความอื่นนอก JSON:

{
  "items": [
    { "name": "ชื่อรายการ", "amount": 99.00 }
  ],
  "subtotal": 198.00,
  "vat": 13.86,
  "total": 211.86,
  "vatIncluded": false,
  "rawLines": ["บรรทัดที่ 1", "บรรทัดที่ 2"]
}

กฎสำคัญ:
- "items" คือรายการที่ลูกค้าสั่ง แต่ละรายการมี name และ amount (ราคาต่อรายการ รวมถ้ามีหลายชิ้น)
- ถ้าไม่พบรายการใด ให้ใส่ array ว่าง []
- "subtotal" คือยอดก่อน VAT (null ถ้าหาไม่ได้)
- "vat" คือภาษีมูลค่าเพิ่ม (null ถ้าไม่มี)
- "total" คือยอดรวมทั้งหมด (null ถ้าหาไม่ได้)
- "vatIncluded" = true ถ้าราคาในรายการรวม VAT แล้ว
- "rawLines" คือข้อความจากใบเสร็จทุกบรรทัด (สำหรับ debug)
- amount ต้องเป็นตัวเลขเท่านั้น ไม่มีสัญลักษณ์`

async function callGemini(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
): Promise<ParsedReceiptResult> {
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`

  const body = {
    contents: [
      {
        parts: [
          { text: RECEIPT_PROMPT },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.status === 429) {
    throw new Error('RATE_LIMIT')
  }

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini error ${res.status}: ${errText}`)
  }

  const json = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
    }>
  }

  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

  // Parse the JSON response from Gemini
  let parsed: {
    items?: Array<{ name?: string; amount?: number }>
    subtotal?: number | null
    vat?: number | null
    total?: number | null
    vatIncluded?: boolean
    rawLines?: string[]
  }

  try {
    // Strip markdown code fences if Gemini wraps in ```json
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`Failed to parse Gemini JSON: ${rawText.slice(0, 200)}`)
  }

  const items: ParsedReceiptItem[] = (parsed.items ?? []).map((it, i) => ({
    id: `gemini-${Date.now()}-${i}`,
    name: String(it.name ?? '').trim() || `รายการ ${i + 1}`,
    amount: Number(it.amount) || 0,
  }))

  const lines = parsed.rawLines ?? rawText.split('\n').filter(Boolean)

  return {
    rawText: lines.join('\n'),
    lines,
    items,
    summary: {
      subtotal: parsed.subtotal ?? null,
      vat: parsed.vat ?? null,
      total: parsed.total ?? null,
    },
    vatIncluded: parsed.vatIncluded ?? false,
  }
}

// ── CORS helper ───────────────────────────────────────────────────────────────

function corsHeaders(origin: string, allowedOrigin: string): Record<string, string> {
  // Allow localhost for dev, and the configured production origin
  const allowed = [allowedOrigin, 'http://localhost:5173', 'http://localhost:4173']
  const finalOrigin = allowed.includes(origin) ? origin : allowedOrigin

  return {
    'Access-Control-Allow-Origin': finalOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? ''
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN)

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const url = new URL(request.url)

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ ok: true }, { headers: cors })
    }

    // OCR endpoint
    if (url.pathname === '/ocr' && request.method === 'POST') {
      if (!env.GEMINI_API_KEY) {
        return Response.json(
          { error: 'GEMINI_API_KEY not configured' },
          { status: 500, headers: cors },
        )
      }

      let body: { imageBase64?: string; mimeType?: string }
      try {
        body = await request.json() as { imageBase64?: string; mimeType?: string }
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors })
      }

      const { imageBase64, mimeType } = body
      if (!imageBase64 || !mimeType) {
        return Response.json(
          { error: 'Missing imageBase64 or mimeType' },
          { status: 400, headers: cors },
        )
      }

      try {
        const result = await callGemini(env.GEMINI_API_KEY, imageBase64, mimeType)
        return Response.json(result, { headers: cors })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'RATE_LIMIT') {
          return Response.json(
            { error: 'RATE_LIMIT', message: 'Gemini quota exceeded, use Tesseract fallback' },
            { status: 429, headers: cors },
          )
        }
        console.error('Gemini OCR error:', msg)
        return Response.json(
          { error: 'OCR_FAILED', message: msg },
          { status: 502, headers: cors },
        )
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: cors })
  },
} satisfies ExportedHandler<Env>
