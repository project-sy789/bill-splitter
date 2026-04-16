import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Camera,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  History,
  Image,
  Loader2,
  Plus,
  QrCode as QrCodeIcon,
  Receipt,
  Trash2,
  Upload,
  Users,
  X,
  Bookmark,
  BookmarkPlus,
  Share,
} from 'lucide-react'
import * as htmlToImage from 'html-to-image'

import { QrCode } from './components/qr-code'
import { useReceiptOcr } from './hooks/use-receipt-ocr'
import { useBillHistory } from './hooks/use-bill-history'
import { useGroups } from './hooks/use-groups'
import { buildPromptPayPayload, formatPromptPay, validatePromptPay, toPromptPayTarget } from './lib/promptpay'
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
  const currentId = localStorage.getItem('bill-splitter-current-id')
  const initialState = safeParseBillState(
    currentId ? localStorage.getItem(`bill-splitter-state-${currentId}`) : localStorage.getItem('bill-splitter-state')
  ) || safeParseBillState(localStorage.getItem('bill-splitter-state'))

  // ── State ──
  const [currentBillId, setCurrentBillId] = useState<string>(currentId ?? crypto.randomUUID())
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
  const [serviceCharge, setServiceCharge] = useState(initialState?.serviceCharge ?? 0)
  const [vat, setVat] = useState(initialState?.vat ?? 0)
  const [discount, setDiscount] = useState(initialState?.discount ?? 0)
  const [allocationMode, setAllocationMode] = useState<AllocationMode>(initialState?.allocationMode ?? 'proportional')
  const [paidByMember, setPaidByMember] = useState<Record<string, number>>(initialState?.paidByMember ?? {})
  const [settlementStatus, setSettlementStatus] = useState<Record<string, boolean>>(initialState?.settlementStatus ?? {})
  const [manualBills, setManualBills] = useState<ManualBill[]>(initialState?.manualBills ?? [])
  const [vatMode, setVatMode] = useState<'exclusive' | 'inclusive'>('exclusive')
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

  // ── Persist to localStorage ──
  useEffect(() => {
    const state: PersistedBillState = { members, items, serviceCharge, vat, discount, allocationMode, paidByMember, settlementStatus, manualBills, receiptPayerMap }
    localStorage.setItem(`bill-splitter-state-${currentBillId}`, JSON.stringify(state))
    localStorage.setItem('bill-splitter-current-id', currentBillId)
    
    // Auto-save history if the bill has any meaningful data
    if (items.length > 0 || members.length > 2 || Object.keys(paidByMember).length > 0 || manualBills.length > 0) {
      addOrUpdateBill(currentBillId, `บิลวันที่ ${new Date().toLocaleDateString('th-TH')} - ยอด ฿${(items.reduce((sum, item) => sum + item.amount, 0) + serviceCharge + vat - discount).toFixed(2)}`)
    }
  }, [members, items, serviceCharge, vat, discount, allocationMode, paidByMember, settlementStatus, manualBills, receiptPayerMap, currentBillId, addOrUpdateBill])



  // Merge OCR results into items list when mergedItems changes
  const prevMergedLenRef = useRef(0)
  const prevResultsLenRef = useRef(0)
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

  const unifiedBills = useMemo(() => [
    ...results.map((r, i) => {
      const bId = `ocr-${i}`
      const activeItemsCount = items.filter(it => it.billId === bId).length
      return {
        id: bId,
        title: `สลิป ${i + 1}`,
        subtitle: `${activeItemsCount} รายการ${r.vatIncluded ? ' (VAT รวมแล้ว)' : ''}`,
        amount: r.summary.total ?? r.items.reduce((s, it) => s + it.amount, 0),
      }
    }),
    ...manualBills.map((m) => {
      const activeItemsCount = items.filter(it => it.billId === m.id).length
      return {
        id: m.id,
        title: m.name,
        subtitle: activeItemsCount > 0 ? `${activeItemsCount} รายการ` : 'ยอดใส่เอง',
        amount: m.amount,
      }
    })
  ], [results, manualBills, items])

  const unifiedBillsSum = useMemo(() => round2(unifiedBills.reduce((s, b) => s + b.amount, 0)), [unifiedBills])

  const normalizedPaid = useMemo(() => {
    const out: Record<string, number> = {}
    members.forEach((m) => {
      const ex = paidByMember[m.id]
      out[m.id] = typeof ex === 'number' ? ex : 0
    })
    return out
  }, [members, paidByMember])

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
        
        const payerId = receiptPayerMap[oldItem.billId]
        if (payerId) {
          setPaidByMember(payers => ({ ...payers, [payerId]: Math.max(0, round2((payers[payerId] || 0) + diff)) }))
        }
      }
    }
    setItems((prev) => prev.map((item) => item.id === itemId ? { ...item, [field]: value } : item))
  }, [items, setResults, receiptPayerMap])

  const removeItem = useCallback((id: string) => {
    const itemToDelete = items.find((item) => item.id === id)
    if (itemToDelete && itemToDelete.billId) {
      if (itemToDelete.billId.startsWith('ocr-')) {
        const ocrIdx = parseInt(itemToDelete.billId.split('-')[1]!, 10)
        setResults(res => res.map((r, i) => i === ocrIdx ? { ...r, summary: { ...r.summary, total: round2((r.summary.total || 0) - itemToDelete.amount) } } : r))
      } else {
        setManualBills(prev => prev.map(m => m.id === itemToDelete.billId ? { ...m, amount: Math.max(0, round2(m.amount - itemToDelete.amount)) } : m))
      }
      
      const payerId = receiptPayerMap[itemToDelete.billId]
      if (payerId) {
        setPaidByMember(payers => ({ ...payers, [payerId]: Math.max(0, round2((payers[payerId] || 0) - itemToDelete.amount)) }))
      }
    }
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [items, setResults, receiptPayerMap])

  const addManualItem = useCallback((billId?: string) => {
    const item = makeNewItem(members)
    if (billId) item.billId = billId
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
    const blob = new Blob([JSON.stringify({ members, items, serviceCharge, vat, discount, allocationMode, paidByMember, settlementStatus, manualBills, receiptPayerMap }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: `บิล-${Date.now()}.json` }).click()
    URL.revokeObjectURL(url)
  }, [members, items, serviceCharge, vat, discount, allocationMode, paidByMember, settlementStatus, manualBills, receiptPayerMap])

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
    setSettlementStatus(data.settlementStatus ?? {})
    setManualBills(data.manualBills ?? [])
    setReceiptPayerMap(data.receiptPayerMap ?? {})
    reset()
  }, [reset])

  const resetAll = useCallback(() => {
    setItems([])
    setServiceCharge(0)
    setVat(0)
    setDiscount(0)
    setPaidByMember({})
    setSettlementStatus({})
    setManualBills([])
    setReceiptPayerMap({})
    setVatMode('exclusive')
    reset()
    prevMergedLenRef.current = 0
    prevResultsLenRef.current = 0
  }, [reset])

  const loadHistoryBill = useCallback((id: string) => {
    let dataStr = localStorage.getItem(`bill-splitter-state-${id}`)
    if (!dataStr && id === localStorage.getItem('bill-splitter-current-id') && localStorage.getItem('bill-splitter-state')) {
      dataStr = localStorage.getItem('bill-splitter-state') // fallback for migration
    }
    if (!dataStr) return
    const data = safeParseBillState(dataStr)
    if (!data) return
    setCurrentBillId(id)
    setMembers(data.members)
    setItems(data.items)
    setServiceCharge(data.serviceCharge ?? 0)
    setVat(data.vat ?? 0)
    setDiscount(data.discount ?? 0)
    setAllocationMode(data.allocationMode ?? 'proportional')
    setPaidByMember(data.paidByMember ?? {})
    setSettlementStatus(data.settlementStatus ?? {})
    setManualBills(data.manualBills ?? [])
    setReceiptPayerMap(data.receiptPayerMap ?? {})
    setVatMode('exclusive')
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
    setServiceCharge(0)
    setVat(0)
    setDiscount(0)
    setPaidByMember({})
    setSettlementStatus({})
    setManualBills([])
    setReceiptPayerMap({})
    setVatMode('exclusive')
    reset()
    prevMergedLenRef.current = 0
    prevResultsLenRef.current = 0
    setIsHistoryModalOpen(false)
  }, [reset])

  // ──────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-sky-50">
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
              onClick={() => setIsHistoryModalOpen(true)}
              className="rounded-xl border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 transition-colors"
              title="ประวัติบิล"
            >
              <History className="h-4 w-4" />
            </button>
            <button
              onClick={triggerImportUpload}
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
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-5 pb-16">

        {/* ── STEP 1: คนหาร ── */}
        <SectionCard>
          <div className="flex justify-between items-center mb-4">
            <StepBadge n={1} label="ใส่ชื่อคนที่จะหารบิล" />
            <div className="flex gap-2">
              <button onClick={() => setGroupModalMode('save')} className="text-xs text-violet-600 bg-violet-50 hover:bg-violet-100 flex items-center gap-1 px-2 py-1.5 rounded-lg font-medium transition-colors border border-violet-100">
                <BookmarkPlus className="w-3.5 h-3.5"/> บันทึกแก๊ง
              </button>
              <button onClick={() => setGroupModalMode('load')} className="text-xs text-violet-600 bg-violet-50 hover:bg-violet-100 flex items-center gap-1 px-2 py-1.5 rounded-lg font-medium transition-colors border border-violet-100">
                <Bookmark className="w-3.5 h-3.5"/> โหลดแก๊ง
              </button>
            </div>
          </div>

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
                    onChange={(e) => updateMember(member.id, 'promptPayId', formatPromptPay(e.target.value))}
                    placeholder="เบอร์โทร 10 หลัก (ถ้ามี)"
                    className={`flex-1 rounded-lg border bg-white px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-violet-400 ${!validatePromptPay(member.promptPayId) ? 'border-red-300 text-red-600 focus:border-red-500 focus:ring-red-200' : 'border-gray-200'}`}
                  />
                </div>
                {!validatePromptPay(member.promptPayId) && (
                  <p className="pl-9 mt-1 text-[10px] text-red-500 font-medium">เบอร์ต้องมี 10 หรือ 13 หลัก</p>
                )}
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
              onClick={() => addManualItem()}
              className="flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 transition-colors"
            >
              <Plus className="h-4 w-4" />
              เพิ่มรายการ
            </button>
            <button
              onClick={() => cameraInputRef.current?.click()}
              disabled={isBusy}
              className="flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-50 transition-colors"
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
              {isBusy ? 'กำลังสแกน...' : 'ถ่ายบิลเลย'}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
              className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Image className="h-4 w-4" />}
              {isBusy ? 'กำลังสแกน...' : 'เลือกรูปจากคลัง'}
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
              onClick={() => {
                if (manualBills.length > 0 || results.length > 0) addManualItem()
                else cameraInputRef.current?.click()
              }}
              onKeyDown={(e) => { 
                if (e.key === 'Enter' || e.key === ' ') {
                  if (manualBills.length > 0 || results.length > 0) addManualItem()
                  else cameraInputRef.current?.click()
                }
              }}
              className="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-gray-200 py-10 text-center transition hover:border-violet-300 hover:bg-violet-50/50"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
                {manualBills.length > 0 || results.length > 0 ? (
                  <Plus className="h-6 w-6 text-violet-500" />
                ) : (
                  <Camera className="h-6 w-6 text-gray-400" />
                )}
              </div>
              <div>
                {manualBills.length > 0 || results.length > 0 ? (
                  <>
                    <p className="font-semibold text-gray-700">ใส่ยอดจ่ายแล้ว ต้องเพิ่มรายการด้วย!</p>
                    <p className="text-sm text-gray-400">กดที่นี่เพื่อเพิ่มรายการว่า <b>มีค่าอะไรบ้าง</b> และ <b>ใครเป็นคนกิน</b></p>
                  </>
                ) : (
                  <>
                    <p className="font-semibold text-gray-700">ถ่ายหรืออัปโหลดรูปสลิป</p>
                    <p className="text-sm text-gray-400">สแกนอัตโนมัติ หรือกดเพิ่มรายการเพื่อระบุเองได้ทันที</p>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {unifiedBills.map((bill) => {
                const billItems = items.filter(i => i.billId === bill.id)
                // If there are no items and it's a manual bill, it might just be someone typing a total. But we show the group anyway so they can add items.
                return (
                  <div key={bill.id} className="space-y-2.5">
                    <div className="flex items-end justify-between border-b border-gray-100 pb-2 px-1">
                       <h3 className="text-sm font-bold text-gray-700">{bill.title}</h3>
                       <span className="text-xs font-semibold text-violet-600">ยอดบิล {bill.amount.toFixed(2)} ฿</span>
                    </div>
                    {billItems.map((item) => {
                      const split = calcItemSplit(item, members)
                      const isExpanded = expandedItems.has(item.id)
                      const pctSum = item.consumerIds.reduce((s, id) => s + (item.percentageByUser[id] ?? 0), 0)
                      const exactSum = item.consumerIds.reduce((s, id) => s + (item.exactByUser[id] ?? 0), 0)

                      return (
                        <div key={item.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
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

                          {/* Expanded options */}
                          {isExpanded && (
                            <div className="border-t border-gray-100 bg-gray-50/50 p-3 space-y-3">
                              {/* Split Mode toggle */}
                              <div className="flex rounded-lg bg-gray-100/80 p-0.5">
                                <button
                                  onClick={() => updateItem(item.id, 'splitMode', 'equally')}
                                  className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
                                    item.splitMode === 'equally' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                                  }`}
                                >
                                  หารเท่า
                                </button>
                                <button
                                  onClick={() => updateItem(item.id, 'splitMode', 'percentage')}
                                  className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
                                    item.splitMode === 'percentage' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                                  }`}
                                >
                                  % สัดส่วน
                                </button>
                                <button
                                  onClick={() => updateItem(item.id, 'splitMode', 'exact')}
                                  className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
                                    item.splitMode === 'exact' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                                  }`}
                                >
                                  ระบุยอดเอง
                                </button>
                              </div>

                              {/* Split input controls */}
                              {item.splitMode === 'percentage' && (
                                <div className="space-y-2">
                                  {item.consumerIds.map((cid) => {
                                    const m = members.find((x) => x.id === cid)
                                    if (!m) return null
                                    return (
                                      <label key={cid} className="flex items-center justify-between gap-2">
                                        <span className="text-xs text-gray-600">{m.name}</span>
                                        <div className="flex items-center gap-1">
                                          <input
                                            type="number"
                                            min={0}
                                            step="1"
                                            value={item.percentageByUser[cid] ?? ''}
                                            onChange={(e) =>
                                              updateItem(item.id, 'percentageByUser', {
                                                ...item.percentageByUser,
                                                [cid]: Number(e.target.value) || 0,
                                              })
                                            }
                                            className="w-16 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-right text-sm outline-none focus:ring-2 focus:ring-violet-400"
                                          />
                                          <span className="text-xs text-gray-400">%</span>
                                        </div>
                                      </label>
                                    )
                                  })}
                                  <p className={`text-xs mt-1 ${Math.abs(pctSum - 100) < 0.1 ? 'text-emerald-600' : 'text-amber-600'}`}>
                                    รวม {pctSum.toFixed(2)}% {Math.abs(pctSum - 100) < 0.1 ? '✓' : '(ไม่ถึง 100%)'}
                                  </p>
                                </div>
                              )}

                              {item.splitMode === 'exact' && (
                                <div className="space-y-2">
                                  {item.consumerIds.map((cid) => {
                                    const m = members.find((x) => x.id === cid)
                                    if (!m) return null
                                    return (
                                      <label key={cid} className="flex items-center justify-between gap-2">
                                        <span className="text-xs text-gray-600">{m.name}</span>
                                        <div className="flex items-center gap-1">
                                          <span className="text-xs text-gray-400">฿</span>
                                          <input
                                            type="number"
                                            min={0}
                                            step="0.01"
                                            value={item.exactByUser[cid] ?? ''}
                                            onChange={(e) =>
                                              updateItem(item.id, 'exactByUser', {
                                                ...item.exactByUser,
                                                [cid]: Number(e.target.value) || 0,
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
                    
                    <button
                      onClick={() => addManualItem(bill.id)}
                      className="flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-200 bg-gray-50/50 py-2.5 text-xs font-semibold text-gray-400 transition hover:border-violet-300 hover:text-violet-600 hover:bg-violet-50/50"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      เพิ่มรายการใน {bill.title}
                    </button>
                  </div>
                )
              })}

              {(() => {
                const unassignedItems = items.filter(i => !i.billId)
                if (unassignedItems.length === 0 && unifiedBills.length > 0) return null
                return (
                  <div className="space-y-2.5">
                    {unifiedBills.length > 0 && (
                      <div className="flex items-end justify-between border-b border-gray-100 pb-2 px-1 mt-4">
                        <h3 className="text-sm font-bold text-gray-700">รายการอื่นๆ (ไม่มีบิล)</h3>
                      </div>
                    )}
                    {unassignedItems.map((item) => {
                      const split = calcItemSplit(item, members)
                      const isExpanded = expandedItems.has(item.id)
                      const pctSum = item.consumerIds.reduce((s, id) => s + (item.percentageByUser[id] ?? 0), 0)
                      const exactSum = item.consumerIds.reduce((s, id) => s + (item.exactByUser[id] ?? 0), 0)

                      return (
                        <div key={item.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
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

                          {/* Expanded options */}
                          {isExpanded && (
                            <div className="border-t border-gray-100 bg-gray-50/50 p-3 space-y-3">
                              {/* Split Mode toggle */}
                              <div className="flex rounded-lg bg-gray-100/80 p-0.5">
                                <button
                                  onClick={() => updateItem(item.id, 'splitMode', 'equally')}
                                  className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
                                    item.splitMode === 'equally' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                                  }`}
                                >
                                  หารเท่า
                                </button>
                                <button
                                  onClick={() => updateItem(item.id, 'splitMode', 'percentage')}
                                  className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
                                    item.splitMode === 'percentage' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                                  }`}
                                >
                                  % สัดส่วน
                                </button>
                                <button
                                  onClick={() => updateItem(item.id, 'splitMode', 'exact')}
                                  className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
                                    item.splitMode === 'exact' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                                  }`}
                                >
                                  ระบุยอดเอง
                                </button>
                              </div>

                              {/* Split input controls */}
                              {item.splitMode === 'percentage' && (
                                <div className="space-y-2">
                                  {item.consumerIds.map((cid) => {
                                    const m = members.find((x) => x.id === cid)
                                    if (!m) return null
                                    return (
                                      <label key={cid} className="flex items-center justify-between gap-2">
                                        <span className="text-xs text-gray-600">{m.name}</span>
                                        <div className="flex items-center gap-1">
                                          <input
                                            type="number"
                                            min={0}
                                            step="1"
                                            value={item.percentageByUser[cid] ?? ''}
                                            onChange={(e) =>
                                              updateItem(item.id, 'percentageByUser', {
                                                ...item.percentageByUser,
                                                [cid]: Number(e.target.value) || 0,
                                              })
                                            }
                                            className="w-16 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-right text-sm outline-none focus:ring-2 focus:ring-violet-400"
                                          />
                                          <span className="text-xs text-gray-400">%</span>
                                        </div>
                                      </label>
                                    )
                                  })}
                                  <p className={`text-xs mt-1 ${Math.abs(pctSum - 100) < 0.1 ? 'text-emerald-600' : 'text-amber-600'}`}>
                                    รวม {pctSum.toFixed(2)}% {Math.abs(pctSum - 100) < 0.1 ? '✓' : '(ไม่ถึง 100%)'}
                                  </p>
                                </div>
                              )}

                              {item.splitMode === 'exact' && (
                                <div className="space-y-2">
                                  {item.consumerIds.map((cid) => {
                                    const m = members.find((x) => x.id === cid)
                                    if (!m) return null
                                    return (
                                      <label key={cid} className="flex items-center justify-between gap-2">
                                        <span className="text-xs text-gray-600">{m.name}</span>
                                        <div className="flex items-center gap-1">
                                          <span className="text-xs text-gray-400">฿</span>
                                          <input
                                            type="number"
                                            min={0}
                                            step="0.01"
                                            value={item.exactByUser[cid] ?? ''}
                                            onChange={(e) =>
                                              updateItem(item.id, 'exactByUser', {
                                                ...item.exactByUser,
                                                [cid]: Number(e.target.value) || 0,
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
                    
                    <button
                      onClick={() => addManualItem()}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-3 text-sm font-semibold text-gray-400 transition hover:border-violet-300 hover:text-violet-600 hover:bg-violet-50/50"
                    >
                      <Plus className="h-4 w-4" />
                      เพิ่มรายการอิสระ
                    </button>
                  </div>
                )
              })()}
            </div>
          )}

          {/* Charges summary */}
          {items.length > 0 && (
            <div className="mt-4 rounded-xl bg-gray-50 border border-gray-100 p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {/* ค่าบริการ */}
                <label className="block">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">ค่าบริการ</span>
                    <button
                      type="button"
                      onClick={() => setServiceCharge(round2(items.reduce((sum, item) => sum + item.amount, 0) * 0.1))}
                      className="text-[10px] px-1.5 py-0.5 rounded-full font-medium transition-colors bg-violet-100 text-violet-600 border border-violet-200 hover:bg-violet-200"
                    >
                      +10%
                    </button>
                  </div>
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
                    {vatMode === 'exclusive' && (
                      <button
                        type="button"
                        onClick={() => setVat(round2((items.reduce((sum, item) => sum + item.amount, 0) + serviceCharge - discount) * 0.07))}
                        className="text-[10px] px-1.5 py-0.5 rounded-full font-medium transition-colors bg-violet-100 text-violet-600 border border-violet-200 hover:bg-violet-200 ml-1"
                      >
                        +7%
                      </button>
                    )}
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

        {/* ── Discrepancy Warning ── */}
        {(unifiedBillsSum > 0 || grandTotal > 0) && Math.abs(unifiedBillsSum - grandTotal) > 0.01 && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-amber-100 p-1.5 shrink-0">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-bold text-amber-800">ยอดบิลไม่ตรงกับยอดรายการ</h4>
                <p className="mt-1 text-[11px] xs:text-xs text-amber-700 leading-relaxed">
                  ยอดรวมในบิลคือ <b>฿{unifiedBillsSum.toFixed(2)}</b> แต่รวมรายการด้านบนได้ <b>฿{grandTotal.toFixed(2)}</b>
                  <br className="hidden xs:block" />
                  {unifiedBillsSum > grandTotal ? '(อาจเกิดจากสแกนตกหล่น หรือบวกแค่ยอดรวมแต่ไม่พิมพ์รายการ)' : '(อาจเกิดจากพิมพ์รายการเกิน หรือไม่ได้กดยกยอดจ่ายบิลเพิ่มเข้าไป)'}
                </p>
                
                {unifiedBillsSum > grandTotal ? (
                  <button
                    onClick={() => {
                      const diff = round2(unifiedBillsSum - grandTotal)
                      setItems((prev) => [
                        ...prev,
                        {
                          id: crypto.randomUUID(),
                          name: 'ส่วนต่างบัญชี / สแกนไม่ครบ',
                          amount: Math.abs(diff),
                          splitMode: 'equally',
                          consumerIds: members.map((m) => m.id),
                          percentageByUser: Object.fromEntries(members.map((m) => [m.id, round2(100 / Math.max(members.length, 1))])),
                          exactByUser: Object.fromEntries(members.map((m) => [m.id, round2(Math.abs(diff) / Math.max(members.length, 1))])),
                        },
                      ])
                    }}
                    className="mt-3 flex items-center gap-1.5 rounded-lg bg-amber-200/50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-200 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    เพิ่มส่วนต่าง (฿{Math.abs(unifiedBillsSum - grandTotal).toFixed(2)}) ลงในรายการให้ที
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      const diff = round2(grandTotal - unifiedBillsSum)
                      setManualBills((prev) => [
                        ...prev,
                        {
                          id: crypto.randomUUID(),
                          name: 'ส่วนเกินบัญชี / บิลที่จ่ายตกหล่น',
                          amount: Math.abs(diff),
                        },
                      ])
                    }}
                    className="mt-3 flex items-center gap-1.5 rounded-lg bg-amber-200/50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-200 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    เพิ่มเป็นยอดบิลใส่เอง (฿{Math.abs(grandTotal - unifiedBillsSum).toFixed(2)})
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Scanned & Manual receipts payer assignment ── */}
        {(results.length > 0 || manualBills.length > 0 || !isBusy) && (
          <SectionCard>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-violet-500" />
                <span className="text-sm font-semibold text-gray-800">ใบเสร็จ & ยอดจ่าย ({results.length + manualBills.length})</span>
                <span className="text-[10px] sm:text-xs text-gray-400 ml-1 hidden xs:inline">— ยอดจะไปรวมในกล่องใครจ่ายอัตโนมัติ</span>
              </div>
              <button
                onClick={() => setIsManualBillModalOpen(true)}
                className="text-[10px] sm:text-xs font-semibold text-violet-600 bg-violet-50 hover:bg-violet-100 px-2 py-1.5 sm:px-2.5 rounded-lg border border-violet-100 transition-colors flex items-center gap-1 shrink-0"
              >
                <Plus className="h-3 w-3" /> เพิ่มยอดบิลเอง
              </button>
            </div>
            
            {unifiedBills.length === 0 ? (
              <div className="text-center text-xs text-gray-400 py-3">ยังไม่มีบิล กดเพิ่มยอดบิลเอง หรือถ่ายรูปสลิป</div>
            ) : (
              <div className="space-y-2">
                {unifiedBills.map((b) => {
                  const assignedId = receiptPayerMap[b.id]
                  return (
                    <div key={b.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-600 truncate">
                          {b.title} — {b.subtitle}
                        </p>
                        <p className="text-sm font-bold text-violet-700">฿{b.amount.toFixed(2)}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select
                          value={assignedId ?? ''}
                          onChange={(e) => {
                            const newPayerId = e.target.value
                            const oldPayerId = receiptPayerMap[b.id]
                            if (oldPayerId === newPayerId) return

                            // Update paid amounts immediately without needing a button
                            setPaidByMember((prev) => {
                              const next = { ...prev }
                              if (oldPayerId) {
                                next[oldPayerId] = Math.max(0, round2((next[oldPayerId] ?? 0) - b.amount))
                              }
                              if (newPayerId) {
                                next[newPayerId] = round2((next[newPayerId] ?? 0) + b.amount)
                              }
                              return next
                            })

                            setReceiptPayerMap((prev) => ({ ...prev, [b.id]: newPayerId }))
                          }}
                          className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-violet-400"
                        >
                          <option value="">ใครจ่าย?</option>
                          {members.map((m) => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>

                        {!b.id.startsWith('ocr-') && (
                          <button
                            onClick={() => {
                              const payerId = receiptPayerMap[b.id]
                              if (payerId) {
                                setPaidByMember(payers => ({ ...payers, [payerId]: Math.max(0, round2((payers[payerId] || 0) - b.amount)) }))
                                setReceiptPayerMap(prev => { const next = {...prev}; delete next[b.id]; return next })
                              }
                              setManualBills(prev => prev.filter(m => m.id !== b.id))
                            }}
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                            title="ลบสลิป/บิลนี้"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </SectionCard>
        )}

        {/* ── STEP 3: Who paid? ── */}
        {items.length > 0 && (
          <SectionCard>
            <StepBadge n={3} label="ใครจ่ายไปแล้วเท่าไหร่?" />
            <p className="mb-3 -mt-2 text-xs text-gray-400">ใส่ยอดที่แต่ละคนจ่ายไปแล้ว หรือเลือกคนจ่ายจากบิลด้านบน</p>

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
                            className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${
                              settlementStatus[`${s.fromMemberId}-${s.toMemberId}`]
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
                  const newBill = { id: crypto.randomUUID(), name: newManualBillName.trim(), amount: round2(amt) }
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

  function triggerImportUpload() {
    importInputRef.current?.click()
  }
}

export default App
