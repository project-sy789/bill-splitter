<div align="center">

# 💸 หารบิลกัน (Bill Splitter AI)

**สแกนสลิป แชร์บิล จบทุกดราม่าในโต๊ะเดียว ด้วยระบบ Multi-Tier AI (Gemini 3.1 & Gemma 4)**

[![GitHub Stars](https://img.shields.io/github/stars/project-sy789/bill-splitter?style=for-the-badge&color=violet)](https://github.com/project-sy789/bill-splitter)
[![License](https://img.shields.io/github/license/project-sy789/bill-splitter?style=for-the-badge&color=fuchsia)](LICENSE)

[✨ ลองใช้งานแอปที่นี่ (Live Demo)](https://project-sy789.github.io/bill-splitter/)

</div>

---

## 🚀 มีอะไรใหม่ในเวอร์ชันนี้?

- **🤖 ระบบ AI 3 ระดับ (Multi-Tier):** ใช้ Gemini 3.1 Flash-Lite เป็นหลัก เสริมด้วย Gemma 4 31B และ Gemini 2.5 Flash เพื่อความแม่นยำสูงสุด
- **⚡ OCR Hybrid Pipeline:** ระบบสลับอัตโนมัติ (Fallback) ไปใช้ Tesseract (Local OCR) ทันทีหาก AI ทุกรุ่นติดขัด
- **🔍 Model Transparency:** แสดงชื่อรุ่น AI ที่ประมวลผลจริงในหน้า Debug เพื่อความโปร่งใส
- **🔄 Smart Auto-Retry:** ระบบลองใหม่อัตโนมัติเมื่อติด Rate Limit (429) เพื่อให้สแกนได้ลื่นไหลที่สุด
- **🎨 New Progress UI:** แถบสถานะการอ่านแบบใหม่ เห็นชัดเจนว่า AI กำลังทำอะไรอยู่

---

## ✨ ฟีเจอร์เด่น

- 📸 **Scan & Go:** ถ่ายรูปสลิปหรือเลือกจากอัลบั้ม AI จะแยกรายการอาหารและราคาให้เอง
- 👥 **Member Management:** เพิ่มเพื่อนในแก๊ง บันทึกรายชื่อไว้ใช้ในรอบหน้าได้ (Local Storage)
- ⚖️ **Flexible Splitting:** หารเท่ากัน, หารตามสัดส่วน (%), หรือระบุยอดเป๊ะๆ ของแต่ละคน
- 🧾 **Multiple Bills:** จัดการบิลหลายใบในรอบเดียว (เช่น ค่าข้าว + ค่าเครื่องดื่ม) สรุปรวมยอดโอนทีเดียว
- 💸 **QR PromptPay:** เจน QR Code พร้อมยอดเงินให้เพื่อนโอนได้ทันที ไม่ต้องบอกเลขบัญชีซ้ำๆ
- 📱 **PWA Ready:** ติดตั้งลงหน้าจอมือถือได้เหมือนแอปจริง (Add to Home Screen)

---

## 🛠️ เทคโนโลยีเบื้องหลัง

- **Frontend:** [React 19](https://react.dev/) + [Vite](https://vitejs.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/) + [Framer Motion](https://www.framer.com/motion/) (Animations)
- **AI/OCR:** [Gemini 3.1 / Gemma 4 / Gemini 2.5](https://aistudio.google.com/) + [Cloudflare Workers](https://workers.cloudflare.com/) (Proxy) + [Tesseract.js](https://tesseract.projectnaptha.com/)
- **Storage:** [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) (เก็บข้อมูลในเครื่อง ปลอดภัย 100%)

---

## 💻 วิธีติดตั้งและรันในเครื่อง

### 1. โคลนโปรเจกต์
```bash
git clone https://github.com/project-sy789/bill-splitter.git
cd bill-splitter
```

### 2. ติดตั้งและรัน Frontend
```bash
npm install
npm run dev
```

### 3. ตั้งค่า OCR Worker (Optional)
หากต้องการใช้ระบบ AI สแกนบิล:
1. เข้าไปที่โฟลเดอร์ `worker`
2. ใส่ `GEMINI_API_KEY` ใน Cloudflare Secret
3. รัน `npx wrangler deploy`

---

## 🔒 ความเป็นส่วนตัว

ข้อมูลบิล, รายชื่อเพื่อน และเบอร์พร้อมเพย์ทั้งหมด **จะถูกเก็บไว้ใน Browser ของคุณเท่านั้น** (Local Storage/IndexedDB) ไม่มีการส่งข้อมูลส่วนตัวเหล่านี้ขึ้นไปเก็บที่เซิร์ฟเวอร์ใดๆ (ยกเว้นรูปสลิปที่ส่งไปประมวลผลผ่าน Gemini API แบบชั่วคราวแล้วลบทิ้ง)

---

<div align="center">

สร้างด้วย ❤️ เพื่อให้การหารบิลเป็นเรื่องสนุกและจบง่ายที่สุด

[⭐ ให้ดาวโปรเจกต์นี้บน GitHub](https://github.com/project-sy789/bill-splitter)

</div>
