import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, ImageUp, LoaderCircle, Copy, Receipt, Sparkles, Upload, Users, Wallet } from 'lucide-react'

import { Button } from './components/ui/button'
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

interface Settlement {
  fromMemberId: string
  toMemberId: string
  amount: number
  promptPayPayload: string | null
}

const MEMBER_COLORS = ['#7C3AED', '#0EA5E9', '#22C55E', '#F97316', '#EC4899', '#EAB308']

const round2 = (value: number) => Number(value.toFixed(2))

function calcItemSplit(item: BillItemDraft, members: MemberDraft[]) {
  const result: Record<string, number> = {}

  members.forEach((member) => {
    result[member.id] = 0
  })

  const selected = item.consumerIds.filter((id) => members.some((m) => m.id === id))

  if (item.splitMode === 'equally' || item.splitMode === 'itemized') {
    if (selected.length === 0) return result
    const each = item.amount / selected.length
    selected.forEach((id) => {
      result[id] = each
    })
    return result
  }

  if (item.splitMode === 'percentage') {
    selected.forEach((id) => {
      const pct = item.percentageByUser[id] ?? 0
      result[id] = (item.amount * pct) / 100
    })
    return result
  }

  if (item.splitMode === 'exact') {
    selected.forEach((id) => {
      result[id] = item.exactByUser[id] ?? 0
    })
    return result
  }

  return result
}

function allocateAmount(
  amount: number,
  members: MemberDraft[],
  baseByMember: Record<string, number>,
  mode: AllocationMode,
): Record<string, number> {
  const allocations: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]))
  if (members.length === 0 || amount === 0) return allocations

  const totalBase = members.reduce((sum, member) => sum + (baseByMember[member.id] ?? 0), 0)

  if (mode === 'equal' || totalBase <= 0) {
    const each = amount / members.length
    members.forEach((member) => {
      allocations[member.id] = each
    })
    return allocations
  }

  members.forEach((member) => {
    const ratio = (baseByMember[member.id] ?? 0) / totalBase
    allocations[member.id] = amount * ratio
  })

  return allocations
}

function simplifyDebts(netByMember: Record<string, number>): Settlement[] {
  const creditors = Object.entries(netByMember)
    .filter(([, net]) => net > 0.01)
    .map(([memberId, net]) => ({ memberId, amount: net }))
    .sort((a, b) => b.amount - a.amount)

  const debtors = Object.entries(netByMember)
    .filter(([, net]) => net < -0.01)
    .map(([memberId, net]) => ({ memberId, amount: Math.abs(net) }))
    .sort((a, b) => b.amount - a.amount)

  const settlements: Settlement[] = []
  let i = 0
  let j = 0

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i]
    const creditor = creditors[j]
    const amount = Math.min(debtor.amount, creditor.amount)

    if (amount > 0.009) {
      settlements.push({
        fromMemberId: debtor.memberId,
        toMemberId: creditor.memberId,
        amount: round2(amount),
        promptPayPayload: null,
      })
    }

    debtor.amount -= amount
    creditor.amount -= amount

    if (debtor.amount <= 0.01) i += 1
    if (creditor.amount <= 0.01) j += 1
  }

  return settlements
}


function App() {
  const initialBillState = safeParseBillState(localStorage.getItem(STORAGE_KEY))
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [members, setMembers] = useState<MemberDraft[]>(
    initialBillState?.members ?? [
      { id: crypto.randomUUID(), name: 'Me', color: MEMBER_COLORS[0], promptPayId: '' },
      { id: crypto.randomUUID(), name: 'Friend', color: MEMBER_COLORS[1], promptPayId: '' },
    ],
  )
  const [newMemberName, setNewMemberName] = useState('')
  const [items, setItems] = useState<BillItemDraft[]>(initialBillState?.items ?? [])

  const [serviceCharge, setServiceCharge] = useState(initialBillState?.serviceCharge ?? 0)
  const [vat, setVat] = useState(initialBillState?.vat ?? 0)
  const [discount, setDiscount] = useState(initialBillState?.discount ?? 0)
  const [allocationMode, setAllocationMode] = useState<AllocationMode>(initialBillState?.allocationMode ?? 'proportional')
  const [paidByMember, setPaidByMember] = useState<Record<string, number>>(initialBillState?.paidByMember ?? {})
  const [selectedSettlement, setSelectedSettlement] = useState<Settlement | null>(null)

  const { status, progress, result, error, runOcr, reset, terminate } = useReceiptOcr()

  useEffect(() => {
    const payload: PersistedBillState = {
      members,
      items,
      serviceCharge,
      vat,
      discount,
      allocationMode,
      paidByMember,
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [members, items, serviceCharge, vat, discount, allocationMode, paidByMember])

  useEffect(() => {
    return () => {
      void terminate()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl, terminate])

  useEffect(() => {
    if (!result) return

    setItems(
      result.items.map((item: { id: string; name: string; amount: number }) => ({
        id: item.id,
        name: item.name,
        amount: item.amount,
        splitMode: 'equally',
        consumerIds: members.map((m) => m.id),
        percentageByUser: Object.fromEntries(members.map((m) => [m.id, round2(100 / Math.max(members.length, 1))])),
        exactByUser: Object.fromEntries(members.map((m) => [m.id, round2(item.amount / Math.max(members.length, 1))])),
      })),
    )

    setVat(result.summary.vat ?? 0)
  }, [result, members])

  const isBusy = status === 'loading' || status === 'recognizing'

  const baseTotalsByMember = useMemo(() => {
    const totals: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]))

    items.forEach((item) => {
      const split = calcItemSplit(item, members)
      Object.entries(split).forEach(([memberId, amount]) => {
        totals[memberId] = (totals[memberId] ?? 0) + amount
      })
    })

    Object.keys(totals).forEach((memberId) => {
      totals[memberId] = round2(totals[memberId])
    })

    return totals
  }, [items, members])

  const totalItemsAmount = useMemo(() => round2(items.reduce((sum, item) => sum + item.amount, 0)), [items])

  const adjustmentsByMember = useMemo(() => {
    const combined = serviceCharge + vat - discount
    return allocateAmount(combined, members, baseTotalsByMember, allocationMode)
  }, [serviceCharge, vat, discount, members, baseTotalsByMember, allocationMode])

  const finalDueByMember = useMemo(() => {
    const due: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]))

    members.forEach((member) => {
      due[member.id] = round2((baseTotalsByMember[member.id] ?? 0) + (adjustmentsByMember[member.id] ?? 0))
    })

    return due
  }, [members, baseTotalsByMember, adjustmentsByMember])

  const grandTotal = useMemo(() => round2(totalItemsAmount + serviceCharge + vat - discount), [totalItemsAmount, serviceCharge, vat, discount])

  useEffect(() => {
    if (members.length === 0) return

    setPaidByMember((prev) => {
      const next: Record<string, number> = {}
      members.forEach((member, index) => {
        const existing = prev[member.id]
        if (typeof existing === 'number') {
          next[member.id] = existing
        } else {
          next[member.id] = index === 0 ? grandTotal : 0
        }
      })
      return next
    })
  }, [members, grandTotal])

  const netByMember = useMemo(() => {
    const net: Record<string, number> = {}
    members.forEach((member) => {
      const paid = paidByMember[member.id] ?? 0
      const due = finalDueByMember[member.id] ?? 0
      net[member.id] = round2(paid - due)
    })
    return net
  }, [members, paidByMember, finalDueByMember])

  const settlements = useMemo(
    () =>
      simplifyDebts(netByMember).map((settlement) => ({
        ...settlement,
        promptPayPayload: buildPromptPayPayload(
          members.find((m) => m.id === settlement.toMemberId)?.promptPayId ?? '',
          settlement.amount,
        ),
      })),
    [netByMember, members],
  )


  const handleFileSelect = async (file: File | null) => {
    if (!file) return

    if (previewUrl) URL.revokeObjectURL(previewUrl)

    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    setSelectedFile(file)
    await runOcr(file)
  }

  const onInputChange: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0] ?? null
    await handleFileSelect(file)
    event.target.value = ''
  }

  const triggerReceiptUpload = () => fileInputRef.current?.click()
  const triggerImportUpload = () => importInputRef.current?.click()

  const handleReset = () => {
    reset()
    setSelectedFile(null)
    setItems([])
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
  }

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text)
  }

  const copySettlement = async (settlement: Settlement) => {
    const from = members.find((member) => member.id === settlement.fromMemberId)?.name ?? 'Unknown'
    const to = members.find((member) => member.id === settlement.toMemberId)?.name ?? 'Unknown'
    await copyText(`${from} -> ${to}: ฿${settlement.amount.toFixed(2)}`)
  }

  const openSettlement = (settlement: Settlement) => setSelectedSettlement(settlement)

  const exportBill = () => {
    const payload: PersistedBillState = { members, items, serviceCharge, vat, discount, allocationMode, paidByMember }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `bill-splitter-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const importBill = async (file: File | null) => {
    if (!file) return
    const text = await file.text()
    const data = safeParseBillState(text)
    if (data) {
      setMembers(data.members)
      setItems(data.items)
      setServiceCharge(data.serviceCharge ?? 0)
      setVat(data.vat ?? 0)
      setDiscount(data.discount ?? 0)
      setAllocationMode(data.allocationMode ?? 'proportional')
      setPaidByMember(data.paidByMember ?? {})
    }
  }

  const addMember = () => {
    const trimmed = newMemberName.trim()
    if (!trimmed) return

    const member: MemberDraft = {
      id: crypto.randomUUID(),
      name: trimmed,
      color: MEMBER_COLORS[members.length % MEMBER_COLORS.length],
      promptPayId: '',
    }

    setMembers((prev) => [...prev, member])
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        consumerIds: [...new Set([...item.consumerIds, member.id])],
        percentageByUser: {
          ...item.percentageByUser,
          [member.id]: 0,
        },
        exactByUser: {
          ...item.exactByUser,
          [member.id]: 0,
        },
      })),
    )
    setNewMemberName('')
  }

  const removeMember = (memberId: string) => {
    if (members.length <= 1) return

    setMembers((prev) => prev.filter((m) => m.id !== memberId))
    setItems((prev) =>
      prev.map((item) => {
        const nextPercentages = { ...item.percentageByUser }
        const nextExact = { ...item.exactByUser }
        delete nextPercentages[memberId]
        delete nextExact[memberId]

        return {
          ...item,
          consumerIds: item.consumerIds.filter((id) => id !== memberId),
          percentageByUser: nextPercentages,
          exactByUser: nextExact,
        }
      }),
    )
  }

  const updateMember = <K extends keyof MemberDraft>(memberId: string, field: K, value: MemberDraft[K]) => {
    setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, [field]: value } : m)))
  }

  const toggleConsumer = (itemId: string, memberId: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item
        const exists = item.consumerIds.includes(memberId)
        return {
          ...item,
          consumerIds: exists ? item.consumerIds.filter((id) => id !== memberId) : [...item.consumerIds, memberId],
        }
      }),
    )
  }

  const updateItem = <K extends keyof BillItemDraft>(itemId: string, field: K, value: BillItemDraft[K]) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, [field]: value } : item)))
  }

  const clearLocalData = () => {
    localStorage.removeItem(STORAGE_KEY)
  }


  const activeSettlement = selectedSettlement
    ? settlements.find(
        (settlement) =>
          settlement.fromMemberId === selectedSettlement.fromMemberId &&
          settlement.toMemberId === selectedSettlement.toMemberId &&
          settlement.amount === selectedSettlement.amount,
      ) ?? null
    : null

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-8 sm:px-6 sm:py-10">
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onInputChange} />
      <input ref={importInputRef} type="file" accept="application/json" className="hidden" onChange={(event) => void importBill(event.target.files?.[0] ?? null)} />
      <header className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-sm backdrop-blur sm:p-10">
        <p className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          Phase 4 • Allocation + Simplify Debt + PromptPay + LocalStorage
        </p>

        <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-5xl">
          เคลียร์บิลครบลูปแบบคนจริงใช้งานได้
          <span className="block text-primary">จัดสรรค่าบริการ/ภาษี ลดจำนวนการโอน</span>
        </h1>
      </header>

      <section className="mt-6 rounded-3xl border bg-card p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={triggerReceiptUpload}>
            <Upload className="mr-2 h-4 w-4" />
            Choose Receipt
          </Button>
          <Button variant="secondary" onClick={triggerImportUpload}>
            <Download className="mr-2 h-4 w-4" />
            Load Saved Bill
          </Button>
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={triggerReceiptUpload}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') triggerReceiptUpload()
          }}
          className="group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/40 px-4 py-10 text-center transition hover:border-primary/50 hover:bg-secondary/40"
        >
          <ImageUp className="h-7 w-7 text-primary" />
          <div>
            <p className="font-semibold">แตะเพื่ออัปโหลดรูปใบเสร็จ</p>
            <p className="text-sm text-muted-foreground">รองรับไฟล์ภาพจากมือถือ เช่น JPG, PNG, WEBP</p>
          </div>
          <p className="text-xs text-muted-foreground">แตะเพื่อเปิดตัวเลือกไฟล์</p>
        </div>

        {selectedFile && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/70 p-3">
            <p className="text-sm text-muted-foreground">
              เลือกไฟล์: <span className="font-medium text-foreground">{selectedFile.name}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={triggerReceiptUpload}>
                <Upload className="mr-2 h-4 w-4" />
                Replace Image
              </Button>
              <Button variant="secondary" onClick={clearLocalData}>
                Clear Saved Draft
              </Button>
              <Button variant="secondary" onClick={handleReset} disabled={isBusy}>
                ล้างผลลัพธ์ OCR
              </Button>
            </div>
          </div>
        )}

        {isBusy && (
          <div className="mt-4 rounded-2xl border bg-background p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
              {progress.statusText}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.progress}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">กำลังประมวลผล {progress.progress}%</p>
          </div>
        )}

        {previewUrl && (
          <div className="mt-4">
            <p className="mb-2 text-sm font-semibold">ภาพใบเสร็จ</p>
            <img src={previewUrl} alt="Receipt preview" className="max-h-80 w-full rounded-2xl border object-contain bg-background" />
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            OCR Error: {error}
          </div>
        )}
      </section>

      {result && (
        <>
          <section className="mt-6 rounded-3xl border bg-card p-4 sm:p-6">
            <h2 className="text-lg font-bold">Members</h2>
            <div className="mt-4 space-y-2">
              {members.map((member) => (
                <div key={member.id} className="grid gap-2 rounded-2xl border bg-background/80 p-3 md:grid-cols-12 md:items-center">
                  <div className="md:col-span-3">
                    <label className="text-xs text-muted-foreground">Name</label>
                    <input
                      value={member.name}
                      onChange={(event) => updateMember(member.id, 'name', event.target.value)}
                      className="mt-1 h-9 w-full rounded-lg border px-2 text-sm"
                    />
                  </div>
                  <div className="md:col-span-4">
                    <label className="text-xs text-muted-foreground">PromptPay (phone/tax id)</label>
                    <input
                      value={member.promptPayId}
                      onChange={(event) => updateMember(member.id, 'promptPayId', event.target.value)}
                      placeholder="0812345678"
                      className="mt-1 h-9 w-full rounded-lg border px-2 text-sm"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <label className="text-xs text-muted-foreground">Paid</label>
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      value={paidByMember[member.id] ?? 0}
                      onChange={(event) => setPaidByMember((prev) => ({ ...prev, [member.id]: Number(event.target.value) || 0 }))}
                      className="mt-1 h-9 w-full rounded-lg border px-2 text-sm"
                    />
                  </div>
                  <div className="flex items-end md:col-span-2 md:justify-end">
                    <Button variant="secondary" onClick={() => removeMember(member.id)} disabled={members.length <= 1}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <input
                value={newMemberName}
                onChange={(event) => setNewMemberName(event.target.value)}
                placeholder="เพิ่มชื่อเพื่อน"
                className="h-10 rounded-xl border bg-background px-3 text-sm outline-none ring-primary/40 placeholder:text-muted-foreground focus:ring"
              />
              <Button onClick={addMember}>Add Member</Button>
            </div>
          </section>

          <section className="mt-6 grid gap-4 xl:grid-cols-5">
            <article className="rounded-2xl border bg-card p-4 xl:col-span-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Bill Items</h3>

              <div className="mt-3 space-y-3">
                {items.map((item) => {
                  const split = calcItemSplit(item, members)
                  const pctSum = item.consumerIds.reduce((sum, id) => sum + (item.percentageByUser[id] ?? 0), 0)
                  const exactSum = item.consumerIds.reduce((sum, id) => sum + (item.exactByUser[id] ?? 0), 0)

                  return (
                    <div key={item.id} className="rounded-2xl border bg-background/80 p-3">
                      <div className="grid gap-2 sm:grid-cols-5">
                        <input
                          value={item.name}
                          onChange={(event) => updateItem(item.id, 'name', event.target.value)}
                          className="h-10 rounded-xl border px-3 text-sm sm:col-span-3"
                        />
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={item.amount}
                          onChange={(event) => updateItem(item.id, 'amount', Number(event.target.value) || 0)}
                          className="h-10 rounded-xl border px-3 text-sm"
                        />
                        <select
                          value={item.splitMode}
                          onChange={(event) => updateItem(item.id, 'splitMode', event.target.value as SplitMode)}
                          className="h-10 rounded-xl border bg-card px-2 text-sm"
                        >
                          <option value="equally">equally</option>
                          <option value="itemized">itemized</option>
                          <option value="percentage">percentage</option>
                          <option value="exact">exact</option>
                        </select>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {members.map((member) => {
                          const checked = item.consumerIds.includes(member.id)
                          return (
                            <label key={member.id} className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs">
                              <input type="checkbox" checked={checked} onChange={() => toggleConsumer(item.id, member.id)} />
                              {member.name}
                            </label>
                          )
                        })}
                      </div>

                      {item.splitMode === 'percentage' && (
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {item.consumerIds.map((memberId) => {
                            const member = members.find((m) => m.id === memberId)
                            if (!member) return null
                            return (
                              <label key={memberId} className="flex items-center justify-between gap-2 rounded-xl border p-2 text-xs">
                                <span>{member.name}</span>
                                <input
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  value={item.percentageByUser[memberId] ?? 0}
                                  onChange={(event) => {
                                    const value = Number(event.target.value) || 0
                                    updateItem(item.id, 'percentageByUser', {
                                      ...item.percentageByUser,
                                      [memberId]: value,
                                    })
                                  }}
                                  className="h-8 w-24 rounded-lg border px-2 text-right"
                                />
                              </label>
                            )
                          })}
                          <p className="text-xs text-muted-foreground sm:col-span-2">รวมเปอร์เซ็นต์: {pctSum.toFixed(2)}%</p>
                        </div>
                      )}

                      {item.splitMode === 'exact' && (
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {item.consumerIds.map((memberId) => {
                            const member = members.find((m) => m.id === memberId)
                            if (!member) return null
                            return (
                              <label key={memberId} className="flex items-center justify-between gap-2 rounded-xl border p-2 text-xs">
                                <span>{member.name}</span>
                                <input
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  value={item.exactByUser[memberId] ?? 0}
                                  onChange={(event) => {
                                    const value = Number(event.target.value) || 0
                                    updateItem(item.id, 'exactByUser', {
                                      ...item.exactByUser,
                                      [memberId]: value,
                                    })
                                  }}
                                  className="h-8 w-24 rounded-lg border px-2 text-right"
                                />
                              </label>
                            )
                          })}
                          <p className="text-xs text-muted-foreground sm:col-span-2">รวมยอด exact: ฿{exactSum.toFixed(2)}</p>
                        </div>
                      )}

                      <div className="mt-3 rounded-lg bg-muted/40 p-2 text-xs text-muted-foreground">
                        {members.map((member) => (
                          <span key={member.id} className="mr-3 inline-block">
                            {member.name}: ฿{round2(split[member.id] ?? 0).toFixed(2)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </article>

            <article className="rounded-2xl border bg-card p-4 xl:col-span-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Allocation & Totals</h3>

              <div className="mt-3 space-y-2 rounded-xl border bg-background/80 p-3 text-sm">
                <label className="grid grid-cols-2 items-center gap-3">
                  <span>Service charge</span>
                  <input
                    type="number"
                    step="0.01"
                    value={serviceCharge}
                    onChange={(event) => setServiceCharge(Number(event.target.value) || 0)}
                    className="h-9 rounded-lg border px-2 text-right"
                  />
                </label>
                <label className="grid grid-cols-2 items-center gap-3">
                  <span>VAT</span>
                  <input
                    type="number"
                    step="0.01"
                    value={vat}
                    onChange={(event) => setVat(Number(event.target.value) || 0)}
                    className="h-9 rounded-lg border px-2 text-right"
                  />
                </label>
                <label className="grid grid-cols-2 items-center gap-3">
                  <span>Discount</span>
                  <input
                    type="number"
                    step="0.01"
                    value={discount}
                    onChange={(event) => setDiscount(Number(event.target.value) || 0)}
                    className="h-9 rounded-lg border px-2 text-right"
                  />
                </label>
                <label className="grid grid-cols-2 items-center gap-3">
                  <span>Allocation mode</span>
                  <select
                    value={allocationMode}
                    onChange={(event) => setAllocationMode(event.target.value as AllocationMode)}
                    className="h-9 rounded-lg border bg-card px-2"
                  >
                    <option value="proportional">proportional</option>
                    <option value="equal">equal</option>
                  </select>
                </label>
              </div>

              <ul className="mt-3 space-y-2">
                {members.map((member) => (
                  <li key={member.id} className="rounded-xl border bg-background/80 p-3 text-sm">
                    <div className="flex items-center justify-between font-medium">
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: member.color }} />
                        {member.name}
                      </span>
                      <span className="text-primary">฿{(finalDueByMember[member.id] ?? 0).toFixed(2)}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      base ฿{(baseTotalsByMember[member.id] ?? 0).toFixed(2)} + adj ฿{(adjustmentsByMember[member.id] ?? 0).toFixed(2)}
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-3 rounded-xl bg-secondary/50 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span>Grand total</span>
                  <strong>฿{grandTotal.toFixed(2)}</strong>
                </div>
                <div className="mt-1 flex items-center justify-between text-muted-foreground">
                  <span>OCR total</span>
                  <span>{result.summary.total !== null ? `฿${result.summary.total.toFixed(2)}` : '-'}</span>
                </div>
              </div>
            </article>
          </section>

          <section className="mt-6 grid gap-4 xl:grid-cols-3">
            <article className="rounded-2xl border bg-card p-4 xl:col-span-1">
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <Wallet className="h-4 w-4" />
                Net Position
              </h3>
              <ul className="mt-3 space-y-2 text-sm">
                {members.map((member) => (
                  <li key={member.id} className="flex items-center justify-between rounded-xl border bg-background/80 px-3 py-2">
                    <span>{member.name}</span>
                    <span className={(netByMember[member.id] ?? 0) >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                      {(netByMember[member.id] ?? 0) >= 0 ? '+' : ''}
                      {(netByMember[member.id] ?? 0).toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            </article>

            <article className="rounded-2xl border bg-card p-4 xl:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Settlements + QR</h3>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={exportBill}>
                    <Download className="mr-2 h-4 w-4" />
                    Export JSON
                  </Button>
                  <Button variant="secondary" onClick={triggerImportUpload}>
                    <Upload className="mr-2 h-4 w-4" />
                    Import JSON
                  </Button>
                  <Button variant="secondary" onClick={() => void copyText(JSON.stringify({ members, items, serviceCharge, vat, discount, allocationMode, paidByMember }, null, 2))}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy State
                  </Button>
                </div>
              </div>

              {settlements.length === 0 ? (
                <p className="mt-3 rounded-xl border bg-muted/30 p-3 text-sm text-muted-foreground">ทุกคนเคลียร์แล้ว หรือข้อมูลการจ่ายยังไม่พอสำหรับสร้างรายการโอน</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {settlements.map((settlement, index) => {
                    const from = members.find((m) => m.id === settlement.fromMemberId)
                    const to = members.find((m) => m.id === settlement.toMemberId)
                    if (!from || !to) return null

                    const payload = settlement.promptPayPayload
                    const recipientTarget = toPromptPayTarget(to.promptPayId)
                    const payloadToShow = payload ?? (recipientTarget ? buildPromptPayPayload(to.promptPayId, settlement.amount) : null)

                    return (
                      <li key={`${settlement.fromMemberId}-${settlement.toMemberId}-${index}`} className="rounded-xl border bg-background/80 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium">
                            {from.name} โอนให้ {to.name} = ฿{settlement.amount.toFixed(2)}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button variant="secondary" onClick={() => openSettlement(settlement)}>
                              View QR
                            </Button>
                            <Button variant="secondary" onClick={() => void copySettlement(settlement)}>
                              <Copy className="mr-2 h-4 w-4" />
                              Copy
                            </Button>
                            {payloadToShow && (
                              <Button variant="secondary" onClick={() => void copyText(payloadToShow)}>
                                Copy Payload
                              </Button>
                            )}
                          </div>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          PromptPay target: {to.promptPayId ? toPromptPayTarget(to.promptPayId) ?? 'invalid' : 'ยังไม่ได้ตั้งค่า'}
                        </p>
                        <div className="mt-3 grid gap-3 md:grid-cols-[auto_1fr] md:items-center">
                          <div className="rounded-2xl border bg-white p-2">
                            {payloadToShow ? <QrCode value={payloadToShow} size={160} /> : <div className="flex h-40 w-40 items-center justify-center rounded-xl bg-muted text-xs text-muted-foreground">Add PromptPay ID</div>}
                          </div>
                          <textarea
                            readOnly
                            value={payloadToShow ?? 'กรอก PromptPay receiver (เบอร์โทร 10 หลัก หรือเลขผู้เสียภาษี 13 หลัก) เพื่อสร้าง payload'}
                            className="h-40 w-full rounded-lg border bg-card p-2 text-xs"
                          />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </article>
          </section>

          <section className="mt-6 rounded-2xl border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Raw OCR Text</h3>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => void copyText(result.rawText)}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy OCR
                </Button>
                <Button variant="secondary" onClick={exportBill}>
                  <Download className="mr-2 h-4 w-4" />
                  Export JSON
                </Button>
              </div>
            </div>
            <pre className="mt-3 max-h-72 overflow-auto rounded-xl border bg-background/80 p-3 text-xs leading-5 text-muted-foreground">
              {result.rawText || 'No text detected.'}
            </pre>
          </section>
        </>
      )}

      {activeSettlement && (
        <section className="mt-6 rounded-3xl border bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Settlement QR Preview</p>
              <h2 className="text-xl font-bold">
                {members.find((m) => m.id === activeSettlement.fromMemberId)?.name} → {members.find((m) => m.id === activeSettlement.toMemberId)?.name}
              </h2>
            </div>
            <Button variant="secondary" onClick={() => setSelectedSettlement(null)}>
              Close
            </Button>
          </div>

          {activeSettlement.promptPayPayload ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-[280px_1fr]">
              <QrCode value={activeSettlement.promptPayPayload} size={280} />
              <div className="space-y-3">
                <p className="rounded-xl border bg-background/80 p-3 text-sm">
                  Amount: <strong>฿{activeSettlement.amount.toFixed(2)}</strong>
                </p>
                <textarea readOnly value={activeSettlement.promptPayPayload} className="h-40 w-full rounded-xl border bg-background p-3 text-xs" />
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void copyText(activeSettlement.promptPayPayload ?? '')}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy Payload
                  </Button>
                  <Button variant="secondary" onClick={() => void copyText(JSON.stringify(activeSettlement, null, 2))}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy Settlement JSON
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-4 rounded-xl border bg-muted/30 p-3 text-sm text-muted-foreground">PromptPay receiver ยังไม่พร้อมสำหรับ settlement นี้</p>
          )}
        </section>
      )}

      {result && (
        <section className="mt-6 grid gap-4 sm:grid-cols-3">
          <article className="rounded-2xl border bg-card p-5">
            <Receipt className="h-5 w-5 text-primary" />
            <h2 className="mt-3 font-bold">QR Ready</h2>
            <p className="mt-1 text-sm text-muted-foreground">สร้างภาพ QR จาก PromptPay payload แบบทันที</p>
          </article>

          <article className="rounded-2xl border bg-card p-5">
            <Users className="h-5 w-5 text-primary" />
            <h2 className="mt-3 font-bold">Copy & Share</h2>
            <p className="mt-1 text-sm text-muted-foreground">คัดลอก settlement หรือ payload ไปแชทได้ง่าย</p>
          </article>

          <article className="rounded-2xl border bg-card p-5">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="mt-3 font-bold">Import / Export</h2>
            <p className="mt-1 text-sm text-muted-foreground">ย้ายบิลระหว่างเครื่องด้วย JSON ได้ทันที</p>
          </article>
        </section>
      )}

      {!result && (
        <section className="mt-6 grid gap-4 sm:grid-cols-3">
          <article className="rounded-2xl border bg-card p-5">
            <Receipt className="h-5 w-5 text-primary" />
            <h2 className="mt-3 font-bold">Smart Allocation</h2>
            <p className="mt-1 text-sm text-muted-foreground">กระจาย service/VAT/discount แบบ equal หรือ proportional</p>
          </article>

          <article className="rounded-2xl border bg-card p-5">
            <Users className="h-5 w-5 text-primary" />
            <h2 className="mt-3 font-bold">Simplify Debts</h2>
            <p className="mt-1 text-sm text-muted-foreground">ลดจำนวนครั้งการโอนด้วยการจับคู่หนี้แบบ greedy</p>
          </article>

          <article className="rounded-2xl border bg-card p-5">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="mt-3 font-bold">PromptPay + Save Draft</h2>
            <p className="mt-1 text-sm text-muted-foreground">สร้าง payload พร้อมบันทึกสถานะไว้ใน localStorage</p>
          </article>
        </section>
      )}
    </main>
  )
}

export default App
