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
  Trash2,
  Upload,
  Users,
  X,
  Bookmark,
  BookmarkPlus,
  Share,
  Check,
  AlertCircle,
  Lock,
  Unlock,
} from 'lucide-react'
import * as htmlToImage from 'html-to-image'

import { QrCode } from './components/qr-code'
import { BillCard } from './components/bill-card'
import { useReceiptOcr } from './hooks/use-receipt-ocr'
import { useBillHistory, type BillHistoryMeta } from './hooks/use-bill-history'
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
import { initLiff, login, logout, shareBillToFriends, type LineProfile } from './lib/liff'
import liff from '@line/liff'
import { subscribeToBill, fetchBillById, updateBillData, logUsage, fetchUsageStats, fetchRemoteAffiliateLinks, deleteBill } from './lib/supabase'
import { getRandomAffiliateLink, USAGE_LIMITS } from './config/affiliate'
import { ShoppingBag } from 'lucide-react'

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface Settlement {
  fromMemberId: string
  toMemberId: string
  amount: number
  promptPayPayload: string | null
}

interface AffiliateLink {
  url: string;
  image_url?: string;
  description?: string;
  price_text?: string;
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
  const [lineProfile, setLineProfile] = useState<LineProfile | null>(null)

  useEffect(() => {
    initLiff().then(profile => setLineProfile(profile))
  }, [])

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

  const [remoteUpdating, setRemoteUpdating] = useState(false)
  const [billIdFromUrl] = useState(() => new URLSearchParams(window.location.search).get('billId'))
  const [isBillOwner, setIsBillOwner] = useState(false)
  const [isLocked, setIsLocked] = useState(false)
  const [usageStats, setUsageStats] = useState({ daily: 0, weekly: 0 })
  const [showLimitModal, setShowLimitModal] = useState(false)
  const [randomLink, setRandomLink] = useState('')
  const [randomAd, setRandomAd] = useState<AffiliateLink | null>(null)
  const [isTemporarilyUnlocked, setIsTemporarilyUnlocked] = useState(false)
  const [remoteLinks, setRemoteLinks] = useState<AffiliateLink[]>([])
  const [isInitialLoadFinished, setIsInitialLoadFinished] = useState(false)

  // ── Usage Tracking Effect ──
  useEffect(() => {
    if (lineProfile) {
      fetchUsageStats(lineProfile.userId).then(setUsageStats)
    }
    // Fetch affiliate links from Supabase
    fetchRemoteAffiliateLinks().then((links: any[]) => {
      if (links.length > 0) {
        // Enhance links: parse if they look like the Shopee message pattern
        const enhanced = links.map((item: any) => {
          if (typeof item.url === 'string' && item.url.includes('ลองดู')) {
            const urlMatch = item.url.match(/https:\/\/s\.shopee\.co\.th\/[a-zA-Z0-9]+/);
            const descMatch = item.url.match(/ลองดู (.*) ในราคา/);
            const priceMatch = item.url.match(/ในราคา (.*) ที่ Shopee/);
            
            return {
              ...item,
              url: urlMatch ? urlMatch[0] : item.url,
              description: item.description || (descMatch ? descMatch[1] : ''),
              price_text: item.price_text || (priceMatch ? priceMatch[1] : '')
            };
          }
          return item as AffiliateLink;
        });
        setRemoteLinks(enhanced);
      }
    })
  }, [lineProfile])

  const checkAndRecordUsage = async (action: string) => {
    if (!lineProfile) return true
    
    // If user just clicked Shopee, let them pass once
    if (isTemporarilyUnlocked) {
      setIsTemporarilyUnlocked(false)
      logUsage(lineProfile.userId, action) // Log in background
      return true
    }

    // Use pre-loaded stats to avoid 'await' before input click
    if (usageStats.daily >= USAGE_LIMITS.DAILY || usageStats.weekly >= USAGE_LIMITS.WEEKLY) {
      if (remoteLinks.length > 0) {
        const pick = { ...remoteLinks[Math.floor(Math.random() * remoteLinks.length)] }
        
        if (!pick.image_url && pick.url.startsWith('http')) {
          const workerUrl = import.meta.env.VITE_OCR_WORKER_URL || '';
          fetch(`${workerUrl}/unfurl?url=${encodeURIComponent(pick.url)}`)
            .then(res => res.json())
            .then(data => {
              if (data.image) {
                setRandomAd(prev => (prev?.url === pick.url ? { ...prev, image_url: data.image } : prev));
              }
            }).catch(() => {});
        }

        setRandomAd(pick)
        setRandomLink(pick.url)
      } else {
        setRandomAd(null)
        setRandomLink(getRandomAffiliateLink())
      }
      setShowLimitModal(true)
      return false
    }

    logUsage(lineProfile.userId, action) // Log in background
    return true
  }

  // ── Collaborative Sync Effect ──
  useEffect(() => {
    if (!billIdFromUrl) {
      setIsBillOwner(true) // New bills are owned by the creator
      return
    }

    const setupSync = async () => {
      const dbBill = await fetchBillById(billIdFromUrl)
      if (dbBill) {
        // Check ownership
        if (lineProfile && dbBill.user_id === lineProfile.userId) {
          setIsBillOwner(true)
        } else {
          setIsBillOwner(false)
        }

        console.log('Successfully fetched bill data:', dbBill.bill_data)

        // Load initial state from cloud
        const state = dbBill.bill_data as PersistedBillState
        if (state) {
          setIsLocked(state.isLocked || false)
          if (state.members) setMembers(state.members)
          if (state.items) setItems(state.items)
          if (state.allocationMode) setAllocationMode(state.allocationMode)
          if (state.paidByMember) setPaidByMember(state.paidByMember)
          if (state.settlementStatus) setSettlementStatus(state.settlementStatus || {})
          if (state.manualBills) setManualBills(state.manualBills || [])
          if (state.receiptPayerMap) setReceiptPayerMap(state.receiptPayerMap || {})
        }
      } else {
        console.warn('No bill found with ID:', billIdFromUrl)
      }
      setIsInitialLoadFinished(true)

      // Subscribe to real-time updates
      const unsubscribe = subscribeToBill(billIdFromUrl, (newState: any) => {
        console.log('Real-time update received:', newState)
        setRemoteUpdating(true)
        if (newState.isLocked !== undefined) setIsLocked(newState.isLocked)
        if (newState.members) setMembers(newState.members)
        if (newState.items) setItems(newState.items)
        if (newState.allocationMode) setAllocationMode(newState.allocationMode)
        if (newState.paidByMember) setPaidByMember(newState.paidByMember)
        if (newState.settlementStatus) setSettlementStatus(newState.settlementStatus)
        if (newState.manualBills) setManualBills(newState.manualBills)
        if (newState.receiptPayerMap) setReceiptPayerMap(newState.receiptPayerMap)
        setTimeout(() => setRemoteUpdating(false), 200)
      })

      return unsubscribe
    }

    const unsubPromise = setupSync()
    return () => {
      unsubPromise.then(unsub => unsub && unsub())
    }
  }, [billIdFromUrl, lineProfile])

  // If it's a new bill (no ID in URL), we consider initial load finished immediately
  useEffect(() => {
    if (!billIdFromUrl) setIsInitialLoadFinished(true)
  }, [billIdFromUrl])

  // ── Auto-fill LINE Profile Effect ──
  useEffect(() => {
    if (lineProfile && lineProfile.displayName) {
      setMembers(prev => {
        const newMembers = [...prev]
        if (newMembers.length > 0 && (newMembers[0].name === '' || newMembers[0].name === 'ฉัน')) {
          newMembers[0] = { 
            ...newMembers[0], 
            name: lineProfile.displayName, 
            pictureUrl: lineProfile.pictureUrl || '' 
          }
          return newMembers
        }
        return prev
      })
    }
  }, [lineProfile])

  const { history, addOrUpdateBill, removeBill } = useBillHistory(lineProfile?.userId)
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false)
  
  // Only use local initial state if NOT loading a shared bill
  const shouldLoadLocal = !billIdFromUrl
  const effectiveInitialState = shouldLoadLocal ? initialState : null

  const [members, setMembers] = useState<MemberDraft[]>(
    effectiveInitialState?.members ?? [
      { id: crypto.randomUUID(), name: 'ฉัน', color: MEMBER_COLORS[0]!, promptPayId: '' },
      { id: crypto.randomUUID(), name: 'เพื่อน', color: MEMBER_COLORS[1]!, promptPayId: '' },
    ],
  )
  const [items, setItems] = useState<BillItemDraft[]>(effectiveInitialState?.items ?? [])
  const [allocationMode, setAllocationMode] = useState<AllocationMode>(effectiveInitialState?.allocationMode ?? 'proportional')
  const [paidByMember, setPaidByMember] = useState<Record<string, number>>(effectiveInitialState?.paidByMember ?? {})
  const [settlementStatus, setSettlementStatus] = useState<Record<string, boolean>>(effectiveInitialState?.settlementStatus ?? {})
  const [manualBills, setManualBills] = useState<ManualBill[]>(effectiveInitialState?.manualBills?.map(b => ({
    ...b,
    serviceCharge: b.serviceCharge ?? 0,
    vat: b.vat ?? 0,
    itemDiscount: b.itemDiscount ?? 0,
    billDiscount: b.billDiscount ?? 0,
    vatIncluded: b.vatIncluded ?? false
  })) ?? [])
  const [receiptPayerMap, setReceiptPayerMap] = useState<Record<string, string>>(effectiveInitialState?.receiptPayerMap ?? {})
  const [activeSettlementIdx, setActiveSettlementIdx] = useState<number | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // ── Auto-fill LINE Profile ──
  useEffect(() => {
    if (lineProfile) {
      setMembers(prev => {
        const newMembers = [...prev]
        // Only auto-fill if the first member is still the default 'ฉัน' or empty
        if (newMembers.length > 0 && (newMembers[0].name === 'ฉัน' || newMembers[0].name === '')) {
          newMembers[0].name = lineProfile.displayName
          newMembers[0].pictureUrl = lineProfile.pictureUrl
          return newMembers
        }
        return prev
      })
    }
  }, [lineProfile])

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

  const handleShareBill = useCallback(async (billId: string) => {
    const el = document.getElementById(`bill-card-${billId}`)
    if (!el) return
    try {
      const dataUrl = await htmlToImage.toPng(el, {
        quality: 1, backgroundColor: '#ffffff', style: { borderRadius: '24px' }
      })
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      const file = new File([blob], `bill-${billId}-${new Date().getTime()}.png`, { type: 'image/png' })

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: `รายการบิล ${billId}`,
          files: [file]
        })
      } else {
        const blobUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.download = file.name
        link.href = blobUrl
        link.click()
        URL.revokeObjectURL(blobUrl)
      }
    } catch (e) {
      console.error('Share bill failed', e)
      alert('ไม่สามารถแชร์บิลนี้ได้ในขณะนี้')
    }
  }, [])

  const { progress, results, mergedItems, error, lastSource, debugPayload, sourceHint, ocrStageLabel, scanFiles, reset, terminate, isBusy, setResults } = useReceiptOcr()

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
      
      // Calculate target total for this bill (the one displayed in the UI)
      const targetAmount = bill.id.startsWith('ocr-')
        ? (results[parseInt(bill.id.split('-')[1]!, 10)]?.summary.total ?? 0)
        : (manualBills.find(m => m.id === bill.id)?.amount ?? 0)
      
      const itemsSum = bill.items.reduce((s, it) => s + Math.max(0, it.amount - (it.itemDiscount ?? 0)), 0)
      
      // Total adjustment is everything that isn't the items themselves (fees + discrepancy)
      // This ensures: itemsSum + netAdjustment = targetAmount (if targetAmount is set)
      let netAdjustment = 0
      if (targetAmount > 0) {
        netAdjustment = targetAmount - itemsSum
      } else {
        // Fallback to calculated if no manual target is set
        netAdjustment = bill.serviceCharge + (bill.vatIncluded ? 0 : bill.vat) - bill.billDiscount
      }

      if (netAdjustment !== 0) {
        const consumersOfThisBill = members.filter((m) => (baseByMember[m.id] ?? 0) > 0)
        const adjustments = allocateAmount(netAdjustment, consumersOfThisBill.length > 0 ? consumersOfThisBill : members, baseByMember, allocationMode)
        Object.entries(adjustments).forEach(([id, amt]) => { totalAdjustments[id] = (totalAdjustments[id] ?? 0) + amt })
      }
    })

    Object.keys(totalAdjustments).forEach((id) => { totalAdjustments[id] = round2(totalAdjustments[id]!) })
    return totalAdjustments
  }, [billContexts, billBaseByMemberMap, members, allocationMode, results, manualBills])

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

      const amount = m.amount > 0 ? m.amount : calculatedTotal

      return {
        id: m.id,
        title: m.name,
        subtitle: m.amount > 0 ? (billItems.length > 0 ? `${billItems.length} รายการ` : 'ยอดใส่เอง') : 'คำนวณตามรายการ',
        amount,
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
    const state: PersistedBillState = { 
      version: 4, 
      members, 
      items, 
      serviceCharge: 0, 
      vat: 0, 
      billDiscount: 0, 
      discount: 0, 
      allocationMode, 
      paidByMember, 
      settlementStatus, 
      manualBills, 
      receiptPayerMap,
      isLocked,
      createdBy: lineProfile?.userId
    }
    const title = `บิลวันที่ ${new Date().toLocaleDateString('th-TH')} - ยอด ฿${grandTotal.toFixed(2)}`

    void db.saveBill(currentBillId, title, state)
    void db.setSetting('current-bill-id', currentBillId)

    // Auto-save history if the bill has any meaningful data
    if (items.length > 0 || members.length > 2 || Object.keys(paidByMember).length > 0 || manualBills.length > 0) {
      addOrUpdateBill(currentBillId, title, { ...state, grandTotal }, lineProfile?.userId)
      
      // Collaborative Sync: 
      // 1. Must be a shared bill
      // 2. Initial data from cloud must be loaded (to prevent overwriting with empty local state)
      // 3. Must NOT be a remote update triggering this effect
      // 4. Must be owner OR the bill is NOT locked
      if (billIdFromUrl && isInitialLoadFinished && !remoteUpdating) {
        if (isBillOwner || !isLocked) {
          updateBillData(billIdFromUrl, state)
        }
      }
    }
  }, [dbReady, members, items, allocationMode, paidByMember, settlementStatus, manualBills, receiptPayerMap, currentBillId, addOrUpdateBill, grandTotal, lineProfile, billIdFromUrl, remoteUpdating, isLocked, isBillOwner, isInitialLoadFinished])



  const handleScanReceipt = async () => {
    const allowed = await checkAndRecordUsage('scan_receipt')
    if (allowed) cameraInputRef.current?.click()
  }

  const handleUploadReceipt = async () => {
    const allowed = await checkAndRecordUsage('upload_receipt')
    if (allowed) fileInputRef.current?.click()
  }

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
        const existing = manualBills.find(m => m.id === bId)
        recovered.push({
          id: bId,
          name: existing?.name || (ocrIdx !== undefined ? `สลิปอดีต ${parseInt(ocrIdx) + 1}` : `บิลอดีต`),
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
      console.log('[App] handleFilesSelected:', files?.length)
      if (files && files.length > 0) {
        await scanFiles(Array.from(files))
      }
    },
    [scanFiles],
  )

  const handleInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[App] handleInputChange triggered, files:', e.target.files?.length)
    const files = e.target.files
    await handleFilesSelected(files)
    e.target.value = ''
  }, [handleFilesSelected])


  const addMember = useCallback(() => {
    setMembers((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: '',
        promptPayId: '',
        pictureUrl: '',
        color: MEMBER_COLORS[prev.length % MEMBER_COLORS.length]!,
      },
    ])
  }, [])

  const shareJoinLink = useCallback(async () => {
    const url = new URL(window.location.href)
    url.searchParams.set('billId', currentBillId)
    const joinUrl = url.toString()

    if (liff.isLoggedIn()) {
      if (!liff.isApiAvailable('shareTargetPicker')) {
        console.warn('shareTargetPicker is not available. Please check Scopes in LINE Developers Console.')
        await navigator.clipboard.writeText(joinUrl)
        alert('ระบบแชร์ LINE ยังไม่เปิดใช้งาน (ตรวจสอบ Scopes: chat_message.write) \n\nระบบคัดลอกลิงก์ลง Clipboard ให้แล้วครับ!')
        return
      }

      try {
        const result = await liff.shareTargetPicker([
          {
            type: 'text',
            text: `ช่วยกันหารบิลหน่อย! กดลิงก์นี้เพื่อร่วมหารกัน: ${joinUrl}`
          }
        ])
        if (result) {
          alert('ส่งคำเชิญเรียบร้อยแล้ว!')
        }
      } catch (err) {
        console.error('Share target picker failed:', err)
        await navigator.clipboard.writeText(joinUrl)
        alert('ไม่สามารถเปิดหน้าต่างแชร์ได้ (อาจเกิดจากสิทธิ์เข้าถึง) \n\nระบบคัดลอกลิงก์ลง Clipboard ให้แล้วครับ!')
      }
    } else {
      await navigator.clipboard.writeText(joinUrl)
      alert('คัดลอกลิงก์เข้าร่วมแล้ว! ส่งให้เพื่อนได้เลย')
    }
  }, [currentBillId])


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

  const handleDeleteBill = useCallback((billId: string) => {
    if (billId.startsWith('ocr-')) {
      const idx = parseInt(billId.split('-')[1]!, 10)
      setResults(prev => prev.filter((_, i) => i !== idx))
      
      // Shift billIds for items
      setItems(prev => {
        const filtered = prev.filter(it => it.billId !== billId)
        return filtered.map(it => {
          if (it.billId?.startsWith('ocr-')) {
            const currentIdx = parseInt(it.billId.split('-')[1]!, 10)
            if (currentIdx > idx) return { ...it, billId: `ocr-${currentIdx - 1}` }
          }
          return it
        })
      })

      // Shift billIds in payer map
      setReceiptPayerMap(prev => {
        const next = { ...prev }
        delete next[billId]
        Object.keys(next).forEach(key => {
          if (key.startsWith('ocr-')) {
            const currentIdx = parseInt(key.split('-')[1]!, 10)
            if (currentIdx > idx) {
              next[`ocr-${currentIdx - 1}`] = next[key]
              delete next[key]
            }
          }
        })
        return next
      })
    } else {
      setManualBills(prev => prev.filter(m => m.id !== billId))
      setItems(prev => prev.filter(it => it.billId !== billId))
      setReceiptPayerMap(prev => {
        const next = { ...prev }
        delete next[billId]
        return next
      })
    }
  }, [setResults, setItems, setReceiptPayerMap, setManualBills])

  const handleSetBillTotal = useCallback((billId: string, value: number) => {
    if (billId.startsWith('ocr-')) {
      const idx = parseInt(billId.split('-')[1]!, 10)
      setResults(prev => {
        const next = [...prev]
        if (next[idx]) {
          next[idx] = {
            ...next[idx]!,
            summary: { ...next[idx]!.summary, total: value }
          }
        }
        return next
      })
    } else {
      setManualBills(prev => prev.map(m => m.id === billId ? { ...m, amount: value } : m))
    }
  }, [setResults, setManualBills])

  const updateItem = useCallback(<K extends keyof BillItemDraft>(itemId: string, field: K, value: BillItemDraft[K]) => {
    // Removed auto-updating bill total from item amount changes to preserve the target total
    setItems((prev) => prev.map((item) => item.id === itemId ? { ...item, [field]: value } : item))
  }, [setItems])

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

    // If it was a shared bill and we are the owner, delete it from cloud
    if (billIdFromUrl && isBillOwner && lineProfile) {
      deleteBill(billIdFromUrl, lineProfile.userId)
    }
  }, [reset, billIdFromUrl, isBillOwner, lineProfile])

  // ──────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────

  if (dbReady && !lineProfile && !billIdFromUrl) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-600 via-violet-700 to-fuchsia-600 flex items-center justify-center p-6 text-white overflow-hidden relative">
        {/* Animated background elements */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-white/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-fuchsia-500/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />

        <div className="max-w-sm w-full text-center space-y-8 relative z-10">
          <div className="space-y-4">
            <div className="mx-auto w-20 h-20 bg-white/20 backdrop-blur-xl rounded-[28px] flex items-center justify-center shadow-2xl border border-white/30 animate-bounce">
              <Receipt className="w-10 h-10 text-white" />
            </div>
            <div className="space-y-2">
              <h1 className="text-4xl font-black tracking-tight">หารบิลกัน</h1>
              <p className="text-violet-100 text-lg font-medium opacity-90">จัดการค่าใช้จ่ายกับเพื่อนได้ง่ายๆ <br/>ซิงค์ข้อมูลผ่าน LINE ทันที</p>
            </div>
          </div>

          <div className="space-y-4 pt-4">
            <button
              onClick={login}
              className="w-full flex items-center justify-center gap-3 bg-white text-violet-600 py-4 px-6 rounded-2xl font-black text-lg shadow-[0_20px_40px_rgba(0,0,0,0.2)] transition-all hover:-translate-y-1 hover:shadow-[0_25px_50px_rgba(0,0,0,0.25)] active:translate-y-0 active:scale-[0.98]"
            >
              <img src="https://upload.wikimedia.org/wikipedia/commons/4/41/LINE_logo.svg" className="w-6 h-6" alt="LINE" />
              เข้าสู่ระบบด้วย LINE
            </button>
            <p className="text-[11px] text-violet-200/70 font-medium tracking-wide uppercase">ปลอดภัย • ซิงค์ข้อมูล Real-time • ใช้งานฟรี</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-sky-50 text-[15px] leading-6 tracking-[0.01em] sm:text-base">
      {/* Hidden inputs */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleInputChange}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />
      <input
        ref={importInputRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => void importBill(e.target.files?.[0] ?? null)}
      />

      {/* Usage Limit Modal (Rich Ads) */}
      {showLimitModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-white rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl animate-in zoom-in-95 duration-300 border border-white/20">
            {/* Ad Banner Image */}
            {randomAd?.image_url ? (
              <div className="h-48 w-full overflow-hidden relative group">
                <img src={randomAd.image_url} alt="Ad" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                <div className="absolute top-3 left-3 bg-[#EE4D2D] text-white text-[10px] font-black px-2 py-1 rounded shadow-lg uppercase tracking-widest">
                  Hot Deal
                </div>
              </div>
            ) : (
              <div className="bg-gradient-to-br from-[#EE4D2D] to-[#FF7337] p-8 text-center text-white relative">
                <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none">
                  <div className="absolute top-2 left-4 rotate-12"><ShoppingBag className="w-12 h-12" /></div>
                  <div className="absolute bottom-4 right-6 -rotate-12"><Receipt className="w-16 h-16" /></div>
                </div>
                <div className="mx-auto w-16 h-16 bg-white/20 backdrop-blur-md rounded-2xl flex items-center justify-center mb-4 shadow-inner border border-white/30">
                  <AlertCircle className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-xl font-black mb-1">ใช้งานครบโควตาแล้ว!</h3>
                <p className="text-orange-50 text-xs font-medium opacity-90">เพื่อสนับสนุนแอปให้เราไปต่อได้...</p>
              </div>
            )}

            <div className="p-6 space-y-4">
              {/* Ad Content */}
              <div className="space-y-2">
                <h4 className="text-sm font-black text-gray-800 leading-tight line-clamp-2">
                  {randomAd?.description || 'ขอบคุณที่สนับสนุนเรา! ช่วยช้อปปิ้งเพื่อปลดล็อคการใช้งานต่อครับ'}
                </h4>
                {randomAd?.price_text && (
                  <p className="text-lg font-black text-[#EE4D2D]">{randomAd.price_text}</p>
                )}
              </div>

              <div className="bg-gray-50 rounded-2xl p-3 border border-gray-100 flex items-center justify-between">
                <div>
                  <p className="text-[9px] text-gray-400 font-bold uppercase tracking-wider mb-0.5">สถานะโควตาของคุณ</p>
                  <p className="text-sm font-black text-gray-700">{usageStats.daily} / {USAGE_LIMITS.DAILY} ครั้งวันนี้</p>
                </div>
                <div className="h-8 w-8 rounded-full bg-orange-100 flex items-center justify-center">
                  <div className="h-4 w-4 rounded-full border-2 border-orange-500 border-t-transparent animate-spin" />
                </div>
              </div>
              
              <a
                href={randomLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  setIsTemporarilyUnlocked(true)
                  setTimeout(() => setShowLimitModal(false), 1500)
                }}
                className="w-full flex items-center justify-center gap-3 bg-[#EE4D2D] text-white py-4 rounded-2xl font-black text-lg shadow-[0_10px_25px_rgba(238,77,45,0.35)] transition-all hover:-translate-y-1 hover:shadow-[0_15px_35px_rgba(238,77,45,0.45)] active:translate-y-0 active:scale-95"
              >
                <ShoppingBag className="w-6 h-6" />
                ไปที่ Shopee เพื่อใช้งานต่อ
              </a>
              
              <button 
                onClick={() => setShowLimitModal(false)}
                className="w-full text-gray-400 text-[10px] font-bold py-2 hover:text-gray-600 transition-colors uppercase tracking-widest"
              >
                ยังไม่พร้อมตอนนี้
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/60 bg-white/75 backdrop-blur-2xl shadow-[0_1px_0_rgba(255,255,255,0.9),0_20px_60px_rgba(124,58,237,0.10)]" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
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

            {lineProfile ? (
              <button
                onClick={logout}
                className="flex items-center gap-2 rounded-xl border border-violet-100 bg-white/50 p-1.5 pr-3 transition-all hover:bg-violet-50"
                title="ออกจากระบบ LINE"
              >
                {lineProfile.pictureUrl ? (
                  <img 
                    src={lineProfile.pictureUrl} 
                    alt={lineProfile.displayName} 
                    className="h-7 w-7 rounded-lg object-cover shadow-sm ring-1 ring-violet-200"
                  />
                ) : (
                  <div className="h-7 w-7 rounded-lg bg-violet-600 flex items-center justify-center text-[10px] font-bold text-white shadow-sm">
                    {lineProfile.displayName.slice(0, 1)}
                  </div>
                )}
                <span className="text-xs font-bold text-violet-700 hidden sm:inline">{lineProfile.displayName}</span>
              </button>
            ) : (
              <button
                onClick={login}
                className="flex items-center gap-1.5 rounded-xl border border-[#06C755] bg-white px-3 py-1.5 text-xs font-bold text-[#06C755] shadow-sm transition-all hover:bg-[#06C755]/5 hover:-translate-y-0.5 active:translate-y-0"
              >
                <img 
                  src="https://upload.wikimedia.org/wikipedia/commons/4/41/LINE_logo.svg" 
                  className="h-4 w-4" 
                  alt="LINE" 
                />
                <span>Login with LINE</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-3 py-4 pb-14 sm:px-4 sm:py-5 sm:pb-16" style={{ paddingBottom: 'max(3.5rem, env(safe-area-inset-bottom))' }}>
        <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_top,rgba(124,58,237,0.10),transparent_28%),radial-gradient(circle_at_bottom,rgba(14,165,233,0.08),transparent_22%)]" />

        {/* ── STEP 1: คนหาร ── */}
        <SectionCard className="shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
          <div className="flex items-start justify-between gap-3 mb-4">
            <StepBadge n={1} label="ใส่ชื่อคนที่จะหารบิล" />
            <div className="flex flex-wrap gap-2 justify-end">
              {isBillOwner && (
                <button 
                  onClick={() => setIsLocked(!isLocked)}
                  className={`text-xs flex items-center gap-1 px-2 py-1.5 rounded-lg font-bold transition-colors border ${
                    isLocked 
                      ? 'text-orange-600 bg-orange-50 border-orange-100 hover:bg-orange-100' 
                      : 'text-gray-600 bg-gray-50 border-gray-100 hover:bg-gray-100'
                  }`}
                >
                  {isLocked ? <Lock className="w-3.5 h-3.5"/> : <Unlock className="w-3.5 h-3.5"/>}
                  {isLocked ? 'ปลดล็อคบิล' : 'ล็อคบิล'}
                </button>
              )}
              {!isBillOwner && isLocked && (
                <div className="text-[10px] bg-orange-100 text-orange-700 px-2 py-1.5 rounded-lg font-bold flex items-center gap-1 border border-orange-200 animate-pulse">
                  <Lock className="w-3 h-3"/> บิลถูกล็อค (ดูได้อย่างเดียว)
                </div>
              )}
              <button 
                onClick={shareJoinLink}
                disabled={isLocked && !isBillOwner}
                className="text-xs text-[#06C755] bg-[#06C755]/10 hover:bg-[#06C755]/20 flex items-center gap-1 px-2 py-1.5 rounded-lg font-bold transition-colors border border-[#06C755]/20 disabled:opacity-50"
              >
                <Share className="w-3.5 h-3.5"/> เชิญเพื่อน
              </button>
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
              <div key={member.id} className="flex flex-col gap-3 rounded-2xl border border-violet-100 bg-gradient-to-br from-white via-white to-violet-50/40 p-3 shadow-[0_10px_24px_rgba(15,23,42,0.05)] backdrop-blur-xl sm:p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium text-gray-400">แตะชื่อเพื่อแก้ไข</span>
                  <button
                    onClick={() => removeMember(member.id)}
                    disabled={members.length <= 1}
                    className="inline-flex items-center gap-1.5 rounded-full border border-red-100 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-red-500 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-red-50 hover:shadow-md disabled:translate-y-0 disabled:opacity-30"
                  >
                    <Trash2 className="h-3 w-3" />
                    ลบ
                  </button>
                </div>
                <div className="flex items-start gap-2">
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-sm font-black text-white shadow-sm overflow-hidden"
                    style={{ backgroundColor: member.color }}
                  >
                    {member.pictureUrl ? (
                      <img src={member.pictureUrl} className="h-full w-full object-cover" alt={member.name} />
                    ) : (
                      member.name.slice(0, 1) || (idx + 1)
                    )}
                  </div>
                  <div className="flex-1 space-y-2">
                    <input
                      value={member.name}
                      onChange={(e) => updateMember(member.id, 'name', e.target.value)}
                      placeholder={`คนที่ ${idx + 1}`}
                      className="w-full rounded-2xl border border-violet-100 bg-white px-4 py-3 text-sm font-semibold text-gray-800 outline-none shadow-[0_1px_0_rgba(255,255,255,0.85),0_8px_18px_rgba(15,23,42,0.05)] transition-all placeholder:text-gray-300 focus:border-violet-300 focus:ring-2 focus:ring-violet-200"
                    />
                    <input
                      value={member.promptPayId || ''}
                      onChange={(e) => updateMember(member.id, 'promptPayId', formatPromptPay(e.target.value))}
                      placeholder="PromptPay: เบอร์โทร หรือ เลขบัตรประชาชน"
                      className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-[12px] font-mono font-bold text-gray-700 outline-none shadow-[0_1px_0_rgba(255,255,255,0.85),0_8px_18px_rgba(15,23,42,0.04)] transition-all placeholder:text-gray-300 focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-2 mt-3 sm:mt-4">
            <button
              onClick={addMember}
              className="flex-1 flex items-center justify-center gap-2 rounded-2xl border border-violet-100 bg-gradient-to-r from-violet-600 to-fuchsia-500 py-3 text-sm font-bold text-white shadow-[0_14px_34px_rgba(124,58,237,0.20)] transition-all hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgba(124,58,237,0.28)] active:translate-y-0"
            >
              <Plus className="h-4 w-4" />
              เพิ่มคนหารบิล
            </button>
          </div>
        </SectionCard>

        {/* ── STEP 2: ใบเสร็จ & รายการ ── */}
        <div className="space-y-6">
            <SectionCard>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 mb-6">
                <div>
                  <StepBadge n={2} label="ใบเสร็จ & รายการ" />
                  <p className="text-[11px] text-gray-400 mt-1 ml-1">สแกน/เพิ่มบิล แล้วระบุว่าใครกินอะไร</p>
                </div>
                <div className="flex gap-2">
                    <button
                      onClick={handleUploadReceipt}
                      disabled={isBusy}
                      className="flex-1 sm:flex-initial flex items-center justify-center gap-2 rounded-2xl border border-sky-100 bg-white/80 px-3 py-2 text-sm font-semibold text-sky-700 shadow-[0_8px_24px_rgba(14,165,233,0.08)] backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:bg-sky-50 hover:shadow-[0_14px_30px_rgba(14,165,233,0.12)] active:translate-y-0 disabled:translate-y-0 disabled:opacity-50 font-heading sm:px-4"
                    >
                      {isBusy ? <Loader2 className="h-4 w-4 animate-spin text-sky-500" /> : <Upload className="h-4 w-4" />}
                      {isBusy ? 'กำลังอ่านรูป...' : 'จากอัลบั้ม'}
                    </button>
                    <button
                      onClick={handleScanReceipt}
                      disabled={isBusy}
                      className="flex-1 sm:flex-initial flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 via-violet-500 to-fuchsia-500 px-3 py-2 text-sm font-bold text-white shadow-[0_14px_34px_rgba(124,58,237,0.28)] transition-all hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgba(124,58,237,0.34)] active:translate-y-0 font-heading sm:px-4"
                    >
                      {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                      {isBusy ? 'กำลังสแกน...' : 'ถ่ายบิลใหม่'}
                    </button>
                    <button
                      onClick={() => setIsManualBillModalOpen(true)}
                      className="flex-1 sm:flex-initial flex items-center justify-center gap-2 rounded-2xl border border-white/80 bg-white/75 px-3 py-2 text-sm font-semibold text-gray-700 shadow-[0_8px_24px_rgba(15,23,42,0.06)] backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_14px_30px_rgba(15,23,42,0.10)] active:translate-y-0 font-heading sm:px-4"
                    >
                      <Plus className="h-4 w-4" /> เพิ่มบิลเอง
                    </button>
                  </div>
                </div>

              {/* OCR Progress & Errors (Moved up for visibility) */}
              {(isBusy || error) && (
                <div className="mb-6 space-y-4">
                  {isBusy && (
                    <div className="rounded-3xl border border-white/80 bg-gradient-to-br from-violet-50/95 via-white to-fuchsia-50/80 p-4 shadow-[0_14px_34px_rgba(124,58,237,0.10)] backdrop-blur-xl animate-in fade-in slide-in-from-top-4 duration-300">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2 text-[11px] font-semibold text-violet-700">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {progress.statusText}
                          </div>
                          <span className="text-[10px] font-medium text-violet-400">{ocrStageLabel}</span>
                          {sourceHint && <span className="text-[10px] font-medium text-violet-400">{sourceHint}</span>}
                        </div>
                        <span className="rounded-full bg-white/80 px-2 py-1 text-[10px] font-semibold text-violet-600 shadow-sm">
                          {lastSource === 'gemini' ? 'Gemini' : lastSource === 'fallback' ? 'Fallback' : lastSource === 'tesseract' ? 'Tesseract' : 'กำลังอ่าน'}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-white/80 shadow-inner">
                        <div className="h-full rounded-full bg-gradient-to-r from-violet-600 via-violet-500 to-fuchsia-500 transition-all duration-300" style={{ width: `${progress.progress}%` }} />
                      </div>
                    </div>
                  )}
                  
                  {error && (
                    <div className="flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 p-4 text-xs text-red-700 animate-in fade-in zoom-in-95 duration-300">
                      <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                      <span>{error}</span>
                    </div>
                  )}
                </div>
              )}

              {debugPayload && (
                <details className="mt-6 overflow-hidden rounded-2xl border border-violet-100 bg-white/85 shadow-sm">
                  <summary className="cursor-pointer select-none px-4 py-3 text-sm font-bold text-violet-700">
                    Gemini debug panel
                  </summary>
                  <div className="space-y-3 border-t border-violet-100 px-4 py-4 text-[11px] text-gray-600">
                    <div>
                      <p className="mb-1 font-black uppercase tracking-[0.16em] text-gray-400">Endpoint</p>
                      <p className="break-all rounded-xl bg-violet-50 px-3 py-2 text-violet-700">{debugPayload.endpoint}</p>
                    </div>
                    <div>
                      <p className="mb-1 font-black uppercase tracking-[0.16em] text-gray-400">Model Used</p>
                      <p className="rounded-xl bg-sky-50 px-3 py-2 text-sky-700 font-bold">{debugPayload.parsed.modelUsed || '—'}</p>
                    </div>
                    <div>
                      <p className="mb-1 font-black uppercase tracking-[0.16em] text-gray-400">Raw text</p>
                      <pre className="max-h-40 overflow-auto rounded-xl bg-gray-50 px-3 py-2 text-[10px] leading-5 text-gray-700">{debugPayload.rawText || '—'}</pre>
                    </div>
                    <div>
                      <p className="mb-1 font-black uppercase tracking-[0.16em] text-gray-400">Parsed items</p>
                      <pre className="max-h-40 overflow-auto rounded-xl bg-gray-50 px-3 py-2 text-[10px] leading-5 text-gray-700">{JSON.stringify(debugPayload.parsed.items, null, 2)}</pre>
                    </div>
                  </div>
                </details>
              )}
            </SectionCard>

            <div className="flex flex-col lg:grid lg:grid-cols-12 gap-6 items-start">
              {/* LEFT COLUMN: helper note */}

              {/* RIGHT COLUMN: RECEIPTS & BILL SUMMARY (ใบเสร็จ & ยอดจ่าย) */}
              <div className="lg:col-span-12 w-full space-y-6 order-1 lg:order-2">
                <div className="px-2">
                  <h3 className="text-sm font-black text-gray-800 uppercase tracking-[0.18em] flex items-center gap-2">
                    <Receipt className="h-4 w-4 text-violet-500" />
                    ใบเสร็จ & ยอดจ่าย
                  </h3>
                </div>

                <div className="space-y-6">
                  {unifiedBills.map((b) => {
                    const isDiscrepant = Math.abs(round2(b.amount - b.calculatedTotal)) > 0.01
                    return (
                      <BillCard
                        key={b.id}
                        bill={b}
                        items={items}
                        members={members}
                        results={results}
                        manualBills={manualBills}
                        assignedId={receiptPayerMap[b.id]}
                        isDiscrepant={isDiscrepant}
                        onAddItem={(billId) => {
                          const item: BillItemDraft = {
                            id: crypto.randomUUID(),
                            name: '',
                            amount: 0,
                            itemDiscount: 0,
                            billId,
                            splitMode: 'equally',
                            consumerIds: members.map((m) => m.id),
                            percentageByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                            exactByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                          }
                          setItems((prev) => [...prev, item])
                        }}
                        onAddDifference={(billId, deficit) => {
                          const item: BillItemDraft = {
                            id: crypto.randomUUID(),
                            name: `ส่วนต่างของ ${b.title}`,
                            billId,
                            amount: deficit,
                            itemDiscount: 0,
                            splitMode: 'equally',
                            consumerIds: members.map((m) => m.id),
                            percentageByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                            exactByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                          }
                          setItems((prev) => [...prev, item])
                        }}
                        onSetServiceCharge={(billId, value) => {
                          if (billId.startsWith('ocr-')) {
                            setResults(res => res.map((rr, ii) => ii === parseInt(billId.split('-')[1]!, 10) ? { ...rr, summary: { ...rr.summary, serviceCharge: value } } : rr))
                          }
                          setManualBills(prev => prev.map(mm => mm.id === billId ? { ...mm, serviceCharge: value } : mm))
                        }}
                        onToggleVatIncluded={(billId, next) => {
                          if (billId.startsWith('ocr-')) {
                            setResults(res => res.map((rr, ii) => ii === parseInt(billId.split('-')[1]!, 10) ? { ...rr, vatIncluded: next } : rr))
                          }
                          setManualBills(prev => prev.map(mm => mm.id === billId ? { ...mm, vatIncluded: next } : mm))
                        }}
                        onSetVat={(billId, value) => {
                          if (billId.startsWith('ocr-')) {
                            setResults(res => res.map((rr, ii) => ii === parseInt(billId.split('-')[1]!, 10) ? { ...rr, summary: { ...rr.summary, vat: value } } : rr))
                          }
                          setManualBills(prev => prev.map(mm => mm.id === billId ? { ...mm, vat: value } : mm))
                        }}
                        onSetDiscount={(billId, value) => {
                          if (billId.startsWith('ocr-')) {
                            setResults(res => res.map((rr, ii) => ii === parseInt(billId.split('-')[1]!, 10) ? { ...rr, summary: { ...rr.summary, billDiscount: value, discount: value } } : rr))
                          }
                          setManualBills(prev => prev.map(mm => mm.id === billId ? { ...mm, billDiscount: value, discount: value } : mm))
                        }}
                        onSetName={(billId, name) => {
                          if (billId.startsWith('ocr-')) {
                            setResults(res => res.map((rr, ii) => ii === parseInt(billId.split('-')[1]!, 10) ? { ...rr, customName: name } : rr))
                          }
                          setManualBills(prev => prev.map(mm => mm.id === billId ? { ...mm, name } : mm))
                        }}
                        onSetPayer={(billId, memberId) => {
                          setReceiptPayerMap(prev => ({ ...prev, [billId]: memberId }))
                          if (memberId) setPaidByMember(prev => ({ ...prev, [memberId]: round2((prev[memberId] ?? 0) + b.amount) }))
                        }}
                        onEditItem={(itemId, field, value) => updateItem(itemId, field as keyof BillItemDraft, value as never)}
                        onRemoveItem={(itemId) => setItems(prev => prev.filter(it => it.id !== itemId))}
                        onAddItemToBill={(billId) => {
                          const item: BillItemDraft = {
                            id: crypto.randomUUID(),
                            name: '',
                            amount: 0,
                            itemDiscount: 0,
                            billId,
                            splitMode: 'equally',
                            consumerIds: members.map((m) => m.id),
                            percentageByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                            exactByUser: Object.fromEntries(members.map((m) => [m.id, 0])),
                          }
                          setItems((prev) => [...prev, item])
                        }}
                        onDeleteBill={handleDeleteBill}
                        onSetTotal={handleSetBillTotal}
                        onShare={handleShareBill}
                      />
                    )
                  })}
                  {unifiedBills.length === 0 && (
                    <div className="rounded-[32px] border-2 border-dashed border-gray-100 bg-white/50 py-12 text-center">
                      <Receipt className="mx-auto mb-3 h-8 w-8 text-gray-200" />
                      <p className="text-sm font-black uppercase tracking-widest leading-tight text-gray-400">ยังไม่มีใบเสร็จ<br /><span className="text-[10px] font-bold text-gray-300">สแกนหรือเพิ่มบิลด้านบน</span></p>
                    </div>
                  )}
                </div>
            </div>
          </div>
        </div>

        {/* ── STEP 3: Who paid? ── */}
        {items.length > 0 && (
          <SectionCard>
            <StepBadge n={3} label="ใครจ่ายไปแล้วเท่าไหร่?" />
            <p className="mb-3 -mt-2 text-[11px] leading-5 text-gray-400">ยอดจากบิลที่เลือกคนจ่ายจะนับให้อัตโนมัติ ส่วนช่องนี้ใช้กรอกยอดเพิ่ม/แก้ไขจริง</p>

            <div className="mb-4 grid grid-cols-1 gap-3 rounded-2xl bg-gradient-to-r from-violet-50 to-fuchsia-50 p-3 sm:grid-cols-3">
              <div className="rounded-xl bg-white/80 p-3 shadow-sm">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">ยอดรวม</p>
                <p className="mt-1 text-lg font-black text-violet-700">฿{grandTotal.toFixed(2)}</p>
              </div>
              <div className="rounded-xl bg-white/80 p-3 shadow-sm">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">จ่ายแล้วทั้งหมด</p>
                <p className="mt-1 text-lg font-black text-emerald-600">฿{Object.values(totalPaidByMember).reduce((sum, amt) => sum + amt, 0).toFixed(2)}</p>
              </div>
              <div className="rounded-xl bg-white/80 p-3 shadow-sm">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">คงเหลือ</p>
                <p className="mt-1 text-lg font-black text-amber-600">฿{Math.max(0, grandTotal - Object.values(totalPaidByMember).reduce((sum, amt) => sum + amt, 0)).toFixed(2)}</p>
              </div>
            </div>

            <div className="space-y-2">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white px-3 py-2 shadow-sm">
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
                            <button
                              onClick={() => void shareBillToFriends(`${from.name} → ${to.name}`, s.amount, to.promptPayId)}
                              className="rounded-lg p-2 text-emerald-500 hover:bg-emerald-50 transition-colors"
                              title="แชร์เข้า LINE"
                            >
                              <Share className="h-3.5 w-3.5" />
                            </button>
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
                history.map((h: BillHistoryMeta) => (
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
                  const amt = Number(newManualBillAmount) || 0
                  if (!newManualBillName.trim()) return
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
                disabled={!newManualBillName.trim()}
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
    </main>
    </div>
  )

}

export default App
