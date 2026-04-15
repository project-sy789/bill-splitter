interface QrCodeProps {
  value: string
  size?: number
  title?: string
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function QrCode({ value, size = 280, title = 'PromptPay QR Code' }: QrCodeProps) {
  const encoded = encodeURIComponent(value)
  const imgSrc = `https://quickchart.io/qr?size=${size}&text=${encoded}`
  const svgFallback = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="100%" height="100%" fill="white"/>
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="14" fill="#111">${escapeXml(title)}</text>
    </svg>`,
  )}`

  return <img src={imgSrc} alt={title} width={size} height={size} className="h-auto w-full rounded-xl border bg-white object-contain" onError={(event) => {
    event.currentTarget.src = svgFallback
  }} />
}
