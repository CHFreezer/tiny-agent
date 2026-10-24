// ===== 类型（服务器是会话状态的唯一所有者；浏览器只发指令、收事件） =====
export interface ToolCall {
  id: string
  name: string
  arguments: string
}
export interface Entry {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool' | 'summary'
  content: string | null
  reasoning?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  images?: string[] // 图片 URL（/api/sessions/<id>/files/<名>，前端 <img src> 直接用；发上游前读回 data URL）
  diff?: EditDiff // edit 工具的结构化 diff（仅前端展示，不发给上游）
  summaryStatus?: 'failed' // 压缩摘要生成失败（截断/报错）：不是有效分割点
  ts?: number // 创建时间（毫秒），前端显示相对时间
}
export interface DiffLine {
  type: ' ' | '-' | '+' | '\\' // 空格=上下文；\ = 上一行缺少末尾换行（git 风格标记）
  oldNo?: number // 旧文件行号（上下文/- 行）
  newNo?: number // 新文件行号（上下文/+ 行）
  text: string
}
export interface DiffBlock {
  lines: DiffLine[]
}
export interface EditDiff {
  path: string
  kind?: 'hex' // 缺省 text
  offset?: string // hex 模式的起始字节偏移（如 "0x10"）
  blocks: DiffBlock[]
}
export interface Session {
  id: number
  title: string
  history: Entry[]
  createdAt: number
  lastPromptTokens?: number // 最近一次主请求的精确 prompt_tokens（上游分词器）
  lastCompletionTokens?: number // 最近一次主请求响应的精确 completion_tokens（精确当前上下文 = 两者之和）
}
export interface McpServerConfig {
  name: string
  command: string
  args: string
  env: string
  enabled: boolean // 工具是否加入模型上下文（false=不连接、不出现在工具集）
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
  headers: Record<string, string> // 上游自定义请求头（面板配置），对所有 OpenAI 兼容请求生效
  pwsh: boolean // pwsh 工具开关（是否下发给模型）
}
export interface ToolResult {
  text: string
  images?: string[] // data URL：工具结果随上下文注入（read_image），服务端落盘后条目录 URL
  diff?: EditDiff // 结构化编辑 diff（仅前端展示）
}
// 上游真实 token 用量（stream_options.include_usage 的末尾 chunk）
export interface Usage {
  prompt: number
  completion: number
  total: number
}