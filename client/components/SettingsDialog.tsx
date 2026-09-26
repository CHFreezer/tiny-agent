import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { scanModels } from '@/lib/api'
import type { Settings } from '@/lib/types'

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings
  onSave: (next: Settings) => Promise<boolean>
}) {
  const [base, setBase] = useState(settings.baseUrl)
  const [mode, setMode] = useState(settings.mode)
  const [model, setModel] = useState(settings.model)
  const [models, setModels] = useState<string[]>([])
  const [apiKey, setApiKey] = useState(settings.apiKey)
  const [maxContext, setMaxContext] = useState(settings.maxContext ? String(settings.maxContext) : '')
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens ? String(settings.maxTokens) : '')
  const [msg, setMsg] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const modelRef = useRef<HTMLDivElement>(null)
  // 点模型框以外：先关下拉，点击继续落到原目标（可点面板其他控件）
  useEffect(() => {
    if (!modelOpen) return
    const onDown = (e: PointerEvent) => {
      if (!modelRef.current?.contains(e.target as Node)) setModelOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [modelOpen])

  // 模型选项：扫描结果 + 已保存的模型（不在列表里也保留）
  const modelOptions = models.includes(model) ? models : model ? [model, ...models] : models

  const scan = async () => {
    const b = base.trim()
    if (!b) {
      setMsg('请先填写服务器地址')
      return
    }
    setMsg('扫描中…')
    try {
      const list = await scanModels(b, apiKey.trim())
      setModels(list)
      setMsg(`找到 ${list.length} 个模型`)
    } catch (err) {
      setMsg(`扫描失败: ${(err as Error).message}`)
    }
  }

  const save = async () => {
    setSaving(true)
    const b = base.trim()
    if (!b) {
      setMsg('请填写服务器地址')
      setSaving(false)
      return
    }
    const toPosInt = (v: string) => {
      const n = Math.floor(Number(v))
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    const ok = await onSave({ ...settings, baseUrl: b, mode, model, effort: settings.effort, apiKey: apiKey.trim(), maxContext: toPosInt(maxContext), maxTokens: toPosInt(maxTokens) })
    setSaving(false)
    if (ok) onOpenChange(false)
    else setMsg('保存失败（服务器不可达？）')
  }

  // 打开时从服务器设置同步（Dialog 的 onOpenChange 在 prop 驱动打开时不触发，故用 effect）
  useEffect(() => {
    if (open) {
      setBase(settings.baseUrl)
      setMode(settings.mode)
      setModel(settings.model)
      setApiKey(settings.apiKey)
      setMaxContext(settings.maxContext ? String(settings.maxContext) : '')
      setMaxTokens(settings.maxTokens ? String(settings.maxTokens) : '')
      setMsg('')
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>服务器配置</DialogTitle>
          <DialogDescription>OpenAI 兼容接口，配置保存在服务器本地</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            服务器地址
            <Input value={base} onChange={(e) => setBase(e.target.value)} spellCheck={false} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            模式
            <Select value={mode} onValueChange={(v) => setMode(String(v))}>
              <SelectTrigger className="w-full">
                <span className="truncate">{mode === 'openai' ? 'OpenAI 兼容' : mode}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI 兼容</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            API Key（Authorization，可选）
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="留空则不发送" spellCheck={false} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            模型（可手填，或扫描后下拉选择）
            <div className="flex items-center gap-2">
              <div ref={modelRef} className="relative flex-1">
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onFocus={() => setModelOpen(true)}
                placeholder="输入模型名"
                spellCheck={false}
                className="pr-8"
              />
              <button
                type="button"
                title="选择模型"
                onClick={() => setModelOpen((o) => !o)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              >
                <ChevronDown className="size-4" />
              </button>
              {modelOpen && (
                <>
                  <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-auto rounded-md border bg-popover p-1 shadow-md">
                    {modelOptions.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无模型，先扫描</div>
                    ) : (
                      modelOptions.map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => {
                            setModel(m)
                            setModelOpen(false)
                          }}
                          className="w-full truncate px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                        >
                          {m}
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={scan}>
                扫描模型
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">{msg}</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              最大上下文窗口（token）
              <Input type="number" min={0} value={maxContext} onChange={(e) => setMaxContext(e.target.value)} placeholder="0 = 不限" spellCheck={false} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              最大输出（token）
              <Input type="number" min={0} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="0 = 模型默认" spellCheck={false} />
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={saving}>
            保存
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}