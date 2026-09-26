import { Plug, PlugZap } from 'lucide-react'
import { useEffect, useState } from 'react'
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
import { fetchMcp, syncMcpServers } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import type { McpServerConfig, McpServerStatus, Settings } from '@/lib/types'

const EMPTY: McpServerConfig = { name: '', command: '', args: '', env: '', enabled: true }

function StatusChip({ status }: { status: McpServerStatus | undefined }) {
  if (!status) {
    return <span className="text-xs text-muted-foreground">未连接</span>
  }
  if (status.status === 'ok') {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <Plug className="size-3.5" />
        {status.tools.length} 个工具
      </span>
    )
  }
  if (status.status === 'connecting') {
    return <span className="text-xs text-amber-600 dark:text-amber-400">连接中…</span>
  }
  return (
    <span className="flex items-center gap-1 text-xs text-destructive" title={status.error}>
      <Plug className="size-3.5" />
      {status.error?.slice(0, 60) || '连接失败'}
    </span>
  )
}

// 单服务器编辑面板：editing=null 为新增，否则编辑侧边栏选中的那一个
export function McpDialog({
  open,
  onOpenChange,
  settings,
  onSave,
  onSaved,
  editing,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings
  onSave: (next: Settings) => Promise<boolean>
  onSaved?: () => void
  editing: McpServerConfig | null
}) {
  const [row, setRow] = useState<McpServerConfig>(EMPTY)
  const [status, setStatus] = useState<McpServerStatus | undefined>()
  const [busyConn, setBusyConn] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 打开时从选中项（或空表单）初始化
  useEffect(() => {
    if (!open) return
    setRow(editing ? { ...editing } : { ...EMPTY })
    setMsg('')
    const name = (editing?.name ?? '').trim()
    void fetchMcp()
      .then((d) => setStatus(d.servers.find((s) => s.name === name)))
      .catch(() => setStatus(undefined))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  const patch = (p: Partial<McpServerConfig>) => setRow((r) => ({ ...r, ...p }))

  const recheck = async () => {
    setBusyConn(true)
    setMsg('')
    try {
      const d = await syncMcpServers()
      setStatus(d.servers.find((s) => s.name === row.name.trim()))
    } catch (e) {
      setMsg(`重连失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyConn(false)
    }
  }

  const save = async () => {
    const name = row.name.trim()
    const command = row.command.trim()
    if (!name || !command) {
      setMsg('名称和命令不能为空')
      return
    }
    // 按原名移出旧条目（改名=删旧加新），并按新名去重
    const origName = (editing?.name ?? '').trim()
    const mcp = [
      ...settings.mcp.filter((c) => c.name.trim() !== origName && c.name.trim() !== name),
      { ...EMPTY, ...row, name, command },
    ]
    setSaving(true)
    setMsg('')
    const ok = await onSave({ ...settings, mcp })
    setSaving(false)
    if (ok) {
      onSaved?.()
      onOpenChange(false)
    } else {
      setMsg('保存失败（服务器不可达？）')
    }
  }

  const remove = async () => {
    const origName = (editing?.name ?? '').trim()
    setSaving(true)
    setMsg('')
    const ok = await onSave({ ...settings, mcp: settings.mcp.filter((c) => c.name.trim() !== origName) })
    setSaving(false)
    if (ok) {
      onSaved?.()
      onOpenChange(false)
    } else {
      setMsg('删除失败（服务器不可达？）')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `MCP 工具：${editing.name}` : 'MCP 工具：新服务器'}</DialogTitle>
          <DialogDescription>
            配置 stdio 类型的 MCP 服务器，其工具将并入模型可调用的工具集（工具名加 mcp__服务器__ 前缀）
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 rounded-lg border p-2.5">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <div className="text-sm">工具加入上下文</div>
              <div className="text-xs text-muted-foreground">关闭后不连接该服务器，其工具不会下发给模型</div>
            </div>
            <Switch checked={row.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
          </div>
          <Input
            value={row.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="名称（如 fs）"
            spellCheck={false}
            className="h-8 font-mono text-xs"
          />
          <div className="flex flex-col gap-1.5">
            <Input
              value={row.command}
              onChange={(e) => patch({ command: e.target.value })}
              placeholder="命令（如 npx）"
              spellCheck={false}
              className="h-8 font-mono text-xs"
            />
            <Input
              value={row.args}
              onChange={(e) => patch({ args: e.target.value })}
              placeholder="参数（空格分隔，如 -y @modelcontextprotocol/server-everything）"
              spellCheck={false}
              className="h-8 font-mono text-xs"
            />
            <Input
              value={row.env}
              onChange={(e) => patch({ env: e.target.value })}
              placeholder="环境变量（可选，分号分隔，如 KEY=value;K2=v2）"
              spellCheck={false}
              className="h-8 font-mono text-xs"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={recheck} disabled={busyConn}>
            <PlugZap className="size-3.5" />
            {busyConn ? '重连中…' : '重连'}
          </Button>
          <StatusChip status={status} />
          <span className={cn('flex-1 text-xs text-muted-foreground', msg && 'text-foreground')}>{msg}</span>
        </div>
        <DialogFooter>
          {editing && (
            <Button type="button" variant="destructive" className="mr-auto" onClick={() => setConfirmDelete(true)} disabled={saving}>
              删除
            </Button>
          )}
          <Button onClick={save} disabled={saving}>
            保存
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`删除 MCP 服务器“${editing?.name}”？`}
        description="删除后其工具不再下发给模型"
        onConfirm={remove}
      />
    </Dialog>
  )
}