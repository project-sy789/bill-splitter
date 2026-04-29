import { useState, useEffect, useCallback } from 'react'
import { fetchUserProfile, upsertUserProfile, type DbProfile } from '../lib/supabase'

export function useUserProfile(userId: string | null | undefined) {
  const [profile, setProfile] = useState<DbProfile | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!userId) { setProfile(null); return }
    setIsLoading(true)
    fetchUserProfile(userId)
      .then(p => setProfile(p))
      .finally(() => setIsLoading(false))
  }, [userId])

  const updateProfile = useCallback(async (patch: Partial<DbProfile>) => {
    if (!userId) return
    const next: DbProfile = { id: userId, ...profile, ...patch }
    setProfile(next)
    await upsertUserProfile(next)
  }, [userId, profile])

  return { profile, isLoading, updateProfile }
}
