import { useState, useEffect } from 'react'
import { Receipt, Zap, ChevronDown, Users, Check, Trash2, Share } from 'lucide-react'

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
  onSetTotal: (billId: string, value: number) => void
  onShare: (billId: string) => void
  onDeleteBill: (billId: string) => void
  readOnly?: boolean
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
  onSetTotal,
  onShare,
  onDeleteBill,
  readOnly = false
}: BillCardProps) {
  const currentItems = items.filter((it) => it.billId === bill.id)
  const currentItemsSum = currentItems.reduce((s, it) => s + Math.max(0, it.amount - (it.itemDiscount ?? 0)), 0)
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

  // Local state for the total amount input to prevent jumping while typing
  const [localAmount, setLocalAmount] = useState<string>(bill.amount.toString())
  
  // Sync local amount when bill.amount changes from parent (e.g. loaded from history)
  useEffect(() => {
    setLocalAmount(bill.amount.toString())
  }, [bill.amount])

  return (
    <div id={`bill-card-${bill.id}`} className="receipt-serrated-top receipt-serrated-bottom receipt-thermal-texture relative border border-gray-200 rounded-[28px] shadow-[0_18px_40px_rgba(15,23,42,0.12)]">
      <div className="border-b border-dashed border-gray-200 px-4 pb-4 pt-7 sm:px-5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.16em] ${sourceVariant}`}>
              {sourceLabel}
            </span>
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.16em] text-gray-500">
              {itemCount} รายการ
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onShare(bill.id)}
              className="rounded-full p-1.5 text-gray-400 hover:bg-violet-50 hover:text-violet-600 transition-all active:scale-95"
              title="แชร์บิลนี้เป็นรูปภาพ"
            >
              <Share className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => {
                if (window.confirm('ยืนยันการลบบิลนี้และรายการทั้งหมดในบิล?')) {
                  onDeleteBill(bill.id)
                }
              }}
              className="rounded-full p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-all active:scale-95"
              title="ลบบิลนี้"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="group relative -ml-1">
          <input
            value={bill.title}
            onChange={(e) => onSetName(bill.id, e.target.value)}
            readOnly={readOnly}
            className={`w-full rounded-xl border-none bg-transparent px-1 py-0.5 text-[17px] font-bold tracking-tight text-gray-900 outline-none transition-all placeholder:text-gray-300 ${readOnly ? '' : 'hover:bg-gray-100/50 focus:bg-white focus:ring-2 focus:ring-violet-200'} sm:text-lg`}
            placeholder="ตั้งชื่อบิลรายการนี้..."
          />
        </div>
        <div className="mt-1 flex items-end justify-between">
          <div className="ml-auto text-right w-full">
            <p className="text-[10px] font-black uppercase leading-none tracking-[0.16em] text-gray-300">Net Total (จ่ายจริง)</p>
            <div className="relative group/total flex items-center justify-end">
              <span className="text-xl font-bold text-violet-300 mr-1">฿</span>
              <input
                type="number"
                value={localAmount}
                onChange={(e) => setLocalAmount(e.target.value)}
                onBlur={() => {
                  const val = parseFloat(localAmount) || 0
                  onSetTotal(bill.id, val)
                }}
                readOnly={readOnly}
                className={`w-32 rounded-xl border-none bg-transparent text-right font-mono text-2xl font-semibold tabular-nums tracking-tight text-violet-700 outline-none transition-all ${readOnly ? '' : 'hover:bg-violet-50 focus:bg-white focus:ring-4 focus:ring-violet-100'}`}
                placeholder="0.00"
              />
            </div>
            {Math.abs(bill.amount - bill.calculatedTotal) > 0.01 && (
              <p className="mt-1 text-[9px] font-bold text-amber-500 animate-pulse">
                {bill.amount > bill.calculatedTotal 
                  ? `⚠️ ยอดรวมรายการขาดไป ฿${(bill.amount - bill.calculatedTotal).toFixed(2)}`
                  : `⚠️ ยอดรวมรายการเกินมา ฿${(bill.calculatedTotal - bill.amount).toFixed(2)}`}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3 bg-white/40 px-5 py-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">รายการสินค้าในบิล</p>
            <p className="text-[11px] text-gray-400">เพิ่มสินค้าแต่ละรายการ แล้วค่อยเลือกคนหาร</p>
          </div>
          <div className="rounded-full bg-white px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-gray-500 shadow-sm">
            ฿{currentItemsSum.toFixed(2)}
          </div>
        </div>

        <button
          onClick={() => onAddItemToBill(bill.id)}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-white/80 bg-white/90 px-3 py-2.5 text-[11px] font-bold text-violet-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-violet-50 hover:shadow-md"
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
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-violet-700">รายการ</span>
                    <span className="text-[9px] font-medium text-gray-400">แตะเพื่อแก้ชื่อและราคา</span>
                  </div>
                  <button
                    onClick={() => onRemoveItem(it.id)}
                    className="inline-flex items-center gap-1 rounded-full border border-red-100 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-red-500 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-red-50 hover:shadow-md"
                  >
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-50 text-[10px] leading-none">×</span>
                    ลบ
                  </button>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <input
                    value={it.name}
                    onChange={(e) => onEditItem(it.id, 'name', e.target.value)}
                    placeholder="ชื่อรายการ"
                    readOnly={readOnly}
                    className={`min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-800 outline-none placeholder:text-gray-300 ${readOnly ? '' : 'focus:ring-2 focus:ring-violet-300'}`}
                  />
                  <div className="text-right shrink-0">
                    <p className="text-[9px] font-black uppercase tracking-[0.14em] text-gray-300">ยอดสุทธิ</p>
                    <p className="font-mono text-sm font-bold text-violet-700">฿{(Math.max(0, it.amount - (it.itemDiscount ?? 0))).toFixed(2)}</p>
                  </div>
                </div>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    {/* Price Input */}
                    <div className="flex flex-col gap-1">
                      <label className="ml-1 text-[9px] font-black uppercase tracking-[0.16em] text-gray-400">ราคาต่อหน่วย</label>
                      <div className="relative group">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-bold text-gray-300 transition-colors group-focus-within:text-violet-500">฿</span>
                        <input
                          type="number"
                          value={it.amount || ''}
                          onChange={(e) => onEditItem(it.id, 'amount', Number(e.target.value) || 0)}
                          placeholder="0.00"
                          readOnly={readOnly}
                          className={`w-full rounded-xl border border-gray-200 bg-gray-50/50 py-2.5 pl-7 pr-3 text-right text-xs font-bold text-gray-700 outline-none transition-all ${readOnly ? '' : 'focus:border-violet-300 focus:bg-white focus:ring-4 focus:ring-violet-50'}`}
                        />
                      </div>
                    </div>

                    {/* Discount Input */}
                    <div className="flex flex-col gap-1">
                      <label className="ml-1 text-[9px] font-black uppercase tracking-[0.16em] text-pink-400">ส่วนลด</label>
                      <div className="relative group">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-bold text-pink-200 transition-colors group-focus-within:text-pink-500">฿</span>
                        <input
                          type="number"
                          value={it.itemDiscount || ''}
                          onChange={(e) => onEditItem(it.id, 'itemDiscount', Number(e.target.value) || 0)}
                          placeholder="0.00"
                          readOnly={readOnly}
                          className={`w-full rounded-xl border border-pink-100 bg-pink-50/20 py-2.5 pl-7 pr-3 text-right text-xs font-bold text-pink-600 outline-none transition-all ${readOnly ? '' : 'focus:border-pink-300 focus:bg-white focus:ring-4 focus:ring-pink-50'}`}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Split Mode Selector */}
                  <div className="rounded-2xl border border-violet-100 bg-violet-50/40 p-3 shadow-[inset_0_1px_2px_rgba(124,58,237,0.03)]">
                    <div className="mb-2.5 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1 w-3 rounded-full bg-violet-400" />
                        <span className="text-[10px] font-black uppercase tracking-[0.16em] text-violet-700">วิธีหารรายการนี้</span>
                      </div>
                      <span className="text-[9px] font-medium text-violet-400/80">เลือกระบบคำนวณ</span>
                    </div>
                    <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                      {(['equally', 'percentage', 'exact'] as const).map((mode, idx) => {
                        const active = it.splitMode === mode
                        const color = members[idx % members.length]?.color ?? '#7C3AED'
                        return (
                          <button
                            key={mode}
                            onClick={() => onEditItem(it.id, 'splitMode', mode)}
                            className={`flex-1 rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-all ${
                              active 
                                ? 'text-white shadow-[0_4px_12px_rgba(124,58,237,0.25)] scale-[1.02]' 
                                : 'bg-white text-gray-500 border-gray-200 hover:border-violet-200 hover:bg-violet-50/30'
                            }`}
                            style={{ 
                              backgroundColor: active ? color : undefined,
                              borderColor: active ? color : undefined
                            }}
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
                          <span className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-black text-white overflow-hidden" style={{ backgroundColor: m.color }}>
                            {m.pictureUrl ? <img src={m.pictureUrl} className="h-full w-full object-cover" alt={m.name} /> : m.name.slice(0, 1)}
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
                <div className="mt-3 rounded-2xl border border-gray-100 bg-gray-50/40 p-3 shadow-[inset_0_1px_2px_rgba(0,0,0,0.02)]">
                  <div className="mb-2.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Users className="h-3 w-3 text-gray-400" />
                      <span className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-500">คนที่หารรายการนี้</span>
                    </div>
                    <span className="text-[9px] font-medium text-gray-400/80">แตะเพื่อเลือก</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {members.map((m) => {
                      const isActive = it.consumerIds.includes(m.id)
                      return (
                        <button
                          key={m.id}
                          onClick={() => {
                            const next = isActive ? it.consumerIds.filter((id) => id !== m.id) : [...it.consumerIds, m.id]
                            onEditItem(it.id, 'consumerIds', next)
                          }}
                          className={`group flex items-center gap-1.5 rounded-full border px-2 py-1 pr-3 text-[10px] font-bold transition-all ${
                            isActive 
                              ? 'bg-white shadow-sm ring-1 ring-black/5' 
                              : 'bg-white/50 border-gray-100 text-gray-400 opacity-60 hover:opacity-100 grayscale-[0.5]'
                          }`}
                          style={{ 
                            borderColor: isActive ? m.color : undefined,
                            color: isActive ? m.color : undefined
                          }}
                        >
                          <span 
                            className={`flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-black text-white shadow-sm transition-transform group-active:scale-90 overflow-hidden ${!isActive && 'grayscale'}`}
                            style={{ backgroundColor: m.color }}
                          >
                            {isActive ? <Check className="h-2.5 w-2.5" /> : (m.pictureUrl ? <img src={m.pictureUrl} className="h-full w-full object-cover" alt={m.name} /> : m.name.slice(0, 1))}
                          </span>
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
                  readOnly={readOnly}
                  className={`w-full rounded-xl border border-violet-100 bg-white px-3 py-2 text-right text-sm font-semibold text-gray-800 outline-none ${readOnly ? '' : 'focus:ring-2 focus:ring-violet-400'}`}
                />
              </div>
              <p className="mt-2 text-[10px] leading-4 text-violet-500">ใส่ค่าบริการรวมของบิล เช่น 10% หรือจำนวนเงินจริง</p>
            </div>

            <div className="rounded-2xl border border-amber-100 bg-amber-50/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-black uppercase tracking-[0.16em] text-amber-700">VAT</span>
                <button
                  onClick={() => {
                    if (readOnly) return
                    const next = !(bill.id.startsWith('ocr-') ? results[parseInt(bill.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find((m) => m.id === bill.id)?.vatIncluded)
                    onToggleVatIncluded(bill.id, next)
                  }}
                  disabled={readOnly}
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
                  disabled={(bill.id.startsWith('ocr-') ? results[parseInt(bill.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find((m) => m.id === bill.id)?.vatIncluded) || readOnly}
                  placeholder="0"
                  readOnly={readOnly}
                  className={`w-full rounded-xl border border-amber-100 bg-white px-3 py-2 text-right text-sm font-semibold text-gray-800 outline-none ${readOnly ? '' : 'focus:ring-2 focus:ring-amber-300'} disabled:bg-gray-50 disabled:text-gray-400`}
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
                  readOnly={readOnly}
                  className={`w-full rounded-xl border border-pink-100 bg-white px-3 py-2 text-right text-sm font-semibold text-gray-800 outline-none ${readOnly ? '' : 'focus:ring-2 focus:ring-pink-300'}`}
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
