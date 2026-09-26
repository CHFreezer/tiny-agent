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
  summaryStatus?: 'failed' // 压缩摘要生成失败：不是有效分割点
  ts?: number // 创建时间（毫秒），前端显示相对时间
}

export interface Session {
  id: number
  title: string
  history: Entry[]
  createdAt?: number
  contextTokens?: number // 服务器估算的当前上下文 token（含记忆注入/压缩分割点）
  lastPromptTokens?: number // 最近一次主请求的精确 prompt_tokens（上游分词器）
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
  pwsh: boolean // pwsh 工具开关
}

export interface McpServerConfig {
  name: string
  command: string
  args: string
  env: string
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
  pwsh: true,
}