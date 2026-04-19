# หารบิลกัน

แอปหารค่าใช้จ่ายบนมือถือที่ดูเรียบร้อย ใช้ง่าย และทำงานได้ออฟไลน์

## ทำอะไรได้บ้าง

- เพิ่มหลายบิลในรอบเดียว
- ใส่คนหาร, รายการสินค้า, และยอดที่จ่ายจริง
- แยก Service Charge / VAT / ส่วนลด รายบิลได้
- สแกนสลิปด้วย AI OCR หรือกรอกเอง
- บันทึกกลุ่มเพื่อนและ PromptPay ได้
- แชร์สรุปเป็นรูป PNG

## เด่นสุด

- PWA ติดตั้งเป็นแอปได้
- ข้อมูลเก็บในเครื่อง ไม่ส่งบิลออกไปเอง
- UI มือถือเน้นแตะง่าย อ่านง่าย
- รองรับ OCR สำรองเมื่ออ่านสลิปไม่ครบ

## ใช้งานเร็ว

```bash
git clone https://github.com/project-sy789/bill-splitter.git
cd bill-splitter
npm install
npm run dev
```

เปิด `http://localhost:5173/bill-splitter/`

## Deploy OCR Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

ตั้งค่า `VITE_GEMINI_PROXY_URL=<worker-url>` ใน `.env.local`

## Stack

- React + Vite + TypeScript
- Tailwind CSS
- IndexedDB
- Cloudflare Workers สำหรับ OCR proxy

## Privacy

ข้อมูลบิลและรายชื่อเก็บในเครื่องคุณเป็นหลัก


