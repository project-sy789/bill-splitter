export type SplitMode = 'equally' | 'itemized' | 'percentage' | 'exact'

export interface User {
  id: string
  name: string
  color?: string
  isActive: boolean
}

export interface Item {
  id: string
  name: string
  quantity: number
  unitPrice: number
  totalPrice: number
  consumerIds: string[]
  splitMode: SplitMode
  notes?: string
}

export interface BillMeta {
  merchantName?: string
  receiptDate?: string
  currency: 'THB'
}

export interface BillTotals {
  subtotal: number
  vat: number
  serviceCharge: number
  discount: number
  grandTotal: number
}

export interface Bill {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  members: User[]
  items: Item[]
  totals: BillTotals
  meta: BillMeta
}
