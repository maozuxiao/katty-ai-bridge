/**
 * Katty AI Bridge — content script
 *
 * 注入到所有页面（含 file://），负责两件事：
 *   1. 把页面的 window.postMessage 桥接到扩展的 Service Worker
 *   2. 流式期间每 20s 发一次心跳，防止 MV3 Service Worker 被 30s 空闲回收
 *
 * 运行在隔离世界，只使用 window.postMessage 与 chrome.runtime，不碰页面 DOM，
 * 也不会触发页面的 CSP。页面侧无需知道扩展 ID（未打包扩展的 ID 每台机器都不同）。
 */

;(function () {
  var MSG_FROM_PAGE = 'katty-ai-bridge/page'
  var MSG_FROM_EXT = 'katty-ai-bridge/ext'
  var PORT_NAME = 'katty-ai-bridge'
  var HEARTBEAT_MS = 20000

  /** requestId -> { port, timer } */
  var active = {}

  function sendToPage(msg) {
    try {
      window.postMessage(Object.assign({ source: MSG_FROM_EXT }, msg), '*')
    } catch (e) {
      /* 页面已销毁，忽略 */
    }
  }

  /** file:// 页面下 location.origin 是字符串 "null"，统一成可辨识的值 */
  function currentOrigin() {
    var o = location.origin
    if (!o || o === 'null') return 'file://'
    return o
  }

  function cleanup(id) {
    var rec = active[id]
    if (!rec) return
    clearInterval(rec.timer)
    try {
      rec.port.disconnect()
    } catch (e) {}
    delete active[id]
  }

  /**
   * ping 在 content script 本地应答，不惊动 Service Worker。
   * 页面每次加载都会 ping，若都转发给 SW 会造成无谓唤醒。
   */
  function handlePing(id) {
    var out = {
      type: 'pong',
      id: id,
      payload: { version: '', configured: false, providerName: '', model: '', models: [] }
    }
    try {
      out.payload.version = chrome.runtime.getManifest().version
    } catch (e) {}

    var got
    try {
      got = chrome.storage.local.get(['providers', 'prefs'])
    } catch (e) {
      sendToPage(out)
      return
    }

    Promise.resolve(got)
      .then(function (cfg) {
        var prefs = (cfg && cfg.prefs) || {}
        var providers = (cfg && cfg.providers) || {}
        var p = prefs.lastProviderId ? providers[prefs.lastProviderId] : null
        if (p) {
          out.payload.providerName = p.name || prefs.lastProviderId
          out.payload.model = prefs.lastModelId || p.defaultModel || ''
          out.payload.models = p.models || []
          out.payload.configured = p.requiresKey === false ? true : !!p.apiKey
        }
      })
      .catch(function () {})
      .then(function () {
        sendToPage(out)
      })
  }

  function handleChat(id, payload) {
    var port
    try {
      port = chrome.runtime.connect({ name: PORT_NAME })
    } catch (e) {
      sendToPage({
        type: 'error',
        id: id,
        payload: { code: 'NO_RUNTIME', message: '扩展上下文不可用，请刷新页面或重新加载扩展。' }
      })
      return
    }

    // 心跳：持续唤醒 SW。MV3 空闲 30s 会回收 SW 并中断 fetch，
    // 模型思考超 30s 才吐首个 token 的场景全靠这个保命。
    var timer = setInterval(function () {
      try {
        port.postMessage({ type: 'hb' })
      } catch (e) {}
    }, HEARTBEAT_MS)

    active[id] = { port: port, timer: timer }

    port.onMessage.addListener(function (msg) {
      if (!msg || msg.id !== id) return
      if (msg.type === 'delta') {
        sendToPage({ type: 'delta', id: id, payload: { text: msg.text } })
      } else if (msg.type === 'done') {
        cleanup(id)
        sendToPage({ type: 'done', id: id, payload: { text: msg.text, usage: msg.usage } })
      } else if (msg.type === 'error') {
        cleanup(id)
        sendToPage({
          type: 'error',
          id: id,
          payload: { code: msg.code, message: msg.message }
        })
      }
      // 'hb-ack' 与未知类型不转发给页面
    })

    port.onDisconnect.addListener(function () {
      // cleanup 已调用过的（done/error 正常收尾）不会再进这里
      if (!active[id]) return
      cleanup(id)
      sendToPage({
        type: 'error',
        id: id,
        payload: { code: 'DISCONNECTED', message: '与扩展的通信中断，可能是扩展被重载或已更新。' }
      })
    })

    port.postMessage({ type: 'chat', id: id, origin: currentOrigin(), payload: payload })
  }

  function handleCancel(id) {
    var rec = active[id]
    if (!rec) return
    try {
      rec.port.postMessage({ type: 'cancel', id: id })
    } catch (e) {}
  }

  /** 页面请求打开扩展选项页。网页无法直接打开扩展页面，必须借道本脚本。 */
  function handleOpenOptions(id) {
    try {
      chrome.runtime.sendMessage({ type: 'katty-open-options' })
    } catch (e) {}
    sendToPage({ type: 'done', id: id, payload: { opened: true } })
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return
    var data = event.data
    if (!data || data.source !== MSG_FROM_PAGE) return

    switch (data.type) {
      case 'ping':
        handlePing(data.id)
        break
      case 'chat':
        handleChat(data.id, data.payload)
        break
      case 'cancel':
        handleCancel(data.id)
        break
      case 'openOptions':
        handleOpenOptions(data.id)
        break
      default:
        break
    }
  })
})()
