export interface SettlementTx {
  fromId: string
  toId: string
  amount: number
}

interface BalanceRow {
  id: string
  amount: number
}

const EPS = 0.005

export function simplifyDebts(balances: Record<string, number>): SettlementTx[] {
  const debtors: BalanceRow[] = []
  const creditors: BalanceRow[] = []

  Object.entries(balances).forEach(([id, amount]) => {
    if (amount > EPS) debtors.push({ id, amount })
    else if (amount < -EPS) creditors.push({ id, amount: -amount })
  })

  debtors.sort((a, b) => b.amount - a.amount)
  creditors.sort((a, b) => b.amount - a.amount)

  const txs: SettlementTx[] = []
  let i = 0
  let j = 0

  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount)
    if (pay > EPS) {
      txs.push({
        fromId: debtors[i].id,
        toId: creditors[j].id,
        amount: Number(pay.toFixed(2)),
      })
    }

    debtors[i].amount -= pay
    creditors[j].amount -= pay

    if (debtors[i].amount <= EPS) i += 1
    if (creditors[j].amount <= EPS) j += 1
  }

  return txs
}
