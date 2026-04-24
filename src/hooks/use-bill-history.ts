import { useState, useEffect, useCallback } from 'react'
import * as db from '../lib/bill-db'
import { saveBillToCloud, fetchUserBills, type DbBill } from '../lib/supabase'

export interface BillHistoryMeta {
  id: string
  title: string
  updatedAt: number
  isCloud?: boolean
  data?: any
}

export function useBillHistory(userId?: string | null) {
  const [history, setHistory] = useState<BillHistoryMeta[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load history from IndexedDB and Supabase on mount
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true)
      try {
        const localBills = await db.listBills()
        let cloudBills: BillHistoryMeta[] = []
        
        if (userId) {
          const dbBills = await fetchUserBills(userId)
          cloudBills = dbBills.map((b: DbBill) => ({
            id: b.id,
            title: b.name,
            updatedAt: b.updated_at 
              ? new Date(b.updated_at).getTime() 
              : (b.created_at ? new Date(b.created_at).getTime() : Date.now()),
            isCloud: true,
            data: b.bill_data
          }))
        }

        // Deduplicate: cloud bills take precedence over local bills with the same ID
        const cloudIds = new Set(cloudBills.map(b => b.id))
        const uniqueLocalBills = localBills.filter(b => !cloudIds.has(b.id))
        const combined = [...cloudBills, ...uniqueLocalBills].sort((a, b) => b.updatedAt - a.updatedAt)
        setHistory(combined)
      } catch (err) {
        console.error('Failed to load history:', err)
      } finally {
        setIsLoading(false)
      }
    }
    
    loadData()
  }, [userId])

  const addOrUpdateBill = useCallback(async (id: string, title: string, state: object, userId?: string | null) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.saveBill(id, title, state as any)
      
      if (userId) {
        const grandTotal = (state as any).grandTotal || 0
        void saveBillToCloud(id, userId, title, grandTotal, state)
      }

      setHistory((prev: BillHistoryMeta[]) => {
        const filtered = prev.filter((h: BillHistoryMeta) => h.id !== id)
        return [{ id, title, updatedAt: Date.now() }, ...filtered]
      })
    } catch (err) {
      console.error('[useBillHistory] Failed to save bill:', err)
    }
  }, [])

  const removeBill = useCallback(async (id: string) => {
    try {
      await db.deleteBill(id)
      setHistory((prev: BillHistoryMeta[]) => prev.filter((h: BillHistoryMeta) => h.id !== id))
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
