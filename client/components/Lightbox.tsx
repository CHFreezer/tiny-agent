import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

// 模块级 pub/sub：任意组件调 showLightbox(url) 即可弹预览，无需层层传 prop
let listener: ((url: string | null) => void) | null = null

export function showLightbox(url: string) {
  listener?.(url)
}

export function Lightbox() {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    listener = setUrl
    return () => {
      if (listener === setUrl) listener = null
    }
  }, [])
  // Esc 关闭
  useEffect(() => {
    if (!url) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUrl(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [url])
  if (!url) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={() => setUrl(null)}
    >
      <button
        type="button"
        className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        onClick={() => setUrl(null)}
        aria-label="关闭"
      >
        <X className="size-5" />
      </button>
      <img
        src={url}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        alt=""
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}