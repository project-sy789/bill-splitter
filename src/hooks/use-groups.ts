import { useState, useCallback } from 'react'

export interface SavedGroup {
  id: string
  name: string
  members: { name: string; promptPayId: string }[]
}

const GROUPS_KEY = 'bill-splitter-saved-groups'

export function useGroups() {
  const [groups, setGroups] = useState<SavedGroup[]>(() => {
    try {
      const data = localStorage.getItem(GROUPS_KEY)
      return data ? JSON.parse(data) : []
    } catch {
      return []
    }
  })

  const saveGroup = useCallback((name: string, members: { name: string; promptPayId: string }[]) => {
    const newGroupId = crypto.randomUUID()
    setGroups((prev) => {
      const newGroups = [...prev, { id: newGroupId, name, members }]
      localStorage.setItem(GROUPS_KEY, JSON.stringify(newGroups))
      return newGroups
    })
  }, [])

  const deleteGroup = useCallback((id: string) => {
    setGroups((prev) => {
      const newGroups = prev.filter((g) => g.id !== id)
      localStorage.setItem(GROUPS_KEY, JSON.stringify(newGroups))
      return newGroups
    })
  }, [])

  return { groups, saveGroup, deleteGroup }
}
