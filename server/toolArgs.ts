// ===== 工具参数严格校验 =====
// 约定：
// - 未知参数直接报错（不静默忽略）
// - 类型 / 范围 / 枚举不合法直接报错（不静默回退默认值）
// - 必填缺失报错；可选参数省略即可，显式传 null 视为非法（避免"传了但被忽略"）
// 领域内约束（模式互斥、文件是否存在等）仍由各工具自己检查。
export class ArgError extends Error {}

export interface ArgSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'string[]' | 'number|string'
  required?: boolean
  min?: number
  max?: number
  enum?: readonly string[]
  allowEmpty?: boolean // string：是否允许空串（默认 true）
  maxItems?: number // string[]：最多几项
  itemMax?: number // string[]：单项最大字符数
}

const bad = (k: string, why: string) => new ArgError(`参数 "${k}" ${why}`)

function check(k: string, v: unknown, s: ArgSpec): unknown {
  if (s.type === 'string') {
    if (typeof v !== 'string') throw bad(k, '应为字符串')
    if (s.allowEmpty === false && !v.trim()) throw bad(k, '不能为空')
    if (s.enum && !s.enum.includes(v)) throw bad(k, `只能是 ${s.enum.join(' | ')}`)
    return v
  }
  if (s.type === 'number|string') {
    if (typeof v !== 'number' && typeof v !== 'string') throw bad(k, '应为数字或字符串')
    if (typeof v === 'number' && !Number.isFinite(v)) throw bad(k, '应为有限数字')
    if (typeof v === 'string' && !v.trim()) throw bad(k, '不能为空')
    return v
  }
  if (s.type === 'number' || s.type === 'integer') {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(k, '应为数字')
    if (s.type === 'integer' && !Number.isInteger(v)) throw bad(k, '应为整数')
    if ((s.min !== undefined && v < s.min) || (s.max !== undefined && v > s.max)) {
      const range = s.min !== undefined && s.max !== undefined ? `${s.min}..${s.max}` : s.min !== undefined ? `≥${s.min}` : `≤${s.max}`
      throw bad(k, `超出范围（应为 ${range}）`)
    }
    return v
  }
  if (s.type === 'boolean') {
    if (typeof v !== 'boolean') throw bad(k, '应为布尔值')
    return v
  }
  // string[]
  if (!Array.isArray(v)) throw bad(k, '应为字符串数组')
  if (s.maxItems !== undefined && v.length > s.maxItems) throw bad(k, `最多 ${s.maxItems} 项`)
  v.forEach((x, i) => {
    if (typeof x !== 'string') throw bad(k, `第 ${i + 1} 项应为字符串`)
    if (!x.trim()) throw bad(k, `第 ${i + 1} 项不能为空`)
    if (s.itemMax !== undefined && x.length > s.itemMax) throw bad(k, `第 ${i + 1} 项超过 ${s.itemMax} 字符`)
  })
  return v
}

export function validateArgs(tool: string, raw: Record<string, unknown>, spec: Record<string, ArgSpec>): Record<string, unknown> {
  const allowed = Object.keys(spec)
  for (const k of Object.keys(raw)) {
    if (!Object.hasOwn(spec, k)) throw new ArgError(`未知参数 "${k}"（${tool} 支持：${allowed.join(', ')}）`)
  }
  const out: Record<string, unknown> = {}
  for (const [k, s] of Object.entries(spec)) {
    const v = raw[k]
    if (v === undefined) {
      if (s.required) throw new ArgError(`缺少参数 "${k}"`)
      continue
    }
    if (v === null) throw new ArgError(`参数 "${k}" 不能为 null`)
    out[k] = check(k, v, s)
  }
  return out
}

// ===== 各内置工具的参数声明 =====
export const READ_ARGS: Record<string, ArgSpec> = {
  path: { type: 'string', required: true, allowEmpty: false },
  encoding: { type: 'string', allowEmpty: false },
  line: { type: 'integer', min: 1 },
  offset: { type: 'number|string' },
  limit: { type: 'integer', min: 1, max: 2000 },
  bytes: { type: 'integer', min: 1, max: 4096 },
  cwd: { type: 'string' },
}

export const EDIT_ARGS: Record<string, ArgSpec> = {
  path: { type: 'string', required: true, allowEmpty: false },
  old: { type: 'string' }, // 空串=插入
  new: { type: 'string', required: true }, // 空串=删除
  encoding: { type: 'string', allowEmpty: false },
  replace_all: { type: 'boolean' },
  line: { type: 'integer', min: 1 },
  offset: { type: 'number|string' },
  cwd: { type: 'string' },
}

export const WRITE_ARGS: Record<string, ArgSpec> = {
  path: { type: 'string', required: true, allowEmpty: false },
  content: { type: 'string', required: true }, // 允许空串（创建空文件）
  encoding: { type: 'string', allowEmpty: false },
  overwrite: { type: 'boolean' },
  cwd: { type: 'string' },
}

export const SEARCH_ARGS: Record<string, ArgSpec> = {
  pattern: { type: 'string', required: true, allowEmpty: false },
  mode: { type: 'string', enum: ['literal', 'regex'] },
  flags: { type: 'string' },
  path: { type: 'string', allowEmpty: false },
  cwd: { type: 'string' },
  max_results: { type: 'integer', min: 1, max: 1000 },
  timeout: { type: 'integer', min: 1, max: 600 },
  context: { type: 'integer', min: 0, max: 20 },
  encoding: { type: 'string', allowEmpty: false },
  include: { type: 'string[]', maxItems: 50, itemMax: 260 },
  exclude: { type: 'string[]', maxItems: 50, itemMax: 260 },
}

export const PWSH_ARGS: Record<string, ArgSpec> = {
  command: { type: 'string', required: true, allowEmpty: false },
  timeout: { type: 'integer', min: 1, max: 600 },
  cwd: { type: 'string' },
}

export const READ_IMAGE_ARGS: Record<string, ArgSpec> = {
  path: { type: 'string', required: true, allowEmpty: false },
  cwd: { type: 'string' },
}

// MCP 工具：参数契约由服务器自己的 inputSchema 定义。这里只做 JSON Schema 语义下
// 无歧义的检查——必填存在性、以及服务器显式声明 additionalProperties:false 时的未知参数。
// 类型/嵌套结构交给 MCP 服务器校验，避免我们误判复杂 schema（$ref/anyOf 等）。
export function validateMcpArgs(tool: string, schema: unknown, args: Record<string, unknown>): void {
  const s = schema as { type?: unknown; properties?: unknown; required?: unknown; additionalProperties?: unknown } | null
  if (!s || typeof s !== 'object' || s.type !== 'object') return
  if (Array.isArray(s.required)) {
    for (const k of s.required) {
      if (typeof k === 'string' && args[k] === undefined) throw new ArgError(`缺少参数 "${k}"（${tool}）`)
    }
  }
  if (s.additionalProperties === false && s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, unknown>
    for (const k of Object.keys(args)) {
      if (!Object.hasOwn(props, k)) throw new ArgError(`未知参数 "${k}"（${tool} 不支持）`)
    }
  }
}
