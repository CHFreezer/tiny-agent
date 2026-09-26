import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { Entry } from '@/lib/types'

interface Field {
  label: string | null
  value: string
  set: (v: string) => void
}

// 编辑：按 JSON 对象粒度（思考/调用名/调用参数/工具结果/内容），保存/取消按钮（手机键盘无 Esc，回车用于换行）
export function EditForm({
  entry,
  onSave,
  onCancel,
}: {
  entry: Entry
  onSave: (patch: Partial<Entry>) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<Partial<Entry>>({
    content: entry.content ?? '',
    reasoning: entry.reasoning,
    tool_calls: entry.tool_calls?.map((tc) => ({ ...tc })),
  })

  const save = () => {
    const patch: Partial<Entry> = {}
    if (entry.role === 'system') {
      patch.content = draft.content ?? ''
    } else if (entry.role === 'user') {
      if ((draft.content ?? '').trim()) patch.content = draft.content
    } else if (entry.role === 'tool') {
      patch.content = draft.content ?? ''
    } else if (entry.role === 'summary') {
      patch.content = draft.content ?? ''
    } else if (entry.tool_calls?.length) {
      if (draft.reasoning !== undefined) patch.reasoning = draft.reasoning
      patch.tool_calls = (draft.tool_calls ?? []).map((tc) => ({
        ...tc,
        name: tc.name.trim() || (entry.tool_calls?.find((x) => x.id === tc.id)?.name ?? ''),
      }))
    } else {
      if (draft.reasoning !== undefined) patch.reasoning = draft.reasoning
      if ((draft.content ?? '').trim()) patch.content = draft.content
    }
    onSave(patch)
  }

  const fields: Field[] = []
  if (entry.role === 'system') {
    fields.push({ label: '系统提示', value: draft.content ?? '', set: (v) => setDraft((d) => ({ ...d, content: v })) })
  } else if (entry.role === 'user') {
    fields.push({ label: null, value: draft.content ?? '', set: (v) => setDraft((d) => ({ ...d, content: v })) })
  } else if (entry.role === 'tool') {
    fields.push({ label: '结果', value: draft.content ?? '', set: (v) => setDraft((d) => ({ ...d, content: v })) })
  } else if (entry.role === 'summary') {
    fields.push({ label: '摘要', value: draft.content ?? '', set: (v) => setDraft((d) => ({ ...d, content: v })) })
  } else if (entry.tool_calls?.length) {
    fields.push({
      label: '思考',
      value: draft.reasoning ?? '',
      set: (v) => setDraft((d) => ({ ...d, reasoning: v })),
    })
    draft.tool_calls?.forEach((tc, i) => {
      fields.push({
        label: `调用 ${i + 1} · 函数名`,
        value: tc.name,
        set: (v) =>
          setDraft((d) => ({
            ...d,
            tool_calls: d.tool_calls?.map((x, j) => (j === i ? { ...x, name: v } : x)),
          })),
      })
      fields.push({
        label: `调用 ${i + 1} · 参数`,
        value: tc.arguments,
        set: (v) =>
          setDraft((d) => ({
            ...d,
            tool_calls: d.tool_calls?.map((x, j) => (j === i ? { ...x, arguments: v } : x)),
          })),
      })
    })
  } else {
    fields.push({
      label: '思考',
      value: draft.reasoning ?? '',
      set: (v) => setDraft((d) => ({ ...d, reasoning: v })),
    })
    fields.push({ label: '内容', value: draft.content ?? '', set: (v) => setDraft((d) => ({ ...d, content: v })) })
  }

  return (
    <div className="flex flex-col gap-1.5">
      {fields.map((f, i) => (
        <div key={i}>
          {f.label && <div className="text-[11px] text-muted-foreground mb-0.5">{f.label}</div>}
          <Textarea
            className="min-h-16 resize-none"
            rows={3}
            value={f.value}
            onChange={(e) => f.set(e.target.value)}
          />
        </div>
      ))}
      <div className="flex gap-2 mt-1">
        <Button size="sm" variant="outline" onClick={save}>
          保存
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  )
}