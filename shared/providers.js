/**
 * Katty AI Bridge — 供应商预设与协议常量
 *
 * 预设清单移植自 mc-tool 的 src/main/ai/providerStore.ts（PROVIDER_PRESETS，52-161 行），
 * 已剔除 Electron 依赖，并补充本扩展需要的字段：
 *   - cors     : 浏览器直连（不经过扩展）是否可行。true=可行，false=明确不可行，null=未知需实测
 *   - protocol : anthropic 协议者本扩展不支持（mc-tool 同样只做了类型声明、未实现）
 *
 * ⚠ cors 字段只是提示，不作为硬判断。页面 SDK 的直连模式始终会真实发起请求，
 *   失败时把 CORS 错误原样上报，由用户自行判断。这样即使本表的判断过时也不会误导。
 */

export const BRIDGE_VERSION = '1.0.0'

/** postMessage 协议标识。页面与扩展双向都必须带 source，用于过滤页面上其它脚本的消息。 */
export const MSG_FROM_PAGE = 'katty-ai-bridge/page'
export const MSG_FROM_EXT = 'katty-ai-bridge/ext'

/** 默认信任的站点。页面是公开站点，白名单默认拒绝未知来源。 */
export const DEFAULT_ALLOWLIST = ['https://maozuxiao.github.io']

export const PROVIDER_PRESETS = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    requiresKey: true,
    cors: false,
    corsNote: '官方端点刻意不返回 CORS 头，浏览器无法直连，必须经由扩展。'
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'deepseek-v4-flash',
    suggestedModels: [
      'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.3-flash',
      'qwen3.8-max', 'kimi-k3', 'grok-4.6'
    ],
    requiresKey: true,
    cors: null,
    corsNote: '需每会话带 x-opencode-session 头，扩展已内置；直连可用性未实测。'
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen（含免费模型）',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'deepseek-v4-flash',
    suggestedModels: [
      'deepseek-v4-flash', 'deepseek-v4-pro',
      'glm-5.2', 'glm-5.1',
      'kimi-k3', 'kimi-k2.7-code',
      'minimax-m3', 'grok-4.6',
      'big-pickle', 'mimo-v2.5-free', 'ox-alpha-free', 'hy3-free',
      'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free',
      'x-preview-f-free'
    ],
    requiresKey: true,
    cors: null,
    corsNote: '免费模型由上游动态调度，常见「Model is unavailable」表示当前无额度或已下架。'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
    requiresKey: true,
    cors: false,
    corsNote: '未开放 CORS，必须经由扩展。'
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    suggestedModels: [
      'claude-sonnet-4-20250514', 'claude-opus-4-20250514',
      'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022'
    ],
    requiresKey: true,
    protocol: 'anthropic',
    unsupported: true,
    cors: false,
    corsNote: 'Anthropic 使用自有协议，非 OpenAI 兼容。本扩展与 mc-tool 一样暂未实现该协议。'
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
    suggestedModels: ['kimi-k2-0905-preview', 'moonshot-v1-128k'],
    requiresKey: true,
    cors: false,
    corsNote: '未开放 CORS，必须经由扩展。'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5',
    suggestedModels: ['glm-4.5', 'glm-4.5-air', 'glm-4-flash'],
    requiresKey: true,
    cors: false,
    corsNote: '未开放 CORS，必须经由扩展。'
  },
  {
    id: 'qwen',
    name: '阿里 Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    suggestedModels: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-coder-plus'],
    requiresKey: true,
    cors: false,
    corsNote: '未开放 CORS，必须经由扩展。'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3.1',
    suggestedModels: ['deepseek-ai/DeepSeek-V3.1', 'Qwen/Qwen3-235B-A22B', 'zai-org/GLM-4.5'],
    requiresKey: true,
    cors: null,
    corsNote: '直连可用性未实测，SDK 会真实尝试。'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    suggestedModels: [
      'openai/gpt-4o-mini', 'anthropic/claude-sonnet-4',
      'deepseek/deepseek-chat', 'qwen/qwen3-coder'
    ],
    requiresKey: true,
    cors: true,
    corsNote: '官方明确支持浏览器直连（会返回 CORS 头），未装扩展时也可尝试直接使用。'
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3:8b',
    suggestedModels: ['qwen3:8b', 'deepseek-r1:8b', 'llama3.1:8b'],
    requiresKey: false,
    cors: null,
    corsNote: '需先设置 OLLAMA_ORIGINS 才允许跨域；经扩展的 Service Worker 发起则无此限制。'
  }
]

export function findPreset(id) {
  return PROVIDER_PRESETS.find(function (p) { return p.id === id }) || null
}

/** 把 baseUrl 转成 chrome.permissions 需要的 origin 通配模式 */
export function originPatternFor(baseUrl) {
  try {
    return new URL(baseUrl).origin + '/*'
  } catch (e) {
    return null
  }
}

/**
 * OpenCode（Go / Zen）要求每会话带稳定的 x-opencode-session 头。
 * 移植自 mc-tool chatService.ts 的 opencodeSessionHeaders。
 */
export function opencodeSessionHeader(baseUrl, sessionId) {
  if (!baseUrl || !sessionId) return null
  if (!/opencode\.ai/i.test(baseUrl)) return null
  return { 'x-opencode-session': sessionId }
}

/**
 * 白名单匹配。支持三种写法：
 *   https://example.com     精确匹配该 origin
 *   https://example.com/*   匹配该 origin 及其下任意路径
 *   http://localhost:*      匹配该主机任意端口（本地开发常用）
 *
 * ⚠ 原来 `/*` 分支写成 origin.indexOf(base + '/') === 0，而 location.origin
 *   本身不带尾斜杠，导致该分支永远为 false，用户填的通配项一律匹配不上。
 */
export function matchOrigin(allowlist, origin) {
  if (!origin) return false
  const list = allowlist || []
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (!entry) continue
    if (entry === '*' || entry === origin) return true

    if (entry.slice(-2) === '/*') {
      const base = entry.slice(0, -2)
      if (origin === base || origin.indexOf(base + '/') === 0) return true
      continue
    }

    if (entry.slice(-2) === ':*') {
      const stem = entry.slice(0, -2)
      if (origin === stem || origin.indexOf(stem + ':') === 0) return true
    }
  }
  return false
}
