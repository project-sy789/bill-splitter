import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials missing. Cloud sync disabled.')
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '')

export interface DbBill {
  id: string
  user_id: string
  name: string
  total_amount: number
  bill_data: any
  created_at?: string
}

export async function saveBillToCloud(userId: string, name: string, total: number, data: any) {
  if (!supabaseUrl) return

  const { error } = await supabase
    .from('bills')
    .upsert({
      user_id: userId,
      name: name,
      total_amount: total,
      bill_data: data,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' })

  if (error) {
    console.error('Error saving bill to Supabase:', error)
  }
}

export async function fetchUserBills(userId: string): Promise<DbBill[]> {
  if (!supabaseUrl) return []

  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Error fetching bills from Supabase:', error)
    return []
  }

  return data || []
}

export async function deleteBillFromCloud(billId: string) {
  if (!supabaseUrl) return

  const { error } = await supabase
    .from('bills')
    .delete()
    .eq('id', billId)

  if (error) {
    console.error('Error deleting bill from Supabase:', error)
  }
}

export async function updateBillData(billId: string, data: any) {
  if (!supabaseUrl) return

  const { error } = await supabase
    .from('bills')
    .update({
      bill_data: data,
      updated_at: new Date().toISOString()
    })
    .eq('id', billId)

  if (error) {
    console.error('Error updating bill in Supabase:', error)
  }
}

export function subscribeToBill(billId: string, onUpdate: (data: any) => void) {
  if (!supabaseUrl) return () => {}

  const channel = supabase
    .channel(`bill:${billId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'bills',
        filter: `id=eq.${billId}`
      },
      (payload) => {
        onUpdate(payload.new.bill_data)
      }
    )
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}

export async function fetchBillById(billId: string): Promise<DbBill | null> {
  if (!supabaseUrl) return null

  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('id', billId)
    .single()

  if (error) {
    console.error('Error fetching bill by ID:', error)
    return null
  }

  return data
}

// ── Usage Tracking Functions ──

export async function logUsage(userId: string, actionType: string) {
  if (!supabaseUrl) return

  const { error } = await supabase
    .from('usage_logs')
    .insert({
      user_id: userId,
      action_type: actionType
    })

  if (error) {
    console.error('Error logging usage:', error)
  }
}

export async function fetchUsageStats(userId: string) {
  if (!supabaseUrl) return { daily: 0, weekly: 0 }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  
  const lastWeek = new Date()
  lastWeek.setDate(lastWeek.getDate() - 7)

  // Count daily
  const { count: dailyCount, error: dailyError } = await supabase
    .from('usage_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', today.toISOString())

  // Count weekly
  const { count: weeklyCount, error: weeklyError } = await supabase
    .from('usage_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', lastWeek.toISOString())

  if (dailyError || weeklyError) {
    console.error('Error fetching usage stats:', dailyError || weeklyError)
  }

  return {
    daily: dailyCount || 0,
    weekly: weeklyCount || 0
  }
}

export async function fetchRemoteAffiliateLinks(): Promise<string[]> {
  if (!supabaseUrl) return []

  const { data, error } = await supabase
    .from('affiliate_links')
    .select('url')
    .eq('is_active', true)

  if (error) {
    console.error('Error fetching affiliate links:', error)
    return []
  }

  return data.map(item => item.url)
}
