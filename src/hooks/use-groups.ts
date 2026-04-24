import { useState, useCallback, useEffect } from 'react'
import { saveGroupToCloud, fetchUserGroups, deleteGroupFromCloud } from '../lib/supabase'

export interface SavedGroup {
  id: string
  name: string
  members: { 
    name: string; 
    promptPayId: string;
    pictureUrl?: string;
    userId?: string;
  }[]
}

const GROUPS_KEY = 'bill-splitter-saved-groups'

export function useGroups(userId?: string) {
  const [groups, setGroups] = useState<SavedGroup[]>(() => {
    try {
      const data = localStorage.getItem(GROUPS_KEY)
      return data ? JSON.parse(data) : []
    } catch {
      return []
    }
  })

  // Fetch from cloud when userId is available
  useEffect(() => {
    if (!userId) return

    fetchUserGroups(userId).then(cloudGroups => {
      if (cloudGroups.length > 0) {
        // Map DB structure to local structure
        const mapped: SavedGroup[] = cloudGroups.map(g => ({
          id: g.id,
          name: g.name,
          members: g.members
        }))
        
        setGroups(mapped)
        localStorage.setItem(GROUPS_KEY, JSON.stringify(mapped))
      }
    })
  }, [userId])

  const saveGroup = useCallback((name: string, members: { name: string; promptPayId: string; pictureUrl?: string; userId?: string }[]) => {
    const newGroupId = crypto.randomUUID()
    
    // Save to local
    setGroups((prev) => {
      const newGroups = [...prev, { id: newGroupId, name, members }]
      localStorage.setItem(GROUPS_KEY, JSON.stringify(newGroups))
      return newGroups
    })

    // Save to cloud if logged in
    if (userId) {
      saveGroupToCloud(userId, name, members)
    }
  }, [userId])

  const updateGroupName = useCallback((id: string, newName: string) => {
    // Update local
    setGroups((prev) => {
      const updated = prev.map((g) => g.id === id ? { ...g, name: newName } : g)
      localStorage.setItem(GROUPS_KEY, JSON.stringify(updated))
      return updated
    })

    // Update cloud if logged in
    if (userId) {
      const group = groups.find(g => g.id === id)
      if (group) {
        saveGroupToCloud(userId, newName, group.members, id)
      }
    }
  }, [userId, groups])

  return { groups, saveGroup, deleteGroup, updateGroupName }
}
