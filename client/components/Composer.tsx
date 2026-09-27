import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { showLightbox } from '@/components/Lightbox'

export function Composer({
  busy,
  images,
  onSend,
  onStop,
  onAttach,
  onRemoveImage,
}: {
  busy: boolean
  images: string[]
  onSend: (text: string) => void
  onStop: () => void
  onAttach: (files: FileList) => void
  onRemoveImage: (index: number) => void
}) {
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    if (busy) {
      onStop()
      return
    }
    const t = text.trim()
    if (!t && !images.length) return
    onSend(t)
    setText('')
  }

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((url, i) => (
            <div key={i} className="relative">
              <img src={url} className="h-16 w-16 rounded-lg object-cover border border-border cursor-zoom-in" alt="" onClick={() => showLightbox(url)} />
              <button
                type="button"
                title="移除"
                className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-foreground text-background text-xs leading-none"
                onClick={() => onRemoveImage(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-end">
        <Textarea
          className="min-h-18 max-h-80 flex-1 resize-none bg-background"
          rows={3}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行；支持拖拽/粘贴图片"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="flex w-[72px] flex-col gap-2">
          <Button type="button" variant="outline" className="bg-background" onClick={() => fileRef.current?.click()}>
            图片
          </Button>
          <Button
            type="button"
            variant={busy ? 'destructive' : 'default'}
            onClick={submit}
          >
            {busy ? '停止' : '发送'}
          </Button>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onAttach(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}