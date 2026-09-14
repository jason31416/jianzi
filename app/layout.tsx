import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '见字 JIANZI',
  description: '一张一张地遇见知乎上那些写得认真的人，然后走进去读完他写的东西。',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
