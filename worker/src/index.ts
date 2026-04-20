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

      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: 'อ่านข้อความจากใบเสร็จภาษาไทย/อังกฤษ แล้วตอบกลับเป็น JSON ล้วนเท่านั้น ห้ามมี markdown หรือคำอธิบายเสริม รูปแบบต้องเป็น: {"rawText":string,"lines":[string],"summary":{"total":number|null,"subtotal":number|null,"vat":number|null,"serviceCharge":number|null,"discount":number|null,"billDiscount":number|null,"vatIncluded":boolean},"items":[{"name":string,"amount":number}]} กฎสำคัญ: 1) ดึงชื่อสินค้าและราคาต่อบรรทัดให้ครบที่สุด 2) ถ้าพบ VAT/ค่าบริการ/ส่วนลด ให้ใส่ใน summary 3) ถ้าเห็นคำว่า VAT รวมในราคา ให้ตั้ง vatIncluded=true 4) ใช้ number จริงเท่านั้น ไม่ต้องใส่สัญลักษณ์เงิน 5) rawText และ lines ควรคงข้อความจากสลิปตามที่อ่านได้',
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
              temperature: 0.05,
            },
          }),
        },
      )

      if (!geminiResponse.ok) {
        const text = await geminiResponse.text()
        return jsonResponse({ error: `Gemini error ${geminiResponse.status}`, detail: text }, { status: geminiResponse.status }, origin, env)
      }

      const data = await geminiResponse.json() as any
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      const cleaned = text.replace(/```json|```/g, '').trim()
      let parsed: unknown
      try {
        parsed = JSON.parse(cleaned)
      } catch {
        return jsonResponse({ error: 'Gemini did not return valid JSON', raw: text }, { status: 502 }, origin, env)
      }

      return jsonResponse(parsed, { status: 200 }, origin, env)
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : 'Worker error' }, { status: 500 }, origin, env)
    }
  },
}
