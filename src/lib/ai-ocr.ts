import type { ParsedReceiptResult } from '../types/ocr'

const SYSTEM_PROMPT = `คุณเป็นผู้เชี่ยวชาญด้านการอ่านใบเสร็จร้านอาหารและใบเสร็จในไทย

หน้าที่ของคุณ: อ่านภาพใบเสร็จและแยกข้อมูลรายการสินค้า/อาหาร ออกมาในรูปแบบ JSON

กฎสำคัญ:
- ดึงเฉพาะรายการสินค้า/อาหาร พร้อมราคา
- ไม่รวม: subtotal, vat, service charge, total, discount, tip ในรายการ items
- แยก subtotal, vat, serviceCharge, discount, total ออกมาต่างหาก
- ชื่อรายการให้ใช้ภาษาไทยหรืออังกฤษตามที่ปรากฎในใบเสร็จ
- ราคาเป็นตัวเลขทศนิยม 2 ตำแหน่ง
- ถ้าอ่านไม่ออกหรือภาพไม่ชัด ให้ส่ง items เป็น array ว่าง

ตอบในรูปแบบ JSON เท่านั้น ห้ามมีข้อความอื่น:
{
  "items": [
    { "name": "ชื่อรายการ", "amount": 0.00 }
  ],
  "subtotal": null,
  "vat": null,
  "serviceCharge": null,
  "discount": null,
  "total": null
}`

export interface AiOcrResult {
  items: { name: string; amount: number }[]
  subtotal: number | null
  vat: number | null
  serviceCharge: number | null
  discount: number | null
  total: number | null
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // remove data:image/xxx;base64, prefix
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'))
    reader.readAsDataURL(file)
  })
}

export async function runAiOcr(
  file: File,
  apiKey: string,
  onProgress?: (pct: number, text: string) => void,
): Promise<ParsedReceiptResult> {
  onProgress?.(10, 'กำลังเตรียมภาพ...')

  const base64 = await fileToBase64(file)
  const mimeType = file.type || 'image/jpeg'

  onProgress?.(30, 'กำลังส่งภาพให้ AI วิเคราะห์...')

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64}`,
                detail: 'high',
              },
            },
            {
              type: 'text',
              text: 'กรุณาอ่านใบเสร็จนี้และส่งผลลัพธ์เป็น JSON ตามที่กำหนด',
            },
          ],
        },
      ],
    }),
  })

  onProgress?.(80, 'AI กำลังประมวลผล...')

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    const message = (errorData as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`
    throw new Error(`OpenAI API Error: ${message}`)
  }

  const data = await response.json() as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content ?? ''

  onProgress?.(90, 'กำลังแปลงผลลัพธ์...')

  // Extract JSON from response
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('AI ส่งผลลัพธ์ในรูปแบบที่ไม่ถูกต้อง')
  }

  const parsed = JSON.parse(jsonMatch[0]) as AiOcrResult

  const items = (parsed.items ?? []).map((item) => ({
    id: crypto.randomUUID(),
    name: item.name,
    amount: Number(item.amount) || 0,
  }))

  return {
    rawText: content,
    lines: [],
    items,
    summary: {
      subtotal: parsed.subtotal ?? null,
      vat: parsed.vat ?? null,
      total: parsed.total ?? null,
    },
  }
}
