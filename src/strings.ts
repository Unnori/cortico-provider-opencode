/**
 * WebUI wording for the endpoint page and the errors this module throws. OpenCode is a proper noun and
 * stays as written; only the labels around it are translated.
 */
import type { Language } from 'cortico/core/language.ts';

export interface OpenCodeText {
  title: string;
  description: string;
  protocol: string;
  protocolHint: string;
  billing: string;
  billingHint: string;
  badProtocol(allowed: string): string;
  badBilling(allowed: string): string;
  allowancePanel: string;
  allowancePanelHint: string;
  windowRolling: string;
  windowWeekly: string;
  windowMonthly: string;
  refresh: string;
  reading: string;
  rateLimited: string;
  resetsAt: string;
  localSpend(usd: string): string;
  estimated: string;
  readAt(time: string): string;
  stale(reason: string): string;
  notGo: string;
  notGateway: string;
  instanceRequired: string;
  unknownMethod(method: string): string;
  noModelPicked: string;
  noKeyYet: string;
  notSaved: string;
  noSecretName: string;
  noSecretValue: string;
  tierOff: string;
  tierLow: string;
  tierMedium: string;
  tierHigh: string;
  modelRates(model: string, context: string | null, input: string | null, output: string | null): string;
}

const zh: OpenCodeText = {
  title: 'OpenCode',
  description: 'OpenCode 的模型供应商:默认走 Go 订阅的额度,支持 Responses、Chat、Messages 与 Gemini,内置价目与额度面板。',
  protocol: '协议',
  protocolHint: 'chat 走 /chat/completions,是多数模型的原生路径,实测最快;GPT / Grok / Muse 这类 Responses 原生模型选 responses;Messages 与 Gemini 各有专用家族路径。Console 会把每个文本模型翻译到你选的这一套,翻译要按上下文逐条做。',
  billing: '计费账户',
  billingHint: 'go 走 Go 订阅的额度,balance 走 Console 余额。额度窗口只对 Go 有。',
  badProtocol: (allowed) => `协议只能是 ${allowed}。`,
  badBilling: (allowed) => `计费账户只能是 ${allowed}。`,
  allowancePanel: '订阅额度',
  allowancePanelHint: '每 5 小时、每周、每月的用量与重置时间;只对 Go 订阅有。',
  windowRolling: '每 5 小时',
  windowWeekly: '每周',
  windowMonthly: '每月',
  refresh: '立即刷新',
  reading: '正在查询…',
  rateLimited: '已达上限',
  resetsAt: '重置于',
  localSpend: (usd) => `本机自上次查询 ${usd}`,
  estimated: '含本机消耗估算',
  readAt: (time) => `查询于 ${time}`,
  stale: (reason) => `上次数据(${reason})`,
  notGo: '这个端点按量计费,没有额度窗口。花费看「用量与成本」页。',
  notGateway: '端点地址不是 OpenCode 网关,读不到额度。',
  instanceRequired: '缺少端点名。',
  unknownMethod: (method) => `额度面板没有 ${method} 这个方法。`,
  noModelPicked: '先在「模型与生成」里选一个模型。',
  noKeyYet: '先在「连接」里填好 API Key 并保存端点,再点「立即刷新」。',
  notSaved: '这个端点还没保存。面板读的是已保存的配置,浏览器里刚输入的密钥它还看不到——先点保存,再点「立即刷新」。',
  noSecretName: '端点的密钥变量名是空的。在「连接」里填好 API Key,保存时会自动生成变量名。',
  noSecretValue: '密钥值还没写进端点目录。填好 API Key 并保存,再点「立即刷新」。',
  tierOff: '不思考',
  tierLow: '思考 · 快',
  tierMedium: '思考 · 标准',
  tierHigh: '思考 · 深入',
  modelRates: (model, context, input, output) => {
    const parts = [`当前模型 ${model}`];
    if (context) parts.push(`上下文 ${context}`);
    if (input || output) parts.push(`每百万 token 输入 ${input ?? '?'} / 输出 ${output ?? '?'}`);
    return parts.join(' · ');
  },
};

const zhHant: OpenCodeText = {
  title: 'OpenCode',
  description: 'OpenCode 的模型供應商:預設走 Go 訂閱的額度,支援 Responses、Chat、Messages 與 Gemini,內建價目與額度面板。',
  protocol: '協定',
  protocolHint: 'chat 走 /chat/completions,是多數模型的原生路徑,實測最快;GPT / Grok / Muse 這類 Responses 原生模型選 responses;Messages 與 Gemini 各有專用家族路徑。Console 會把每個文字模型翻譯到你選的這一套,翻譯要按上下文逐條做。',
  billing: '計費帳戶',
  billingHint: 'go 走 Go 訂閱的額度,balance 走 Console 餘額。額度視窗只對 Go 有。',
  badProtocol: (allowed) => `協定只能是 ${allowed}。`,
  badBilling: (allowed) => `計費帳戶只能是 ${allowed}。`,
  allowancePanel: '訂閱額度',
  allowancePanelHint: '每 5 小時、每週、每月的用量與重置時間;只對 Go 訂閱有。',
  windowRolling: '每 5 小時',
  windowWeekly: '每週',
  windowMonthly: '每月',
  refresh: '立即重新整理',
  reading: '正在查詢…',
  rateLimited: '已達上限',
  resetsAt: '重置於',
  localSpend: (usd) => `本機自上次查詢 ${usd}`,
  estimated: '含本機消耗估算',
  readAt: (time) => `查詢於 ${time}`,
  stale: (reason) => `上次資料(${reason})`,
  notGo: '這個端點按量計費,沒有額度視窗。花費看「用量與成本」頁。',
  notGateway: '端點位址不是 OpenCode 閘道,讀不到額度。',
  instanceRequired: '缺少端點名。',
  unknownMethod: (method) => `額度面板沒有 ${method} 這個方法。`,
  noModelPicked: '先在「模型與生成」裡選一個模型。',
  noKeyYet: '先在「連線」裡填好 API Key 並儲存端點,再點「立即重新整理」。',
  notSaved: '這個端點還沒儲存。面板讀的是已儲存的設定,瀏覽器裡剛輸入的金鑰它還看不到——先按儲存,再點「立即重新整理」。',
  noSecretName: '端點的金鑰變數名是空的。在「連線」裡填好 API Key,儲存時會自動產生變數名。',
  noSecretValue: '金鑰值還沒寫進端點目錄。填好 API Key 並儲存,再點「立即重新整理」。',
  tierOff: '不思考',
  tierLow: '思考 · 快',
  tierMedium: '思考 · 標準',
  tierHigh: '思考 · 深入',
  modelRates: (model, context, input, output) => {
    const parts = [`目前模型 ${model}`];
    if (context) parts.push(`上下文 ${context}`);
    if (input || output) parts.push(`每百萬 token 輸入 ${input ?? '?'} / 輸出 ${output ?? '?'}`);
    return parts.join(' · ');
  },
};

const en: OpenCodeText = {
  title: 'OpenCode',
  description: 'The OpenCode provider: a Go subscription by default, over Responses, Chat, Messages or the Gemini API, with built-in prices and an allowance panel.',
  protocol: 'Protocol',
  protocolHint: 'chat posts to /chat/completions, the native path for most models and the fastest one measured; pick responses for Responses-native models such as GPT, Grok and Muse; Messages and Gemini have their own family paths. Console translates every text model to whichever one you pick, item by item across the whole context.',
  billing: 'Billed to',
  billingHint: 'go spends the Go subscription allowance, balance spends Console credit. Only Go has allowance windows.',
  badProtocol: (allowed) => `Protocol must be ${allowed}.`,
  badBilling: (allowed) => `Billing must be ${allowed}.`,
  allowancePanel: 'Subscription allowance',
  allowancePanelHint: 'Usage and reset time for the 5-hour, weekly and monthly windows; a Go subscription only.',
  windowRolling: 'Every 5 hours',
  windowWeekly: 'Weekly',
  windowMonthly: 'Monthly',
  refresh: 'Refresh now',
  reading: 'Reading…',
  rateLimited: 'At the limit',
  resetsAt: 'resets',
  localSpend: (usd) => `${usd} spent here since the last read`,
  estimated: 'includes this machine’s spend',
  readAt: (time) => `read at ${time}`,
  stale: (reason) => `last read (${reason})`,
  notGo: 'This endpoint bills the Console balance, which has no allowance windows. Spend is on the Usage page.',
  notGateway: 'The endpoint URL is not an OpenCode gateway, so there is nothing to read.',
  instanceRequired: 'The endpoint name is missing.',
  unknownMethod: (method) => `The allowance panel has no ${method} method.`,
  noModelPicked: 'Pick a model under Model and generation first.',
  noKeyYet: 'Fill in the API key under Connection and save the endpoint, then press Refresh now.',
  notSaved: 'This endpoint is not saved yet. The panel reads the saved configuration, so it cannot see a key that only exists in the browser — save first, then press Refresh now.',
  noSecretName: 'The endpoint has no secret variable name. Fill in the API key under Connection; saving derives the name.',
  noSecretValue: 'The key value has not been written to the endpoint directory. Fill it in and save, then press Refresh now.',
  tierOff: 'No thinking',
  tierLow: 'Thinking · fast',
  tierMedium: 'Thinking · standard',
  tierHigh: 'Thinking · deeper',
  modelRates: (model, context, input, output) => {
    const parts = [`Model ${model}`];
    if (context) parts.push(`${context} context`);
    if (input || output) parts.push(`per million tokens in ${input ?? '?'} / out ${output ?? '?'}`);
    return parts.join(' · ');
  },
};

export function opencodeText(language: Language): OpenCodeText {
  if (language === 'zh') return zh;
  if (language === 'zh-Hant') return zhHant;
  return en;
}
