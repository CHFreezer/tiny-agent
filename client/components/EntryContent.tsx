import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { cn } from '@/lib/utils'
import { showLightbox } from '@/components/Lightbox'
import type { Entry } from '@/lib/types'

// breaks=true 时单换行也渲染为 <br>（user/工具结果/思考保留原始换行）
export function renderMarkdown(text: string, breaks = false): string {
  // 兼容旧数据：早期 MCP 错误前缀 “(MCP 返回错误) ” 后无换行，导致后续 ### 等标题语法不渲染
  const src = text.replace(/\(MCP 返回错误\) (#{1,6}\s)/g, '(MCP 返回错误)\n$1')
  const html = DOMPurify.sanitize(marked.parse(src, { async: false, breaks }) as string)
  // 表格包进横向滚动容器：窄屏下列宽不被压缩，超宽时左右滑动
  return html.replace(/<table>[\s\S]*?<\/table>/g, '<div class="table-wrap">$&</div>')
}

// 朗读用纯文本：与渲染同管线（marked + DOMPurify），块级边界转换行，去掉全部语法符号
export function markdownToPlain(text: string): string {
  let html = DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string)
  html = html.replace(/<\/(p|div|li|h[1-6]|tr|pre|blockquote)>/g, '\n').replace(/<br\s*\/?>/g, '\n')
  const div = document.createElement('div')
  div.innerHTML = html
  return (div.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// 可折叠文本块：默认折叠（preview=true 时露一行尾巴并跟随最后一行；false 时完全折叠只剩标题行）；
// text 为原始文本：折叠预览原样展示（不走任何 markdown 格式化）；点击展开全文（流式输出时贴底跟随，用户上滚则暂停跟随）
function CollapsibleText({ label, text, className, preview = true, error = false, previewText, tail = true, plain = false, selectMode = false, subline }: { label: string; text: string; className?: string; preview?: boolean; error?: boolean; previewText?: string; tail?: boolean; plain?: boolean; selectMode?: boolean; subline?: string }) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stuckBottom = useRef(true)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (!tail) {
      el.scrollTop = 0
      return
    }
    if (!open || stuckBottom.current) el.scrollTop = el.scrollHeight
  }, [text, open, tail])

  return (
    <div
      className={cn(
        'rounded-lg border px-2.5 py-1.5 text-xs',
        error ? 'border-destructive/50 bg-destructive/10 text-destructive' : 'border-border bg-muted/50 text-muted-foreground',
        className,
      )}
    >
      <button
        type="button"
        onClick={
          selectMode
            ? undefined
            : () => {
                stuckBottom.current = true
                setOpen((o) => !o)
              }
        }
        className={cn('flex w-full items-center gap-1 text-left font-medium select-none', !selectMode && 'cursor-pointer')}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      {subline && <div className="mt-1 text-xs text-destructive">{subline}</div>}
      {open || preview ? (
        <div
          ref={bodyRef}
          onScroll={() => {
            const el = bodyRef.current
            if (el) stuckBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
          }}
          className={cn(
            'md-tight mt-1 break-words overflow-hidden',
            open
              ? plain
                ? 'font-mono whitespace-pre-wrap max-h-56 overflow-y-auto'
                : cn('prose text-xs max-w-none dark:prose-invert max-h-56 overflow-y-auto code-wrap', error ? 'prose-destructive' : 'prose-muted')
              : 'h-4 leading-4 whitespace-pre-wrap',
          )}
          dangerouslySetInnerHTML={open && !plain ? { __html: renderMarkdown(text, true) } : undefined}
        >
          {open ? (plain ? text : undefined) : (previewText ?? text).trimEnd()}
        </div>
      ) : null}
    </div>
  )
}

// MCP 工具显示名：mcp__server__tool → server:tool（仅展示）
const formatToolName = (name: string) => (name.startsWith('mcp__') ? name.replace(/^mcp__(.*?)__(.+)$/, '$1: $2') : name)

// 工具调用参数 → 美化 JSON（能解析则格式化；流式中 JSON 未完整时按原文）
const prettyArgs = (args: string) => {
  let body = args
  try {
    if (args) body = JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    // 流式中 JSON 未完整：原文展示
  }
  return body || '(无参数)'
}

// 一个条目（一个 JSON 对象）的内容
export function EntryContent({
  entry,
  executing,
  selectMode = false,
}: {
  entry: Entry
  executing?: boolean
  selectMode?: boolean
}) {
  if (entry.role === 'system') {
    return (
      <>
        <div className="text-[11px] text-muted-foreground mb-1">系统提示</div>
        <div className="whitespace-pre-wrap">{entry.content}</div>
      </>
    )
  }
  if (entry.role === 'tool') {
    const content = entry.content ?? ''
    const isMcpError = content.startsWith('(MCP 返回错误)') || content.startsWith('MCP 工具执行失败')
    return (
      <>
        <CollapsibleText label="工具结果" text={content} error={isMcpError} selectMode={selectMode} />
        {entry.images?.map((url, i) => (
          <img key={i} src={url} className="mt-1.5 block max-h-50 max-w-50 rounded-lg object-cover cursor-zoom-in" alt="" onClick={() => showLightbox(url)} />
        ))}
      </>
    )
  }
  if (entry.role === 'summary') {
    // 压缩气泡：横向分割线 + 可展开摘要；失败时标注（非有效分割点）
    return (
      <CollapsibleText
        label={entry.summaryStatus === 'failed' ? '上下文压缩摘要（失败）' : '上下文压缩摘要'}
        text={entry.content ?? ''}
        preview={false}
        selectMode={selectMode}
        error={entry.summaryStatus === 'failed'}
        subline={entry.summaryStatus === 'failed' ? '压缩失败：摘要不完整，此分割点无效，上方对话仍计入上下文' : undefined}
      />
    )
  }
  if (entry.role === 'assistant') {
    return (
      <>
        {entry.reasoning && (
          <CollapsibleText className="mb-2" label="思考" text={entry.reasoning} selectMode={selectMode} />
        )}
        {entry.content && (
          <div className="prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content) }} />
        )}
        {entry.tool_calls?.map((tc) => (
          <CollapsibleText key={tc.id || tc.name} className="mt-1.5" label={`🔧 ${formatToolName(tc.name)}`} text={prettyArgs(tc.arguments)} previewText={tc.arguments} tail={false} plain selectMode={selectMode} />
        ))}
        {executing && <div className="mt-1.5 rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">⏳ 执行中…</div>}
      </>
    )
  }
  // user
  return (
    <>
      {entry.content && (
        <div className="bubble-user prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content, true) }} />
      )}
      {entry.images?.map((url, i) => (
        <img key={i} src={url} className="mt-1.5 block max-h-50 max-w-50 rounded-lg object-cover cursor-zoom-in" alt="" onClick={() => showLightbox(url)} />
      ))}
    </>
  )
}