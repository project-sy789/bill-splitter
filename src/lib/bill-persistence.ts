import type { SplitMode } from '../types/bill'

export type AllocationMode = 'proportional' | 'equal'

export interface MemberDraft {
  id: string
  name: string
  color: string
  promptPayId: string
}

export interface BillItemDraft {
  id: string
  name: string
  amount: number
  splitMode: SplitMode
  consumerIds: string[]
  percentageByUser: Record<string, number>
  exactByUser: Record<string, number>
}

export interface ManualBill {
  id: string
  name: string
  amount: number
}

export interface PersistedBillState {
  members: MemberDraft[]
  items: BillItemDraft[]
  serviceCharge: number
  vat: number
  discount: number
  allocationMode: AllocationMode
  paidByMember: Record<string, number>
  settlementStatus?: Record<string, boolean>
  manualBills?: ManualBill[]
}

export const STORAGE_KEY = 'bill-splitter:v2'

export function safeParseBillState(raw: string | null): PersistedBillState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PersistedBillState
    if (!Array.isArray(parsed.members) || !Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    return null
  }
}
