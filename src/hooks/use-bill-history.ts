import { useState, useCallback } from 'react'

export interface BillHistoryMeta {
  id: string
  title: string
  updatedAt: number
}

const HISTORY_INDEX_KEY = 'bill-splitter-history-index'

export function useBillHistory() {
  const [history, setHistory] = useState<BillHistoryMeta[]>(() => {
    try {
      const idx = localStorage.getItem(HISTORY_INDEX_KEY)
      return idx ? JSON.parse(idx) : []
    } catch {
      return []
    }
  })

  // We don't need the useEffect for initial load anymore.

  const addOrUpdateBill = useCallback((id: string, title: string) => {
    setHistory((prev) => {
      const filtered = prev.filter((h) => h.id !== id)
      const newHistory = [{ id, title, updatedAt: Date.now() }, ...filtered]
      localStorage.setItem(HISTORY_INDEX_KEY, JSON.stringify(newHistory))
      return newHistory
    })
  }, [])

  const removeBill = useCallback((id: string) => {
    setHistory((prev) => {
      const newHistory = prev.filter((h) => h.id !== id)
      localStorage.setItem(HISTORY_INDEX_KEY, JSON.stringify(newHistory))
      localStorage.removeItem(`bill-splitter-state-${id}`)
      return newHistory
    })
  }, [])

  return {
    history,
    addOrUpdateBill,
    removeBill,
  }
}
