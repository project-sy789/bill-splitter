<div align="center">

# หารบิลกัน

**แอปหารบิลบนมือถือ ใช้ง่าย สแกนได้ จดเองได้ และหาเงินที่ต้องโอนกันได้เร็ว**

[Demo](https://project-sy789.github.io/bill-splitter/) • PWA • Offline-first • MIT

</div>

## ทำอะไรได้บ้าง
- แยกบิลหลายใบในรอบเดียว
- สแกนสลิปหรือเพิ่มบิลเอง
- ตั้ง `Service`, `VAT`, `Discount` แยกต่อบิล
- บันทึกแก๊งเพื่อนและ PromptPay
- สรุปว่าใครต้องโอนให้ใครแบบอัตโนมัติ
- ใช้งานแบบ PWA และออฟไลน์ได้

## เปิดใช้งาน
1. เข้าเว็บ Demo
2. บน iPhone กด `Share` แล้วเลือก `Add to Home Screen`
3. บน Android กดเมนู `⋮` แล้วเลือก `Install App`

## รันในเครื่อง
```bash
git clone https://github.com/project-sy789/bill-splitter.git
cd bill-splitter
npm install
npm run dev
```

## OCR ฝั่ง Worker
```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

## Tech
React 19 • Vite • TypeScript • Tailwind CSS • IndexedDB • Cloudflare Workers • Gemini Vision • Tesseract fallback

## Privacy
ข้อมูลบิลและรายชื่อเก็บบนเครื่องผู้ใช้เป็นหลัก
