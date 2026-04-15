import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Loader2,
  Plus,
  QrCode as QrCodeIcon,
  Receipt,
  ScanLine,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react'

import { QrCode } from './components/qr-code'
import { useReceiptOcr } from './hooks/use-receipt-ocr'
import { buildPromptPayPayload, toPromptPayTarget } from './lib/promptpay'
import {
  type AllocationMode,
  type BillItemDraft,
  type MemberDraft,
  type PersistedBillState,
  STORAGE_KEY,
  safeParseBillState,
} from './lib/bill-persistence'
import type { SplitMode } from './types/bill'

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface Settlement {
  fromMemberId: string
  toMemberId: string
  amount: number
  promptPayPayload: string | null
}

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const MEMBER_COLORS = ['#7C3AED', '#0EA5E9', '#22C55E', '#F97316', '#EC4899', '#EAB308']


const SPLIT_MODE_LABELS: Record<SplitMode, string> = {
  equally: 'หารเท่ากัน',
  percentage: 'แบ่งตามเปอร์เซ็นต์',
  exact: 'ระบุยอดเอง',
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const round2 = (v: number) => Number(v.toFixed(2))

function calcItemSplit(item: BillItemDraft, members: MemberDraft[]) {
  const result: Record<string, number> = {}
  members.forEach((m) => { result[m.id] = 0 })

  const selected = item.consumerIds.filter((id) => members.some((m) => m.id === id))
  if (selected.length === 0) return result

  if (item.splitMode === 'equally') {
    const each = item.amount / selected.length
    selected.forEach((id) => { result[id] = each })
  } else if (item.splitMode === 'percentage') {
    selected.forEach((id) => {
      result[id] = (item.amount * (item.percentageByUser[id] ?? 0)) / 100
    })
  } else if (item.splitMode === 'exact') {
    selected.forEach((id) => { result[id] = item.exactByUser[id] ?? 0 })
  }
  return result
}

function allocateAmount(
  amount: number,
  members: MemberDraft[],
  baseByMember: Record<string, number>,
  mode: AllocationMode,
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]))
  if (members.length === 0 || amount === 0) return out
  const totalBase = members.reduce((s, m) => s + (baseByMember[m.id] ?? 0), 0)
  if (mode === 'equal' || totalBase <= 0) {
    const each = amount / members.length
    members.forEach((m) => { out[m.id] = each })
  } else {
    members.forEach((m) => { out[m.id] = amount * ((baseByMember[m.id] ?? 0) / totalBase) })
  }
  return out
}

function simplifyDebts(netByMember: Record<string, number>): Settlement[] {
  const creditors = Object.entries(netByMember)
    .filter(([, n]) => n > 0.01)
    .map(([id, n]) => ({ id, amount: n }))
    .sort((a, b) => b.amount - a.amount)
  const debtors = Object.entries(netByMember)
    .filter(([, n]) => n < -0.01)
    .map(([id, n]) => ({ id, amount: Math.abs(n) }))
    .sort((a, b) => b.amount - a.amount)

  const settlements: Settlement[] = []
  let i = 0; let j = 0
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i]!
    const creditor = creditors[j]!
    const amount = Math.min(debtor.amount, creditor.amount)
    if (amount > 0.009) {
      settlements.push({ fromMemberId: debtor.id, toMemberId: creditor.id, amount: round2(amount), promptPayPayload: null })
    }
    debtor.amount -= amount
    creditor.amount -= amount
    if (debtor.amount <= 0.01) i++
    if (creditor.amount <= 0.01) j++
  }
  return settlements
}

function makeNewItem(members: MemberDraft[]): BillItemDraft {
  return {
    id: crypto.randomUUID(),
    name: '',
    amount: 0,
    splitMode: 'equally',
    consumerIds: members.map((m) => m.id),
    percentageByUser: Object.fromEntries(members.map((m) => [m.id, round2(100 / Math.max(members.length, 1))])),
    exactByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
  }
}

// ──────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────

function StepBadge({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600 text-sm font-bold text-white">
        {n}
      </span>
      <span className="text-base font-bold text-gray-800">{label}</span>
    </div>
  )
}

function SectionCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-gray-200 bg-white p-4 sm:p-5 shadow-sm ${className}`}>
      {children}
    </section>
  )
}



// ──────────────────────────────────────────────
// Main App
// ──────────────────────────────────────────────

function App() {
  const initialState = safeParseBillState(localStorage.getItem(STORAGE_KEY))

  // ── State ──
  const [members, setMembers] = useState<MemberDraft[]>(
    initialState?.members ?? [
      { id: crypto.randomUUID(), name: 'ฉัน', color: MEMBER_COLORS[0]!, promptPayId: '' },
      { id: crypto.randomUUID(), name: 'เพื่อน', color: MEMBER_COLORS[1]!, promptPayId: '' },
    ],
  )
  const [newMemberName, setNewMemberName] = useState('')
  const [items, setItems] = useState<BillItemDraft[]>(initialState?.items ?? [])
  const [serviceCharge, setServiceCharge] = useState(initialState?.serviceCharge ?? 0)
  const [vat, setVat] = useState(initialState?.vat ?? 0)
  const [discount, setDiscount] = useState(initialState?.discount ?? 0)
  const [allocationMode, setAllocationMode] = useState<AllocationMode>(initialState?.allocationMode ?? 'proportional')
  const [paidByMember, setPaidByMember] = useState<Record<string, number>>(initialState?.paidByMember ?? {})
  const [vatMode, setVatMode] = useState<'exclusive' | 'inclusive'>('exclusive')
  const [receiptPayerMap, setReceiptPayerMap] = useState<Record<number, string>>({}) // resultIdx → memberId
  const [activeSettlementIdx, setActiveSettlementIdx] = useState<number | null>(null)
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  const { progress, results, mergedItems, error, scanFiles, reset, terminate, isBusy } = useReceiptOcr()

  // ── Persist to localStorage ──
  useEffect(() => {
    const state: PersistedBillState = { members, items, serviceCharge, vat, discount, allocationMode, paidByMember }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [members, items, serviceCharge, vat, discount, allocationMode, paidByMember])



  // Merge OCR results into items list when mergedItems changes
  const prevMergedLenRef = useRef(0)
  const prevResultsLenRef = useRef(0)
  useEffect(() => {
    if (mergedItems.length === prevMergedLenRef.current) return
    const newOcrItems = mergedItems.slice(prevMergedLenRef.current)
    prevMergedLenRef.current = mergedItems.length
    if (newOcrItems.length === 0) return

    setItems((prev) => [
      ...prev,
      ...newOcrItems.map((oi) => ({
        id: oi.id,
        name: oi.name,
        amount: oi.amount,
        splitMode: 'equally' as SplitMode,
        consumerIds: members.map((m) => m.id),
        percentageByUser: Object.fromEntries(members.map((m) => [m.id, round2(100 / Math.max(members.length, 1))])),
        exactByUser: Object.fromEntries(members.map((m) => [m.id, round2(oi.amount / Math.max(members.length, 1))])),
      })),
    ])

    // Accumulate VAT from each new receipt — but SKIP if receipt says "VAT INCLUDED"
    const newResults = results.slice(prevResultsLenRef.current)
    prevResultsLenRef.current = results.length
    newResults.forEach((r) => {
      if (r.summary.vat && !r.vatIncluded) {
        setVat((prev) => round2(prev + r.summary.vat!))
      }
      if (r.vatIncluded) {
        // Auto-switch to inclusive mode when receipt signals VAT already in price
        setVatMode('inclusive')
      }
    })
  }, [mergedItems, results, members])

  useEffect(() => () => { void terminate() }, [terminate])

  // ── Calculations ──
  const baseTotalsByMember = useMemo(() => {
    const totals: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]))
    items.forEach((item) => {
      const split = calcItemSplit(item, members)
      Object.entries(split).forEach(([id, amt]) => { totals[id] = (totals[id] ?? 0) + amt })
    })
    Object.keys(totals).forEach((id) => { totals[id] = round2(totals[id]!) })
    return totals
  }, [items, members])

  const totalItemsAmount = useMemo(() => round2(items.reduce((s, i) => s + i.amount, 0)), [items])

  const adjustmentsByMember = useMemo(
    () => allocateAmount(
      serviceCharge + (vatMode === 'exclusive' ? vat : 0) - discount,
      members, baseTotalsByMember, allocationMode,
    ),
    [serviceCharge, vat, vatMode, discount, members, baseTotalsByMember, allocationMode],
  )

  const finalDueByMember = useMemo(() => {
    const due: Record<string, number> = {}
    members.forEach((m) => {
      due[m.id] = round2((baseTotalsByMember[m.id] ?? 0) + (adjustmentsByMember[m.id] ?? 0))
    })
    return due
  }, [members, baseTotalsByMember, adjustmentsByMember])

  const grandTotal = useMemo(
    () => round2(totalItemsAmount + serviceCharge + (vatMode === 'exclusive' ? vat : 0) - discount),
    [totalItemsAmount, serviceCharge, vat, vatMode, discount],
  )

  const normalizedPaid = useMemo(() => {
    const out: Record<string, number> = {}
    members.forEach((m, i) => {
      const ex = paidByMember[m.id]
      out[m.id] = typeof ex === 'number' ? ex : i === 0 ? grandTotal : 0
    })
    return out
  }, [members, paidByMember, grandTotal])

  const netByMember = useMemo(() => {
    const net: Record<string, number> = {}
    members.forEach((m) => { net[m.id] = round2((normalizedPaid[m.id] ?? 0) - (finalDueByMember[m.id] ?? 0)) })
    return net
  }, [members, normalizedPaid, finalDueByMember])

  const settlements = useMemo(
    () =>
      simplifyDebts(netByMember).map((s) => ({
        ...s,
        promptPayPayload: buildPromptPayPayload(
          members.find((m) => m.id === s.toMemberId)?.promptPayId ?? '',
          s.amount,
        ),
      })),
    [netByMember, members],
  )

  // ── Handlers ──

  const handleFilesSelected = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      await scanFiles(Array.from(files))
    },
    [scanFiles],
  )

  const addMember = useCallback(() => {
    const name = newMemberName.trim()
    if (!name) return
    const member: MemberDraft = {
      id: crypto.randomUUID(),
      name,
      color: MEMBER_COLORS[members.length % MEMBER_COLORS.length]!,
      promptPayId: '',
    }
    setMembers((prev) => [...prev, member])
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        consumerIds: [...new Set([...item.consumerIds, member.id])],
        percentageByUser: { ...item.percentageByUser, [member.id]: 0 },
        exactByUser: { ...item.exactByUser, [member.id]: 0 },
      })),
    )
    setNewMemberName('')
  }, [newMemberName, members.length])

  const removeMember = useCallback((id: string) => {
    if (members.length <= 1) return
    setMembers((prev) => prev.filter((m) => m.id !== id))
    setItems((prev) =>
      prev.map((item) => {
        const pct = { ...item.percentageByUser }
        const ex = { ...item.exactByUser }
        delete pct[id]; delete ex[id]
        return { ...item, consumerIds: item.consumerIds.filter((c) => c !== id), percentageByUser: pct, exactByUser: ex }
      }),
    )
  }, [members.length])

  const updateMember = useCallback(<K extends keyof MemberDraft>(id: string, field: K, value: MemberDraft[K]) => {
    setMembers((prev) => prev.map((m) => m.id === id ? { ...m, [field]: value } : m))
  }, [])

  const toggleConsumer = useCallback((itemId: string, memberId: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item
        const has = item.consumerIds.includes(memberId)
        return { ...item, consumerIds: has ? item.consumerIds.filter((c) => c !== memberId) : [...item.consumerIds, memberId] }
      }),
    )
  }, [])

  const updateItem = useCallback(<K extends keyof BillItemDraft>(itemId: string, field: K, value: BillItemDraft[K]) => {
    setItems((prev) => prev.map((item) => item.id === itemId ? { ...item, [field]: value } : item))
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const addManualItem = useCallback(() => {
    const item = makeNewItem(members)
    setItems((prev) => [...prev, item])
    setExpandedItems((prev) => new Set([...prev, item.id]))
  }, [members])

  const toggleExpanded = useCallback((id: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const copyText = useCallback(async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }, [])

  const exportBill = useCallback(() => {
    const blob = new Blob([JSON.stringify({ members, items, serviceCharge, vat, discount, allocationMode, paidByMember }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `บิล-${Date.now()}.json` }).click()
    URL.revokeObjectURL(url)
  }, [members, items, serviceCharge, vat, discount, allocationMode, paidByMember])

  const importBill = useCallback(async (file: File | null) => {
    if (!file) return
    const data = safeParseBillState(await file.text())
    if (!data) return
    setMembers(data.members)
    setItems(data.items)
    setServiceCharge(data.serviceCharge ?? 0)
    setVat(data.vat ?? 0)
    setDiscount(data.discount ?? 0)
    setAllocationMode(data.allocationMode ?? 'proportional')
    setPaidByMember(data.paidByMember ?? {})
    reset()
  }, [reset])

  const resetAll = useCallback(() => {
    setItems([])
    setServiceCharge(0)
    setVat(0)
    setDiscount(0)
    setPaidByMember({})
    setReceiptPayerMap({})
    setVatMode('exclusive')
    reset()
    prevMergedLenRef.current = 0
    prevResultsLenRef.current = 0
  }, [reset])

  // ──────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-sky-50">
      {/* Hidden inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => void handleFilesSelected(e.target.files)}
      />
      <input
        ref={importInputRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => void importBill(e.target.files?.[0] ?? null)}
      />



      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-gray-100 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-600 text-white">
              <Receipt className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-base font-bold leading-none text-gray-900">หารบิลกัน</h1>
              <p className="text-xs text-gray-400 leading-none mt-0.5">หารค่าใช้จ่ายกับเพื่อน</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="hidden sm:flex items-center gap-1 rounded-full bg-violet-50 border border-violet-200 px-2 py-1 text-xs font-medium text-violet-700">
              ฟรี 100%
            </span>
            <button
              onClick={triggerImportUpload}
              className="rounded-xl border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 transition-colors"
              title="โหลดข้อมูลที่บันทึกไว้"
            >
              <Upload className="h-4 w-4" />
            </button>
            <button
              onClick={exportBill}
              className="rounded-xl border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 transition-colors"
              title="บันทึกข้อมูล"
            >
              <Download className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-5 pb-16">

        {/* ── STEP 1: คนหาร ── */}
        <SectionCard>
          <StepBadge n={1} label="ใส่ชื่อคนที่จะหารบิล" />

          <div className="space-y-2.5">
            {members.map((member, idx) => (
              <div key={member.id} className="flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-center gap-2">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ backgroundColor: member.color }}
                  >
                    {member.name.slice(0, 1) || (idx + 1)}
                  </span>
                  <input
                    value={member.name}
                    onChange={(e) => updateMember(member.id, 'name', e.target.value)}
                    placeholder={`คนที่ ${idx + 1}`}
                    className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-400"
                  />
                  <button
                    onClick={() => removeMember(member.id)}
                    disabled={members.length <= 1}
                    className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-30 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <label className="text-xs text-gray-400 shrink-0">PromptPay:</label>
                  <input
                    value={member.promptPayId}
                    onChange={(e) => updateMember(member.id, 'promptPayId', e.target.value)}
                    placeholder="เบอร์โทร 10 หลัก (ถ้ามี)"
                    className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-violet-400"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              value={newMemberName}
              onChange={(e) => setNewMemberName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addMember() }}
              placeholder="ชื่อเพื่อน..."
              className="flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-400"
            />
            <button
              onClick={addMember}
              disabled={!newMemberName.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-40 transition-colors"
            >
              <Plus className="h-4 w-4" />
              เพิ่ม
            </button>
          </div>
        </SectionCard>

        {/* ── STEP 2: รายการ ── */}
        <SectionCard>
          <StepBadge n={2} label="รายการค่าใช้จ่าย" />

          {/* Action buttons */}
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              onClick={addManualItem}
              className="flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 transition-colors"
            >
              <Plus className="h-4 w-4" />
              เพิ่มรายการ
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
              className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
              {isBusy ? 'กำลังสแกน...' : 'สแกนสลิป'}
              {!isBusy && (
                <span className="ml-0.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 font-normal">
                  หลายใบได้
                </span>
              )}
            </button>
            {items.length > 0 && (
              <button
                onClick={resetAll}
                className="flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                ล้างทั้งหมด
              </button>
            )}
          </div>

          {/* OCR Progress */}
          {isBusy && (
            <div className="mb-4 rounded-xl border border-violet-100 bg-violet-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-violet-700">
                <Loader2 className="h-4 w-4 animate-spin" />
                {progress.statusText}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-violet-100">
                <div
                  className="h-full rounded-full bg-violet-600 transition-all duration-300"
                  style={{ width: `${progress.progress}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-violet-500">{progress.progress}%</p>
            </div>
          )}

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <X className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Item list */}
          {items.length === 0 ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click() }}
              className="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-gray-200 py-10 text-center transition hover:border-violet-300 hover:bg-violet-50/50"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
                <Camera className="h-6 w-6 text-gray-400" />
              </div>
              <div>
                <p className="font-semibold text-gray-700">ถ่ายหรืออัปโหลดรูปสลิป</p>
                <p className="text-sm text-gray-400">เลือกได้หลายใบพร้อมกัน หรือกด &quot;เพิ่มรายการ&quot; เพื่อใส่เองได้เลย</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              {items.map((item) => {
                const split = calcItemSplit(item, members)
                const isExpanded = expandedItems.has(item.id)
                const pctSum = item.consumerIds.reduce((s, id) => s + (item.percentageByUser[id] ?? 0), 0)
                const exactSum = item.consumerIds.reduce((s, id) => s + (item.exactByUser[id] ?? 0), 0)

                return (
                  <div key={item.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                    {/* Item header row */}
                    <div className="flex items-center gap-2 p-3">
                      <input
                        value={item.name}
                        onChange={(e) => updateItem(item.id, 'name', e.target.value)}
                        placeholder="ชื่อรายการ"
                        className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-400 min-w-0"
                      />
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-sm text-gray-400">฿</span>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={item.amount || ''}
                          onChange={(e) => updateItem(item.id, 'amount', Number(e.target.value) || 0)}
                          placeholder="0"
                          className="w-24 rounded-lg border border-gray-200 px-2 py-2 text-right text-sm outline-none focus:ring-2 focus:ring-violet-400"
                        />
                      </div>
                      <button
                        onClick={() => toggleExpanded(item.id)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors"
                        title="แก้ไขรายละเอียด"
                      >
                        {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                      <button
                        onClick={() => removeItem(item.id)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Consumer chips (always shown) */}
                    <div className="border-t border-gray-100 px-3 py-2 flex flex-wrap gap-1.5 items-center">
                      <span className="text-xs text-gray-400 mr-1">ใครกิน/ใช้:</span>
                      {members.map((m) => {
                        const checked = item.consumerIds.includes(m.id)
                        return (
                          <button
                            key={m.id}
                            onClick={() => toggleConsumer(item.id, m.id)}
                            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-all ${
                              checked
                                ? 'text-white shadow-sm'
                                : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                            }`}
                            style={checked ? { backgroundColor: m.color } : {}}
                          >
                            {m.name}
                          </button>
                        )
                      })}
                    </div>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div className="border-t border-gray-100 bg-gray-50 px-3 py-3 space-y-3">
                        {/* Split mode */}
                        <div>
                          <label className="text-xs text-gray-500 mb-1 block">วิธีหาร</label>
                          <select
                            value={item.splitMode}
                            onChange={(e) => updateItem(item.id, 'splitMode', e.target.value as SplitMode)}
                            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-400"
                          >
                            {(Object.entries(SPLIT_MODE_LABELS) as [SplitMode, string][]).map(([v, l]) => (
                              <option key={v} value={v}>{l}</option>
                            ))}
                          </select>
                        </div>

                        {/* Percentage inputs */}
                        {item.splitMode === 'percentage' && (
                          <div className="space-y-1.5">
                            {item.consumerIds.map((mid) => {
                              const m = members.find((x) => x.id === mid)
                              if (!m) return null
                              return (
                                <label key={mid} className="flex items-center justify-between gap-2 text-sm">
                                  <span className="text-gray-600">{m.name}</span>
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="number"
                                      min={0}
                                      step="0.01"
                                      value={item.percentageByUser[mid] ?? 0}
                                      onChange={(e) =>
                                        updateItem(item.id, 'percentageByUser', {
                                          ...item.percentageByUser,
                                          [mid]: Number(e.target.value) || 0,
                                        })
                                      }
                                      className="w-20 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-right text-sm outline-none focus:ring-2 focus:ring-violet-400"
                                    />
                                    <span className="text-gray-400">%</span>
                                  </div>
                                </label>
                              )
                            })}
                            <p className={`text-xs mt-1 ${Math.abs(pctSum - 100) < 0.1 ? 'text-emerald-600' : 'text-amber-600'}`}>
                              รวม {pctSum.toFixed(1)}% {Math.abs(pctSum - 100) < 0.1 ? '✓' : '(ควรรวมได้ 100%)'}
                            </p>
                          </div>
                        )}

                        {/* Exact inputs */}
                        {item.splitMode === 'exact' && (
                          <div className="space-y-1.5">
                            {item.consumerIds.map((mid) => {
                              const m = members.find((x) => x.id === mid)
                              if (!m) return null
                              return (
                                <label key={mid} className="flex items-center justify-between gap-2 text-sm">
                                  <span className="text-gray-600">{m.name}</span>
                                  <div className="flex items-center gap-1">
                                    <span className="text-gray-400">฿</span>
                                    <input
                                      type="number"
                                      min={0}
                                      step="0.01"
                                      value={item.exactByUser[mid] ?? 0}
                                      onChange={(e) =>
                                        updateItem(item.id, 'exactByUser', {
                                          ...item.exactByUser,
                                          [mid]: Number(e.target.value) || 0,
                                        })
                                      }
                                      className="w-24 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-right text-sm outline-none focus:ring-2 focus:ring-violet-400"
                                    />
                                  </div>
                                </label>
                              )
                            })}
                            <p className={`text-xs mt-1 ${Math.abs(exactSum - item.amount) < 0.1 ? 'text-emerald-600' : 'text-amber-600'}`}>
                              รวม ฿{exactSum.toFixed(2)} {Math.abs(exactSum - item.amount) < 0.1 ? '✓' : `(ต่างจากราคา ฿${Math.abs(exactSum - item.amount).toFixed(2)})`}
                            </p>
                          </div>
                        )}

                        {/* Preview split */}
                        <div className="rounded-lg bg-white border border-gray-100 p-2">
                          <p className="text-xs text-gray-400 mb-1.5">แต่ละคนจ่าย:</p>
                          <div className="flex flex-wrap gap-2">
                            {members.map((m) => (
                              <span key={m.id} className="text-xs text-gray-600">
                                <span className="font-medium">{m.name}</span> ฿{round2(split[m.id] ?? 0).toFixed(2)}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Quick add row */}
              <button
                onClick={addManualItem}
                className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-3 text-sm text-gray-400 transition hover:border-violet-300 hover:text-violet-600 hover:bg-violet-50/50"
              >
                <Plus className="h-4 w-4" />
                เพิ่มรายการ
              </button>
            </div>
          )}

          {/* Charges summary */}
          {items.length > 0 && (
            <div className="mt-4 rounded-xl bg-gray-50 border border-gray-100 p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {/* ค่าบริการ */}
                <label className="block">
                  <span className="text-xs text-gray-500">ค่าบริการ</span>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-xs text-gray-400">฿</span>
                    <input
                      type="number" min={0} step="0.01"
                      value={serviceCharge || ''}
                      onChange={(e) => setServiceCharge(Number(e.target.value) || 0)}
                      placeholder="0"
                      className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-right outline-none focus:ring-2 focus:ring-violet-400"
                    />
                  </div>
                </label>

                {/* VAT with inclusive/exclusive toggle */}
                <label className="block">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">VAT</span>
                    <button
                      type="button"
                      onClick={() => setVatMode((m) => m === 'exclusive' ? 'inclusive' : 'exclusive')}
                      title={vatMode === 'exclusive' ? 'คลิกถ้า VAT รวมอยู่ในราคาแล้ว' : 'คลิกถ้าต้องการบวก VAT เพิ่ม'}
                      className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium transition-colors ${
                        vatMode === 'inclusive'
                          ? 'bg-amber-100 text-amber-700 border border-amber-200'
                          : 'bg-gray-100 text-gray-500 border border-gray-200'
                      }`}
                    >
                      {vatMode === 'inclusive' ? 'รวมแล้ว' : 'บวกเพิ่ม'}
                    </button>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-xs text-gray-400">฿</span>
                    <input
                      type="number" min={0} step="0.01"
                      value={vat || ''}
                      onChange={(e) => setVat(Number(e.target.value) || 0)}
                      placeholder="0"
                      disabled={vatMode === 'inclusive'}
                      className={`w-full rounded-lg border px-2 py-1.5 text-sm text-right outline-none focus:ring-2 focus:ring-violet-400 ${
                        vatMode === 'inclusive'
                          ? 'border-amber-200 bg-amber-50 text-amber-600 cursor-not-allowed'
                          : 'border-gray-200 bg-white'
                      }`}
                    />
                  </div>
                  {vatMode === 'inclusive' && (
                    <p className="mt-0.5 text-[10px] text-amber-600">รวมในราคาแล้ว ไม่บวกซ้ำ</p>
                  )}
                </label>

                {/* ส่วนลด */}
                <label className="block">
                  <span className="text-xs text-gray-500">ส่วนลด</span>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-xs text-gray-400">฿</span>
                    <input
                      type="number" min={0} step="0.01"
                      value={discount || ''}
                      onChange={(e) => setDiscount(Number(e.target.value) || 0)}
                      placeholder="0"
                      className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-right outline-none focus:ring-2 focus:ring-violet-400"
                    />
                  </div>
                </label>

                <div className="flex flex-col justify-end">
                  <span className="text-xs text-gray-500">วิธีกระจายค่าบริการ</span>
                  <select
                    value={allocationMode}
                    onChange={(e) => setAllocationMode(e.target.value as AllocationMode)}
                    className="mt-0.5 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-violet-400"
                  >
                    <option value="proportional">ตามยอดแต่ละคน</option>
                    <option value="equal">แบ่งเท่ากันทุกคน</option>
                  </select>
                </div>
              </div>
              <div className="mt-2 flex justify-between border-t border-gray-200 pt-2">
                <span className="text-sm font-semibold text-gray-700">ยอดรวมทั้งหมด</span>
                <span className="text-base font-bold text-violet-700">฿{grandTotal.toFixed(2)}</span>
              </div>
            </div>
          )}
        </SectionCard>

        {/* ── Scanned receipts payer assignment ── */}
        {results.length > 0 && !isBusy && (
          <SectionCard>
            <div className="flex items-center gap-2 mb-3">
              <Receipt className="h-4 w-4 text-violet-500" />
              <span className="text-sm font-semibold text-gray-800">สลิปที่สแกน ({results.length} ใบ)</span>
              <span className="text-xs text-gray-400 ml-1">— ระบุผู้จ่ายต่อสลิป แล้วกด &quot;+เพิ่มยอดจ่าย&quot;</span>
            </div>
            <div className="space-y-2">
              {results.map((r, idx) => {
                const slipTotal = r.summary.total ?? r.items.reduce((s, it) => s + it.amount, 0)
                const assignedId = receiptPayerMap[idx]
                return (
                  <div key={idx} className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-600">
                        สลิป {idx + 1} — {r.items.length} รายการ
                        {r.vatIncluded && (
                          <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">VAT รวมแล้ว</span>
                        )}
                      </p>
                      <p className="text-sm font-bold text-violet-700">฿{slipTotal.toFixed(2)}</p>
                    </div>
                    <select
                      value={assignedId ?? ''}
                      onChange={(e) => {
                        const newPayerId = e.target.value
                        const oldPayerId = receiptPayerMap[idx]
                        if (oldPayerId === newPayerId) return

                        // Update paid amounts immediately without needing a button
                        setPaidByMember((prev) => {
                          const next = { ...prev }
                          if (oldPayerId) {
                            next[oldPayerId] = Math.max(0, round2((next[oldPayerId] ?? 0) - slipTotal))
                          }
                          if (newPayerId) {
                            next[newPayerId] = round2((next[newPayerId] ?? 0) + slipTotal)
                          }
                          return next
                        })

                        setReceiptPayerMap((prev) => ({ ...prev, [idx]: newPayerId }))
                      }}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-violet-400"
                    >
                      <option value="">ใครจ่าย?</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                )
              })}
            </div>
          </SectionCard>
        )}

        {/* ── STEP 3: Who paid? ── */}
        {items.length > 0 && (
          <SectionCard>
            <StepBadge n={3} label="ใครจ่ายไปแล้วเท่าไหร่?" />
            <p className="mb-3 -mt-2 text-xs text-gray-400">ใส่ยอดที่แต่ละคนจ่ายไปแล้ว (ถ้าคนเดียวจ่ายทั้งหมด ไม่ต้องแก้)</p>

            <div className="space-y-2">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-3">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ backgroundColor: m.color }}
                  >
                    {m.name.slice(0, 1)}
                  </span>
                  <span className="flex-1 text-sm font-medium text-gray-700">{m.name}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-gray-400">฿</span>

                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={normalizedPaid[m.id] ?? 0}
                      onChange={(e) =>
                        setPaidByMember((prev) => ({ ...prev, [m.id]: Number(e.target.value) || 0 }))
                      }
                      className="w-28 rounded-xl border border-gray-200 px-3 py-2 text-right text-sm outline-none focus:ring-2 focus:ring-violet-400"
                    />
                  </div>
                  <span className="w-16 text-right text-xs font-semibold">
                    {(finalDueByMember[m.id] ?? 0) > 0 && (
                      <span className="text-gray-500">ควรจ่าย<br />฿{(finalDueByMember[m.id] ?? 0).toFixed(2)}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {/* ── ผลสรุป: ใครโอนใคร ── */}
        {items.length > 0 && (
          <SectionCard>
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-violet-600" />
                <h2 className="text-base font-bold text-gray-800">สรุป — ใครโอนให้ใคร</h2>
              </div>
              {settlements.length > 0 && (
                <button
                  onClick={() => {
                    const lines = [
                      '🧾 สรุปการหารบิล',
                      `ยอดรวม ฿${grandTotal.toFixed(2)}`,
                      '',
                      ...settlements.map((s) => {
                        const from = members.find((m) => m.id === s.fromMemberId)
                        const to = members.find((m) => m.id === s.toMemberId)
                        const pp = to?.promptPayId ? ` (PromptPay: ${to.promptPayId})` : ''
                        return `• ${from?.name} → โอน ${to?.name} ฿${s.amount.toFixed(2)}${pp}`
                      }),
                    ]
                    void copyText(lines.join('\n'), 'copy-all-summary')
                  }}
                  className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-violet-50 hover:text-violet-700 hover:border-violet-200 transition-colors"
                >
                  {copiedId === 'copy-all-summary' ? (
                    <><span className="text-emerald-600">✓</span> คัดลอกแล้ว</>
                  ) : (
                    <><Copy className="h-3 w-3" /> คัดลอกสรุป</>
                  )}
                </button>
              )}
            </div>

            {settlements.length === 0 ? (
              <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-center">
                <p className="text-sm font-semibold text-emerald-700">🎉 ทุกคนเคลียร์แล้ว!</p>
                <p className="text-xs text-emerald-500 mt-1">ไม่มีใครต้องโอนเพิ่ม</p>
              </div>
            ) : (
              <div className="space-y-3">
                {settlements.map((s, idx) => {
                  const from = members.find((m) => m.id === s.fromMemberId)
                  const to = members.find((m) => m.id === s.toMemberId)
                  if (!from || !to) return null

                  const hasQr = !!s.promptPayPayload
                  const isOpen = activeSettlementIdx === idx

                  return (
                    <div key={idx} className="rounded-xl border border-gray-200 overflow-hidden">
                      {/* Settlement row */}
                      <div className="flex items-center gap-3 p-3">
                        <div className="flex flex-1 items-center gap-2 min-w-0">
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                            style={{ backgroundColor: from.color }}
                          >
                            {from.name.slice(0, 1)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-gray-800 truncate">
                              {from.name} → {to.name}
                            </p>
                            <p className="text-xs text-gray-400">
                              {to.promptPayId ? `PromptPay: ${to.promptPayId}` : 'ยังไม่มีเบอร์ PromptPay'}
                            </p>
                          </div>
                        </div>
                        <span className="text-base font-bold text-violet-700 shrink-0">
                          ฿{s.amount.toFixed(2)}
                        </span>
                        <div className="flex gap-1 shrink-0">
                          <button
                            onClick={() => void copyText(`${from.name} โอน ${to.name} ฿${s.amount.toFixed(2)}${to.promptPayId ? ` (PromptPay: ${to.promptPayId})` : ''}`, `copy-${idx}`)}
                            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 transition-colors"
                            title="คัดลอก"
                          >
                            {copiedId === `copy-${idx}` ? (
                              <span className="text-xs text-emerald-600 font-medium">✓</span>
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                          {hasQr && (
                            <button
                              onClick={() => setActiveSettlementIdx(isOpen ? null : idx)}
                              className={`rounded-lg p-2 transition-colors ${isOpen ? 'bg-violet-100 text-violet-600' : 'text-gray-400 hover:bg-gray-100'}`}
                              title="QR PromptPay"
                            >
                              <QrCodeIcon className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* QR Expanded */}
                      {isOpen && s.promptPayPayload && (
                        <div className="border-t border-gray-100 bg-gray-50 p-4 flex flex-col sm:flex-row gap-4 items-center">
                          <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
                            <QrCode value={s.promptPayPayload} size={180} />
                          </div>
                          <div className="flex-1 text-center sm:text-left space-y-2">
                            <p className="text-sm font-semibold text-gray-700">สแกน QR เพื่อโอน</p>
                            <p className="text-lg font-bold text-violet-700">฿{s.amount.toFixed(2)}</p>
                            <p className="text-xs text-gray-400">
                              โอนไปหา {to.name}
                              {toPromptPayTarget(to.promptPayId) ? ` (${toPromptPayTarget(to.promptPayId)})` : ''}
                            </p>
                            <button
                              onClick={() => void copyText(s.promptPayPayload!, `qr-${idx}`)}
                              className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs hover:bg-gray-50 transition-colors"
                            >
                              <Copy className="h-3 w-3" />
                              {copiedId === `qr-${idx}` ? 'คัดลอกแล้ว ✓' : 'คัดลอก Payload'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Per-member summary */}
            <div className="mt-4 pt-3 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-2">สรุปต่อคน</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {members.map((m) => (
                  <div key={m.id} className="rounded-xl bg-gray-50 border border-gray-100 p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />
                      <span className="text-xs font-medium text-gray-700 truncate">{m.name}</span>
                    </div>
                    <p className="text-sm font-bold text-gray-800">฿{(finalDueByMember[m.id] ?? 0).toFixed(2)}</p>
                    <p className={`text-xs ${(netByMember[m.id] ?? 0) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {(netByMember[m.id] ?? 0) >= 0 ? '↑ ได้รับคืน' : '↓ ต้องโอน'}
                      {' '}฿{Math.abs(netByMember[m.id] ?? 0).toFixed(2)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </SectionCard>
        )}
      </main>
    </div>
  )

  function triggerImportUpload() {
    importInputRef.current?.click()
  }
}

export default App
