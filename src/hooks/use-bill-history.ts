import { useState, useEffect, useCallback } from 'react'
import * as db from '../lib/bill-db'

export interface BillHistoryMeta {
  id: string
  title: string
  updatedAt: number
}

export function useBillHistory() {
  const [history, setHistory] = useState<BillHistoryMeta[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load history from IndexedDB on mount
  useEffect(() => {
    db.listBills()
      .then((bills) => setHistory(bills))
      .catch(() => setHistory([]))
      .finally(() => setIsLoading(false))
  }, [])

  const addOrUpdateBill = useCallback(async (id: string, title: string, state: object) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.saveBill(id, title, state as any)
      setHistory((prev) => {
        const filtered = prev.filter((h) => h.id !== id)
        return [{ id, title, updatedAt: Date.now() }, ...filtered]
      })
    } catch (err) {
      console.error('[useBillHistory] Failed to save bill:', err)
    }
  }, [])

  const removeBill = useCallback(async (id: string) => {
    try {
      await db.deleteBill(id)
      setHistory((prev) => prev.filter((h) => h.id !== id))
    } catch (err) {
      console.error('[useBillHistory] Failed to delete bill:', err)
    }
  }, [])

  return {
    history,
    isLoading,
    addOrUpdateBill,
    removeBill,
  }
}
