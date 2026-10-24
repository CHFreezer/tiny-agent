import { Fragment, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SearchResult } from '@/lib/types'

// 匹配片段高亮（服务端已把 rg 的字节偏移换算成 JS 字符索引）
const MARK = 'rounded-[2px] bg-amber-300/70 px-[1px] text-foreground dark:bg-amber-400/30'

function Highlight({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  if (!ranges.length) return <>{text}</>
  const out: ReactNode[] = []
  let pos = 0
  ranges.forEach(([start, end], i) => {
    const s = Math.max(pos, start)
    const e = Math.max(s, end)
    if (s > pos) out.push(text.slice(pos, s))
    if (e > s) out.push(<mark key={i} className={MARK}>{text.slice(s, e)}</mark>)
    pos = e
  })
  if (pos < text.length) out.push(text.slice(pos))
  return <>{out}</>
}

export function SearchResultView({ result }: { result: SearchResult }) {
  const [open, setOpen] = useState(false)
  const { files, totalMatches, nameHits, truncated, timedOut } = result
  const totalResults = totalMatches + nameHits
  const breakdown = nameHits ? `（${totalMatches} 处内容 + ${nameHits} 个文件名命中）` : ''
  return (
    <div className="mt-1.5 min-w-0 rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-x-1.5 gap-y-1 text-left font-medium select-none cursor-pointer"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <span>搜索结果</span>
        <code
          className="min-w-0 max-w-[55%] truncate rounded bg-muted px-1 py-0.5 font-mono text-[11px] font-normal text-foreground"
          title={result.pattern}
        >
          {result.pattern}
        </code>
        <span className="font-normal">· {files.length} 个文件，{totalResults} 个结果</span>
        {truncated && (
          <span className="rounded bg-amber-500/15 px-1 text-[10px] font-normal text-amber-700 dark:text-amber-300">已截断</span>
        )}
        {timedOut && <span className="rounded bg-destructive/10 px-1 text-[10px] font-normal text-destructive">搜索超时</span>}
        {result.nonUtf8 && (
          <span
            className="rounded bg-amber-500/15 px-1 text-[10px] font-normal text-amber-700 dark:text-amber-300"
            title="指定 encoding（如 gbk）可正确解码"
          >
            非 UTF-8
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1.5 min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="min-w-0 max-w-full truncate" title={result.root}>
              于 {result.root}
            </span>
            {result.include?.length ? (
              <span className="min-w-0 max-w-full truncate" title={result.include.join(', ')}>
                · 仅 {result.include.join(', ')}
              </span>
            ) : null}
            {result.exclude?.length ? (
              <span className="min-w-0 max-w-full truncate" title={result.exclude.join(', ')}>
                · 排除 {result.exclude.join(', ')}
              </span>
            ) : null}
            {result.context ? <span>· 上下文 {result.context} 行</span> : null}
            {breakdown ? <span>{breakdown}</span> : null}
            {truncated && (
              <span className="text-amber-700 dark:text-amber-300">
                · 已显示 {totalResults} 个结果{result.limit ? `（上限 ${result.limit}）` : ''}
              </span>
            )}
            {result.nonUtf8 && (
              <span className="text-amber-700 dark:text-amber-300">· 含非 UTF-8 内容，建议指定 encoding</span>
            )}
          </div>
          <div className="mt-1.5 max-h-56 overflow-y-auto font-mono text-[11px] leading-5">
            {!files.length && <div className="py-1">未找到匹配</div>}
            {files.map((file) => {
              const fileCount = file.matches.reduce((n, m) => n + (m.kind === 'context' ? 0 : (m.count ?? m.ranges.length)), 0)
              return (
                <div key={file.path} className="mt-1.5 first:mt-0">
                  <div className="flex flex-wrap items-center gap-1.5 break-all">
                    <span className="text-foreground">
                      <Highlight text={file.path} ranges={file.nameRanges ?? []} />
                    </span>
                    {file.nameMatch && (
                      <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300">文件名命中</span>
                    )}
                    {fileCount > 0 && <span className="shrink-0 text-[10px] opacity-70">{fileCount}</span>}
                  </div>
                  {file.matches.map((m, i) => {
                    const isContext = m.kind === 'context'
                    const prev = i > 0 ? file.matches[i - 1] : undefined
                    const gap = prev && m.line > prev.line + 1
                    return (
                      <Fragment key={`${m.line}-${i}`}>
                        {gap && (
                          <div className="flex gap-2 py-0.5 opacity-40">
                            <span className="w-10 shrink-0 select-none text-right text-[10px]">...</span>
                          </div>
                        )}
                        <div className={cn('flex gap-2', isContext && 'text-muted-foreground/70')}>
                          <span className="w-10 shrink-0 select-none text-right text-muted-foreground/60">{m.line}</span>
                          <span className="min-w-0 whitespace-pre-wrap break-all">
                            {isContext ? m.text : <Highlight text={m.text} ranges={m.ranges} />}
                          </span>
                        </div>
                      </Fragment>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
