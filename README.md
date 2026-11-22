# cortico-provider-opencode

Owner: `src/index.ts`

OpenCode 作为供应商:一条端点接 OpenCode Console 网关,`options.protocol` 选 Responses、Chat Completions、Messages 或 Gemini,
`options.billing` 选 Go 订阅(默认)或按量余额。

| 文件 | 内容 |
|---|---|
| `src/index.ts` | `ProviderModule`:档位、选项、`create()`、`prices()`、`describe`、`webUi` |
| `src/options.ts` | 协议、计费账户、附件、Go 套餐及密钥轮转选项 |
| `src/address.ts` | 从端点地址取网关根,按协议与计费侧拼家族路径 |
| `src/catalog.ts` | 模型清单,以及从模型库补的上下文/输出/图片字段 |
| `src/model-metadata.ts` | 输入声明、MIME 别名与条件价格解析 |
| `src/attachments.ts` | 原生附件校验、协议转换与文本降级 |
| `src/meters.ts` | 网关收费 token 细分与请求时价格核算 |
| `src/models-snapshot.json` | 2026-11-17 公开模型声明及费率快照 |
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

## 安装

Coopanion 里:高级模式 →「扩展」→ 填包名 `cortico-provider-opencode`(可带版本,如 `cortico-provider-opencode@0.3.5`),装好重启进程。改本地目录时,扩展页填包目录的绝对路径即可挂 link,改完源码同样是重启生效。

- npm:https://www.npmjs.com/package/cortico-provider-opencode
- 仓库:https://github.com/Unnori/cortico-provider-opencode
- 许可证:MIT

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

- `go`:走 Go / Go Plus 订阅的额度。地址带 `/go` 段。
- `balance`:走 Console 余额,按次计费。地址不带 `/go`。

**留空时按地址判断**:地址里写了 `/go` 就是 Go,写了家族路径却没有 `/go`(`/openai/v1`、`/anthropic/v1`、`/google/v1beta`、`/v1/models`)就是按量余额;只有光秃秃的 `/inference` 才用默认值 Go。显式选中某一项时以选项为准。

两套账户的模型清单不同,这决定端点页能选到什么:

| 账户 | 模型数 | 例子 |
|---|---|---|
| Go | 30 | `deepseek-v4.1-flash`、`gemini-4-argon`、`kimi-k3.1-pro` |
| 按量余额 | 12 | `claude-opus-5-5`、`gpt-6.1-sol`、`gemini-4-carbon` |

**Opus 这类高级模型只在按量余额里。** 把余额的模型名发到 Go 路径会得到 `400 Model is unavailable`,不是权限问题,是那个账户没有这条路由。

额度窗口只对 Go 有;`balance` 端点没有额度可看,面板会直接说这件事。

## 模型输入与原生附件

「获取模型列表」读取网关的 `modalities.input`、上下文和 `cost` 声明。选择模型后按声明自动发送附件，无需手动开启；原图像开关仍可关闭图片，`options.attachments: off` 可关闭全部原生附件，省略或 `auto` 为自动识别。

「模型输入与计价」面板顶部并排显示图片、音频、视频、PDF／文件四个开关；未声明支持或当前协议无法发送的类别会置灰。图片开关接管原「模型与生成」中的同名开关，仍写入框架的 `multimodal` 配置；适配器面板加载后隐藏上方重复入口，其他适配器不受影响。其余分别使用 `options.inputAudio`、`options.inputVideo`、`options.inputFiles`；省略为自动，`false` 为手动关闭。「查看模型声明的格式」可展开完整 MIME 列表。旧缓存缺少声明时会补齐随包快照中的字段。

网关没有声明的字段才从对应计费账户的 models.dev 模型资料补充，未知类型不猜测支持。内置 2026-11-17 的公开模型声明快照，实时列表和缓存优先。切换模型时重新判断本次发送的附件。

从 **0.7.1** 起，图片、音频、视频、PDF 等原生附件只随**最新一批投递**发送。这一批后续的模型请求和工具循环保留附件；下一批用户消息或 Core 外部事件到来后，旧附件只保留说明文字、引用和已有的分析回答，不再读取或重复发送原始字节。连续送达、尚未有模型输出的用户消息与外部事件视为同一批；刚产生且尚未给模型看的工具附件不会因新事件到来而被提前剔除。

这项策略不改动存储历史，也不额外调用模型生成摘要。追问原文件细节时，需要用户重新上传，或由 World／工具把原 blob 句柄作为**新的附件回执／事件**提交；只在文字中提到文件名不会自动重发。没有可识别投递边界的独立工具上下文保留调用方给出的附件。同一批仍可能多次发送媒体，用量并非只计一次。

| 选用协议 | 原生附件形式 |
|---|---|
| Chat | 图片 `image_url`、PDF `file`；适配器将音视频限定为原生 Gemini |
| Responses | 图片 `input_image`、PDF 等 `input_file`；适配器将音视频限定为原生 Gemini |
| Messages | 图片 `image`、PDF／text/plain 文件 `document`；此路径不发送音视频 |
| Gemini | 模型声明支持的图片、音频、视频、PDF 等以 `inlineData` 发送 |

Core 通过工具回执投递外部事件时，Gemini 和 Messages 也会保留其中的附件。Gemini 媒体放在完整工具响应组之后的用户内容中，并行调用仍在同一响应组内配对；Messages 图片和 PDF／文档保留在对应 `tool_result.content` 的原生内容块中，纯文本回执保持字符串形式。

允许类型为模型声明与协议编码能力的交集。网关给出精确 MIME 时以精确列表为准，不把“支持图片”当作支持所有格式。附件从消息 blob 或内嵌 data URL 读取，不主动下载远端 URL；无法读取的 URL 降级为文本。接收附件的 World/聊天入口须先把文件提供给适配器，本次不修改桌面聊天文件选择器。

音视频仅在显式选择 `options.protocol: gemini` 时发送，适配器不会自动切换协议。其他协议下的音视频开关置灰表示这项适配器限制，不代表 Gemini 模型没有声明相应能力。图片和 PDF／文档仍按各协议与模型声明处理。

检查真实字节与格式；常见图片、PDF、音频和容器文件做文件头识别。单附件最多 20 MiB，单请求媒体合计最多 40 MiB。原生音频保留源字节，不转写、不转码。未知、不支持、不可读或超限的附件发送前剔除，保留消息和附件 `fallbackText`。不完整解码图片正文，上游仍可能拒绝损坏内容。

声明与实际服务不符时，仅在上游明确拒绝媒体（400/415/422）且未产生输出的情况下去掉本次所有媒体、保留文本重试一次。失败批次的附件哈希在该端点实例中按模型记住，后续重放使用文本。同批正常附件也可能被保守降级；存储历史不变，重建端点实例后清空拒绝记录。拒绝原因进入日志，不记录附件字节。

World 使用框架的运行时接口按 MIME 查询当前端点，不要只看 `multimodal` 或市场的静态声明：

```ts
host.modelFacts.accepts('image/png');
host.modelFacts.accepts('audio/wav');
host.modelFacts.accepts('video/mp4');
host.modelFacts.accepts('application/pdf');
```

Core 将查询交给适配器的 `accepts(entry, spec, mime)`，按当前模型声明、协议和已保存开关实时返回结果。市场 `describe.input` 仅表示适配器整体提供的模态，不代表所有模型和协议都可用。World 仍须通过事件的 `blobs` 提交实际附件。

外部应用可经框架公开的面板契约读取同一份能力，不必读取报价：

```js
const args = [{ name: '你的端点名', mimes: ['image/png', 'audio/wav', 'video/mp4', 'application/pdf'] }];
const url = `/api/webui/providers/llm%3Aopencode/panels/model-settings/input-capabilities?args=${encodeURIComponent(JSON.stringify(args))}`;
const capabilities = await fetch(url).then(response => response.json());
// capabilities.input: 模型原始声明；inputs: 各类的 declared / available / enabled
// capabilities.accepts: 所查询的每种 MIME 当前是否可接收
```

该方法也接受 POST，体为 `{ args }`；沿用部署的 WebUI 登录鉴权，不修改配置、不发起推理请求。省略 `mimes` 仅返回模型和类别信息；单次最多查询 128 种 MIME。输入能力变化后应重新查询。查询仅判断类型，具体文件仍需通过字节、大小等检查以及上游校验。上传控件是否提供某类文件仍由应用或 World 自身决定。

尺寸检查只解析文件头(JPEG SOF / PNG IHDR / WebP VP8X、VP8、VP8L),不解码像素:

| 一次请求里的图片数 | 长边上限 |
|---|---|
| 少于 15 张 | 8192 px |
| 15 张及以上 | 4096 px |

限制按完整请求里通过格式检查的图片出现次数计算，重复引用同一附件也计数。

`src/images.ts` 的 `LONG_SIDE_LIMIT` 与 `CROWDED_LONG_SIDE_LIMIT` 是唯一要改的数字。

模型列表、模型资料与额度查询均拒绝 HTTP 重定向,并限制下载时间和响应体字节数。额度错误正文中的当前密钥会先脱敏再显示;需要代理时,端点应直接填写代理的最终地址。

## 多把密钥

一个端点可以按顺序用多把密钥,适合「两个 Go 订阅」这类情况。`options.keys` 写备用密钥的变量名,分号分隔:

```
CORTICO_KEY_KAI;CORTICO_KEY_KAI_2
```

规则:

- **按顺序轮转**：收到 `401/403` 后才尝试下一把可用密钥，进程内不会自动切回之前的密钥。
- **只有一把时不轮转**:只有 `entry.secret` 一条时,行为与单密钥端点完全一致。
- **额度读数报当前那把**:面板读的是正在使用的密钥的窗口。换了密钥之后要点「立即刷新」才显示新账号的额度。
- 换密钥会丢一次 prompt 缓存,因为网关的缓存属于填了它的那个账号。

收到 `401/403` 时，按实际发送的密钥判断是否前进。并发请求收到同一把旧密钥的拒绝时，共用已经选出的备用密钥。存在不同的可用密钥时，框架执行一次鉴权重试。`429/5xx` 沿用框架的重试规则。

## 协议

`options.protocol`:

- `chat`(默认):`POST <baseUrl>/chat/completions`。Go 侧多数模型(GLM / Kimi / MiniMax / DeepSeek / Qwen-Max)是 Chat 原生,这条路不需要网关翻译。
- `responses`:`POST <baseUrl>/responses`。按官方 Responses 契约请求并回放加密思考块；仅重放来源和模型匹配的块，不合成思考文本。
- `anthropic`:`POST <baseUrl>/messages`,即 Messages API。回程的 SSE 翻成框架已校验的 Chat 形状,工具调用、终态与计量因此与另外两个方言同路。
- `gemini`:`POST <baseUrl>/models/<模型>:generateContent`,流式走 `:streamGenerateContent?alt=sse`。模型名与调用方法都在路径里，鉴权使用 OpenCode 官方的 `Authorization: Bearer`。

Console 官方声明支持文本跨协议翻译；附件仍取模型声明与协议格式的交集，文本翻译能力不等同于全部媒体都可跨协议发送。

Gemini 要求 `contents` 以 **user 轮**结尾,而框架的历史在「一轮以助手消息收尾」或「被事件推送打断」时会停在 model 轮上,于是报 `Requests ending with a model turn are not supported`。翻译器发现末轮是 model 就补一条极短的 user 轮(`(继续。)`),已经以 user 结尾的历史不动。`src/signatures.ts` 则负责签名:Gemini 3 起要求每个 `functionCall` 回传时带上模型给它的 `thoughtSignature`,而框架的历史只存 `{ id, type, function }`,放不下这个字段。所以 `src/signatures.ts` 按 call id 记住签名、回放时按 id 取回;进程重启或遇到更早的历史时,用文档里的 `skip_thought_signature_validator` 兜底放行——不带签名必然是 400,带哨兵则照常作答。

**为什么默认 chat**:同一段 100k 上下文实测,chat 首字节 2.3 秒、总耗时 3.5 秒;responses 首字节 5.5 秒、总耗时 6.0 秒。responses 让网关把整份上下文逐条翻成 Chat,上下文越长代价越大——工具定义与并发都不影响这个数(实测过),只有协议与上下文规模影响。

## 模型列表

端点页的「获取模型列表」每次都向网关实时请求,列表**按密钥过滤**:同一个地址,不带密钥拿到整个目录,带上你自己的密钥只拿到账号可用的那些。实测同一端点两个数字是 86 与 13。

所以列表里没有某个模型,通常意味着那个账户不能调它,而不是插件缓存了旧列表。`models.json` 只存上下文长度与价格这类补充事实,不存列表本身。

## 思考档位与默认值

端点页的「推理强度」有四档:不思考 / 快 / 标准 / 深入。后三档发的 effort 是 `low` / `medium` / `high`,即网关与 models.dev 列出的那组取值。

按官方型号表转换档位，详见[协议核对清单](docs/protocol-compatibility.md)。Gemini 4 Argon 的最低档为 LOW；支持 MINIMAL 的 Gemini 使用该档，2.5 使用预算接口。Claude 区分 adaptive、between_tools、手动预算与允许关闭的型号；强制思考型号的“关闭”映射为低 effort。未知型号不套用其他型号的原生思考参数。

Gemini 工具参数使用官方 `parametersJsonSchema`，保留数值 enum、布尔、const 与引用。Chat 工具回执只放文字，媒体放到完整回执组之后的 user 消息；Responses 保留官方允许的多模态工具输出。

本轮核对与修复的 16 项差异、逐项来源及验证范围见[完整记录](docs/protocol-compatibility.md)。

选中模型后,`normalize()` 会补上 OpenCode 文档里的默认:`temperature = 1`、`maxTokens = 8192`。只填空着的字段,运营者填过的值不会被覆盖。输出上限在端点页可以改——8192 是默认,不是上限。

每个请求都带 `x-opencode-session`:Go 端点会拒收没有这个头的请求。有会话 id 时用它,探测这类没有会话 id 的请求用端点自己的稳定 id。

## 模型清单

`GET <root>/v1/models`（按量）或 `GET <root>/go/v1/models`（Go）返回模型及其声明。请求携带当前密钥，列表以账号可用范围为准。

模型清单**不需要先填模型名**:端点里模型还空着时,`normalize()` 会把空的 `spec` 丢掉,于是「获取模型列表」照常可用——列表本来就是模型的来源。「测试连接」仍要先选模型,因为探测请求本身要带模型名。

网关直接返回名称、上下文、最大输出、精确输入 MIME 与计价声明；缺少字段时从 [models.dev](https://models.dev/api.json) 的对应 `opencode` / `opencode-go` 段补充，网关声明优先。每次获取模型列表都会刷新声明，缓存按地址和计费账户隔离。资料读取失败时仍可返回模型 ID，未知能力采用文本降级。

上下文的查询在需要时才读缓存:实例往往在拉列表之前就建好了,所以「当前模型」这一行与 `contextWindow()` 都能拿到列表刚写进去的信息。

清单外的 id 照样可以手填。

## 价目

选择模型后，「模型输入与计价」面板自动展示适用价格，约一秒内随模型或计费账户变化。数字框可直接修改，修改进入端点草稿，保存端点后生效。自动显示不会把当前价格写死为自定义覆盖；已有手填覆盖继续生效，点「恢复自动价格」可清除当前模型及通配覆盖，其他模型的专用覆盖保留。

优先使用网关 `cost` 声明，其次使用 2026-11-17 公开模型接口生成的随包快照，最后使用旧官方价表作为缺失模型的离线补充。模型列表重新获取时更新缓存。资料来源：[Console 模型/价表](https://opencode.ai/docs/console/models/)、[Go 价表](https://opencode.ai/docs/console/go/)和两个公开 `/inference[/go]/v1/models` 接口。

按实际声明显示费率，不再限于三项：未缓存输入、输出（含推理）、缓存读取、缓存写入及其时长（例如 30m / 12h）、音频输入等。完整 JSON 保留长上下文阶梯；日期折扣和峰谷倍率在请求开始时求值，历史固定使用请求当时的报价快照。未声明费率留空，不填成免费。

按量使用 `marginal`，Go 使用 `equivalent`，分别表示余额费用与订阅额度等价费用。`options.goPlan` 可选 `go` / `go-plus` / `go-teams`，只调整本机额度估算的月度额度，不改变实际扣费账户。

在宿主设置页新建 OpenCode Go 端点时，「模型输入与计价」中的「同步 Go 折算额到『实际支出』」（`options.mirrorGoSpend`）默认开启，随端点保存。已有端点可在同一面板修改。开启后每次新请求沿用当时的 Go 折算规则，手动设置的实际支出规则优先。同步金额仍是订阅估算，两个口径分别查看，历史费用快照保留原样。订阅额度面板只累计折算额。

网关明确报告由 Console 余额扣费时，「实际支出」优先使用响应中的美元金额，包括 Go 超额后转余额扣费的请求。这笔扣费不纳入本地 Go 额度估算。

计量读取上游 `opencode.tokens`，保留缓存写入和模态细分。上游没有报告某个收费项目的数量时，该项目金额保持未知；不会把 5m 缓存写入冒充为 30m 或猜测音频用量。纯文本请求的音频输入计为零。推理通常已包含在输出价格中，不重复收取一笔。

## 订阅额度面板

端点编辑页的段落顺序是**连接 → 模型与生成 → 订阅额度 → 计价 → 协议**:密钥填在最上面,往下紧接着就是模型列表与模型选择,额度跟在做它统计的那个模型后面。

额度段显示三个窗口——每 5 小时、每周、每月——的进度条与重置倒计时:

- **打开面板时不发请求**。先用本地的 `state` 判断能不能读:地址不是网关、端点按量计费、密钥还没填,都把原因写在面板上,不产生一次注定被拒的请求。
- 「立即刷新」才真的去读;读成功之后**才开始轮询**,每 5 分钟一次。
- 两次读之间,进度条按**本机消耗**推进:每次生成结束把这一次的金额记进端点账本,金额除以该模型的月度额度、再乘以窗口份额(5 小时 20%、每周 50%、每月 100%)就是推进的百分点。脚注此时标出「含本机消耗估算」,并在下一次读到网关值时被覆盖。
- 顶部一行「当前模型」写明所选模型的上下文上限与每百万 token 的输入/输出价,完整费率在「模型输入与计价」面板显示。

额度面板使用 [OpenCode Go 官方额度接口](https://opencode.ai/docs/console/go/#usage)。该接口用当前 Go 密钥查询，只用于读取额度和重置时间。

## 排错

| 看到什么 | 原因与处置 |
|---|---|
| `模型名不能为空` | 0.3.1 之前:模型字段空着时 `validateEntry` 拒掉整个请求,于是连模型列表都拉不到。0.3.1 起空 spec 会被 `normalize()` 丢掉,列表可用;「测试连接」仍会要求先选模型。 |
| `Request is missing x-opencode-session` | 0.3.1 之前:探测请求不带会话 id,Go 端点直接拒。现在每个请求都带,没有会话 id 的用端点自己的稳定 id。 |
| `OpenCode usage: HTTP 401` | 密钥没读到,或这个密钥不属于有 Go 订阅的工作区。错误信息里 `[key sent via bearer, N chars]` / `[no key]` 说明密钥到底发了没有、走的哪个头,后面跟响应正文。`[no key]` 表示端点的密钥变量没配好;`[key sent, …]` 表示密钥发出去了但被拒——推理能用不代表额度能读,核对工作区是否有 Go 订阅,或改用 OpenCode 里同一个密钥。被拒时模块会再用 `x-api-key` 试一次,哪种头有效会被记住。 |

## 已知限制

- 免费档模型只允许 OpenCode 自己的客户端调用,第三方客户端即使带密钥也收 403。付费模型与 Go 不受影响。
- Go 额度查询暂时失败时，面板保留上次成功读到的数据，并显示失败原因。
- 面板只在 Coopanion 的**高级模式**里可见:provider 的面板是端点编辑页的段落,框架不给 provider 单独的导航页。
- 只有上游明确返回且能匹配报价项目的用量细分才计算金额，缺失或缓存时长不匹配时保持未知。
- Gemini 方言的工具结果只能靠 call id 找回函数名:Gemini 的 `functionResponse` 只认名字,而框架保留的是 id。

## 校验

```bash
pnpm typecheck && pnpm typecheck:web && pnpm test && pnpm build:webui
```

`dist/webui.js` 和 `dist/webui.css` 是面板产物,装到用户机器上直接加载、不经过构建,所以它们要进仓库,`files` 里也要有 `dist`。

```bash
cd <Cortico 仓库根>
pnpm describe:extension <包目录>   # 改了 describe 之后
pnpm check:extension <包目录>
```

真实网关只能手测:起一个干净部署,端点填上面任一条地址,粘贴 Console 的密钥,拉一次模型清单,对话一轮,再看额度面板的数字。
