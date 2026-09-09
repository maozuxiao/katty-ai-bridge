/**
 * Katty AI Bridge — 页面侧接入 SDK  v1.0.0
 *
 * 零依赖单文件。复制到任意静态网页的脚本目录，引入后即可用同一个 API 调用大模型，
 * 无需关心请求究竟是走了浏览器扩展还是页面直连。
 *
 *   <script src="js/ai-bridge.js"></script>
 *   <script>
 *     KattyAI.probe().then(info => console.log(info.mode))   // 'extension' | 'direct' | 'none'
 *     KattyAI.chat({ messages, onDelta: (chunk, full) => {} })  // -> Promise<string>
 *   </script>
 *
 * 两条通道：
 *   extension —— 页面 postMessage 广播，任意监听中的扩展 content script 应答。
 *                不经由扩展 ID（未打包扩展的 ID 每台机器都不同，硬编码必然失效）。
 *                可访问 OpenAI / DeepSeek / 智谱 / Moonshot 等未开放 CORS 的供应商。
 *   direct    —— 页面直接 fetch。仅对开放了 CORS 的供应商有效（如 OpenRouter）。
 *                file:// 页面是 opaque origin（Origin: null），直连基本不可用。
 */

;(function (global) {
  'use strict'

  var MSG_FROM_PAGE = 'katty-ai-bridge/page'
  var MSG_FROM_EXT = 'katty-ai-bridge/ext'
  var PING_TIMEOUT = 400
  var DIRECT_STORAGE_KEY = 'katty-ai-direct'
  var REQUEST_TIMEOUT = 60000

  var _mode = null        // 'extension' | 'direct' | 'none'，null = 尚未探测
  var _probePromise = null
  var _detected = null    // 探测详情

  // ------------------------------------------------------------ 工具

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID()
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  }

  function makeError(code, message) {
    var e = new Error(message)
    e.code = code
    return e
  }

  function readDirectConfig() {
    try {
      var raw = global.localStorage.getItem(DIRECT_STORAGE_KEY)
      if (!raw) return null
      var c = JSON.parse(raw)
      if (!c || !c.baseUrl) return null
      return { baseUrl: String(c.baseUrl).replace(/\/+$/, ''), apiKey: c.apiKey || '', model: c.model || '' }
    } catch (e) {
      return null
    }
  }

  /** SSE 增量解析。要点：decode 必须带 stream:true（否则多字节中文在 chunk 边界被截断成乱码），
   *  且 split 后残留的半行必须留在 buffer 中等下一个 chunk。逻辑与扩展侧 shared/sse.js 保持一致。 */
  function parseSseChunk(state, rawText, onDelta) {
    state.buffer += rawText
    var lines = state.buffer.split(/\r?\n/)
    state.buffer = lines.pop() || ''
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim()
      if (trimmed.indexOf('data:') !== 0) continue
      var data = trimmed.slice(5).trim()
      if (data === '[DONE]') continue
      var json
      try {
        json = JSON.parse(data)
      } catch (e) {
        continue
      }
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error))
      var delta = (json.choices && json.choices[0] && json.choices[0].delta) || {}
      if (delta.content) {
        state.content += delta.content
        if (onDelta) onDelta(delta.content, state.content)
      }
      if (json.usage) state.usage = json.usage
    }
  }

  // ------------------------------------------------------------ 探测

  /**
   * 探测可用通道。结果会缓存，扩展安装/卸载后需调用 resetProbe() 再探。
   * @returns {Promise<{available:boolean, mode:string, configured?:boolean,
   *                    providerName?:string, model?:string, version?:string}>}
   */
  function probe() {
    if (_probePromise) return _probePromise

    _probePromise = new Promise(function (resolve) {
      var id = uuid()
      var settled = false

      function finish(mode, info) {
        if (settled) return
        settled = true
        global.removeEventListener('message', onMessage)
        global.clearTimeout(timer)
        _mode = mode
        _detected = info || {}
        _detected.mode = mode
        _detected.available = mode !== 'none'
        resolve(_detected)
      }

      function onMessage(e) {
        if (e.source !== global) return
        var d = e.data
        if (!d || d.source !== MSG_FROM_EXT || d.id !== id || d.type !== 'pong') return
        var pl = d.payload || {}
        finish('extension', {
          configured: !!pl.configured,
          providerName: pl.providerName || '',
          model: pl.model || '',
          models: pl.models || [],
          version: pl.version || ''
        })
      }

      // 扩展无应答：退而求其次看有没有配过直连参数
      var timer = global.setTimeout(function () {
        finish(readDirectConfig() ? 'direct' : 'none', {})
      }, PING_TIMEOUT)

      global.addEventListener('message', onMessage)
      global.postMessage({ source: MSG_FROM_PAGE, id: id, type: 'ping' }, '*')
    })

    return _probePromise
  }

  function resetProbe() {
    _probePromise = null
    _mode = null
    _detected = null
  }

  // ------------------------------------------------------------ 走扩展

  function chatViaExtension(opts) {
    return new Promise(function (resolve, reject) {
      var id = uuid()
      var settled = false
      // 扩展发来的 delta.text 是「增量片段」而非累积文本，
      // 这里自己累积，才能给 onDelta 提供与直连通道语义一致的 (chunk, full)。
      var acc = ''

      function finish(err, text) {
        if (settled) return
        settled = true
        global.removeEventListener('message', onMessage)
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
        global.clearTimeout(timeout)
        if (err) reject(err)
        else resolve(text)
      }

      function onAbort() {
        global.postMessage({ source: MSG_FROM_PAGE, id: id, type: 'cancel' }, '*')
        finish(makeError('ABORTED', '已取消'), null)
      }

      function onMessage(e) {
        if (e.source !== global) return
        var d = e.data
        if (!d || d.source !== MSG_FROM_EXT || d.id !== id) return
        var pl = d.payload || {}
        if (d.type === 'delta') {
          var piece = pl.text || ''
          acc += piece
          if (opts.onDelta) opts.onDelta(piece, acc)
        } else if (d.type === 'done') {
          // done 的 text 是完整内容；万一扩展侧缺失则回落到本地累积值
          finish(null, pl.text != null && pl.text !== '' ? pl.text : acc)
        } else if (d.type === 'error') {
          finish(makeError(pl.code || 'UNKNOWN', pl.message || '请求失败'), null)
        }
      }

      global.addEventListener('message', onMessage)

      if (opts.signal) {
        if (opts.signal.aborted) return onAbort()
        opts.signal.addEventListener('abort', onAbort)
      }

      // 兜底超时：扩展崩溃或被禁用时不会回任何消息，避免界面永久卡在「生成中」
      var timeout = global.setTimeout(function () {
        finish(makeError('TIMEOUT', '扩展无响应（60 秒）。'), null)
      }, REQUEST_TIMEOUT)

      global.postMessage({
        source: MSG_FROM_PAGE,
        id: id,
        type: 'chat',
        payload: {
          providerId: opts.providerId,
          model: opts.model,
          messages: opts.messages
        }
      }, '*')
    })
  }

  // ------------------------------------------------------------ 直连

  function chatDirect(opts) {
    var cfg = readDirectConfig()
    if (!cfg) {
      return Promise.reject(makeError('NO_DIRECT_CONFIG', '未配置直连参数（baseUrl / apiKey / model）。'))
    }

    var controller = new AbortController()
    var timer = setTimeout(function () { controller.abort() }, REQUEST_TIMEOUT)
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', function () { controller.abort() })
    }

    var headers = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey

    return fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: headers,
      body: JSON.stringify({
        model: opts.model || cfg.model,
        stream: true,
        messages: opts.messages
      })
    })
      .then(function (res) {
        clearTimeout(timer)
        if (!res.ok || !res.body) {
          return res.text().catch(function () { return '' }).then(function (text) {
            var msg = 'HTTP ' + res.status
            try {
              msg = JSON.parse(text).error.message || msg
            } catch (e) { /* 非 JSON，保留状态码 */ }
            throw makeError('HTTP', msg)
          })
        }

        var reader = res.body.getReader()
        var decoder = new TextDecoder()
        var state = { buffer: '', content: '', usage: null }

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return state.content
            parseSseChunk(state, decoder.decode(r.value, { stream: true }), opts.onDelta)
            return pump()
          })
        }
        return pump()
      })
      .catch(function (err) {
        clearTimeout(timer)
        if (err && err.code) throw err
        if (err && err.name === 'AbortError') {
          throw makeError('ABORTED', '已取消或请求超时。')
        }
        // 直连最常见失败原因就是 CORS：fetch 抛的是 TypeError，几乎拿不到响应细节
        throw makeError(
          'CORS_OR_NETWORK',
          '直连失败（' + (err && err.message ? err.message : '网络错误') +
          '）。该供应商多半未开放 CORS，请安装 Katty AI Bridge 扩展后重试。'
        )
      })
  }

  // ------------------------------------------------------------ 对外 API

  /**
   * 发起对话。
   * @param {Object} opts
   * @param {Array<{role:string, content:string}>} opts.messages
   * @param {string} [opts.model]
   * @param {string} [opts.providerId]
   * @param {AbortSignal} [opts.signal]
   * @param {(chunk:string, full:string) => void} [opts.onDelta]
   * @returns {Promise<string>} 完整回复文本
   */
  function chat(opts) {
    opts = opts || {}
    if (!opts.messages || !opts.messages.length) {
      return Promise.reject(makeError('EMPTY_MESSAGES', 'messages 不能为空。'))
    }
    return probe().then(function (info) {
      if (info.mode === 'extension') return chatViaExtension(opts)
      if (info.mode === 'direct') return chatDirect(opts)
      return Promise.reject(makeError(
        'NO_CHANNEL',
        '未检测到 Katty AI Bridge 扩展。请安装扩展，或在设置中填写直连参数（仅部分开放 CORS 的供应商可用）。'
      ))
    })
  }

  /** 请求扩展打开它自己的选项页。网页无法直接打开扩展页面，必须借道 content script。 */
  function openOptions() {
    global.postMessage({ source: MSG_FROM_PAGE, id: uuid(), type: 'openOptions' }, '*')
  }

  /** 读取/写入直连参数（未装扩展时的降级方案）。存 localStorage，页面自行保管 Key。 */
  function getDirectConfig() {
    return readDirectConfig()
  }

  function setDirectConfig(cfg) {
    try {
      if (!cfg || !cfg.baseUrl) global.localStorage.removeItem(DIRECT_STORAGE_KEY)
      else global.localStorage.setItem(DIRECT_STORAGE_KEY, JSON.stringify(cfg))
      resetProbe()
      return true
    } catch (e) {
      return false
    }
  }

  var api = {
    /** @returns {Promise<object>} 探测结果，含 mode 与 available */
    probe: probe,
    /** 扩展状态变化后清缓存，下次 chat 会重新探测 */
    resetProbe: resetProbe,
    chat: chat,
    openOptions: openOptions,
    getDirectConfig: getDirectConfig,
    setDirectConfig: setDirectConfig,
    /** 直连参数在 localStorage 中的键名，供设置界面复用 */
    DIRECT_STORAGE_KEY: DIRECT_STORAGE_KEY
  }

  Object.defineProperty(api, 'MODE', {
    get: function () { return _mode }
  })

  global.KattyAI = api
})(window)
