# Bill Splitter

แอปแยกบิลแบบทำงานในเบราว์เซอร์ 100% สำหรับอัปโหลดรูปใบเสร็จ อ่านด้วย OCR แล้วช่วยคำนวณยอดที่แต่ละคนต้องจ่ายแบบง่าย แชร์ต่อได้ทันที และพร้อม deploy บน GitHub Pages

## จุดเด่น

- อัปโหลดรูปบิลหรือใบเสร็จจากมือถือได้
- อ่านข้อความด้วย OCR ภาษาไทยและอังกฤษ
- แยกรายการจากข้อความอัตโนมัติ
- แก้ไขสมาชิก รายการ และวิธีแบ่งบิลได้
- กระจาย service charge, VAT และ discount ได้
- ลดจำนวนการโอนด้วย debt simplification
- สร้าง PromptPay QR และคัดลอก payload ได้
- บันทึกงานค้างไว้ในเครื่องด้วย localStorage
- รองรับ export/import บิลเป็นไฟล์ JSON
- พร้อม deploy บน GitHub Pages

## วิธีใช้งาน

1. เปิดแอป
2. อัปโหลดรูปใบเสร็จ
3. ตรวจสอบรายการที่ OCR ดึงมา
4. เพิ่มสมาชิกและกำหนดว่าใครแชร์รายการไหน
5. ใส่ยอด service charge, VAT, discount และยอดที่แต่ละคนจ่ายไปแล้ว
6. ดูยอดสุทธิและ settlement ที่ต้องโอน
7. เปิด QR หรือคัดลอก payload เพื่อส่งต่อให้เพื่อน

## ใช้งานในเครื่อง

ติดตั้ง dependencies และเริ่มโปรเจกต์ด้วยคำสั่งมาตรฐานของ Vite:

```bash
npm install
npm run dev
```

## สร้างไฟล์สำหรับ deploy

```bash
npm run build
```

## Deploy บน GitHub Pages

โปรเจกต์นี้มี GitHub Actions workflow สำหรับ build และ deploy ไป GitHub Pages อัตโนมัติเมื่อ push ไปที่ branch หลัก

หากยังไม่เปิด Pages ให้เข้าไปที่ `Settings > Pages` ใน repo แล้วเลือกให้ใช้ GitHub Actions deployment

## โครงสร้างการทำงาน

- ทุกอย่างประมวลผลฝั่ง client
- ไม่มี backend
- ข้อมูล draft ถูกเก็บใน browser ของผู้ใช้
- เหมาะกับการ deploy แบบ static site

## หมายเหตุ

- ถ้าเปิดบน GitHub Pages แล้วรูป/asset ไม่ขึ้น ให้ตรวจว่า workflow deploy สำเร็จแล้ว
- หากต้องการเริ่มใหม่ สามารถล้าง draft จากในแอป หรือปิด/เปิด browser ใหม่ได้
