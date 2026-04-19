/**
 * bill-db.ts — IndexedDB wrapper for Bill Splitter
 *
 * Replaces localStorage for bill state storage.
 * Provides async CRUD operations with automatic migration from localStorage.
 *
 * DB: bill-splitter-db (v1)
 * Stores:
 *   bills    — { id, title, updatedAt, state }
 *   settings — { key, value }
 */

import { PERSISTED_BILL_STATE_VERSION, type PersistedBillState } from './bill-persistence'

const DB_NAME = 'bill-splitter-db'
const DB_VERSION = 1

export interface BillRecord {
  id: string
  title: string
  updatedAt: number
  state: PersistedBillState
}

// ── Singleton DB connection ───────────────────────────────────────────────────

let _db: IDBDatabase | null = null

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db)

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('bills')) {
        const billsStore = db.createObjectStore('bills', { keyPath: 'id' })
        billsStore.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' })
      }
    }

    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result
      _db.onversionchange = () => { _db?.close(); _db = null }
      resolve(_db)
    }

    req.onerror = () => reject(req.error)
  })
}

// ── Generic IDB transaction helpers ──────────────────────────────────────────

function txGet<T>(
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const req = tx.objectStore(storeName).get(key)
        req.onsuccess = () => resolve(req.result as T | undefined)
        req.onerror = () => reject(req.error)
      }),
  )
}

function txPut(storeName: string, value: object): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const req = tx.objectStore(storeName).put(value)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      }),
  )
}

function txDelete(storeName: string, key: IDBValidKey): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const req = tx.objectStore(storeName).delete(key)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      }),
  )
}

function txGetAll<T>(storeName: string): Promise<T[]> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const req = tx.objectStore(storeName).getAll()
        req.onsuccess = () => resolve(req.result as T[])
        req.onerror = () => reject(req.error)
      }),
  )
}

// ── Bills API ─────────────────────────────────────────────────────────────────

export async function saveBill(
  id: string,
  title: string,
  state: PersistedBillState,
): Promise<void> {
  const record: BillRecord = { id, title, updatedAt: Date.now(), state: { ...state, version: PERSISTED_BILL_STATE_VERSION } }
  await txPut('bills', record)
}

export async function getBill(id: string): Promise<PersistedBillState | null> {
  const record = await txGet<BillRecord>('bills', id)
  return record?.state ?? null
}

export async function listBills(): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
  const all = await txGetAll<BillRecord>('bills')
  return all
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteBill(id: string): Promise<void> {
  await txDelete('bills', id)
}

// ── Settings API ──────────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const rec = await txGet<{ key: string; value: string }>('settings', key)
  return rec?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await txPut('settings', { key, value })
}

// ── Migration from localStorage ───────────────────────────────────────────────

/**
 * Runs once on startup: reads all bill-splitter-state-* keys from localStorage,
 * migrates them into IndexedDB, then removes the old keys.
 */
export async function migrateFromLocalStorage(): Promise<string | null> {
  // Migrate history index
  const historyRaw = localStorage.getItem('bill-splitter-history-index')
  let migratedCurrentId: string | null = null

  if (historyRaw) {
    try {
      const history: Array<{ id: string; title: string; updatedAt: number }> =
        JSON.parse(historyRaw)

      for (const { id, title, updatedAt } of history) {
        const stateRaw = localStorage.getItem(`bill-splitter-state-${id}`)
        if (stateRaw) {
          try {
            const state = JSON.parse(stateRaw) as PersistedBillState
            await saveBill(id, title, { ...state, version: state.version ?? 1 })
            localStorage.removeItem(`bill-splitter-state-${id}`)
          } catch {
            // Skip malformed entries
          }
        }
        // Also save with blank state if we at least know the id
        else {
          await txPut('bills', { id, title, updatedAt, state: null })
        }
      }

      localStorage.removeItem('bill-splitter-history-index')
    } catch {
      // Silently skip migration on parse failures
    }
  }

  // Migrate current bill ID to settings
  const currentId = localStorage.getItem('bill-splitter-current-id')
  if (currentId) {
    await setSetting('current-bill-id', currentId)
    localStorage.removeItem('bill-splitter-current-id')
    migratedCurrentId = currentId
  }

  // Migrate legacy single-bill state (before multi-bill support)
  const legacyState = localStorage.getItem('bill-splitter-state')
  if (legacyState && currentId) {
    try {
      const state = JSON.parse(legacyState) as PersistedBillState
      const existing = await getBill(currentId)
      if (!existing) {
        await saveBill(currentId, `บิลที่ย้ายมา`, state)
      }
      localStorage.removeItem('bill-splitter-state')
    } catch {
      // skip
    }
  }

  return migratedCurrentId
}
