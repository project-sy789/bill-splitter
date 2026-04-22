import liff from '@line/liff'

export const LIFF_ID = import.meta.env.VITE_LIFF_ID || ''

export interface LineProfile {
  userId: string
  displayName: string
  pictureUrl?: string
  statusMessage?: string
}

export async function initLiff(): Promise<LineProfile | null> {
  if (!LIFF_ID) {
    console.error('LIFF ID is missing')
    return null
  }

  try {
    await liff.init({ liffId: LIFF_ID })
    if (liff.isLoggedIn()) {
      return (await liff.getProfile()) as LineProfile
    }
  } catch (err) {
    console.error('LIFF initialization failed', err)
  }
  return null
}

export function login() {
  if (!liff.isLoggedIn()) {
    liff.login()
  }
}

export function logout() {
  if (liff.isLoggedIn()) {
    liff.logout()
    window.location.reload()
  }
}

export async function shareBillToFriends(title: string, amount: number, promptPayId: string) {
  if (!liff.isLoggedIn()) {
    liff.login()
    return
  }

  if (liff.isApiAvailable('shareTargetPicker')) {
    try {
      const result = await liff.shareTargetPicker([
        {
          type: 'flex',
          altText: `แจ้งยอดหารบิล: ${title}`,
          contents: {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  text: '💰 แจ้งยอดหารบิล',
                  weight: 'bold',
                  size: 'xl',
                  color: '#7C3AED',
                },
                {
                  type: 'text',
                  text: title,
                  size: 'md',
                  color: '#4B5563',
                  margin: 'md',
                },
                {
                  type: 'separator',
                  margin: 'lg',
                },
                {
                  type: 'box',
                  layout: 'vertical',
                  margin: 'lg',
                  spacing: 'sm',
                  contents: [
                    {
                      type: 'box',
                      layout: 'horizontal',
                      contents: [
                        {
                          type: 'text',
                          text: 'ยอดที่ต้องจ่าย',
                          size: 'sm',
                          color: '#6B7280',
                        },
                        {
                          type: 'text',
                          text: `฿${amount.toFixed(2)}`,
                          size: 'sm',
                          color: '#111827',
                          align: 'end',
                          weight: 'bold',
                        },
                      ],
                    },
                  ],
                },
                {
                  type: 'button',
                  action: {
                    type: 'uri',
                    label: 'กดดูรายละเอียด / จ่ายเงิน',
                    uri: `https://liff.line.me/${LIFF_ID}`,
                  },
                  style: 'primary',
                  color: '#7C3AED',
                  margin: 'xl',
                  height: 'sm',
                },
              ],
            },
          },
        } as any,
      ])
      return result
    } catch (err) {
      console.error('Share Target Picker failed', err)
    }
  } else {
    console.warn('Share Target Picker is not available')
  }
}
