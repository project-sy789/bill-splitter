interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
      }>
    }
  }>
}

interface RawParsedData {
  rawText?: string
  lines?: string[]
  summary?: {
    total?: number | string | null
    subtotal?: number | string | null
    vat?: number | string | null
    serviceCharge?: number | string | null
    discount?: number | string | null
    billDiscount?: number | string | null
    vatIncluded?: boolean
  }
  items?: Array<{
    name?: string
    amount?: number | string | null
  }>
}

export interface Env {
  GEMINI_API_KEY: string
  CORS_ORIGIN?: string
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
}

function corsHeaders(origin: string | null, env: Env) {
  return {
    'Access-Control-Allow-Origin': env.CORS_ORIGIN ?? origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function jsonResponse(data: unknown, init: ResponseInit = {}, origin: string | null = null, env?: Env) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(env ? corsHeaders(origin, env) : {}),
      ...(init.headers ?? {}),
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(origin, env),
      })
    }

    if (request.method !== 'POST' || (url.pathname !== '/' && url.pathname !== '/ocr')) {
      return jsonResponse({ error: 'Not Found' }, { status: 404 }, origin, env)
    }

    try {
      const body = await request.json() as { imageBase64?: string; mimeType?: string }
      if (!body.imageBase64) {
        return jsonResponse({ error: 'Missing imageBase64' }, { status: 400 }, origin, env)
      }

    const models = [
      'gemini-2.0-flash-lite-preview-02-05', // Gemini 3.1 Flash Lite
      'gemini-1.5-flash'                     // Gemini 2.5 Flash
    ]

    const maxRetriesPerModel = 2
    let lastGeminiResponse: Response | null = null
    let successfulModel = ''

    for (const modelId of models) {
      for (let i = 0; i < maxRetriesPerModel; i++) {
        lastGeminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      text: `คุณเป็นผู้ช่วยอ่านใบเสร็จที่แม่นยำที่สุด หน้าที่ของคุณคืออ่านรูปใบเสร็จที่ได้รับแล้วสรุปข้อมูลออกมาเป็น JSON ตามโครงสร้างที่กำหนดเท่านั้น
                      
                      กฎเหล็ก:
                      1. ห้ามตอบนอกเหนือจาก JSON (ห้ามมีคำอธิบาย หรือ Markdown)
                      2. ข้อมูลตัวเลข (amount, total, etc.) ต้องเป็นตัวเลข (number) เท่านั้น ห้ามใส่เครื่องหมายคอมม่า (,) หรือหน่วยเงิน (฿, THB)
                      3. ดึงรายการสินค้าให้ครบทุกบรรทัด (items)
                      4. สรุปยอด (summary) ต้องประกอบด้วย:
                         - total: ยอดสุทธิท้ายสลิป
                         - subtotal: ยอดก่อนภาษี/ค่าบริการ (ถ้ามี)
                         - vat: ภาษีมูลค่าเพิ่ม (ถ้ามี)
                         - serviceCharge: ค่าบริการ (ถ้ามี)
                         - discount/billDiscount: ส่วนลด (ถ้ามี)
                         - vatIncluded: true หากในสลิประบุว่า "รวม VAT แล้ว" หรือราคาสินค้ารวมภาษีแล้ว
                      
                      โครงสร้าง JSON:
                      {
                        "rawText": "ข้อความทั้งหมดที่อ่านได้",
                        "lines": ["ข้อความแยกแต่ละบรรทัด"],
                        "summary": {
                          "total": number,
                          "subtotal": number,
                          "vat": number,
                          "serviceCharge": number,
                          "discount": number,
                          "billDiscount": number,
                          "vatIncluded": boolean
                        },
                        "items": [
                          { "name": "ชื่อสินค้า", "amount": number }
                        ]
                      }`,
                    },
                    {
                      inline_data: {
                        mime_type: body.mimeType ?? 'image/jpeg',
                        data: body.imageBase64,
                      },
                    },
                  ],
                },
              ],
              generationConfig: {
                temperature: 0.1,
                response_mime_type: "application/json"
              },
            }),
          },
        )

        if (lastGeminiResponse.ok) {
          successfulModel = modelId
          break
        }

        const retryableStatuses = [429, 503]
        if (!retryableStatuses.includes(lastGeminiResponse.status)) break
        
        const delay = lastGeminiResponse.status === 503 ? 2000 : 1000
        if (i < maxRetriesPerModel - 1) await new Promise(r => setTimeout(r, delay))
      }
      
      if (lastGeminiResponse?.ok) break
    }

    const geminiResponse = lastGeminiResponse!

    if (!geminiResponse.ok) {
      const text = await geminiResponse.text()
      return jsonResponse({ error: `Gemini error ${geminiResponse.status}`, detail: text }, { status: geminiResponse.status }, origin, env)
    }

      const data = await geminiResponse.json() as GeminiResponse
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      
      let parsed: RawParsedData
      try {
        parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      } catch {
        return jsonResponse({ error: 'Gemini did not return valid JSON', raw: text }, { status: 502 }, origin, env)
      }

      // --- Data Normalization ---
      const cleanNum = (val: number | string | null | undefined): number => {
        if (typeof val === 'number') return val
        if (typeof val === 'string') {
          const n = parseFloat(val.replace(/,/g, '').replace(/[฿฿]/g, ''))
          return isNaN(n) ? 0 : n
        }
        return 0
      }

      const normalized = {
        rawText: parsed.rawText || '',
        lines: Array.isArray(parsed.lines) ? parsed.lines : [],
        summary: {
          total: cleanNum(parsed.summary?.total),
          subtotal: cleanNum(parsed.summary?.subtotal),
          vat: cleanNum(parsed.summary?.vat),
          serviceCharge: cleanNum(parsed.summary?.serviceCharge),
          discount: cleanNum(parsed.summary?.discount),
          billDiscount: cleanNum(parsed.summary?.billDiscount),
          vatIncluded: !!parsed.summary?.vatIncluded
        },
        items: (Array.isArray(parsed.items) ? parsed.items : [])
          .map((it) => ({
            name: String(it.name || 'ไม่มีชื่อสินค้า').trim(),
            amount: cleanNum(it.amount)
          }))
          .filter((it) => it.amount > 0 || it.name.length > 0)
      }

      return jsonResponse(normalized, { status: 200 }, origin, env)
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : 'Worker error' }, { status: 500 }, origin, env)
    }
  },
}
