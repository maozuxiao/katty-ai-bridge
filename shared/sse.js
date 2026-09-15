/**
 * Katty AI Bridge — SSE 流式解析
 *
 * 移植自 mc-tool 的 src/main/ai/chatService.ts（238-278 行）。
 * 核心要点（原实现已处理，勿改）：
 *   1. decoder.decode(value, { stream: true }) —— 必须带 stream，否则多字节中文在 chunk 边界被截断成乱码
 *   2. buffer.split 后 lines.pop() —— 残留的半行必须留在 buffer 里等下一个 chunk
 *   3. SSE 内的 json.error 也要抛（部分上游把错误包在 data 里返回，而非用 HTTP 状态码）
 */

/**
 * 读取 OpenAI 兼容接口的 SSE 流。
 * @param {Response} res
 * @param {(chunk: string) => void} onDelta 每收到一个正文增量回调一次
 * @param {(chunk: string) => void} [onReasoning] 每收到一个「推理片段」回调一次。
 *   推理模型（hy4-preview、deepseek-reasoner、o4-mini 等）会先吐一大段
 *   reasoning_content，这期间 delta.content 一直是空串。调用方需要它来做两件事：
 *   重置空闲计时器（否则会被误判成超时），以及给用户呈现「思考中」的状态。
 * @returns {Promise<{content: string, usage: object|null}>}
 */
export async function readSseStream(res, onDelta, onReasoning) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let usage = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed.indexOf('data:') !== 0) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') continue

      let json
      try {
        json = JSON.parse(data)
      } catch (e) {
        continue
      }

      if (json.error) {
        throw new Error(json.error.message || JSON.stringify(json.error))
      }

      const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {}
      if (delta.content) {
        content += delta.content
        if (onDelta) onDelta(delta.content)
      }
      // 推理内容与正文分开放：它不能进答案，但必须让调用方知道流还在动
      if (delta.reasoning_content && onReasoning) onReasoning(delta.reasoning_content)
      if (json.usage) usage = json.usage
    }
  }

  return { content: content, usage: usage }
}
