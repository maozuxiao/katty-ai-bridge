/**
 * Katty AI Bridge — background service worker (MV3)
 *
 * 唯一真正发起 /chat/completions 请求的地方。Service Worker 的源是 chrome-extension://，
 * 不受页面 CORS 约束，因此 OpenAI / DeepSeek / 智谱 / Moonshot 等未开放 CORS 的供应商均可访问。
 *
 * 安全边界（三条，缺一不可）：
 *   1. 来源白名单：只允许已信任的页面 origin 调用
 *   2. 目标白名单：只请求已配置供应商的 baseURL，绝不转发页面传入的任意 URL
 *   3. Key 隔离：API Key 只存在于 chrome.storage.local，永不回传给页面
 */

import {
  DEFAULT_ALLOWLIST,
  originPatternFor,
  opencodeSessionHeader,
  matchOrigin
} from './shared/providers.js'
import { readSseStream } from './shared/sse.js'

const TIMEOUT_MS = 60000
const PORT_NAME = 'katty-ai-bridge'

/** requestId -> AbortController */
const controllers = new Map()

const DEFAULT_STATS = { requests: 0, inputTokens: 0, outputTokens: 0 }

// ---------------------------------------------------------------- 存储

async function getStore() {
  const got = await chrome.storage.local.get([
    'providers', 'prefs', 'allowlist', 'pendingOrigins', 'stats', 'opencodeSessionId'
  ])
  return {
    providers: got.providers || {},
    prefs: got.prefs || {},
    allowlist: got.allowlist || DEFAULT_ALLOWLIST.slice(),
    pendingOrigins: got.pendingOrigins || [],
    stats: Object.assign({}, DEFAULT_STATS, got.stats || {}),
    opencodeSessionId: got.opencodeSessionId || ''
  }
}

async function bumpStats(usage) {
  if (!usage) return
  const got = await chrome.storage.local.get(['stats'])
  const s = Object.assign({}, DEFAULT_STATS, got.stats || {})
  s.requests += 1
  if (usage.prompt_tokens) s.inputTokens += usage.prompt_tokens
  if (usage.completion_tokens) s.outputTokens += usage.completion_tokens
  await chrome.storage.local.set({ stats: s })
}

async function addPendingOrigin(origin) {
  const got = await chrome.storage.local.get(['pendingOrigins'])
  const list = got.pendingOrigins || []
  if (list.indexOf(origin) === -1) {
    list.push(origin)
    await chrome.storage.local.set({ pendingOrigins: list })
  }
}

// ---------------------------------------------------------------- 请求

async function handleChat(port, msg) {
  const id = msg.id
  const origin = msg.origin
  const payload = msg.payload || {}

  const post = (m) => {
    try {
      port.postMessage(Object.assign({ id }, m))
    } catch (e) {
      /* port 已断开 */
    }
  }

  try {
    const store = await getStore()

    // —— 边界 1：来源白名单 ——
    if (!matchOrigin(store.allowlist, origin)) {
      await addPendingOrigin(origin)
      post({
        type: 'error',
        code: 'ORIGIN_NOT_ALLOWED',
        message: `站点 ${origin} 不在信任列表中。请在扩展选项页的「站点白名单」中授权。`
      })
      return
    }

    // —— 边界 2：目标白名单 ——
    const providerId = payload.providerId || store.prefs.lastProviderId
    const provider = store.providers[providerId]
    if (!provider) {
      post({ type: 'error', code: 'NO_PROVIDER', message: '尚未配置 AI 供应商，请在扩展选项页中添加。' })
      return
    }
    if (provider.unsupported) {
      post({
        type: 'error',
        code: 'UNSUPPORTED_PROTOCOL',
        message: `供应商「${provider.name}」使用非 OpenAI 兼容协议，本扩展暂不支持。`
      })
      return
    }
    if (provider.requiresKey !== false && !provider.apiKey) {
      post({ type: 'error', code: 'NO_KEY', message: `供应商「${provider.name}」未填写 API Key。` })
      return
    }

    const pattern = originPatternFor(provider.baseUrl)
    if (pattern) {
      const granted = await chrome.permissions.contains({ origins: [pattern] })
      if (!granted) {
        post({
          type: 'error',
          code: 'PERMISSION_DENIED',
          message: `缺少 ${pattern} 的跨域权限。请在扩展选项页点击「授权」按钮。`
        })
        return
      }
    }

    const model = payload.model || store.prefs.lastModelId || provider.defaultModel
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    if (!messages.length) {
      post({ type: 'error', code: 'EMPTY_MESSAGES', message: '请求内容为空。' })
      return
    }

    // —— 边界 3：Key 只在此处拼进请求头，不回传页面 ——
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      opencodeSessionHeader(provider.baseUrl, store.opencodeSessionId) || {},
      provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}
    )

    const controller = new AbortController()
    controllers.set(id, controller)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, TIMEOUT_MS)

    let res
    try {
      res = await fetch(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({ model, stream: true, messages })
      })
    } catch (e) {
      clearTimeout(timer)
      controllers.delete(id)
      if (controller.signal.aborted) {
        post({
          type: 'error',
          code: timedOut ? 'TIMEOUT' : 'ABORTED',
          message: timedOut ? '请求超时（60 秒）。' : '已取消。'
        })
      } else {
        post({ type: 'error', code: 'NETWORK', message: `网络请求失败：${e && e.message ? e.message : e}` })
      }
      return
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      let message = `HTTP ${res.status}`
      try {
        message = JSON.parse(text).error.message || message
      } catch (e) {
        /* 非 JSON 响应，保留状态码文案 */
      }
      clearTimeout(timer)
      controllers.delete(id)
      post({ type: 'error', code: 'HTTP', message })
      return
    }

    try {
      const result = await readSseStream(res, (chunk) => post({ type: 'delta', text: chunk }))
      post({ type: 'done', text: result.content, usage: result.usage })
      await bumpStats(result.usage)
    } catch (e) {
      post({ type: 'error', code: 'STREAM', message: `流式读取失败：${e && e.message ? e.message : e}` })
    } finally {
      clearTimeout(timer)
      controllers.delete(id)
    }
  } catch (e) {
    post({ type: 'error', code: 'INTERNAL', message: `内部错误：${e && e.message ? e.message : e}` })
  }
}

// ---------------------------------------------------------------- 接线

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return
  port.onMessage.addListener((msg) => {
    if (!msg) return
    if (msg.type === 'chat') {
      handleChat(port, msg)
    } else if (msg.type === 'cancel') {
      const c = controllers.get(msg.id)
      if (c) c.abort()
    }
    // 'hb' 心跳：收到即唤醒 SW，无需应答
  })
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'katty-open-options') {
    chrome.runtime.openOptionsPage()
  }
})

chrome.runtime.onInstalled.addListener(async () => {
  const got = await chrome.storage.local.get(['opencodeSessionId', 'allowlist'])
  const patch = {}
  if (!got.opencodeSessionId) {
    patch.opencodeSessionId =
      (crypto.randomUUID && crypto.randomUUID()) ||
      String(Date.now()) + Math.random().toString(36).slice(2)
  }
  if (!got.allowlist) patch.allowlist = DEFAULT_ALLOWLIST.slice()
  if (Object.keys(patch).length) await chrome.storage.local.set(patch)
})
