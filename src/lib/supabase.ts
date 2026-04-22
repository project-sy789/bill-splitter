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
