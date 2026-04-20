<div align="center">

# หารบิลกัน

**สแกนสลิป แชร์บิล จบทุกดราม่าในโต๊ะเดียว**

แอปแชร์บิลสายโหดแต่ใช้ง่าย สแกนบิลได้ แยกรายการได้ เลือกคนจ่ายได้ แล้วสรุปให้เลยว่าใครต้องโอนใคร

`Mobile-first` • `PWA-ready` • `Offline-first` • `Gemini OCR` • `PromptPay`

</div>

---

## ของมันต้องมี

- ถ่ายรูปสลิป หรือเลือกรูปจากอัลบั้ม
- ใช้ Gemini OCR ก่อน ถ้าไม่ไหวค่อยตกไป Tesseract
- แยกบิลหลายใบในรอบเดียว แบบไม่ปวดหัว
- แก้รายการสินค้าในแต่ละบิลได้ทันที
- ตั้ง `Service`, `VAT`, `Discount`, คนจ่าย และคนหารแบบครบเครื่อง
- สรุปการโอนให้แบบเข้าใจง่าย พร้อม PromptPay

---

## เล่นยังไง

1. เปิดเว็บแอปแล้วกด `ถ่ายบิลใหม่`
2. หรือกด `จากอัลบั้ม` เพื่อเลือกรูปสลิปเก่า
3. รอ OCR อ่านรายการ แล้วค่อยจัดการบิลต่อ
4. กรอกคนจ่าย คนหาร และยอดที่ต้องแชร์
5. แชร์ผลลัพธ์ให้เพื่อนแบบจบในหน้าเดียว

---

## เปิดในมือถือ

- iPhone กด `Share` แล้วเลือก `Add to Home Screen`
- Android กด `Install App` หรือใช้เมนู `⋮`
- ติดตั้งแล้วใช้งานแบบเต็มจอเหมือนแอปจริง

---

## รันในเครื่อง

```bash
git clone https://github.com/project-sy789/bill-splitter.git
cd bill-splitter
npm install
npm run dev
```

---

## เปิด OCR Gemini

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

จากนั้นตั้งค่า `VITE_GEMINI_PROXY_URL=<worker-url>` ใน `.env.local` แล้ว build ใหม่

---

## สแต็กที่ใช้

React 19 • Vite • TypeScript • Tailwind CSS • IndexedDB • Cloudflare Workers • Gemini Vision • Tesseract fallback

---

## Privacy แบบชิล ๆ

ข้อมูลบิล รายชื่อเพื่อน และ PromptPay เก็บบนเครื่องผู้ใช้เป็นหลัก ไม่ดันขึ้นเซิร์ฟเวอร์เอง
