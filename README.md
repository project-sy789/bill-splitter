<div align="center">

# 🍽️ หารบิลกัน — แอปหารค่าใช้จ่ายกับเพื่อน

**แอปช่วยคำนวณและหารค่าใช้จ่ายกับเพื่อน ง่าย ฟรี ไม่ต้องติดตั้ง**

` ⚡ GitHub Pages `     ` 📜 MIT License `     ` 💎 100% Free `     ` 📱 PWA Ready `

🚨 **แอปพลิเคชันรูปแบบ PWA: ใช้งานออฟไลน์ได้ ข้อมูลทั้งหมดประมวลผลบนเครื่องของคุณ 100%** 🚨

</div>

---

## ✨ โดดเด่นด้วยฟีเจอร์ระดับพรีเมียม (ใช้งานฟรีทั้งหมด)

| ฟีเจอร์ | รายละเอียด |
|---|---|
| 📱 **ติดตั้งเป็นแอป (PWA)** | รองรับการติดตั้งลงบนหน้าจอโฮมมือถือ (Add to Home Screen) เป็นแอปและใช้งานแบบ **ออฟไลน์** ได้ 100% |
| 🗂️ **ระบบบิลแยกอิสระ** | เพิ่มบิลได้หลายใบในรอบเดียว รองรับทั้งสแกนสลิปและจดเอง! |
| 💸 **หารแยกรายบิล (Per-Bill Fees)** | **[ใหม่!]** ตั้งค่าค่าบริการ (Service Charge), VAT และส่วนลดแยกกันในแต่ละบิลได้ จบปัญหาบิลปนกัน คนกินบิลไหนจ่าย SC บิลนั้น |
| 🤖 **AI อ่านสลิป (Gemini Vision)** | ถ่ายรูปสลิป — ระบบส่งให้ Gemini 2.0 Flash อ่านก่อน แม่นกว่า OCR ปกติมาก และมี fallback ไป Tesseract อัตโนมัติ |
| 👥 **จัดการแก๊งเพื่อน (Saved Groups)** | บันทึกกลุ่มเพื่อนประจำ ไม่ต้องพิมพ์ชื่อใหม่ทุกรอบ ดึง PromptPay ติดมาให้ด้วย |
| 💸 **คำนวณเงินฉลาดสุดๆ** | หักลบกลบหนี้ให้อัตโนมัติ ลดจำนวนการโอนเงินไปมาให้เหลือ "น้อยที่สุด" |
| 📊 **แชร์สรุปบิลสวยๆ (Export PNG)** | กด Export รูปสรุปเพื่อส่งเข้าแชท พร้อม QR Code PromptPay ให้เพื่อนเปิดสแกนโอนได้ทันที! |

---

## 🚀 วิธีเปิดใช้งาน / ติดตั้งลงมือถือ

1. เข้าบราวเซอร์ (Safari, Chrome) แล้วไปที่ 👉 **[หารบิลกัน](https://project-sy789.github.io/bill-splitter/)**
2. **สำหรับ iOS:** กดปุ่ม **Share (แชร์)** เลื่อนลงมาเลือก **"Add to Home Screen" (เพิ่มไปยังหน้าจอโฮม)**
3. **สำหรับ Android:** กดไอคอน **3 จุด** มุมขวาบน แล้วเลือก **"Install App" (ติดตั้งแอป)**
4. ไอคอนแอป **"หารบิลกัน" สีม่วงสวยงาม** จะไปโผล่บนหน้าจอมือถือของคุณ สามารถเปิดใช้งานออฟไลน์ครั้งต่อไปได้ทันที!

---

## 🛠️ รันในเครื่องตัวเอง (สำหรับนักพัฒนา)

```bash
git clone https://github.com/project-sy789/bill-splitter.git
cd bill-splitter
npm install
npm run dev
```

เปิด http://localhost:5173/bill-splitter/

### Deploy Cloudflare Worker (สำหรับ AI OCR)

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY   # ใส่ Gemini API Key
npx wrangler deploy
```

จากนั้นเพิ่ม `VITE_GEMINI_PROXY_URL=<worker-url>` ใน `.env.local` แล้ว build ใหม่

---

## 🧱 Tech Stack

| ส่วน | เทคโนโลยี |
|---|---|
| UI Framework | React 19 + Vite + TypeScript |
| Web Standards | Progressive Web App (PWA) + SEO + IndexedDB |
| Styling | Tailwind CSS |
| AI OCR (หลัก) | Google Gemini 2.0 Flash Vision — ผ่าน Cloudflare Workers Proxy |
| OCR (สำรอง) | Tesseract.js (tha + eng) — fallback อัตโนมัติ |
| API Proxy | Cloudflare Workers — ซ่อน Gemini API Key ฝั่ง server |
| Database | IndexedDB (เก็บประวัติบิลในเครื่อง จุได้ไม่จำกัด) |

---

## 📄 License & Privacy

**MIT License** — ใช้งาน ดัดแปลง หรือนำไปแจกจ่ายได้ฟรี 100%

> 🔒 **ข้อมูลส่วนตัวของคุณ ปลอดภัยบนเครื่องคุณ**<br/>
> บิล รายชื่อเพื่อน และเบอร์ PromptPay **ไม่เคยออกไปนอกเครื่องของคุณ** — เก็บใน IndexedDB บน browser ล้วนๆ<br/>
> รูปสลิปที่สแกนจะถูกส่งผ่าน Cloudflare Workers Proxy ไปยัง Gemini เพื่ออ่านรายการ **ไม่มีการเก็บรูปหรือข้อมูลใดๆ** ไว้ที่ server ทั้งสิ้น
