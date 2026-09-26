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
  images?: string[]
  summaryStatus?: 'failed' // 压缩摘要生成失败（截断/报错）：不是有效分割点
  ts?: number // 创建时间（毫秒），前端显示相对时间
}
export interface Session {
  id: number
  title: string
  history: Entry[]
  createdAt: number
  lastPromptTokens?: number // 最近一次主请求的精确 prompt_tokens（上游分词器）
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
  pwsh: boolean // pwsh 工具开关（是否下发给模型）
}
export interface ToolResult {
  text: string
  images?: string[] // data URL：随工具结果注入上下文，让模型看到图片（read_image）
}
// 上游真实 token 用量（stream_options.include_usage 的末尾 chunk）
export interface Usage {
  prompt: number
  completion: number
  total: number
}