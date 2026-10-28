# cortico-provider-opencode

Owner: `src/index.ts`

OpenCode 作为供应商:一条端点接 OpenCode Console 网关,`options.protocol` 选 Responses、Chat Completions、Messages 或 Gemini,
`options.billing` 选 Go 订阅(默认)或按量余额。

| 文件 | 内容 |
|---|---|
| `src/index.ts` | `ProviderModule`:id、档位表、两个选项、`create()`、`prices()`、`describe`、`webUi` |
| `src/options.ts` | 两个选项的值与默认值 |
| `src/address.ts` | 从端点地址取网关根,按协议与计费侧拼家族路径 |
| `src/catalog.ts` | 模型清单,以及从模型库补的上下文/输出/图片字段 |
| `src/native.ts` | Responses / Chat 两个客户端,以及本机消耗账本 |
| `src/anthropic.ts` | Messages 客户端与它的 SSE 翻译 |
| `src/gemini.ts` | Gemini 客户端与它的 SSE 翻译 |
| `src/identity.ts` | User-Agent 与会话头 |
| `src/usage.ts` | Go 的额度窗口读取与本机消耗换算 |
| `src/pricing.ts` | 按量、Go 两张价目表,以及每个模型的月度额度 |
| `src/webui/server.ts` | 「订阅额度」面板的声明与数据面 |
| `src/webui/client.ts` | 面板的浏览器入口,`dist/webui.js` 由它打出来 |
| `src/strings.ts` | 端点页与错误信息的文案 |
| `icon.png` | 扩展图标,512×512 PNG(`cortico.icon`) |

## 端点

网关根是 `https://opencode.ai/inference`。地址只用来认网关,**家族路径由 `options.protocol` 决定,计费段由 `options.billing` 决定**,
所以三条地址都只是"这个网关"的写法,填哪条都一样:

| 填这个 | 含义 |
|---|---|
| `https://opencode.ai/inference/go/openai/v1` | Go 订阅(默认值) |
| `https://opencode.ai/inference/openai/v1` | 按量余额 |
| `https://opencode.ai/inference` | 同上,家族由协议补齐 |

别的地址(自建代理、别的网关)原样使用,不按协议改写。

## 计费账户

`options.billing` 只有两个值:

- `go`(默认):走 Go 或 Go Plus 订阅的额度。地址带 `/go` 段。
- `balance`:走 Console 余额,按次计费。地址不带 `/go`。

额度窗口只对 Go 有;`balance` 端点没有额度可看,面板会直接说这件事。

## 协议

`options.protocol`:

- `chat`(默认):`POST <baseUrl>/chat/completions`。Go 侧多数模型(GLM / Kimi / MiniMax / DeepSeek / Qwen-Max)是 Chat 原生,这条路不需要网关翻译。
- `responses`:`POST <baseUrl>/responses`。给 Responses 原生的模型(GPT / Grok / Muse)用;思维链按明文回传,不带签名块——网关后面是别家的模型,不能假设加密推理项能往返。
- `anthropic`:`POST <baseUrl>/messages`,即 Messages API。回程的 SSE 翻成框架已校验的 Chat 形状,工具调用、终态与计量因此与另外两个方言同路。
- `gemini`:`POST <baseUrl>/models/<模型>:generateContent`,流式走 `:streamGenerateContent?alt=sse`。模型名与调用方法都在路径里,所以路径按请求设置。密钥同时以 `Authorization: Bearer` 与 `x-goog-api-key` 发出,两边各读自己认的那个。

Console 把每个文本模型翻译到被问的那一套,所以四种协议都覆盖全部文本模型;换协议只改请求形状。
Messages 方言不发送思维链:Messages 把思考写成 token 预算,而 Console 怎么把 OpenAI 风格的 effort 映到预算没有文档。

**为什么默认 chat**:同一段 100k 上下文实测,chat 首字节 2.3 秒、总耗时 3.5 秒;responses 首字节 5.5 秒、总耗时 6.0 秒。responses 让网关把整份上下文逐条翻成 Chat,上下文越长代价越大——工具定义与并发都不影响这个数(实测过),只有协议与上下文规模影响。

## 思考档位与默认值

端点页的「推理强度」有四档:不思考 / 快 / 标准 / 深入。后三档发的 effort 是 `low` / `medium` / `high`,即网关与 models.dev 列出的那组取值。

选中模型后,`normalize()` 会补上 OpenCode 文档里的默认:`temperature = 1`、`maxTokens = 8192`。只填空着的字段,运营者填过的值不会被覆盖。输出上限在端点页可以改——8192 是默认,不是上限。

每个请求都带 `x-opencode-session`:Go 端点会拒收没有这个头的请求。有会话 id 时用它,探测这类没有会话 id 的请求用端点自己的稳定 id。

## 模型清单

`GET <root>/v1/models`(按量)或 `GET <root>/go/v1/models`(Go),都免鉴权,只给 id。

模型清单**不需要先填模型名**:端点里模型还空着时,`normalize()` 会把空的 `spec` 丢掉,于是「获取模型列表」照常可用——列表本来就是模型的来源。「测试连接」仍要先选模型,因为探测请求本身要带模型名。

网关只给 id,其余字段从 [models.dev](https://models.dev/api.json)(OpenCode 自己读的那份模型库,优先它的 `opencode` 段)补齐:上下文上限、最大输出、是否接受图片、显示名。那份文件约 6 MB,所以只把匹配到的子集缓存进端点目录,一天一读;读不到就退回只有 id 的清单。选中模型时这些字段会自动填进端点。

上下文的查询在需要时才读缓存:实例往往在拉列表之前就建好了,所以「当前模型」这一行与 `contextWindow()` 都能拿到列表刚写进去的信息。

清单外的 id 照样可以手填。

## 价目

两张表分开,因为官方两页对同名模型给的数字不同、列的模型也不同:按量页 83 个模型,Go 页 30 个。
按量按 `marginal` 计,Go 按 `equivalent` 计(订阅的额度,不是当场扣的钱)。

- 长上下文档:`> 200K` / `> 256K` / `> 272K` / `> 100K` 各自从页面写的门槛起换价。
- Go 的 DeepSeek:`01:00–04:00` 与 `06:00–10:00` UTC、周一到周五为峰时,其余为谷时。
- 限时折扣:`gemini-4-argon` 五折到 2026-11-30,`mistral-large-4` 页面未写结束日,按折后价计。
- 每个模型的月度额度(`$15` / `$60` / `$80` …)也一并内置,供面板换算本机消耗。

页面没列价的模型(如 `omen-alpha`、`qwen3.7-max`)不记金额,只记用量。
端点编辑页里的价目表是**覆盖**用的:空着时模块内置价目生效,所以它空着是正常的。

## 订阅额度面板

端点编辑页的段落顺序是**连接 → 模型与生成 → 订阅额度 → 计价 → 协议**:密钥填在最上面,往下紧接着就是模型列表与模型选择,额度跟在做它统计的那个模型后面。

额度段显示三个窗口——每 5 小时、每周、每月——的进度条与重置倒计时:

- **打开面板时不发请求**。先用本地的 `state` 判断能不能读:地址不是网关、端点按量计费、密钥还没填,都把原因写在面板上,不产生一次注定被拒的请求。
- 「立即刷新」才真的去读;读成功之后**才开始轮询**,每 5 分钟一次。
- 两次读之间,进度条按**本机消耗**推进:每次生成结束把这一次的金额记进端点账本,金额除以该模型的月度额度、再乘以窗口份额(5 小时 20%、每周 50%、每月 100%)就是推进的百分点。脚注此时标出「含本机消耗估算」,并在下一次读到网关值时被覆盖。
- 顶部一行「当前模型」写明所选模型的上下文上限与每百万 token 的输入/输出价,因为端点自己的价目表空着时看不到这些。

OpenCode 没有公开 `/usage` 的限流规则,同一台机器上的 `dsh-opencode-go` 默认每分钟读一次,所以 5 分钟一次是宽裕的。要更频繁或更保守,改 `src/webui/allowance-panel.ts` 的 `READ_MS`。

## 排错

| 看到什么 | 原因与处置 |
|---|---|
| `模型名不能为空` | 0.3.1 之前:模型字段空着时 `validateEntry` 拒掉整个请求,于是连模型列表都拉不到。0.3.1 起空 spec 会被 `normalize()` 丢掉,列表可用;「测试连接」仍会要求先选模型。 |
| `Request is missing x-opencode-session` | 0.3.1 之前:探测请求不带会话 id,Go 端点直接拒。现在每个请求都带,没有会话 id 的用端点自己的稳定 id。 |
| `OpenCode usage: HTTP 401` | 密钥没读到,或这个密钥不属于有 Go 订阅的工作区。错误信息里 `[key sent via bearer, N chars]` / `[no key]` 说明密钥到底发了没有、走的哪个头,后面跟响应正文。`[no key]` 表示端点的密钥变量没配好;`[key sent, …]` 表示密钥发出去了但被拒——推理能用不代表额度能读,核对工作区是否有 Go 订阅,或改用 OpenCode 里同一个密钥。被拒时模块会再用 `x-api-key` 试一次,哪种头有效会被记住。 |

## 已知限制

- 免费档模型只允许 OpenCode 自己的客户端调用,第三方客户端即使带密钥也收 403。付费模型与 Go 不受影响。
- `/go/v1/usage` 不在 OpenCode 的公开 API 文档里,只有 `dsh-opencode-go` 这类客户端在用。它变了以后面板会显示「上次数据」而不是崩掉。
- 面板只在 Coopanion 的**高级模式**里可见:provider 的面板是端点编辑页的段落,框架不给 provider 单独的导航页。
- OpenCode 在 `usage.opencode` 里报的细分(缓存写入 5 分钟 / 1 小时、推理 token)不进框架的计量,缓存写入按未知记。
- Gemini 方言的工具结果只能靠 call id 找回函数名:Gemini 的 `functionResponse` 只认名字,而框架保留的是 id。

## 校验

```bash
pnpm typecheck && pnpm typecheck:web && pnpm test && pnpm build:webui
```

`dist/webui.js` 是面板产物,装到用户机器上直接加载、不经过构建,所以它要进仓库,`files` 里也要有 `dist`。

```bash
cd <Cortico 仓库根>
pnpm describe:extension <包目录>   # 改了 describe 之后
pnpm check:extension <包目录>
```

真实网关只能手测:起一个干净部署,端点填上面任一条地址,粘贴 Console 的密钥,拉一次模型清单,对话一轮,再看额度面板的数字。
