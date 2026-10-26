export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface Entry {
  id: string // UUID：跨页面全局唯一，避免陈旧页面复用自增 id 导致按 id 的 patch/删除打到错误条目
  role: 'system' | 'user' | 'assistant' | 'tool' | 'summary'
  content: string | null
  reasoning?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  images?: string[]
  diff?: EditDiff // edit 工具结果的结构化 diff（仅展示）
  search?: SearchResult // search 工具的结构化结果（仅展示）
  plain?: boolean // 按纯文本展示（read 的 tail 输出没有行号）
  error?: boolean // 工具结果失败（前端标红；不发给上游）
  live?: boolean // 工具结果正在实时输出（仅前端临时的展示态）
  summaryStatus?: 'failed' // 压缩摘要生成失败：不是有效分割点
  ts?: number // 创建时间（毫秒），前端显示相对时间
}

export interface DiffLine {
  type: ' ' | '-' | '+' | '\\' // \ = 上一行缺少末尾换行（git 风格标记）
  oldNo?: number
  newNo?: number
  text: string
}
export interface DiffBlock {
  lines: DiffLine[]
}
export interface EditDiff {
  path: string
  kind?: 'hex'
  offset?: string
  blocks: DiffBlock[]
}
// search 工具的结构化结果（仅展示）
export interface SearchLine {
  line: number
  text: string
  ranges: Array<[number, number]>
  count?: number // 该行命中次数；旧数据没有时回退到 ranges.length
  kind?: 'match' | 'context' // 缺省 match
}
export interface SearchFile {
  path: string
  nameMatch?: boolean
  nameRanges?: Array<[number, number]>
  matches: SearchLine[]
}
export interface SearchResult {
  mode?: 'content' | 'files' // 旧数据缺省按 content
  syntax?: 'literal' | 'regex'
  pattern: string
  root: string
  files: SearchFile[]
  totalMatches: number
  nameHits: number
  truncated: boolean
  limit?: number
  timedOut?: boolean
  nonUtf8?: boolean
  context?: number
  include?: string[]
  exclude?: string[]
}

export interface Session {
  id: number
  title: string
  history: Entry[]
  createdAt?: number
  lastPromptTokens?: number // 最近一次主请求的精确 prompt_tokens（上游分词器）
  lastCompletionTokens?: number // 最近一次主请求响应的精确 completion_tokens
  generating?: boolean // 该会话是否有进行中的生成（页面重开/切换时重新附加）
}

export interface Settings {
  baseUrl: string
  mode: string
  model: string
  effort: string
  apiKey: string
  mcp: McpServerConfig[]
  maxContext: number // 最大上下文窗口 token，0=不限
  maxTokens: number // 最大输出 token，0=模型默认
  headers: Record<string, string> // 上游自定义请求头（每行 Name: value），对所有 OpenAI 兼容请求生效
  pwsh: boolean // pwsh 工具开关
}

export interface McpServerConfig {
  name: string
  command: string
  args: string
  env: Record<string, string> // 环境变量键值（键值对象，UI 按行编辑）
  enabled: boolean // 工具是否加入模型上下文
}

export interface McpServerStatus {
  name: string
  command: string
  status: 'connecting' | 'ok' | 'error'
  error?: string
  tools: string[]
}
export const DEFAULT_SETTINGS: Settings = {
  baseUrl: '',
  mode: 'openai',
  model: '',
  effort: '',
  apiKey: '',
  mcp: [],
  maxContext: 0,
  maxTokens: 0,
  headers: {},
  pwsh: false,
}