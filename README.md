# Katty AI Bridge

给**纯静态网页**用的 AI 请求通道。

浏览器里的网页直连大模型会被 CORS 拦住——OpenAI、DeepSeek、智谱、Moonshot、Anthropic 都没有开放跨域。本扩展把发请求这件事下沉到 Chrome 扩展的 Service Worker（源为 `chrome-extension://`，不受 CORS 约束），网页通过一条 `postMessage` 协议调用它。

装一次，之后任何本地静态网页都能用同一份 SDK 接入。

---

## 安装

1. 打开 `chrome://extensions/`
2. 右上角打开**「开发者模式」**
3. 点**「加载已解压的扩展程序」**，选择本仓库目录
4. 点击工具栏的拼图图标，把 **Katty AI Bridge** 固定到工具栏，方便后续打开

> 开发者模式下 Chrome 每次启动会提示「请停用开发者模式扩展程序」，点「取消」即可继续使用。
> 若要分发给同事，可以打包成 `.crx` 走企业策略下发，或发布到 Chrome 应用商店。

## 配置

点击工具栏图标 → **打开完整设置**。

1. **供应商**：从内置预设里选一家，填 API Key，选模型
2. **授权跨域**：点一下，Chrome 会弹窗确认授予该域名的访问权限
3. **测试连接**：确认能跑通再保存

扩展不会预置任何 Key，`host_permissions` 也留空——只有你明确配置过的供应商域名才会被申请权限。

### 站点白名单

只有白名单里的页面可以调用本扩展。因为调用方是公开站点，**任何第三方网页都可能尝试调用你的扩展**，所以白名单默认拒绝未知来源。被拒绝的来源会记入「待处理的请求来源」，你可在设置页选择**信任**或**忽略**。

> **关于默认白名单**：安装后默认信任 `https://maozuxiao.github.io`，这是作者本人的 GitHub Pages，
> 配套编辑器就部署在那里，预置是为了开箱即用。若你不需要，在设置页把它移除即可；
> 若你 fork 了本仓库自用，建议把它改成你自己的站点地址，或干脆清空、按需添加。
> 该 origin 只有仓库所有者能发布内容，因此信任它等价于信任仓库所有者本人。

支持三种写法：

| 写法 | 含义 |
| --- | --- |
| `https://example.com` | 精确匹配该 origin |
| `https://example.com/*` | 匹配该 origin 及其下任意路径 |
| `http://localhost:*` | 匹配 localhost 的**任意端口**——本地起静态服务器调试时最省事 |

> 本地调试时（`http://localhost:8765` 之类）务必把 `http://localhost:*` 加进白名单，
> 否则请求会被拒，页面提示「站点不在信任列表中」。端口每次可能变，用 `:*` 比写死端口省事。
> 修改白名单后无需重载扩展，但要**刷新调用方的页面**。

### 本地调试（`file://`）

Chrome 默认禁止扩展向 `file://` 页面注入脚本。若要在本地双击 HTML 调试：

1. 打开 `chrome://extensions/`，找到本扩展 → **详细信息**
2. 打开**「允许访问文件网址」**
3. 在设置页白名单里添加 `file://`

注意 `file://` 是 opaque origin（`Origin: null`），即使开放了 CORS 的供应商也会拒绝它的直连请求，所以**本地调试必须走扩展**。

---

## 在其他静态网页里接入

### 1. 放入 SDK

点工具栏图标 → **复制页面接入 SDK**，粘贴成项目里的 `js/ai-bridge.js`（或直接复制本仓库 `sdk/ai-bridge.js`）。零依赖，无需构建。

```html
<script src="js/ai-bridge.js"></script>
```

### 2. 探测通道

```js
KattyAI.probe().then(function (info) {
  console.log(info.mode)        // 'extension' | 'direct' | 'none'
  console.log(info.available)   // 是否有可用通道
  console.log(info.providerName, info.model)
})
```

### 3. 发起请求

```js
var controller = new AbortController()

KattyAI.chat({
  messages: [
    { role: 'system', content: '你是一个 Markdown 编辑助手。' },
    { role: 'user',   content: '帮我润色这段内容：...' }
  ],
  signal: controller.signal,
  onDelta: function (chunk, full) {
    console.log('增量:', chunk)
  }
}).then(function (text) {
  console.log('完整回复:', text)
}).catch(function (err) {
  console.error(err.code, err.message)
})

// 随时取消
controller.abort()
```

### 4. 提示用户去配置

网页无法直接打开扩展的选项页，需借道 SDK：

```js
KattyAI.openOptions()   // 扩展侧会执行 chrome.runtime.openOptionsPage()
```

### 降级：直连

没装扩展时，若页面自己配过直连参数，SDK 会直接 `fetch`：

```js
KattyAI.setDirectConfig({
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey:  'sk-or-...',
  model:   'openai/gpt-4o-mini'
})
KattyAI.resetProbe()   // 配置变更后必须重探
```

直连只对**开放了 CORS 的供应商**有效（OpenRouter 是，OpenAI / DeepSeek / 智谱 / Moonshot 不是）。参数存页面自己的 `localStorage`，Key 由页面自行保管，扩展不参与。

---

## 安全边界

| 边界 | 做法 |
| --- | --- |
| 来源 | 站点白名单，默认拒绝未知来源 |
| 目标 | 只请求已配置供应商的 `baseURL`，绝不转发页面传入的任意 URL |
| 凭据 | API Key 只存在 `chrome.storage.local`，**永不回传给网页** |

这意味着即使调用方页面存在 XSS，攻击者能借你的扩展发请求，也拿不到 Key 本身。

---

## 消息协议

页面与扩展通过 `window.postMessage` 通信，双方都带 `source` 字段用于过滤页面上其他脚本的消息，`id` 用于请求关联与取消。

```js
// 页面 → 扩展
{ source: 'katty-ai-bridge/page', id, type: 'ping' | 'chat' | 'cancel' | 'openOptions', payload }

// 扩展 → 页面
{ source: 'katty-ai-bridge/ext',  id, type: 'pong' | 'delta' | 'done' | 'error',        payload }
```

| 消息 | payload |
| --- | --- |
| `pong` | `{ version, configured, providerName, model }` |
| `chat` | `{ providerId?, model, messages: [{ role, content }] }` |
| `delta` | `{ text }` |
| `done` | `{ text, usage }` |
| `error` | `{ message, code }` |

`code` 取值：`NO_PROVIDER` `NO_KEY` `UNSUPPORTED_PROTOCOL` `ORIGIN_NOT_ALLOWED` `PERMISSION_DENIED` `EMPTY_MESSAGES` `TIMEOUT` `ABORTED` `NETWORK` `HTTP` `STREAM` `DISCONNECTED` `INTERNAL`

## 已知限制

- **流式响应最长 60 秒**：超时会中断。MV3 的 Service Worker 空闲 30 秒会被回收，SDK 在流式期间每 20 秒发一次心跳维持唤醒，但单次请求超过 60 秒仍会超时。
- **Anthropic 暂不支持**：它用自有协议而非 OpenAI 兼容格式，本扩展与 mc-tool 一样未实现。
- **仅 Chromium 系**（Chrome / Edge / Brave）Manifest V3。

---

## 目录

```
manifest.json        MV3 清单
background.js        Service Worker，唯一真正发请求的地方
content.js           注入所有页面，postMessage 桥接 + 心跳保活
options.html/js      配置页：供应商 / Key / 模型 / 白名单
popup.html/js        状态面板 + 一键复制 SDK
shared/
  providers.js       供应商预设（移植自 mc-tool）与协议常量
  sse.js             SSE 流式解析
sdk/
  ai-bridge.js       页面侧 SDK 的源头副本，供其他静态页取用
```
