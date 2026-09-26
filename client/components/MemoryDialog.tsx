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
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/ConfirmDialog'

// 单条记忆编辑：新建（空）或编辑（预填该条）；保存/删除后由 App 处理整表
export function MemoryDialog({
  open,
  onOpenChange,
  mode,
  initialText,
  onSave,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'edit'
  initialText: string
  onSave: (text: string) => void
  onDelete?: () => void
}) {
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (open) {
      setText(initialText)
      setMsg('')
    }
  }, [open, initialText])

  const save = () => {
    if (!text.trim()) {
      setMsg('内容不能为空')
      return
    }
    onSave(text.trim())
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '新建记忆' : '编辑记忆'}</DialogTitle>
          <DialogDescription>保存后原文注入每次生成的 developer 角色，对所有会话生效</DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="记忆内容，例如：用户偏好中文回复"
          rows={6}
          className="resize-y font-mono text-sm"
        />
        <div className="text-xs text-muted-foreground">{msg}</div>
        <DialogFooter>
          {mode === 'edit' && onDelete && (
            <Button variant="destructive" className="mr-auto" onClick={() => setConfirmDelete(true)}>
              删除
            </Button>
          )}
          <Button onClick={save}>保存</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="删除这条记忆？"
        onConfirm={() => onDelete?.()}
      />
    </Dialog>
  )
}