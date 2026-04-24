import type { SplitMode } from '../types/bill'

export type AllocationMode = 'proportional' | 'equal'

export interface MemberDraft {
  id: string
  name: string
  color: string
  promptPayId: string
  pictureUrl?: string
  userId?: string
}

export interface BillItemDraft {
  id: string
  name: string
  amount: number
  itemDiscount: number
  splitMode: SplitMode
  consumerIds: string[]
  percentageByUser: Record<string, number>
  exactByUser: Record<string, number>
  billId?: string
}

export type FeeInputMode = 'amount' | 'percent'

export interface ManualBill {
  id: string
  name: string
  amount: number
  serviceCharge: number
  vat: number
  itemDiscount: number
  billDiscount: number
  discount?: number
  vatIncluded: boolean
  serviceChargeMode?: FeeInputMode
  vatMode?: FeeInputMode
  discountMode?: FeeInputMode
}

export interface PersistedBillState {
  version: number
  members: MemberDraft[]
  items: BillItemDraft[]
  results?: any[] // Store OCR results to preserve receipt context
  serviceCharge?: number
  vat?: number
  itemDiscount?: number
  billDiscount?: number
  discount?: number
  allocationMode: AllocationMode
  paidByMember: Record<string, number>
  settlementStatus?: Record<string, boolean>
  manualBills?: ManualBill[]
  receiptPayerMap?: Record<string, string>
  isLocked?: boolean
  createdBy?: string
  grandTotal?: number
}

export const STORAGE_KEY = 'bill-splitter:v4'
export const PERSISTED_BILL_STATE_VERSION = 4

export function safeParseBillState(raw: string | null): PersistedBillState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedBillState> & { version?: number }
    if (!Array.isArray(parsed.members) || !Array.isArray(parsed.items)) return null
    return {
      version: parsed.version ?? 1,
      members: parsed.members,
      items: parsed.items,
      results: parsed.results ?? [],
      serviceCharge: parsed.serviceCharge ?? 0,
      vat: parsed.vat ?? 0,
      itemDiscount: parsed.itemDiscount ?? 0,
      billDiscount: parsed.billDiscount ?? parsed.discount ?? 0,
      discount: parsed.billDiscount ?? parsed.discount ?? 0,
      allocationMode: parsed.allocationMode ?? 'proportional',
      paidByMember: parsed.paidByMember ?? {},
      settlementStatus: parsed.settlementStatus ?? {},
      manualBills: parsed.manualBills ?? [],
      receiptPayerMap: parsed.receiptPayerMap ?? {},
      isLocked: parsed.isLocked ?? false,
      createdBy: parsed.createdBy,
      grandTotal: parsed.grandTotal ?? 0
    }
  } catch {
    return null
  }
}
