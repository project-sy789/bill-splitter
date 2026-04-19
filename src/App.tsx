import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  Copy,
  Download,
  History,
  Loader2,
  Plus,
  QrCode as QrCodeIcon,
  Receipt,
  ListFilter,
  Zap,
  Trash2,
  Upload,
  Users,
  X,
  Bookmark,
  BookmarkPlus,
  Share,
  Check,
  AlertCircle,
} from 'lucide-react'
import * as htmlToImage from 'html-to-image'

import { QrCode } from './components/qr-code'
import { useReceiptOcr } from './hooks/use-receipt-ocr'
import { useBillHistory } from './hooks/use-bill-history'
import { useGroups } from './hooks/use-groups'
import { buildPromptPayPayload, formatPromptPay, toPromptPayTarget } from './lib/promptpay'
import * as db from './lib/bill-db'
import {
  type AllocationMode,
  type BillItemDraft,
  type MemberDraft,
  type PersistedBillState,
  type ManualBill,
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

// ──────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────

function StepBadge({ n, label }: { n: number; label: string }) {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600 text-sm font-bold text-white shadow-sm">
        {n}
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-gray-900">{label}</span>
    </div>
  )
}

function SectionCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-[28px] border border-gray-200 bg-white p-4 shadow-sm sm:p-5 ${className}`}>
      {children}
    </section>
  )
}



// ──────────────────────────────────────────────
// Main App
// ──────────────────────────────────────────────

function App() {
  // ── Startup: migrate localStorage → IndexedDB then read current id ──
  const [currentBillId, setCurrentBillId] = useState<string>(() => {
    // Synchronous fallback during migration (resolved async below)
    const legacyId = localStorage.getItem('bill-splitter-current-id')
    return legacyId ?? crypto.randomUUID()
  })
  const [initialState, setInitialState] = useState<ReturnType<typeof safeParseBillState>>(null)
  const [dbReady, setDbReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function init() {
      // 1. Run migration once (idempotent)
      const migratedId = await db.migrateFromLocalStorage()

      // 2. Get current bill id from DB settings
      const savedId = await db.getSetting('current-bill-id')
      const resolvedId = savedId ?? migratedId ?? currentBillId

      // 3. Load the bill state
      const state = resolvedId ? await db.getBill(resolvedId) : null

      // 4. Legacy localStorage fallback for very first launch
      const legacyFallback = state ?? safeParseBillState(
        localStorage.getItem('bill-splitter-state')
      )

      if (!cancelled) {
        if (savedId && savedId !== currentBillId) setCurrentBillId(savedId)
        setInitialState(legacyFallback)
        setDbReady(true)
      }
    }
    void init()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Migration: move global fees to first bill ──
  useEffect(() => {
    if (!dbReady || !initialState) return
    const sc = initialState.serviceCharge ?? 0
    const vt = initialState.vat ?? 0
    const ds = initialState.discount ?? 0
    if (sc === 0 && vt === 0 && ds === 0) return

    setManualBills(prev => {
      if (prev.length > 0) {
        return prev.map((b, i) => i === 0 ? {
          ...b,
          serviceCharge: b.serviceCharge || sc,
          vat: b.vat || vt,
          itemDiscount: b.itemDiscount || 0,
          billDiscount: b.billDiscount || ds,
        } : b)
      }
      return [{
        id: crypto.randomUUID(),
        name: 'บิลยกยอด',
        amount: 0,
        serviceCharge: sc,
        vat: vt,
        itemDiscount: 0,
        billDiscount: ds,
        vatIncluded: false
      }]
    })

    // Clear legacy global fields in next save by ensuring they are not in the current state
  }, [dbReady, initialState])
  const { history, addOrUpdateBill, removeBill } = useBillHistory()
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false)
  const [members, setMembers] = useState<MemberDraft[]>(
    initialState?.members ?? [
      { id: crypto.randomUUID(), name: 'ฉัน', color: MEMBER_COLORS[0]!, promptPayId: '' },
      { id: crypto.randomUUID(), name: 'เพื่อน', color: MEMBER_COLORS[1]!, promptPayId: '' },
    ],
  )
  const [newMemberName, setNewMemberName] = useState('')
  const [items, setItems] = useState<BillItemDraft[]>(initialState?.items ?? [])
  const [allocationMode, setAllocationMode] = useState<AllocationMode>(initialState?.allocationMode ?? 'proportional')
  const [paidByMember, setPaidByMember] = useState<Record<string, number>>(initialState?.paidByMember ?? {})
  const [settlementStatus, setSettlementStatus] = useState<Record<string, boolean>>(initialState?.settlementStatus ?? {})
  const [manualBills, setManualBills] = useState<ManualBill[]>(initialState?.manualBills?.map(b => ({
    ...b,
    serviceCharge: b.serviceCharge ?? 0,
    vat: b.vat ?? 0,
    itemDiscount: b.itemDiscount ?? 0,
    billDiscount: b.billDiscount ?? 0,
    vatIncluded: b.vatIncluded ?? false
  })) ?? [])
  const [receiptPayerMap, setReceiptPayerMap] = useState<Record<string, string>>(initialState?.receiptPayerMap ?? {}) // unifiedBillId → memberId
  const [activeSettlementIdx, setActiveSettlementIdx] = useState<number | null>(null)
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const { groups, saveGroup, deleteGroup } = useGroups()
  const [groupModalMode, setGroupModalMode] = useState<'save' | 'load' | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [isManualBillModalOpen, setIsManualBillModalOpen] = useState(false)
  const [newManualBillName, setNewManualBillName] = useState('')
  const [newManualBillAmount, setNewManualBillAmount] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const exportImageRef = useRef<HTMLDivElement>(null)

  const handleExportImage = useCallback(async () => {
    if (!exportImageRef.current) return
    try {
      const dataUrl = await htmlToImage.toPng(exportImageRef.current, {
        quality: 1, backgroundColor: '#ffffff', style: { borderRadius: '24px' }
      })
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      const file = new File([blob], `bill-split-${new Date().getTime()}.png`, { type: 'image/png' })

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: 'สรุปการหารบิล',
            files: [file]
          })
          return
        } catch {
          // Fallback to download if share API failed/cancelled
        }
      }

      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.download = file.name
      link.href = blobUrl
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(blobUrl)
    } catch (e) {
      console.error('Failed to export image', e)
    }
  }, [])

  const { progress, results, mergedItems, error, scanFiles, reset, terminate, isBusy, setResults } = useReceiptOcr()

  // ── Calculations ──
  const baseTotalsByMember = useMemo(() => {
    const totals: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]))
    items.forEach((item) => {
      const split = calcItemSplit({ ...item, amount: round2(Math.max(0, item.amount - (item.itemDiscount ?? 0))) }, members)
      Object.entries(split).forEach(([id, amt]) => { totals[id] = (totals[id] ?? 0) + amt })
    })
    Object.keys(totals).forEach((id) => { totals[id] = round2(totals[id]!) })
    return totals
  }, [items, members])



  const billContexts = useMemo(() => {
    return [
      ...results.map((r, i) => ({
        id: `ocr-${i}`,
        title: r.customName || `สลิป ${i + 1}`,
        items: items.filter((it) => it.billId === `ocr-${i}`),
        serviceCharge: r.summary.serviceCharge ?? 0,
        vat: r.summary.vat ?? 0,
        billDiscount: r.summary.billDiscount ?? r.summary.discount ?? 0,
        vatIncluded: r.vatIncluded,
      })),
      ...manualBills.map((m) => ({
        id: m.id,
        title: m.name,
        items: items.filter((it) => it.billId === m.id),
        serviceCharge: m.serviceCharge,
        vat: m.vat,
        billDiscount: m.billDiscount ?? (m.discount ?? 0),
        vatIncluded: m.vatIncluded,
      })),
    ]
  }, [results, manualBills, items])

  const billBaseByMemberMap = useMemo(() => {
    const map = new Map<string, Record<string, number>>()
    billContexts.forEach((bill) => {
      const base: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]))
      bill.items.forEach((it) => {
        const split = calcItemSplit({ ...it, amount: round2(Math.max(0, it.amount - (it.itemDiscount ?? 0))) }, members)
        Object.entries(split).forEach(([id, amt]) => { base[id] = (base[id] ?? 0) + amt })
      })
      map.set(bill.id, base)
    })
    return map
  }, [billContexts, members])

  const adjustmentsByMember = useMemo(() => {
    const totalAdjustments: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]))

    billContexts.forEach((bill) => {
      const baseByMember = billBaseByMemberMap.get(bill.id) ?? Object.fromEntries(members.map((m) => [m.id, 0]))
      const netAdjustment = bill.serviceCharge + (bill.vatIncluded ? 0 : bill.vat) - bill.billDiscount
      if (netAdjustment !== 0) {
        const consumersOfThisBill = members.filter((m) => (baseByMember[m.id] ?? 0) > 0)
        const adjustments = allocateAmount(netAdjustment, consumersOfThisBill.length > 0 ? consumersOfThisBill : members, baseByMember, allocationMode)
        Object.entries(adjustments).forEach(([id, amt]) => { totalAdjustments[id] = (totalAdjustments[id] ?? 0) + amt })
      }
    })

    Object.keys(totalAdjustments).forEach((id) => { totalAdjustments[id] = round2(totalAdjustments[id]!) })
    return totalAdjustments
  }, [billContexts, billBaseByMemberMap, members, allocationMode])

  const finalDueByMember = useMemo(() => {
    const due: Record<string, number> = {}
    members.forEach((m) => {
      due[m.id] = round2((baseTotalsByMember[m.id] ?? 0) + (adjustmentsByMember[m.id] ?? 0))
    })
    return due
  }, [members, baseTotalsByMember, adjustmentsByMember])

  const unifiedBills = useMemo(() => [
    ...results.map((r, i) => {
      const bId = `ocr-${i}`
      const billItems = items.filter((it) => it.billId === bId)
      const subtotal = billItems.reduce((s, it) => s + Math.max(0, it.amount - (it.itemDiscount ?? 0)), 0)
      const billDiscount = r.summary.billDiscount ?? r.summary.discount ?? 0
      const calculatedTotal = round2(subtotal + (r.summary.serviceCharge ?? 0) + (r.vatIncluded ? 0 : (r.summary.vat ?? 0)) - billDiscount)

      return {
        id: bId,
        title: r.customName !== undefined ? r.customName : `สลิป ${i + 1}`,
        subtitle: `${billItems.length} รายการ${r.vatIncluded ? ' (VAT รวมแล้ว)' : ''}`,
        amount: r.summary.total ?? round2(subtotal + (r.summary.serviceCharge ?? 0) + (r.vatIncluded ? 0 : (r.summary.vat ?? 0)) - billDiscount),
        calculatedTotal,
      }
    }),
    ...manualBills.map((m) => {
      const billItems = items.filter((it) => it.billId === m.id)
      const subtotal = billItems.reduce((s, it) => s + Math.max(0, it.amount - (it.itemDiscount ?? 0)), 0)
      const billDiscount = m.billDiscount ?? (m.discount ?? 0)
      const calculatedTotal = round2(subtotal + m.serviceCharge + (m.vatIncluded ? 0 : m.vat) - billDiscount)

      return {
        id: m.id,
        title: m.name,
        subtitle: billItems.length > 0 ? `${billItems.length} รายการ` : 'ยอดใส่เอง',
        amount: round2(Math.max(0, m.amount - (m.itemDiscount ?? 0)) + m.serviceCharge + (m.vatIncluded ? 0 : m.vat) - billDiscount),
        calculatedTotal,
      }
    })
  ], [results, manualBills, items])

  const grandTotal = useMemo(() => {
    return round2(unifiedBills.reduce((acc, b) => acc + b.amount, 0) + items.filter(it => !it.billId).reduce((acc, it) => acc + it.amount, 0))
  }, [unifiedBills, items])

  // ── Persist to IndexedDB ──
  useEffect(() => {
    if (!dbReady) return
    const state: PersistedBillState = { version: 4, members, items, serviceCharge: 0, vat: 0, billDiscount: 0, discount: 0, allocationMode, paidByMember, settlementStatus, manualBills, receiptPayerMap }
    const title = `บิลวันที่ ${new Date().toLocaleDateString('th-TH')} - ยอด ฿${grandTotal.toFixed(2)}`

    void db.saveBill(currentBillId, title, state)
    void db.setSetting('current-bill-id', currentBillId)

    // Auto-save history if the bill has any meaningful data
    if (items.length > 0 || members.length > 2 || Object.keys(paidByMember).length > 0 || manualBills.length > 0) {
      addOrUpdateBill(currentBillId, title, state)
    }
  }, [dbReady, members, items, allocationMode, paidByMember, settlementStatus, manualBills, receiptPayerMap, currentBillId, addOrUpdateBill, grandTotal])



  // Merge OCR results into items list when mergedItems changes
  const prevMergedLenRef = useRef(0)
  const prevResultsLenRef = useRef(0)

  // ── Recover orphaned OCR items across page reloads ──
  useEffect(() => {
    const knownIds = new Set([
      ...manualBills.map(m => m.id),
      ...results.map((_, i) => `ocr-${i}`)
    ])
    const orphans = items.filter(i => i.billId && !knownIds.has(i.billId))
    if (orphans.length > 0) {
      const orphanGroups = new Map<string, number>()
      orphans.forEach(i => {
        if (i.billId) orphanGroups.set(i.billId, (orphanGroups.get(i.billId) || 0) + i.amount)
      })

      const recovered: ManualBill[] = []
      orphanGroups.forEach((amt, bId) => {
        const ocrIdx = bId.match(/ocr-(\d+)/)?.[1]
        recovered.push({
          id: bId,
          name: ocrIdx !== undefined ? `สลิปอดีต ${parseInt(ocrIdx) + 1}` : `บิลอดีต`,
          amount: amt,
          serviceCharge: 0,
          vat: 0,
          itemDiscount: 0,
          billDiscount: 0,
          vatIncluded: false
        })
      })
      setManualBills(prev => [...prev, ...recovered])
    }
  }, [items, manualBills, results])
  useEffect(() => {
    if (mergedItems.length === prevMergedLenRef.current) return
    const newOcrItems = mergedItems.slice(prevMergedLenRef.current)
    prevMergedLenRef.current = mergedItems.length
    if (newOcrItems.length === 0) return

    setItems((prev) => {
      const next = [...prev]
      newOcrItems.forEach((oi) => {
        // Grouping: Check if an exact match of (name + exact price) exists IN THE SAME BILL
        const matchBaseIdx = next.findIndex((x) =>
          (x.name === oi.name || x.name.startsWith(`${oi.name} (x`)) &&
          Math.abs((x.amount / (parseInt(x.name.match(/\(x(\d+)\)$/)?.[1] || '1', 10))) - oi.amount) < 0.01 &&
          x.billId === oi.billId
        )

        if (matchBaseIdx !== -1) {
          const item = next[matchBaseIdx]!
          const match = item.name.match(/\(x(\d+)\)$/)
          const currentCount = match ? parseInt(match[1]!) : 1
          const newCount = currentCount + 1
          const baseName = match ? item.name.substring(0, item.name.lastIndexOf(' (x')) : item.name

          next[matchBaseIdx] = {
            ...item,
            name: `${baseName} (x${newCount})`,
            amount: round2(item.amount + oi.amount),
            exactByUser: Object.fromEntries(members.map((m) => [m.id, round2((item.amount + oi.amount) / Math.max(members.length, 1))])),
          }
        } else {
          next.push({
            id: oi.id,
            name: oi.name,
            amount: oi.amount,
            itemDiscount: 0,
            billId: oi.billId,
            splitMode: 'equally' as SplitMode,
            consumerIds: members.map((m) => m.id),
            percentageByUser: Object.fromEntries(members.map((m) => [m.id, round2(100 / Math.max(members.length, 1))])),
            exactByUser: Object.fromEntries(members.map((m) => [m.id, round2(oi.amount / Math.max(members.length, 1))])),
          })
        }
      })
      return next
    })

    prevResultsLenRef.current = results.length
  }, [mergedItems, results, members])

  useEffect(() => () => { void terminate() }, [terminate])

  const totalPaidByMember = useMemo(() => {
    const totals: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]))
    Object.entries(paidByMember).forEach(([memberId, amt]) => {
      if (totals[memberId] !== undefined) totals[memberId] = round2((totals[memberId] ?? 0) + (amt ?? 0))
    })
    return totals
  }, [members, paidByMember])

  const normalizedPaid = useMemo(() => {
    const out: Record<string, number> = {}
    members.forEach((m) => {
      const ex = totalPaidByMember[m.id]
      out[m.id] = typeof ex === 'number' ? ex : 0
    })
    return out
  }, [members, totalPaidByMember])

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

  const updateItem = useCallback(<K extends keyof BillItemDraft>(itemId: string, field: K, value: BillItemDraft[K]) => {
    const oldItem = items.find((item) => item.id === itemId)
    if (field === 'amount' && oldItem && oldItem.billId) {
      const diff = (value as number) - oldItem.amount
      if (diff !== 0) {
        if (oldItem.billId.startsWith('ocr-')) {
          const ocrIdx = parseInt(oldItem.billId.split('-')[1]!, 10)
          setResults(res => res.map((r, i) => i === ocrIdx ? { ...r, summary: { ...r.summary, total: round2((r.summary.total || 0) + diff) } } : r))
        } else {
          setManualBills(prev => prev.map(m => m.id === oldItem.billId ? { ...m, amount: Math.max(0, round2(m.amount + diff)) } : m))
        }

      }
    }
    setItems((prev) => prev.map((item) => item.id === itemId ? { ...item, [field]: value } : item))
  }, [items, setResults])

  const exportBill = useCallback(() => {
    const state: PersistedBillState = {
      version: 4,
      members,
      items,
      serviceCharge: 0,
      vat: 0,
      billDiscount: 0,
      allocationMode,
      paidByMember,
      settlementStatus,
      manualBills,
      receiptPayerMap,
    }
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `บิล-${Date.now()}.json` }).click()
    URL.revokeObjectURL(url)
  }, [members, items, allocationMode, paidByMember, settlementStatus, manualBills, receiptPayerMap])

  const importBill = useCallback(async (file: File | null) => {
    if (!file) return
    const data = safeParseBillState(await file.text())
    if (!data) return
    setMembers(data.members)
    setItems(data.items)
    setAllocationMode(data.allocationMode ?? 'proportional')
    setPaidByMember(data.paidByMember ?? {})
    setSettlementStatus(data.settlementStatus ?? {})
    setManualBills((data.manualBills ?? []).map(b => ({
      ...b,
      serviceCharge: b.serviceCharge ?? 0,
      vat: b.vat ?? 0,
      itemDiscount: b.itemDiscount ?? 0,
      billDiscount: b.billDiscount ?? 0,
      vatIncluded: b.vatIncluded ?? false
    })))
    setReceiptPayerMap(data.receiptPayerMap ?? {})
    reset()
  }, [reset])

  const resetAll = useCallback(() => {
    setItems([])
    setPaidByMember({})
    setSettlementStatus({})
    setManualBills([])
    setReceiptPayerMap({})
    reset()
    prevMergedLenRef.current = 0
    prevResultsLenRef.current = 0
  }, [reset])

  const copyText = useCallback(async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }, [])

  const loadHistoryBill = useCallback(async (id: string) => {
    const data = await db.getBill(id)
    if (!data) return
    setCurrentBillId(id)
    setMembers(data.members)
    setItems(data.items)
    setAllocationMode(data.allocationMode ?? 'proportional')
    setPaidByMember(data.paidByMember ?? {})
    setSettlementStatus(data.settlementStatus ?? {})
    setManualBills((data.manualBills ?? []).map(b => ({
      ...b,
      serviceCharge: b.serviceCharge ?? 0,
      vat: b.vat ?? 0,
      itemDiscount: b.itemDiscount ?? 0,
      billDiscount: b.billDiscount ?? b.discount ?? 0,
      vatIncluded: b.vatIncluded ?? false
    })))
    setReceiptPayerMap(data.receiptPayerMap ?? {})
    reset()
    setIsHistoryModalOpen(false)
  }, [reset])

  const createNewBill = useCallback(() => {
    setCurrentBillId(crypto.randomUUID())
    setMembers([
      { id: crypto.randomUUID(), name: 'ฉัน', color: MEMBER_COLORS[0]!, promptPayId: '' },
      { id: crypto.randomUUID(), name: 'เพื่อน', color: MEMBER_COLORS[1]!, promptPayId: '' },
    ])
    setItems([])
    setPaidByMember({})
    setSettlementStatus({})
    setManualBills([])
    setReceiptPayerMap({})
    reset()
    prevMergedLenRef.current = 0
    prevResultsLenRef.current = 0
    setIsHistoryModalOpen(false)
  }, [reset])

  // ──────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-sky-50 text-[15px] leading-6 tracking-[0.01em] sm:text-base">
      {/* Hidden inputs */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void handleFilesSelected(e.target.files)}
      />
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
      <header className="sticky top-0 z-40 border-b border-gray-100 bg-white/90 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.8),0_8px_30px_rgba(124,58,237,0.04)]" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex max-w-3xl items-center justify-between px-3 py-2 sm:px-4 sm:py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-600 text-white">
              <Receipt className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-[17px] font-semibold tracking-tight leading-none text-gray-900">หารบิลกัน</h1>
              <p className="mt-0.5 text-[11px] leading-none tracking-wide text-gray-400">หารค่าใช้จ่ายกับเพื่อน</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setIsHistoryModalOpen(true)}
              className="rounded-xl border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 transition-colors"
              title="ประวัติบิล"
            >
              <History className="h-4 w-4" />
            </button>
            <button
              onClick={() => importInputRef.current?.click()}
              className="rounded-xl border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 transition-colors"
              title="โหลดข้อมูลทีบันทึกย้อนหลัง (JSON)"
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
            <button
              onClick={() => {
                if(confirm('คุณแน่ใจหรือไม่ว่าต้องการล้างข้อมูลทั้งหมด?')) resetAll()
              }}
              className="rounded-xl border border-red-100 p-2 text-red-400 hover:bg-red-50 hover:text-red-500 transition-colors"
              title="ล้างข้อมูลทั้งหมด"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-3 py-4 pb-14 sm:px-4 sm:py-5 sm:pb-16" style={{ paddingBottom: 'max(3.5rem, env(safe-area-inset-bottom))' }}>

        {/* ── STEP 1: คนหาร ── */}
        <SectionCard>
          <div className="flex items-start justify-between gap-3 mb-4">
            <StepBadge n={1} label="ใส่ชื่อคนที่จะหารบิล" />
            <div className="flex gap-2">
              <button 
                onClick={() => setGroupModalMode('save')} 
                className="text-xs text-violet-600 bg-violet-50 hover:bg-violet-100 flex items-center gap-1 px-2 py-1.5 rounded-lg font-medium transition-colors border border-violet-100"
              >
                <BookmarkPlus className="w-3.5 h-3.5"/> บันทึกแก๊ง
              </button>
              <button 
                onClick={() => setGroupModalMode('load')} 
                className="text-xs text-violet-600 bg-violet-50 hover:bg-violet-100 flex items-center gap-1 px-2 py-1.5 rounded-lg font-medium transition-colors border border-violet-100"
              >
                <Bookmark className="w-3.5 h-3.5"/> โหลดแก๊ง
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {members.map((member, idx) => (
              <div key={member.id} className="flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-center gap-2">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm"
                    style={{ backgroundColor: member.color }}
                  >
                    {member.name.slice(0, 1) || (idx + 1)}
                  </span>
                  <input
                    value={member.name}
                    onChange={(e) => updateMember(member.id, 'name', e.target.value)}
                    placeholder={`คนที่ ${idx + 1}`}
                    className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-400 transition-all shadow-sm"
                  />
                  <button
                    onClick={() => removeMember(member.id)}
                    disabled={members.length <= 1}
                    className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-30 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="pl-9">
                  <input
                    value={member.promptPayId || ''}
                    onChange={(e) => updateMember(member.id, 'promptPayId', e.target.value)}
                    placeholder="PromptPay: เบอร์โทร หรือ เลขบัตร"
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[11px] font-mono font-bold text-gray-700 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 placeholder:text-gray-300"
                  />
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={addMember}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-2.5 text-sm font-semibold text-gray-400 transition hover:border-violet-300 hover:text-violet-600 hover:bg-violet-50/50 sm:mt-4 sm:py-3"
          >
            <Plus className="h-4 w-4" />
            เพิ่มคนหารบิล
          </button>
        </SectionCard>

        {/* ── STEP 2: ใบเสร็จ & รายการ ── */}
        {(results.length > 0 || manualBills.length > 0 || !isBusy || items.some(it => !it.billId)) && (
          <div className="space-y-6">
            <SectionCard>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
                <div>
                  <StepBadge n={2} label="ใบเสร็จ & รายการ" />
                  <p className="text-[11px] text-gray-400 mt-1 ml-1">สแกน/เพิ่มบิล แล้วระบุว่าใครกินอะไร</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => cameraInputRef.current?.click()}
                    disabled={isBusy}
                    className="flex-1 sm:flex-initial flex items-center justify-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-bold text-violet-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-violet-100 hover:shadow-md active:translate-y-0 disabled:translate-y-0 disabled:opacity-50 disabled:hover:shadow-sm font-heading sm:px-4"
                  >
                    {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                    {isBusy ? 'กำลังสแกน...' : 'ถ่ายบิลใหม่'}
                  </button>
                  <button
                    onClick={() => setIsManualBillModalOpen(true)}
                    className="flex-1 sm:flex-initial flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 py-2 text-sm font-bold text-white shadow-[0_10px_24px_rgba(124,58,237,0.22)] transition-all hover:-translate-y-0.5 hover:bg-violet-700 hover:shadow-[0_14px_30px_rgba(124,58,237,0.28)] active:translate-y-0 font-heading sm:px-4"
                  >
                    <Plus className="h-4 w-4" /> เพิ่มบิลเอง
                  </button>
                </div>
              </div>

              {/* OCR Progress & Errors */}
              {isBusy && (
                <div className="mt-6 rounded-2xl border border-violet-100 bg-violet-50 p-4 animate-pulse">
                  <div className="mb-2 flex items-center gap-2 text-xs font-bold text-violet-700 uppercase tracking-wider">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {progress.statusText}
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-violet-100">
                    <div className="h-full rounded-full bg-violet-600 transition-all duration-300" style={{ width: `${progress.progress}%` }} />
                  </div>
                </div>
              )}
              
              {error && (
                <div className="mt-6 flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 p-4 text-xs text-red-700">
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                  <span>{error}</span>
                </div>
              )}
            </SectionCard>

            <div className="flex flex-col lg:grid lg:grid-cols-12 gap-6 items-start">
              {/* LEFT COLUMN: ITEM MANAGEMENT (รายการสินค้า) */}
              <div className="lg:col-span-7 w-full space-y-3 sm:space-y-4 order-2 lg:order-1">
                <div className="flex items-end justify-between gap-3 px-2">
                  <div>
                    <h3 className="text-[13px] font-black text-gray-800 uppercase tracking-[0.16em] flex items-center gap-2">
                      <ListFilter className="h-4 w-4 text-violet-500" />
                      รายการสินค้า
                    </h3>
                    <p className="mt-1 text-[11px] leading-5 text-gray-400">เพิ่มชื่อ รายการ ราคา และตั้งค่าวิธีหารได้ทีละรายการ</p>
                  </div>
                  <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-bold text-gray-500">
                    {items.length} รายการ
                  </span>
                </div>

                <div className="space-y-3 sm:space-y-4">
                  {items.map((item) => {
                    const split = calcItemSplit({ ...item, amount: round2(Math.max(0, item.amount - (item.itemDiscount ?? 0))) }, members)
                    const isExpanded = expandedItems.has(item.id)
                    const parentBill = unifiedBills.find(b => b.id === item.billId)
                    
                    return (
                      <div key={item.id} className={`bg-white rounded-[28px] border transition-all duration-300 ${isExpanded ? 'ring-2 ring-violet-100 border-violet-200 shadow-[0_20px_40px_rgba(15,23,42,0.08)]' : 'border-gray-100 shadow-sm hover:shadow-md'}`}>
                        <div className="p-4 sm:p-5">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <input
                                  value={item.name}
                                  onChange={(e) => updateItem(item.id, 'name', e.target.value)}
                                  placeholder="ชื่อรายการ"
                                  className="w-full bg-transparent p-0 text-base font-black tracking-tight text-gray-900 outline-none placeholder:text-gray-300"
                                />
                                {parentBill && (
                                  <span className="shrink-0 text-[8px] font-black bg-violet-50 text-violet-500 px-1.5 py-0.5 rounded-md uppercase tracking-tighter">
                                    {parentBill.title.slice(0, 10)}
                                  </span>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {item.consumerIds.map(cid => (
                                  <span key={cid} className="text-[9px] bg-gray-50 text-gray-400 px-1.5 py-0.5 rounded border border-gray-100 text-center min-w-[30px]">
                                    {members.find(m => m.id === cid)?.name}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50 px-3 py-2 shadow-sm">
                                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">฿</span>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  value={item.amount || ''}
                                  onChange={(e) => updateItem(item.id, 'amount', Number(e.target.value) || 0)}
                                  placeholder="0.00"
                                  className="w-20 bg-transparent text-right text-sm font-semibold tabular-nums text-gray-900 outline-none placeholder:text-gray-300 sm:w-24"
                                />
                              </div>
                              <div className="mt-2 flex items-center justify-end gap-1.5">
                                <button 
                                  onClick={() => setExpandedItems(prev => {
                                    const next = new Set(prev)
                                    if (next.has(item.id)) next.delete(item.id)
                                    else next.add(item.id)
                                    return next
                                  })}
                                  className="rounded-lg border border-violet-100 px-2.5 py-1 text-[10px] font-bold text-violet-700 hover:bg-violet-50 transition-colors"
                                >
                                  {isExpanded ? 'ปิด' : 'ตั้งค่าหาร'}
                                </button>
                                <button 
                                  onClick={() => setItems(prev => prev.filter(it => it.id !== item.id))}
                                  className="rounded-lg p-1.5 text-red-200 transition-all hover:bg-red-50 hover:text-red-500"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="mt-4 pt-4 border-t border-dashed border-gray-100 animate-in fade-in slide-in-from-top-2">
                              <div className="flex items-center justify-between mb-3">
                                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">วิธีหารรายการนี้</span>
                                <div className="flex rounded-lg border border-gray-100 bg-gray-50 p-0.5 shadow-inner">
                                  {(['equally', 'percentage', 'exact'] as const).map((mode) => (
                                    <button
                                      key={mode}
                                      onClick={() => updateItem(item.id, 'splitMode', mode)}
                                      className={`rounded-md px-2.5 py-1.5 text-[10px] font-semibold transition-all ${
                                        item.splitMode === mode ? 'bg-violet-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-600'
                                      }`}
                                    >
                                      {mode === 'equally' ? 'เท่ากัน' : mode === 'percentage' ? '%' : 'ระบุเอง'}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-1.5 mb-4">
                                {members.map((m) => {
                                  const isActive = item.consumerIds.includes(m.id)
                                  return (
                                    <button
                                      key={m.id}
                                      onClick={() => {
                                        const next = isActive ? item.consumerIds.filter(id => id !== m.id) : [...item.consumerIds, m.id]
                                        updateItem(item.id, 'consumerIds', next)
                                      }}
                                      className={`px-3 py-1.5 rounded-xl text-[10px] font-bold transition-all transform active:scale-95 ${
                                        isActive 
                                          ? 'bg-violet-600 text-white shadow-lg' 
                                          : 'bg-white border border-gray-200 text-gray-400 hover:border-violet-300'
                                      }`}
                                    >
                                      {m.name}
                                    </button>
                                  )
                                })}
                              </div>

                              {item.splitMode !== 'equally' && (
                                <div className="space-y-2 mb-4 bg-gray-50 p-3 rounded-2xl border border-gray-100">
                                  {item.consumerIds.map(cid => {
                                    const m = members.find(x => x.id === cid)
                                    if (!m) return null
                                    return (
                                      <div key={cid} className="flex items-center justify-between">
                                        <span className="text-[10px] font-black text-gray-600">{m.name}</span>
                                        <div className="flex items-center gap-1.5">
                                          <span className="text-[10px] font-bold text-gray-300 italic">{item.splitMode === 'percentage' ? '%' : '฿'}</span>
                                          <input 
                                            type="number"
                                            value={(item.splitMode === 'percentage' ? item.percentageByUser[cid] : item.exactByUser[cid]) ?? ''}
                                            onChange={(e) => {
                                              const field = item.splitMode === 'percentage' ? 'percentageByUser' : 'exactByUser'
                                              updateItem(item.id, field, { ...item[field], [cid]: Number(e.target.value) || 0 })
                                            }}
                                            className="w-20 bg-white border border-gray-200 rounded-lg px-2 py-1 text-right text-[11px] font-black outline-none focus:ring-2 focus:ring-violet-400"
                                          />
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              )}

                              <div className="text-[10px] font-bold text-violet-400 flex justify-between items-center bg-violet-50/50 p-2 rounded-xl">
                                <span>สรุปยอดหารต่อคน:</span>
                                <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 max-w-[70%]">
                                  {item.consumerIds.map(cid => (
                                    <span key={cid} className="font-mono">{members.find(x => x.id === cid)?.name} ฿{round2(split[cid] ?? 0).toFixed(1)}</span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}

                  <button
                    onClick={() => {
                      const item: BillItemDraft = {
                        id: crypto.randomUUID(),
                        name: '',
                        amount: 0,
                        itemDiscount: 0,
                        splitMode: 'equally',
                        consumerIds: members.map((m) => m.id),
                        percentageByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                        exactByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                      }
                      setItems((prev) => [...prev, item])
                      setExpandedItems(prev => new Set(prev).add(item.id))
                    }}
                    className="w-full py-4 border-2 border-dashed border-gray-200 rounded-[28px] text-[11px] font-black text-gray-400 hover:border-violet-300 hover:bg-violet-50/50 hover:text-violet-500 transition-all uppercase tracking-widest flex items-center justify-center gap-2 group"
                  >
                    <Plus className="h-4 w-4 group-hover:scale-110 transition-transform" />
                    เพิ่มรายการอาหาร/สินค้า
                  </button>
                </div>
              </div>

              {/* RIGHT COLUMN: RECEIPTS & BILL SUMMARY (ใบเสร็จ & ยอดจ่าย) */}
              <div className="lg:col-span-5 w-full space-y-6 order-1 lg:order-2">
                <div className="px-2">
                  <h3 className="text-sm font-black text-gray-800 uppercase tracking-[0.18em] flex items-center gap-2">
                    <Receipt className="h-4 w-4 text-violet-500" />
                    ใบเสร็จ & ยอดจ่าย
                  </h3>
                </div>

                <div className="space-y-8">
                  {unifiedBills.map((b) => {
                    const isDiscrepant = Math.abs(round2(b.amount - b.calculatedTotal)) > 0.01
                    const assignedId = receiptPayerMap[b.id]
                    const currentItemsSum = items.filter(it => it.billId === b.id).reduce((s, it) => s + it.amount, 0)

                    return (
                      <div key={b.id} className="receipt-serrated-top receipt-serrated-bottom receipt-thermal-texture rounded-b shadow-[0_18px_40px_rgba(15,23,42,0.12)] relative">
                        <div className="px-4 pt-7 pb-4 border-b border-dashed border-gray-200 sm:px-5">
                          <input
                            value={b.title}
                            onChange={(e) => {
                              if (b.id.startsWith('ocr-')) {
                                setResults(res => res.map((rr, ii) => ii === parseInt(b.id.split('-')[1]!, 10) ? { ...rr, customName: e.target.value } : rr))
                              } else {
                                setManualBills(prev => prev.map(m => m.id === b.id ? {...m, name: e.target.value} : m))
                              }
                            }}
                            className="w-full bg-transparent border-none p-0 text-[17px] font-semibold tracking-tight text-gray-900 outline-none focus:ring-0 placeholder:text-gray-300 sm:text-lg"
                            placeholder="บิลรายการ"
                          />
                          <div className="mt-1 flex items-end justify-between">
                            <div className="ml-auto text-right">
                              <p className="text-[10px] font-black uppercase leading-none tracking-[0.16em] text-gray-300">Net Total</p>
                              <p className="text-2xl font-semibold tabular-nums tracking-tight text-violet-700 font-mono">฿{b.amount.toFixed(2)}</p>
                            </div>
                          </div>
                        </div>

                        <div className="px-5 py-4 space-y-3 bg-white/40">
                          {/* Item check for this bill */}
                          <div className="flex justify-between items-center text-[10px] font-black uppercase text-gray-400">
                            <span>รายการสินค้าในบิล</span>
                            <span>฿{currentItemsSum.toFixed(2)}</span>
                          </div>

                          {/* Quick Add Discrepancy inside receipt if needed */}
                          {(() => {
                                                        const billFeeSource = b.id.startsWith('ocr-') ? results[parseInt(b.id.split('-')[1]!, 10)] : manualBills.find(m => m.id === b.id)
                             const billFeesAdjust = b.id.startsWith('ocr-')
                               ? (() => {
                                   const r = billFeeSource as (typeof results)[number] | undefined
                                   return r ? (r.summary.serviceCharge ?? 0) + (r.vatIncluded ? 0 : (r.summary.vat ?? 0)) - (r.summary.billDiscount ?? r.summary.discount ?? 0) : 0
                                 })()
                               : (() => {
                                   const m = billFeeSource as ManualBill | undefined
                                   return m ? (m.serviceCharge ?? 0) + (m.vatIncluded ? 0 : (m.vat ?? 0)) - (m.billDiscount ?? m.discount ?? 0) : 0
                                 })()
                             const deficit = round2(b.amount - currentItemsSum - billFeesAdjust)
                             if (deficit > 0.01) {
                               return (
                                 <button
                                   onClick={() => {
                                     const item: BillItemDraft = {
                                       id: crypto.randomUUID(),
                                       name: `ส่วนต่างของ ${b.title}`,
                                       billId: b.id,
                                       amount: deficit,
                                       itemDiscount: 0,
                                       splitMode: 'equally',
                                       consumerIds: members.map((m) => m.id),
                                       percentageByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                                       exactByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                                     }
                                     setItems((prev) => [...prev, item])
                                   }}
                                   className="w-full flex items-center justify-center gap-2 rounded-xl border border-amber-100 bg-amber-50 py-2 text-[10px] font-black text-amber-600 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-amber-100 hover:shadow-md active:translate-y-0"
                                 >
                                   <Zap className="h-3 w-3" /> เพิ่มส่วนต่าง ฿{deficit.toFixed(2)}
                                 </button>
                               )
                             }
                             return null
                          })()}

                          <div className="space-y-3 rounded-2xl border border-violet-100 bg-white p-3 shadow-sm">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-[10px] font-black text-gray-500 uppercase">Service +10%</span>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-300">฿</span>
                                <input
                                  type="number"
                                  value={(b.id.startsWith('ocr-') ? results[parseInt(b.id.split('-')[1]!, 10)]?.summary.serviceCharge : manualBills.find(m => m.id === b.id)?.serviceCharge) || ''}
                                  onChange={(e) => {
                                    const val = Number(e.target.value) || 0
                                    if (b.id.startsWith('ocr-')) {
                                      setResults(res => res.map((rr, ii) => ii === parseInt(b.id.split('-')[1]!, 10) ? { ...rr, summary: { ...rr.summary, serviceCharge: val } } : rr))
                                    } else {
                                      setManualBills(prev => prev.map(mm => mm.id === b.id ? { ...mm, serviceCharge: val } : mm))
                                    }
                                  }}
                                  className="w-20 rounded-xl border border-violet-100 bg-white px-2 py-1 text-xs text-right font-bold text-gray-700 outline-none focus:ring-2 focus:ring-violet-400"
                                  placeholder="0"
                                />
                              </div>
                            </div>

                            <div className="flex items-center justify-between gap-3">
                              <button
                                onClick={() => {
                                  const isInc = b.id.startsWith('ocr-') ? results[parseInt(b.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find(m => m.id === b.id)?.vatIncluded
                                  if (b.id.startsWith('ocr-')) {
                                    setResults(res => res.map((rr, ii) => ii === parseInt(b.id.split('-')[1]!, 10) ? { ...rr, vatIncluded: !isInc } : rr))
                                  } else {
                                    setManualBills(prev => prev.map(mm => mm.id === b.id ? { ...mm, vatIncluded: !isInc } : mm))
                                  }
                                }}
                                className={`rounded-full px-2.5 py-1 text-[10px] font-black border transition-colors ${
                                  (b.id.startsWith('ocr-') ? results[parseInt(b.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find(m => m.id === b.id)?.vatIncluded)
                                  ? 'bg-amber-100 text-amber-700 border-amber-200'
                                  : 'bg-violet-50 text-violet-700 border-violet-100'
                                }`}
                              >
                                { (b.id.startsWith('ocr-') ? results[parseInt(b.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find(m => m.id === b.id)?.vatIncluded) ? 'VAT รวมแล้ว' : 'VAT แยก +7%' }
                              </button>
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-gray-300">฿</span>
                                <input
                                  type="number"
                                  value={(b.id.startsWith('ocr-') ? results[parseInt(b.id.split('-')[1]!, 10)]?.summary.vat : manualBills.find(m => m.id === b.id)?.vat) || ''}
                                  onChange={(e) => {
                                    const val = Number(e.target.value) || 0
                                    if (b.id.startsWith('ocr-')) {
                                      setResults(res => res.map((rr, ii) => ii === parseInt(b.id.split('-')[1]!, 10) ? { ...rr, summary: { ...rr.summary, vat: val } } : rr))
                                    } else {
                                      setManualBills(prev => prev.map(mm => mm.id === b.id ? { ...mm, vat: val } : mm))
                                    }
                                  }}
                                  disabled={(b.id.startsWith('ocr-') ? results[parseInt(b.id.split('-')[1]!, 10)]?.vatIncluded : manualBills.find(m => m.id === b.id)?.vatIncluded)}
                                  className="w-20 rounded-xl border border-violet-100 bg-white px-2 py-1 text-xs text-right font-bold text-gray-700 outline-none focus:ring-2 focus:ring-violet-400 disabled:bg-gray-50 disabled:text-gray-400"
                                  placeholder="0"
                                />
                              </div>
                            </div>

                            {/* Discount */}
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-black text-pink-500 uppercase">Discount (-)</span>
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-pink-300">฿</span>
                                <input
                                  type="number"
                                  value={(b.id.startsWith('ocr-') ? (results[parseInt(b.id.split('-')[1]!, 10)]?.summary.billDiscount ?? results[parseInt(b.id.split('-')[1]!, 10)]?.summary.discount) : (manualBills.find(m => m.id === b.id)?.billDiscount ?? manualBills.find(m => m.id === b.id)?.discount)) || ''}
                                  onChange={(e) => {
                                    const val = Number(e.target.value) || 0
                                    if (b.id.startsWith('ocr-')) {
                                      setResults(res => res.map((rr, ii) => ii === parseInt(b.id.split('-')[1]!, 10) ? { ...rr, summary: { ...rr.summary, billDiscount: val, discount: val } } : rr))
                                    } else {
                                      setManualBills(prev => prev.map(mm => mm.id === b.id ? { ...mm, billDiscount: val, discount: val } : mm))
                                    }
                                  }}
                                  className="w-16 bg-transparent text-right font-black text-xs outline-none text-pink-600"
                                  placeholder="0"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="pt-3 mt-1 border-t-2 border-dashed border-gray-100 flex items-center justify-between">
                            <span className="text-[11px] font-black text-gray-700 uppercase">Calc. Total</span>
                            <span className={`text-base font-black tabular-nums ${isDiscrepant ? 'text-amber-500 animate-pulse' : 'text-emerald-500'}`}>
                              ฿{b.calculatedTotal.toFixed(2)}
                            </span>
                          </div>

                          {/* Payer Selector */}
                          <div className="mt-4 rounded-2xl border border-violet-100 bg-violet-50/80 p-3">
                             <div className="mb-2 flex items-center justify-between">
                               <div className="flex flex-col">
                                 <span className="text-[10px] font-black uppercase tracking-[0.2em] text-violet-700">ใครจ่ายเงินก้อนนี้?</span>
                                 <span className="text-[8px] font-medium italic leading-none text-violet-400">Payer of this bill</span>
                               </div>
                               <Receipt className="h-4 w-4 text-violet-300" />
                             </div>
                             <select
                               value={assignedId || ''}
                               onChange={(e) => {
                                 const newPayerId = e.target.value
                                 const oldPayerId = receiptPayerMap[b.id]
                                 if (oldPayerId === newPayerId) return
                                 setReceiptPayerMap(prev => ({ ...prev, [b.id]: newPayerId }))
                               }}
                               className="w-full appearance-none rounded-xl border-2 border-violet-100 bg-white px-3 py-2 text-sm font-black text-violet-700 shadow-sm outline-none transition-colors focus:border-violet-400"
                             >
                               <option value="">-- ยังไม่มีคนจ่าย --</option>
                               {members.map(m => (
                                 <option key={m.id} value={m.id}>{m.name}</option>
                               ))}
                             </select>
                          </div>
                        </div>
                      </div>
                    )
                  })}

                  {unifiedBills.length === 0 && (
                    <div className="py-12 text-center border-2 border-dashed border-gray-100 rounded-[32px] bg-white/50">
                      <Receipt className="h-8 w-8 text-gray-200 mx-auto mb-3" />
                      <p className="text-sm font-black text-gray-400 uppercase tracking-widest leading-tight">ยังไม่มีใบเสร็จ<br /><span className="text-[10px] font-bold text-gray-300">สแกนหรือเพิ่มบิลด้านบน</span></p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 3: Who paid? ── */}
        {items.length > 0 && (
          <SectionCard>
            <StepBadge n={3} label="ใครจ่ายไปแล้วเท่าไหร่?" />
            <p className="mb-3 -mt-2 text-[11px] leading-5 text-gray-400">กรอกยอดที่แต่ละคนจ่ายจริง หรือเลือกคนจ่ายจากบิลด้านบน</p>

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
                      value={totalPaidByMember[m.id] ?? 0}
                      onChange={(e) =>
                        setPaidByMember((prev) => ({ ...prev, [m.id]: Number(e.target.value) || 0 }))
                      }
                      className="w-28 rounded-xl border border-gray-200 px-3 py-2 text-right text-sm font-mono font-semibold tabular-nums outline-none focus:ring-2 focus:ring-violet-400"
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
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleExportImage}
                    className="flex items-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors"
                  >
                    <Share className="h-3 w-3" /> แชร์สลิปรูปภาพ
                  </button>
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
                    className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    {copiedId === 'copy-all-summary' ? (
                      <><span className="text-emerald-600">✓</span> คัดลอกแล้ว</>
                    ) : (
                      <><Copy className="h-3 w-3" /> คัดลอกสรุป</>
                    )}
                  </button>
                </div>
              )}
            </div>

            {(() => {
              const allPaid = settlements.length > 0 && settlements.every(s => settlementStatus[`${s.fromMemberId}-${s.toMemberId}`])
              const noSettlements = settlements.length === 0
              const paidSum = Object.values(totalPaidByMember).reduce((sum, amt) => sum + amt, 0)
              const missingPayer = noSettlements && paidSum < grandTotal - 0.01

              if (missingPayer) {
                return (
                  <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-center">
                    <p className="text-sm font-semibold text-amber-700">⚠️ โปรดระบุว่าใครเป็นคนจ่ายเงิน</p>
                    <p className="text-xs text-amber-600 mt-1">เพื่อให้ระบบคำนวณยอดโอนได้อย่างถูกต้อง</p>
                  </div>
                )
              }

              if (noSettlements || allPaid) {
                return (
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-center">
                    <div className="flex justify-center mb-1">
                      <div className="rounded-full bg-emerald-100 p-2">
                        <Check className="h-5 w-5 text-emerald-600" />
                      </div>
                    </div>
                    <p className="text-sm font-semibold text-emerald-700">🎉 ทุกคนเคลียร์แล้ว!</p>
                    <p className="text-xs text-emerald-500 mt-1">ไม่มีใครต้องโอนเพิ่ม {allPaid ? 'ได้รับยอดโอนครบทั้งบิลแล้ว' : ''}</p>
                    {allPaid && (
                      <button
                        onClick={() => setSettlementStatus({})}
                        className="mt-3 text-[10px] text-emerald-400 hover:text-emerald-600 underline"
                      >
                        รีเซ็ตสถานะการโอน
                      </button>
                    )}
                  </div>
                )
              }

              return (
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
                          <span className={`text-base font-bold shrink-0 ${settlementStatus[`${s.fromMemberId}-${s.toMemberId}`] ? 'text-gray-400 line-through' : 'text-violet-700'}`}>
                            ฿{s.amount.toFixed(2)}
                          </span>
                          <div className="flex gap-1 shrink-0">
                            <button
                              onClick={() => {
                                setSettlementStatus((prev) => {
                                  const key = `${s.fromMemberId}-${s.toMemberId}`
                                  return { ...prev, [key]: !prev[key] }
                                })
                              }}
                              className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${settlementStatus[`${s.fromMemberId}-${s.toMemberId}`]
                                  ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                }`}
                            >
                              {settlementStatus[`${s.fromMemberId}-${s.toMemberId}`] ? '✓ จ่ายแล้ว' : 'รอโอน'}
                            </button>
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
              )
            })()}

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

      {/* History Modal */}
      {isHistoryModalOpen && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-black/40 sm:justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-gray-100 p-4">
              <h3 className="text-lg font-bold text-gray-800">ประวัติบิล</h3>
              <button onClick={() => setIsHistoryModalOpen(false)} className="rounded-full p-2 text-gray-400 hover:bg-gray-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <button
                onClick={createNewBill}
                className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-violet-200 bg-violet-50 py-3 text-sm font-semibold text-violet-700 hover:bg-violet-100 transition-colors"
              >
                <Plus className="h-4 w-4" />
                สร้างบิลใหม่
              </button>

              {history.length === 0 ? (
                <div className="text-center text-sm text-gray-400 py-6">ยังไม่มีประวัติบิล</div>
              ) : (
                history.map((h) => (
                  <div key={h.id} className="flex items-center justify-between rounded-xl border border-gray-100 bg-white p-3 shadow-sm hover:border-violet-200 transition-colors">
                    <button onClick={() => loadHistoryBill(h.id)} className="flex-1 text-left min-w-0">
                      <p className={`text-sm font-semibold truncate ${h.id === currentBillId ? 'text-violet-600' : 'text-gray-800'}`}>
                        {h.title}
                        {h.id === currentBillId && <span className="ml-2 text-[10px] bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-md">เปิดอยู่</span>}
                      </p>
                      <p className="text-xs text-gray-400">{new Date(h.updatedAt).toLocaleString('th-TH')}</p>
                    </button>
                    <button
                      onClick={() => removeBill(h.id)}
                      className="ml-2 rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Manual Bill Modal */}
      {isManualBillModalOpen && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-black/40 sm:justify-center p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 p-4 bg-gray-50">
              <h3 className="text-base font-bold text-gray-800">เพิ่มยอดบิลเอง</h3>
              <button
                onClick={() => setIsManualBillModalOpen(false)}
                className="rounded-full p-2 text-gray-400 hover:bg-gray-200 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <label className="block">
                <span className="text-sm text-gray-600 mb-1 block">ชื่อบิล / รายการ</span>
                <input
                  value={newManualBillName}
                  onChange={(e) => setNewManualBillName(e.target.value)}
                  placeholder="เช่น ค่าข้าวร้านป้า, ค่าน้ำแข็ง"
                  className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-400"
                />
              </label>
              <label className="block">
                <span className="text-sm text-gray-600 mb-1 block">ยอดเงิน (บาท)</span>
                <div className="flex items-center gap-2">
                  <span className="text-gray-400">฿</span>
                  <input
                    type="number" min={0} step="0.01"
                    value={newManualBillAmount}
                    onChange={(e) => setNewManualBillAmount(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-400"
                  />
                </div>
              </label>

              <button
                onClick={() => {
                  const amt = Number(newManualBillAmount)
                  if (!newManualBillName.trim() || isNaN(amt) || amt <= 0) return
                  const newBill: ManualBill = {
                    id: crypto.randomUUID(),
                    name: newManualBillName.trim(),
                    amount: round2(amt),
                    serviceCharge: 0,
                    vat: 0,
                    itemDiscount: 0,
                    billDiscount: 0,
                    vatIncluded: false
                  }
                  setManualBills((prev) => [...prev, newBill])
                  setIsManualBillModalOpen(false)
                  setNewManualBillName('')
                  setNewManualBillAmount('')
                }}
                disabled={!newManualBillName.trim() || Number(newManualBillAmount) <= 0}
                className="w-full mt-2 rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
              >
                เพิ่มยอดบิล
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Group Modal */}
      {groupModalMode && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-black/40 sm:justify-center p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 p-4 bg-gray-50">
              <h3 className="text-base font-bold text-gray-800">
                {groupModalMode === 'save' ? 'บันทึกแก๊งนี้' : 'โหลดแก๊งประจำ'}
              </h3>
              <button onClick={() => setGroupModalMode(null)} className="rounded-full p-2 text-gray-400 hover:bg-gray-200 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4">
              {groupModalMode === 'save' ? (
                <div className="space-y-3">
                  <input
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="ตั้งชื่อแก๊ง (เช่น แก๊งออฟฟิศ, เพื่อนมหา'ลัย)"
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-400"
                  />
                  <button
                    onClick={() => {
                      if (!newGroupName.trim()) return
                      saveGroup(newGroupName, members.map(m => ({ name: m.name, promptPayId: m.promptPayId })))
                      setGroupModalMode(null)
                      setNewGroupName('')
                    }}
                    disabled={!newGroupName.trim()}
                    className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
                  >
                    บันทึกแก๊ง
                  </button>
                </div>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {groups.length === 0 ? (
                    <p className="text-center text-sm text-gray-500 py-4">ยังไม่เคยบันทึกแก๊งไหนไว้เลย</p>
                  ) : (
                    groups.map((g) => (
                      <div key={g.id} className="flex flex-col gap-1 rounded-xl border border-gray-100 p-3 hover:border-violet-200 transition-colors">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold text-gray-800">{g.name}</span>
                          <div className="flex gap-1">
                            <button
                              onClick={() => {
                                const loadedMembers = g.members.map((m, i) => ({
                                  id: crypto.randomUUID(),
                                  name: m.name,
                                  promptPayId: m.promptPayId || '',
                                  color: MEMBER_COLORS[i % MEMBER_COLORS.length]!
                                }))
                                setMembers(loadedMembers)
                                setGroupModalMode(null)
                              }}
                              className="rounded-lg bg-violet-50 text-violet-700 px-3 py-1.5 text-xs font-semibold hover:bg-violet-100 transition-colors"
                            >
                              เลือก
                            </button>
                            <button
                              onClick={() => deleteGroup(g.id)}
                              className="rounded-lg text-red-500 px-2 py-1.5 text-xs hover:bg-red-50 transition-colors"
                            >
                              ลบ
                            </button>
                          </div>
                        </div>
                        <span className="text-xs text-gray-500 line-clamp-1">{g.members.map(m => m.name).join(', ')}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Hidden Export Slip Container */}
      <div className="fixed top-[-9999px] left-[-9999px] z-[-1]">
        <div ref={exportImageRef} className="w-[380px] bg-[#f8f9fa] p-5 shadow-sm rounded-[24px]">
          {/* Header */}
          <div className="flex items-center gap-2 mb-4 justify-center">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-600 text-white">
              <Receipt className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-none text-gray-900">สรุปการหารบิล</h1>
              <p className="text-[10px] text-gray-400 leading-none mt-0.5">{new Date().toLocaleDateString('th-TH')}</p>
            </div>
          </div>

          <div className="rounded-xl bg-white p-4 shadow-sm border border-gray-100 mb-4">
            <h2 className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider text-center border-b border-dashed border-gray-200 pb-2">ใครต้องโอนใครบ้าง</h2>
            <div className="space-y-3">
              {settlements.map((s, idx) => {
                const from = members.find((m) => m.id === s.fromMemberId)
                const to = members.find((m) => m.id === s.toMemberId)
                if (!from || !to) return null
                return (
                  <div key={idx} className="flex flex-col gap-1.5 bg-gray-50 rounded-xl p-3 border border-gray-100">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 max-w-[60%]">
                        <span className="font-semibold text-gray-800 text-sm truncate">{from.name}</span>
                        <span className="text-[10px] bg-gray-200 text-gray-500 px-1.5 rounded-full">โอนให้</span>
                        <span className="font-semibold text-gray-800 text-sm truncate">{to.name}</span>
                      </div>
                      <span className="text-lg font-bold text-violet-700">฿{s.amount.toFixed(2)}</span>
                    </div>
                    {to.promptPayId && (
                      <div className="flex items-center justify-between bg-white rounded-lg p-2 mt-1 border border-violet-100 shrink-0 shadow-[0_2px_4px_rgba(0,0,0,0.02)]">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-semibold text-violet-600">พร้อมเพย์ของ {to.name}</span>
                          <span className="text-[11px] font-medium text-gray-600">{formatPromptPay(to.promptPayId)}</span>
                        </div>
                        {s.promptPayPayload && (
                          <div className="w-20 h-20 border border-gray-100 rounded-md overflow-hidden bg-white ml-2 flex-shrink-0">
                            <QrCode value={s.promptPayPayload} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="text-center text-[10px] text-gray-400 mt-2">
            สร้างด้วยแอป หารบิลกัน (Free & Offline)
          </div>
        </div>
      </div>
    </div>
  )

}

export default App
