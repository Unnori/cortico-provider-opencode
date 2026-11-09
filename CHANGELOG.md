## 0.5.2

- 修 Gemini 方言的 400:上游拒绝工具 schema 里的 additionalProperties,报 Invalid JSON payload received. Unknown name additionalProperties at tools[0].function_declarations[10].parameters。
- 新增 geminiSchema():把每个工具的 parameters 收敛到 Gemini 接受的关键字集合,递归处理 properties、items、anyOf/oneOf/allOf/not;无法识别的字段丢弃而不是拒绝整个请求。
- 触发条件是工具表里有 World 带 additionalProperties(内建的 web_search 就是),位置靠后的工具会报错,所以单个简单工具测不出来。
- 测试 90 → 95 条,覆盖递归清洗、真实 web_search 字段保留、非法输入替换。

## 0.5.1

- 流在上游被切断时,已经说出来的文字不再被丢弃。框架在错误里保存了快照(GenerationError.partial),但没有任何上层代码读它:一旦吐过文字就不再重试,于是内容直接作废、整轮重来。
- respond() 现在把这种快照包成 incomplete 响应返回,reason 为 stream_interrupted,与真正的输出截断区分开。一个字都没吐就失败的仍然照常失败重试——没有内容可显示,救它等于吞掉错误。
- 起因是一次 46.2 秒中断(Chat transport ended without finish_reason):框架三个超时都远大于 46 秒,所以是上游自己关的流;重试累积起来就是用户感觉到的长时间无响应。
- 测试 85 → 90 条。这一版没有线上实测:账号额度已用尽,造不出该场景,证据是代码路径与单元测试。

## 0.5.0

- 超限图片不再让会话卡死:发往上游前按 DeepSeek 的像素限制检查图片,超限的那一张从**本次请求**里拿掉,消息与文字保留,框架改发附件的 `fallbackText`。历史里的图片同样检查,所以一次超限不会让后续每一轮都失败。
- 限制随图片数量变化:少于 15 张时长边 8192px,15 张及以上 4096px。只解析文件头(JPEG SOF / PNG IHDR / WebP VP8X),不解码像素。
- 头读不出来的图片照常发送:猜一个拒绝会丢掉上游本来接受的图。
- 实测(真实编码的 PNG,尺寸取自 Issue #653):430×15222 与 413×14602 被拦下,436×503 通过,8192 通过、8193 拦下。测试 74 → 85 条。

## 0.4.1

- 修 Messages 方言的 `Chat transport ended without finish_reason`。`message_delta` 是 Messages 流里唯一带 stop reason 与用量的事件,连接在它之前断掉时,翻译层没有终止块可交,框架就把整轮判成失败。
- `MessagesAssembly.finish()` 现在会先补一个终止块再收尾:已经吐过内容、只是没走到终止事件的一轮,变成完整回复而不是错误。一个字符都没吐就断的,仍由框架正常重试(它本来就不会走到 finish)。
- 三个新测试:内容后断流、正常终止不重复收尾、max_tokens 判为不完整。66 → 74 条。

## 0.4.0

- 一个端点可以用多把密钥:`options.keys` 按顺序列出备用密钥变量名(分号分隔)。当前密钥被账号拒绝(额度用完或限流)后才换下一条,而且**不回头**——被拒意味着那个窗口已经用完,提前切回只会再丢一次缓存。
- 轮转靠框架已有的重试:**401/403 时**由 `onAuthError` 前进一位并让框架重试一次,`429/5xx` 由框架的重试循环处理,每次尝试的 `headers()` 都重新取当前密钥。
- 只有一把密钥时不轮转:行为与 0.3.9 完全一致。
- 额度读数仍是**当前在用**那把密钥的窗口;换密钥后因为端点 `.env` 指纹变了,实例会重建,面板读到的是新密钥的额度。
- 实测:第一次用无效密钥 → `401`,框架自动重试换成有效密钥 → `200`,轮换真实生效。测试 66 → 71 条。

## 0.3.9

- 真正修掉 Gemini 的 400:0.3.8 把问题判成「历史以 model 轮收尾」,方向错了。用真实会话重放才看清:框架给每个工具结果单独一条消息,而 0.3.8 让每个 `functionResponse` 各自成轮;一个 model 轮有 2–4 个 `functionCall` 时,response 数量就对不上,网关报 `number of function response parts is equal to the number of function call parts`。
- 规则改成:同一轮的并行结果**必须合并进同一个 response 轮**(文本绝不混入),这样 3 个 call 对 3 个 response、4 对 4。
- 修法用真实历史验证:把 `session-main.jsonl` 的 189 条真实条目喂给改后的翻译器,配对错位从 14 处降到 **0 处**,同一份 body 发到网关返回 **200**。
- 测试 62 → 66 条,新增并行结果合并与「文本不混入 response 轮」两条。

## 0.3.8

- 修 Gemini 方言的 `400 Requests ending with a model turn are not supported`:Gemini 要求 `contents` 以 user 轮结尾,而框架在「一轮以助手消息收尾」或「推送事件打断」时,历史正好停在 model 轮上。
- 翻译器发现末轮是 model 时补一条极短的 user 轮(`(继续。)`),让请求重新合法;已经以 user 结尾的历史不动。悬空的 `functionCall` 也一并覆盖。
- 实测:同一段历史以 model 结尾 → 400;补一条 user 轮 → 200 且正常作答(流式同样通过,并仍返回签名)。新增 3 条测试。

## 0.3.7

- 修 Gemini 方言在带工具的第二轮直接 400:`Function call is missing a thought_signature`。Gemini 3 起要求每个 `functionCall` 回传时带上模型给它的 `thoughtSignature`,而框架的 Chat 形状历史只保留 `{ id, type, function }`,签名放不进去。
- 新增 `src/signatures.ts`:按 call id 记住签名(有上限,长对话不会无限增长),回放历史时按 id 取回。进程重启或遇到更早的历史时,用 Gemini 文档里的 `skip_thought_signature_validator` 兜底放行,而不是丢掉这一轮。
- 实测确认:同一段历史不带签名 → 400;带哨兵 → 200 且模型正常回话(流式同样通过)。新增 4 条测试覆盖存、取、兜底与上限。

## 0.3.6

- 发布物带上 MIT 许可证文件 `LICENSE`;`package.json` 补 `repository` / `homepage` / `bugs`,npm 页因此链回仓库。
- README 增加「安装」一节:包名、link 本地目录、npm 与仓库链接。
- 新增 `.gitattributes`:行尾统一 LF,二进制不参与转换。
- 代码与行为未变,这一版只为把这些元数据带进发布物。

## 0.3.5

- 默认协议从 `responses` 改成 `chat`。同一段 100k 上下文实测:chat 首字节 2.3 秒、总耗时 3.5 秒;responses 首字节 5.5 秒、总耗时 6.0 秒。Go 侧多数模型(GLM / Kimi / MiniMax / DeepSeek / Qwen-Max)都是 Chat 原生,responses 要网关逐条翻译整份上下文,上下文越长代价越大。GPT / Grok / Muse 这类 Responses 原生模型仍然可以手动切回。
- 协议选项的说明写清了怎么选,不再只是列路径。**已保存的端点不受影响**(它们各自写了 `options.protocol`),只有没显式指定协议的老端点会跟着走新的默认值。

## 0.3.4

- 首个发布版:作者云纪,描述改为简体中文,图标为 512×512 PNG(`cortico.icon`)。
- 额度面板把「读不到」的三种原因分开说:端点还没保存(`host.editing`)、密钥变量名为空、密钥值没写进端点目录。之前一律说「先填好 API Key」,而真正的原因往往是端点还是草稿——框架给面板的是浏览器里的草稿 entry,刚输入的密钥值只在浏览器里,服务端看不到。
- 预填的输出上限不会再挡住保存:上下文窗口比 8192 还小的模型改成填窗口的一半,`validateSpec` 的「上下文必须大于输出」因此不会被触发。
- 预填与面板读取都只对**已保存**的端点生效,这是面板契约的限制,不是这一版的取舍。

## 0.3.3

- 额度面板不再在打开时就发请求:新建端点还没有密钥,那时候请求只能换来 401。改为先用本地的 `state` 判断能不能读,不能读就把原因写在面板上;轮询只在**第一次手动刷新成功之后**才启动。
- 轮询间隔从 60 秒改成 5 分钟。
- 补上四个思考档位(不思考 / 快 / 标准 / 深入),effort 用网关认的 `low` / `medium` / `high`。
- 选中模型后预填 `temperature = 1`、`maxTokens = 8192`,与 OpenCode 文档里的默认一致;运营者自己填过的值不动。

## 0.3.2

- 模型块上移到连接块下面:填完密钥往下就是「获取模型列表」与模型选择,不必先翻到底部再回到顶部测试连接。
- 上下文上限的查询改成延迟读缓存:实例往往在拉列表之前就建好了,旧写法拿不到刚写进去的模型信息,于是「当前模型」一行没有上下文。
- 额度读取失败时说明密钥到底发了没有:错误信息带上 `[key sent, N chars]` 或 `[no key]`,401 时面板再补一句「推理能用不等于额度能读」。

## 0.3.1

- 空模型不再挡住模型清单:`normalize()` 把 `spec.model` 为空的 spec 丢掉,于是「获取模型列表」不必先填模型名。测试连接仍要求先选模型,因为探测请求本身要带模型名。
- 每个请求都带 `x-opencode-session`:Go 端点会拒收没有这个头的请求(400)。没有会话 id 的探测请求改用端点自己的稳定 id。
- 额度面板的密钥改为调用时现读:端点是先建实例、后保存密钥的,旧写法拿到的是空密钥,于是 401。失败信息现在带上响应正文。
- 模型清单按 models.dev(OpenCode 自己读的那份模型库)补上上下文上限、最大输出与图片支持,按端点缓存一天,端点编辑页选中模型即可自动填入。
- 额度面板新增一行「当前模型」:上下文与每百万 token 的输入/输出价,因为端点里的价目表是覆盖用、模块内置价目生效时它是空的。

## 0.3.0

- 补上 Gemini 家族:`options.protocol` 新增 `gemini`,路径 `/google/v1beta/models/<模型>:generateContent`,流式走 `:streamGenerateContent?alt=sse`。密钥同时以 `Authorization: Bearer` 与 `x-goog-api-key` 发出,两边各读自己认的那个。工具结果按 call id 找回函数名,因为 Gemini 只认名字。

## 0.2.0

- 默认走 Go 订阅:新端点的地址与 `options.billing` 都指向 Go,`balance` 在配置里切换。去掉 `auto` 与它的试错换侧,计费账户只剩 `go` / `balance`。
- 补上 Messages 方言:`options.protocol` 新增 `anthropic`,请求走 `/anthropic/v1/messages`;回程的 SSE 翻成框架已校验的 Chat 形状,工具调用与计量因此与另外两个方言同路。
- 新增「订阅额度」面板:每 5 小时 / 每周 / 每月的进度条与重置倒计时,60 秒轮询,另有「立即刷新」按钮。两次查询之间按本机消耗推进进度条,此时脚注标出「含本机消耗估算」。

## 0.1.0

- OpenCode Console 网关作为供应商:一条端点用 Responses 或 Chat Completions,Console 会把全部文本模型翻译到所选的那一套。
- 模型清单取自网关根 `/v1/models`(免鉴权);价目内置按量与 Go 两张表,含长上下文档、Go 的峰谷时段与限时折扣。
