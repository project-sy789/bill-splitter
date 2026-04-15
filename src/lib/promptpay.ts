const round2 = (value: number) => Number(value.toFixed(2))

function crc16(payload: string): string {
  let crc = 0xffff
  for (let i = 0; i < payload.length; i += 1) {
    crc ^= payload.charCodeAt(i) << 8
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

export function toPromptPayTarget(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')

  if (digits.length === 10 && digits.startsWith('0')) {
    return `0066${digits.slice(1)}`
  }

  if (digits.length === 13) return digits
  return null
}

export function buildPromptPayPayload(targetRaw: string, amount: number): string | null {
  const target = toPromptPayTarget(targetRaw)
  if (!target) return null

  const formatField = (id: string, value: string) => `${id}${value.length.toString().padStart(2, '0')}${value}`
  const merchantAccountInfo = formatField('00', 'A000000677010111') + formatField('01', target)

  const body = [
    formatField('00', '01'),
    formatField('01', '12'),
    formatField('29', merchantAccountInfo),
    formatField('58', 'TH'),
    formatField('53', '764'),
    formatField('54', round2(amount).toFixed(2)),
    formatField('63', ''),
  ].join('')

  return `${body}${crc16(body)}`
}

export function formatPromptPay(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 13)
  
  if (digits.startsWith('0') && digits.length <= 10) {
    if (digits.length <= 3) return digits
    if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`
  }
  
  if (digits.length <= 1) return digits
  if (digits.length <= 5) return `${digits.slice(0, 1)}-${digits.slice(1)}`
  if (digits.length <= 10) return `${digits.slice(0, 1)}-${digits.slice(1, 5)}-${digits.slice(5)}`
  if (digits.length <= 12) return `${digits.slice(0, 1)}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10)}`
  return `${digits.slice(0, 1)}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 12)}-${digits.slice(12, 13)}`
}

export function validatePromptPay(raw: string): boolean {
  if (!raw) return true // Empty is valid (not set)
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return true
  if (digits.length === 13) return true
  return false
}
