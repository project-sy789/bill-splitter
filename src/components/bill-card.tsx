import { Receipt, Zap, ChevronDown } from 'lucide-react'

import { type BillItemDraft, type ManualBill, type MemberDraft } from '../lib/bill-persistence'
import type { ParsedReceiptResult } from '../types/ocr'

export interface UnifiedBill {
  id: string
  title: string
  amount: number
  calculatedTotal: number
  subtitle?: string
}

interface BillCardProps {
  bill: UnifiedBill
  items: BillItemDraft[]
  members: MemberDraft[]
  results: ParsedReceiptResult[]
  manualBills: ManualBill[]
  isDiscrepant: boolean
  assignedId?: string
  onAddItem: (billId: string) => void
  onAddDifference: (billId: string, deficit: number) => void
  onSetServiceCharge: (billId: string, value: number) => void
  onToggleVatIncluded: (billId: string, next: boolean) => void
  onSetVat: (billId: string, value: number) => void
  onSetDiscount: (billId: string, value: number) => void
  onSetName: (billId: string, name: string) => void
  onSetPayer: (billId: string, memberId: string) => void
  onEditItem: (itemId: string, field: keyof BillItemDraft, value: BillItemDraft[keyof BillItemDraft]) => void
  onRemoveItem: (itemId: string) => void
  onAddItemToBill: (billId: string) => void
}

export function BillCard({
  bill,
  items,
  members,
  results,
  manualBills,
  isDiscrepant,
  assignedId,
  onAddDifference,
  onSetServiceCharge,
  onToggleVatIncluded,
  onSetVat,
  onSetDiscount,
  onSetName,
  onSetPayer,
  onEditItem,
  onRemoveItem,
  onAddItemToBill,
}: BillCardProps) {
  const currentItems = items.filter((it) => it.billId === bill.id)
  const currentItemsSum = currentItems.reduce((s, it) => s + it.amount, 0)
  const itemCount = currentItems.length
  const sourceLabel = bill.id.startsWith('ocr-') ? 'OCR / Gemini' : 'Manual bill'
  const sourceVariant = bill.id.startsWith('ocr-') ? 'from-violet-50 text-violet-600' : 'bg-gray-100 text-gray-500'

  const billFeeSource = bill.id.startsWith('ocr-') ? results[parseInt(bill.id.split('-')[1]!, 10)] : manualBills.find((m) => m.id === bill.id)
  const billFeesAdjust = bill.id.startsWith('ocr-')
    ? (() => {
        const r = billFeeSource as (typeof results)[number] | undefined
        return r ? (r.summary.serviceCharge ?? 0) + (r.vatIncluded ? 0 : (r.summary.vat ?? 0)) - (r.summary.billDiscount ?? r.summary.discount ?? 0) : 0
      })()
    : (() => {
        const m = billFeeSource as ManualBill | undefined
        return m ? (m.serviceCharge ?? 0) + (m.vatIncluded ? 0 : (m.vat ?? 0)) - (m.billDiscount ?? m.discount ?? 0) : 0
      })()

  const deficit = Math.max(0, Math.round((bill.amount - currentItemsSum - billFeesAdjust) * 100) / 100)

  return (
    <div className="receipt-serrated-top receipt-serrated-bottom receipt-thermal-texture relative rounded-b shadow-[0_18px_40px_rgba(15,23,42,0.12)]">
      <div className="border-b border-dashed border-gray-200 px-4 pb-4 pt-7 sm:px-5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className={`rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.16em] ${sourceVariant}`}>
            {sourceLabel}
          </span>
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.16em] text-gray-500">
            {itemCount} รายการ
          </span>
        </div>
        <input
          value={bill.title}
          onChange={(e) => onSetName(bill.id, e.target.value)}
          className="w-full border-none bg-transparent p-0 text-[17px] font-semibold tracking-tight text-gray-900 outline-none focus:ring-0 placeholder:text-gray-300 sm:text-lg"
          placeholder="บิลรายการ"
        />
        <div className="mt-1 flex items-end justify-between">
          <div className="ml-auto text-right">
            <p className="text-[10px] font-black uppercase leading-none tracking-[0.16em] text-gray-300">Net Total</p>
            <p className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-violet-700">฿{bill.amount.toFixed(2)}</p>
          </div>
        </div>
      </div>

      <div className="space-y-3 bg-white/40 px-5 py-4">
        <div className="flex items-center justify-between text-[10px] font-black uppercase text-gray-400">
          <span>รายการสินค้าในบิล</span>
          <span>฿{currentItemsSum.toFixed(2)}</span>
        </div>

        <button
          onClick={() => onAddItemToBill(bill.id)}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/80 bg-white/90 px-3 py-2 text-[10px] font-semibold text-violet-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-violet-50 hover:shadow-md"
        >
          + เพิ่มรายการในบิลนี้
        </button>

        {currentItems.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 bg-white/70 px-3 py-4 text-center text-[11px] text-gray-400">
            ยังไม่มีรายการในบิลนี้
          </div>
        ) : (
          <div className="space-y-2">
            {currentItems.map((it) => (
              <div key={it.id} className="rounded-xl border border-gray-100 bg-white px-3 py-2 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <input
                    value={it.name}
                    onChange={(e) => onEditItem(it.id, 'name', e.target.value)}
                    placeholder="ชื่อรายการ"
                    className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-gray-800 outline-none placeholder:text-gray-300"
                  />
                  <div className="text-right shrink-0">
                    <button
                      onClick={() => onRemoveItem(it.id)}
                      className="mb-1 rounded-md px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-gray-300 hover:bg-red-50 hover:text-red-400"
                    >
                      ลบ
                    </button>
                    <p className="font-mono text-sm font-bold text-violet-700">฿{(Math.max(0, it.amount - (it.itemDiscount ?? 0))).toFixed(2)}</p>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <input
                    type="number"
                    value={it.amount || ''}
                    onChange={(e) => onEditItem(it.id, 'amount', Number(e.target.value) || 0)}
                    placeholder="ราคา"
                    className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-right text-xs font-semibold outline-none focus:ring-2 focus:ring-violet-300"
                  />
                  <input
                    type="number"
                    value={it.itemDiscount || ''}
                    onChange={(e) => onEditItem(it.id, 'itemDiscount', Number(e.target.value) || 0)}
                    placeholder="ส่วนลด"
                    className="rounded-lg border border-pink-100 bg-white px-2 py-1 text-right text-xs font-semibold text-pink-600 outline-none focus:ring-2 focus:ring-pink-300"
                  />
                  <div className="col-span-2 rounded-2xl border border-violet-100 bg-violet-50/60 p-2 sm:col-span-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[10px] font-black uppercase tracking-[0.16em] text-violet-700">วิธีหาร</span>
                      <span className="text-[9px] font-medium text-violet-400">ใช้กำหนดรูปแบบของรายการนี้</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(['equally', 'percentage', 'exact'] as const).map((mode, idx) => {
                        const active = it.splitMode === mode
                        const color = members[idx % members.length]?.color ?? '#7C3AED'
                        return (
                          <button
                            key={mode}
                            onClick={() => onEditItem(it.id, 'splitMode', mode)}
                            className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] transition-all ${active ? 'text-white shadow-sm ring-2 ring-offset-1 ring-offset-violet-50' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                            style={{ borderColor: active ? color : 'rgb(229 231 235)', backgroundColor: active ? color : undefined }}
                          >
                            {mode === 'equally' ? 'เท่ากัน' : mode === 'percentage' ? 'เปอร์เซ็นต์' : 'ระบุเอง'}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
                {it.splitMode !== 'equally' && (
                  <div className="mt-3 space-y-2 rounded-xl border border-gray-100 bg-gray-50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-gray-500">ตั้งค่าตามคน</span>
                      <span className="text-[9px] text-gray-400">{it.splitMode === 'percentage' ? 'เปอร์เซ็นต์รวม' : 'ยอดต่อคน'}</span>
                    </div>
                    {members.filter((m) => it.consumerIds.includes(m.id)).map((m) => (
                      <div key={m.id} className="flex items-center justify-between gap-3 rounded-lg bg-white px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-black text-white" style={{ backgroundColor: m.color }}>
                            {m.name.slice(0, 1)}
                          </span>
                          <span className="text-[10px] font-bold text-gray-700">{m.name}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold text-gray-300">{it.splitMode === 'percentage' ? '%' : '฿'}</span>
                          <input
                            type="number"
                            value={(it.splitMode === 'percentage' ? it.percentageByUser[m.id] : it.exactByUser[m.id]) ?? ''}
                            onChange={(e) => {
                              const field = it.splitMode === 'percentage' ? 'percentageByUser' : 'exactByUser'
                              onEditItem(it.id, field, { ...it[field], [m.id]: Number(e.target.value) || 0 })
                            }}
                            className="w-24 rounded-lg border border-gray-200 bg-white px-2 py-1 text-right text-[11px] font-semibold outline-none focus:ring-2 focus:ring-violet-300"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 rounded-xl border border-gray-100 bg-gray-50 p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-600">คนที่หารรายการนี้</span>
                    <span className="text-[9px] text-gray-400">แตะเพื่อเลือก/ยกเลิก</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {members.map((m) => {
                      const isActive = it.consumerIds.includes(m.id)
                      return (
                        <button
                          key={m.id}
                          onClick={() => {
                            const next = isActive ? it.consumerIds.filter((id) => id !== m.id) : [...it.consumerIds, m.id]
                            onEditItem(it.id, 'consumerIds', next)
                          }}
                          className={`rounded-full border px-2.5 py-1 text-[10px] font-bold transition-all ${isActive ? 'text-white shadow-sm' : 'bg-white text-gray-600'}`}
                          style={{ backgroundColor: isActive ? m.color : undefined, borderColor: isActive ? m.color : 'rgb(229 231 235)' }}
                        >
                          {m.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {deficit > 0.01 && (
          <button
            onClick={() => onAddDifference(bill.id, deficit)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-100 bg-amber-50 py-2 text-[10px] font-black text-amber-600 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-amber-100 hover:shadow-md"
          >
            <Zap className="h-3 w-3" /> เพิ่มส่วนต่าง ฿{deficit.toFixed(2)}
          </button>
        )}

        <div className="space-y-3 rounded-2xl border border-violet-100 bg-white p-3 shadow-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-violet-100 bg-violet-50/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-black uppercase tracking-[0.16em] text-violet-700">Service fee</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[9px] font-black text-violet-500">เพิ่มตามบิล</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-violet-500">฿</span>
                <input
                  type="number"
                  value={(bill.id.startsWith('ocr-') ? results[parseInt(bill.id.split('-')[1]!, 10)]?.summary.serviceCharge : manualBills.find((m) => m.id === bill.id)?.serviceCharge) || ''}
                  onChange={(e) => onSetServiceCharge(bill.id, Number(e.target.value) || 0)}
                  placeholder="0"
                  className="w-full rounded-xl border border-violet-100 bg-white px-3 py-2 text-right text-sm font-semibold text-gray-800 outline-none focus:ring-2 focus:ring-violet-400"
                />
              </div>
              <p className="mt-2 text-[10px] leading-4 text-violet-500">ใส่ค่าบริการรวมของบิล เช่น 10% หรือจำนวนเงินจริง</p>
            </div>

            <div className="rounded-2xl border border-amber-100 bg-amber-50/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-black uppercase tracking-[0.16em] text-amber-700">VAT</span>
                <button
                  onClick={() => {
                    const next = !(bill.id.startsWith('ocr-') ? results[parseInt(bill.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find((m) => m.id === bill.id)?.vatIncluded)
                    onToggleVatIncluded(bill.id, next)
                  }}
                  className={`rounded-full px-2 py-1 text-[9px] font-black transition-colors ${
                    (bill.id.startsWith('ocr-') ? results[parseInt(bill.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find((m) => m.id === bill.id)?.vatIncluded)
                      ? 'bg-amber-200 text-amber-800'
                      : 'bg-white text-amber-700'
                  }`}
                >
                  {(bill.id.startsWith('ocr-') ? results[parseInt(bill.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find((m) => m.id === bill.id)?.vatIncluded) ? 'รวมแล้ว' : 'แยก VAT'}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-amber-500">฿</span>
                <input
                  type="number"
                  value={(bill.id.startsWith('ocr-') ? results[parseInt(bill.id.split('-')[1]!, 10)]?.summary.vat : manualBills.find((m) => m.id === bill.id)?.vat) || ''}
                  onChange={(e) => onSetVat(bill.id, Number(e.target.value) || 0)}
                  disabled={(bill.id.startsWith('ocr-') ? results[parseInt(bill.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find((m) => m.id === bill.id)?.vatIncluded)}
                  placeholder="0"
                  className="w-full rounded-xl border border-amber-100 bg-white px-3 py-2 text-right text-sm font-semibold text-gray-800 outline-none focus:ring-2 focus:ring-amber-300 disabled:bg-gray-50 disabled:text-gray-400"
                />
              </div>
              <p className="mt-2 text-[10px] leading-4 text-amber-600">สลับได้ว่า VAT รวมอยู่ในยอดแล้ว หรือคิดแยกต่างหาก</p>
            </div>

            <div className="rounded-2xl border border-pink-100 bg-pink-50/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-black uppercase tracking-[0.16em] text-pink-600">Discount</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[9px] font-black text-pink-500">หักออก</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-pink-500">฿</span>
                <input
                  type="number"
                  value={(bill.id.startsWith('ocr-') ? (results[parseInt(bill.id.split('-')[1]!, 10)]?.summary.billDiscount ?? results[parseInt(bill.id.split('-')[1]!, 10)]?.summary.discount) : (manualBills.find((m) => m.id === bill.id)?.billDiscount ?? manualBills.find((m) => m.id === bill.id)?.discount)) || ''}
                  onChange={(e) => onSetDiscount(bill.id, Number(e.target.value) || 0)}
                  placeholder="0"
                  className="w-full rounded-xl border border-pink-100 bg-white px-3 py-2 text-right text-sm font-semibold text-gray-800 outline-none focus:ring-2 focus:ring-pink-300"
                />
              </div>
              <p className="mt-2 text-[10px] leading-4 text-pink-500">ส่วนลดทั้งบิล เช่น คูปอง โปร หรือเงินที่ต้องตัดออก</p>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 pt-1">
            <span className="text-[10px] font-black uppercase tracking-[0.14em] text-violet-700">รวมท้ายบิล</span>
            <span className={`text-base font-black tabular-nums ${isDiscrepant ? 'text-amber-500 animate-pulse' : 'text-emerald-500'}`}>
              ฿{bill.calculatedTotal.toFixed(2)}
            </span>
          </div>
        </div>

        <div className="rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50/95 via-white to-fuchsia-50/80 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-violet-700">ใครจ่ายเงินก้อนนี้?</span>
              <span className="text-[8px] font-medium italic leading-none text-violet-400">Payer of this bill</span>
            </div>
            <Receipt className="h-4 w-4 text-violet-300" />
          </div>
          <div className="relative">
            <select
              value={assignedId || ''}
              onChange={(e) => onSetPayer(bill.id, e.target.value)}
              className="w-full appearance-none rounded-2xl border border-violet-100 bg-white px-3 py-2.5 pr-10 text-sm font-semibold text-gray-800 shadow-sm outline-none transition-all focus:border-violet-400 focus:ring-2 focus:ring-violet-200"
            >
              <option value="">ยังไม่ระบุ</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-violet-300" />
          </div>
          <p className="mt-2 text-[10px] leading-4 text-violet-500">เลือกคนที่จ่ายเงินจริงของบิลนี้</p>
        </div>
      </div>
    </div>
  )
}
