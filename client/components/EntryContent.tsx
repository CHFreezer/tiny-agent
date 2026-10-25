import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { cn, hasVisibleText } from '@/lib/utils'
import { showLightbox } from '@/components/Lightbox'
import { SearchResultView } from '@/components/SearchResultView'
import type { EditDiff, Entry } from '@/lib/types'

// breaks=true 时单换行也渲染为 <br>（user/工具结果/思考保留原始换行）
function renderMarkdown(text: string, breaks = false): string {
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
function CollapsibleText({ label, text, className, preview = true, error = false, previewText, tail = true, plain = false, nowrap = false, selectMode = false, subline, previewClass }: { label: string; text: string; className?: string; preview?: boolean; error?: boolean; previewText?: string; tail?: boolean; plain?: boolean; nowrap?: boolean; selectMode?: boolean; subline?: string; previewClass?: string }) {
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
  }, [text, previewText, open, tail])

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
                ? cn('font-mono max-h-56', nowrap ? 'whitespace-pre overflow-auto' : 'whitespace-pre-wrap overflow-y-auto')
                : cn('prose text-xs max-w-none dark:prose-invert max-h-56 overflow-y-auto code-wrap', error ? 'prose-destructive' : 'prose-muted')
              : (previewClass ?? 'h-4 leading-4 whitespace-pre-wrap'),
          )}
          dangerouslySetInnerHTML={open && !plain ? { __html: renderMarkdown(text, true) } : undefined}
        >
          {open ? (plain ? text : undefined) : (previewText ?? text).trimEnd()}
        </div>
      ) : null}
    </div>
  )
}

// 工具结果里的编辑 diff：文件路径 + (+N/-M) 统计，行号 + (+/-) 行，横向可滚动，纵向限高
function DiffView({ diff }: { diff: EditDiff }) {
  const isHex = diff.kind === 'hex'
  const bytes = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0)
  const added = diff.blocks.reduce((n, b) => n + b.lines.filter((l) => l.type === '+').reduce((m, l) => m + (isHex ? bytes(l.text) : 1), 0), 0)
  const removed = diff.blocks.reduce((n, b) => n + b.lines.filter((l) => l.type === '-').reduce((m, l) => m + (isHex ? bytes(l.text) : 1), 0), 0)
  return (
    <div className="mt-1 overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between gap-3 border-b border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">{diff.path}</span>
        <span className="shrink-0 tabular-nums">
          <span className="text-green-600 dark:text-green-400">+{added}{isHex ? 'B' : ''}</span>{' '}
          <span className="text-red-600 dark:text-red-400">-{removed}{isHex ? 'B' : ''}</span>
        </span>
      </div>
      <div className="max-h-56 overflow-auto font-mono text-[11px] leading-5">
        {isHex && diff.offset && <div className="px-2.5 py-0.5 italic text-muted-foreground">{`offset=${diff.offset}`}</div>}
        {diff.blocks.map((block, bi) => (
          <div key={bi} className={cn(bi > 0 && 'border-t border-border/60')}>
            {block.lines.map((line, li) => (
              <div
                key={li}
                className={cn(
                  'flex min-w-max whitespace-pre',
                  line.type === '-'
                    ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                    : line.type === '+'
                      ? 'bg-green-500/10 text-green-700 dark:text-green-300'
                      : line.type === '\\'
                        ? 'text-muted-foreground italic'
                        : '',
                )}
              >
                <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground/70">
                  {isHex ? '' : line.type === '+' ? (line.newNo ?? '') : (line.oldNo ?? '')}
                </span>
                <span className="w-4 shrink-0 select-none text-center">{line.type === ' ' ? '' : line.type}</span>
                <span className="pr-2">{line.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
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
  generating,
  selectMode = false,
}: {
  entry: Entry
  executing?: boolean
  generating?: boolean
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
    // search 工具：渲染结构化的文件/行号/高亮结果（正文仍保留给模型与复制）
    if (entry.search) return <SearchResultView result={entry.search} />
    const content = entry.content ?? ''
    // 带结构化 diff 时，正文里的 unified diff 只给模型；前端只显示首行摘要，避免重复
    const display = entry.diff ? content.split('\n')[0] : content
    const isMcpError = content.startsWith('(MCP 返回错误)') || content.startsWith('MCP 工具执行失败')
    // 兼容旧数据：结构化 error 标记上线前，pwsh 失败只在正文前加状态前缀
    const isLegacyPwshError = /^\[(退出码 \d+|超时|启动失败|进程被终止)\]/.test(content)
    // isError 由服务端工具结果给出（pwsh 非零退出/超时/启动失败、文件工具失败等）；兼容旧数据的 MCP/pwsh 前缀
    const isError = isMcpError || isLegacyPwshError || entry.error === true
    // hex dump 依赖列对齐；read 文本是 cat -n（行号 + Tab），两者都不能走 markdown；
    // tail 读取没有行号，靠服务端的 plain 标记识别
    const isHexDump = content.startsWith('Offset(h)')
    const isReadText = entry.plain === true || /^\s*\d+\t/.test(content)
    const isPlain = isHexDump || isReadText
    return (
      <>
        <CollapsibleText
          label="工具结果"
          text={display}
          error={isError}
          selectMode={selectMode}
          // 实时输出期间按纯文本显示并多露几行（终端观感）；结束后回到一行预览
          plain={isPlain || entry.live}
          nowrap={isHexDump}
          previewClass={entry.live ? 'h-24 leading-5 whitespace-pre-wrap' : undefined}
          // tail 读取跟随末尾；带行号的 read / hex dump 从头展示；其他工具结果贴底
          tail={entry.plain === true || (!isReadText && !isHexDump)}
        />
        {entry.diff && <DiffView diff={entry.diff} />}
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
        {hasVisibleText(entry.reasoning) && (
          <CollapsibleText className="mb-2" label="思考" text={entry.reasoning} selectMode={selectMode} />
        )}
        {hasVisibleText(entry.content) && (
          <div className="prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content) }} />
        )}
        {entry.tool_calls?.map((tc) => {
          // 流式接收参数：跟随尾部滚动 + 实时字符数，避免大参数看起来像卡死；
          // 折叠预览只保留末尾一段，别把整段 JSON 塞进 DOM
          const streaming = generating === true && tc.arguments.length > 0
          const preview = streaming && tc.arguments.length > 1200 ? tc.arguments.slice(-1200) : tc.arguments
          return (
            <CollapsibleText
              key={tc.id || tc.name}
              className="mt-1.5"
              label={`🔧 ${formatToolName(tc.name)}`}
              // 流式期间不解析 JSON（未完整的 JSON 反复 parse 是 O(n²)）；结束后再格式化一次
              text={generating ? tc.arguments || '(无参数)' : prettyArgs(tc.arguments)}
              previewText={preview}
              tail={generating === true}
              plain
              selectMode={selectMode}
            />
          )
        })}
        {executing && <div className="mt-1.5 rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">⏳ 执行中…</div>}
      </>
    )
  }
  // user
  return (
    <>
      {hasVisibleText(entry.content) && (
        <div className="bubble-user prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content, true) }} />
      )}
      {entry.images?.map((url, i) => (
        <img key={i} src={url} className="mt-1.5 block max-h-50 max-w-50 rounded-lg object-cover cursor-zoom-in" alt="" onClick={() => showLightbox(url)} />
      ))}
    </>
  )
}