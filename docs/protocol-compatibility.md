# OpenCode 协议核对（2026-11-17）

范围：本适配器实际实现的 Anthropic Messages、Gemini generateContent、OpenAI Chat Completions、OpenAI Responses，覆盖工具声明、工具回执、附件、思考配置、终态和用量。

## 依据与边界

- [OpenCode Inference API](https://opencode.ai/docs/console/api/inference/)：路由、Bearer 鉴权、流式和 `cost`／`opencode.tokens` 语义。
- [OpenCode 模型说明](https://opencode.ai/docs/console/models/)：模型原生 API 及文本跨协议翻译。文本可翻译不等于任意媒体可跨协议发送；不自动切换用户所选协议。
- [Google FunctionDeclaration](https://aistudio.google.com/api-reference/caching#Resource:FunctionDeclaration)：`parameters` 是受限 Schema，`parametersJsonSchema` 是互斥的 JSON Schema 字段。
- [Google generateContent](https://aistudio.google.com/api-reference/generate-content)：思考计量、终态、工具配置；[思考模型表](https://aistudio.google.com/docs/thinking#thinking-levels)说明每个模型的档位。
- [OpenAI Chat 类型](https://developers.openai.com/api/reference/resources/chat)：tool 消息只接受文字；[Responses 创建接口](https://developers.openai.com/api/reference/resources/responses/methods/create)允许 function_call_output 的多模态输出。
- [OpenAI 文件输入](https://developers.openai.com/api/docs/guides/file-inputs)：Chat 文件仅 PDF；Responses 按列明的 MIME 接收文件。[图片要求](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements)：PNG、JPEG、WebP、静态 GIF。
- [Claude 工具回执](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)、[并行工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)、[文本文档与 PDF](https://platform.claude.com/docs/en/build-with-claude/citations)、[图片](https://platform.claude.com/docs/en/build-with-claude/vision)。
- [Claude thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)与[手动预算](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)：模型差异、采样限制、签名和 redacted_thinking 回放。

官方 OpenCode 文档没有给出全部跨协议媒体转换规则，所以附件许可取“所选模型声明 ∩ 已实现的协议格式 ∩ 用户设置”。按用户决定，音视频继续只允许原生 Gemini；这项限制不代表 Chat 协议本身没有音频功能。普通 `text` 模态不被解释成支持上传任意文本文件。

模型思考表为上述日期核对的明确 ID 清单；未知 ID 不套用其他型号的原生思考字段，也不自动选择协议。原生 Gemini 的“关闭思考”在不可关闭的模型上表示最低允许档位。Claude 必须思考的型号用低 effort；Sonnet 5.5 使用 between_tools；Claude 4.5 使用手动预算最低值 1024，输出上限不足时明确报错。后续官方模型更新仍需更新表，而不是用版本前缀猜能力。

## 本轮确认并处理的 16 项差异

| # | 原问题 | 修复 |
|---|---|---|
| 1 | Gemini 用受限 Schema 承载 JSON Schema，数字 enum 引发 TYPE_STRING 400 | 使用 parametersJsonSchema，保留数值、布尔、const、引用和组合约束，原工具入参类型不变 |
| 2 | Chat 把图片／文件直接塞进 tool 消息 | tool 保留文字；整组并行回执结束后，在 user 消息附媒体 |
| 3 | 只看模型 MIME，忽略协议图片／文件范围 | 统一协议约束；Chat 文件只允许 PDF，Responses 按官方文件 MIME，Messages 为四种图片／PDF／text/plain |
| 4 | OpenAI 图片路径放行动画 GIF | 检查 GIF 块；动画或损坏 GIF 降级文字，不解码或转码 |
| 5 | Messages 将文本文档错误编码为 base64 source | text/plain 使用 source.type=text 和 UTF-8；PDF 保持 base64 |
| 6 | 把普通 text 模态外推成所有 text/* 文件 | 只有明确文件 MIME 才允许相应文本附件 |
| 7 | 文件开关遗漏明确声明的 text/plain 等文本文档 | 文件类别纳入明确的文本 MIME，查询与发送共享开关 |
| 8 | Gemini 漏算 thoughtsTokenCount；Gemini／Messages 丢 cost | 输出包含 thoughts，reasoning 单独列出但不重复收费；保存网关 cost 原始数据 |
| 9 | 所有 Gemini 型号都强行使用同一 thinkingLevel | 按官方型号档位表；2.5 使用预算，未知型号不注入 |
| 10 | 所有 Claude 都套 adaptive／disabled，部分型号及采样参数会 400 | 按型号选择思考模式，避开明确不允许的 temperature；未知型号不注入原生思考字段 |
| 11 | Messages 丢弃 signature 与 redacted_thinking，多轮工具回放不完整 | 保存完整签名块到 opaque reasoning 数据；仅同模型、兼容来源回放，缓冲有大小上限 |
| 12 | Responses 默认明文回放且合成思考条目 | 默认官方 encrypted 回放，按来源隔离；不合成模型未生成的 reasoning_text |
| 13 | Gemini／Messages 忽略 tool_choice 和相关原生限制 | 映射原生选择；Messages 映射禁用并行；明确不支持强制工具的型号在本地给出错误 |
| 14 | Gemini 被拦截／无效工具终态被当作普通完成 | 保留安全拦截或失败语义；Messages 上下文窗口终态标为不完整，不伪造成功 |
| 15 | Gemini／Messages 断流时合成正常 stop | 缺少终态保持失败；已输出文字可保留为 incomplete，取消仍是取消 |
| 16 | 读附件抛错或文本非 UTF-8 会破坏整次调用／内容 | 保留附件说明并剔除不可读取或编码无效的附件 |

端点和鉴权核对后保留官方路径；Gemini 网关请求统一使用 OpenCode 声明的 Bearer，不额外发送 Google 原生密钥头。

## 验证与未覆盖范围

`tests/protocol-contract.test.ts` 检查四协议最终 HTTP body 的 schema、数字类型、并行回执媒体顺序、原生文本文档、MIME 边界、思考表、签名回放、终态、SSE 断流和计量；其他附件、安全与计价测试继续执行。本地微信 → 真实 Core → 模拟 Gemini HTTP 测试覆盖图片／音频／视频／PDF 的原字节和开关更新。

测试不会调用付费网关。官方兼容声明与本地回归通过，不等于已验证每种模型／账户／代理在真实网关的行为；本轮没有操作用户正在运行的 Coopanion 安装目录。本文随 0.7.0 发布，npm 发布由维护者处理。
