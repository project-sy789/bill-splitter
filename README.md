<div align="center">

# หารบิลกัน

**แอปแชร์บิลที่ออกแบบมาสำหรับโต๊ะอาหารจริง — สแกนสลิป, แยกรายการ, เลือกคนจ่าย, สรุปว่าใครโอนใคร ได้ในไม่กี่แตะ**

`Mobile-first` • `PWA Ready` • `Offline-first` • `Gemini OCR` • `PromptPay` 

</div>

---

## ทำอะไรได้บ้าง

- สแกนสลิปด้วยกล้อง หรือแนบรูปจากอัลบั้ม
- ใช้ Gemini OCR ก่อน แล้วค่อย fallback ไป OCR ปกติอัตโนมัติ
- แยกบิลหลายใบในรอบเดียว และจัดการแต่ละบิลแบบอิสระ
- แก้รายการสินค้าได้ในบิลทันที ไม่ต้องวิ่งไปหน้ารวม
- ตั้ง `Service Charge`, `VAT`, `Discount`, คนจ่าย และคนหารได้ในที่เดียว
- สรุปว่าใครต้องโอนให้ใคร พร้อม PromptPay

---

## เปิดใช้งาน

1. เปิดเว็บแอป: [หารบิลกัน](https://project-sy789.github.io/bill-splitter/)
2. iPhone กด `Share` แล้วเลือก `Add to Home Screen`
3. Android กดเมนู `⋮` แล้วเลือก `Install App`
4. ใช้งานแบบเต็มจอ และเปิดออฟไลน์ได้หลังติดตั้ง

---

## รันในเครื่อง

```bash
git clone https://github.com/project-sy789/bill-splitter.git
cd bill-splitter
npm install
npm run dev
```

---

## OCR ด้วย Gemini

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

จากนั้นตั้ง `VITE_GEMINI_PROXY_URL=<worker-url>` ใน `.env.local` แล้ว build ใหม่

---

## Tech Stack

React 19 • Vite • TypeScript • Tailwind CSS • IndexedDB • Cloudflare Workers • Gemini Vision • Tesseract fallback

---

## Privacy

ข้อมูลบิล รายชื่อเพื่อน และ PromptPay เก็บบนเครื่องผู้ใช้เป็นหลัก
