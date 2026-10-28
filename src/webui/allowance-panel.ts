/**
 * Allowance section of one endpoint: the 5-hour, weekly and monthly windows a Go subscription reports,
 * with a refresh button and polling.
 *
 * Between gateway reads the bars move on this machine's own spend: `local` returns the ledger's share of
 * each window without touching the network, so a finished generation shows up within a few seconds. The
 * gateway's own reading stays authoritative and replaces the estimate whenever it arrives.
 *
 * Text lives here rather than in `strings.ts` because a browser bundle may only import types from the
 * framework.
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { AllowanceState, LocalState, ModelState, ReadyState } from './server.ts';

const READ_MS = 5 * 60_000;
const LOCAL_MS = 5_000;
const TICK_MS = 1_000;

interface PanelText {
  title: string;
  refresh: string;
  reading: string;
  rolling: string;
  weekly: string;
  monthly: string;
  resetsIn(text: string): string;
  resetsAtLimit: string;
  localSpend(usd: string): string;
  estimated: string;
  readAt(time: string): string;
  stale(reason: string): string;
  unauthorized: string;
}

const zh: PanelText = {
  title: '订阅额度',
  refresh: '立即刷新',
  reading: '正在查询…',
  rolling: '每 5 小时',
  weekly: '每周',
  monthly: '每月',
  resetsIn: (text) => `${text}后重置`,
  resetsAtLimit: '已达上限',
  localSpend: (usd) => `本机自上次查询 ${usd}`,
  estimated: '含本机消耗估算',
  readAt: (time) => `查询于 ${time}`,
  stale: (reason) => `上次数据(${reason})`,
  unauthorized: '额度接口拒收了这个密钥:推理能用不等于额度能读。确认这个工作区有 Go 订阅,或改用 OpenCode 里同一个密钥。',
};

const zhHant: PanelText = {
  title: '訂閱額度',
  refresh: '立即重新整理',
  reading: '正在查詢…',
  rolling: '每 5 小時',
  weekly: '每週',
  monthly: '每月',
  resetsIn: (text) => `${text}後重置`,
  resetsAtLimit: '已達上限',
  localSpend: (usd) => `本機自上次查詢 ${usd}`,
  estimated: '含本機消耗估算',
  readAt: (time) => `查詢於 ${time}`,
  stale: (reason) => `上次資料(${reason})`,
  unauthorized: '額度介面拒收了這個金鑰:推理能用不等於額度能讀。確認這個工作區有 Go 訂閱,或改用 OpenCode 裡同一個金鑰。',
};

const en: PanelText = {
  title: 'Subscription allowance',
  refresh: 'Refresh now',
  reading: 'Reading…',
  rolling: 'Every 5 hours',
  weekly: 'Weekly',
  monthly: 'Monthly',
  resetsIn: (text) => `resets in ${text}`,
  resetsAtLimit: 'at the limit',
  localSpend: (usd) => `${usd} spent here since the last read`,
  estimated: 'includes this machine’s spend',
  readAt: (time) => `read at ${time}`,
  stale: (reason) => `last read (${reason})`,
  unauthorized: 'The usage endpoint refused this key: a key that can generate is not always a key that can read allowance. Check that this workspace has a Go subscription, or use the key OpenCode itself uses.',
};

function textFor(language: string): PanelText {
  if (language === 'zh') return zh;
  if (language === 'zh-Hant') return zhHant;
  return en;
}

const WINDOWS = ['rolling', 'weekly', 'monthly'] as const;
type Window = typeof WINDOWS[number];

function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function duration(ms: number): string {
  if (ms <= 0) return '0s';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export const allowancePanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const { ui } = ctx;
    const S = textFor(ctx.language);
    const name = ctx.scope.instance ?? '';
    const card = ui.sheet({ title: S.title });
    const bars = new Map<Window, ReturnType<typeof ui.progress>>();
    for (const window of WINDOWS) {
      const bar = ui.progress({ max: 100, value: 0, label: S[window] });
      bars.set(window, bar);
      card.el.append(bar.el);
    }
    const message = ui.msgline();
    const modelLine = ui.h('div', 'sh-desc');
    const footnote = ui.h('div', 'sh-desc');
    const refreshButton = ui.button(S.refresh, { size: 'sm', variant: 'plain', onClick: () => void refresh() });
    const bar = ui.rowbar();
    bar.append(refreshButton, message);
    card.el.append(modelLine, bar, footnote);
    ctx.root.append(card.el);

    let last: AllowanceState | null = null;
    let advance: Record<Window, number | null> = { rolling: null, weekly: null, monthly: null };
    let spend: Record<string, number> = {};
    let busy = false;

    function paint(): void {
      const now = Date.now();
      for (const window of WINDOWS) {
        const bar = bars.get(window)!;
        const reported = last?.usage[window];
        const extra = advance[window] ?? 0;
        const percent = reported ? Math.min(100, reported.percent + extra) : 0;
        bar.setValue(percent);
        if (!reported) {
          bar.setLabel(S[window]);
          continue;
        }
        const left = Date.parse(reported.resetsAt) - now;
        const state = reported.status === 'rate-limited' ? S.resetsAtLimit : S.resetsIn(duration(left));
        bar.setLabel(`${S[window]} · ${state}`);
      }
      const total = Object.values(spend).reduce((sum, value) => sum + value, 0);
      const parts: string[] = [];
      if (total > 0) parts.push(S.localSpend(usd(total)));
      if (last && Object.values(advance).some((value) => value !== null && value > 0)) parts.push(S.estimated);
      if (last) parts.push(S.readAt(new Date(last.readAt).toLocaleTimeString()));
      footnote.textContent = parts.join(' · ');
    }

    /**
     * Whether a read is possible right now. Answered locally, so a fresh endpoint that has no key yet
     * says so instead of sending a request the gateway can only refuse.
     */
    async function showState(): Promise<boolean> {
      try {
        const state = await ctx.invoke<ReadyState>('state', [{ name }]);
        message.classList.remove('bad');
        message.textContent = state.ready ? '' : (state.reason ?? '');
        return state.ready;
      } catch (error) {
        message.textContent = String(error);
        message.classList.add('bad');
        return false;
      }
    }

    /**
     * Reads the gateway once. Polling starts only after a read the operator asked for succeeded, so an
     * endpoint nobody has configured never calls out on its own.
     */
    async function refresh(): Promise<void> {
      if (busy) return;
      if (!(await showState())) return;
      busy = true;
      message.textContent = S.reading;
      message.classList.remove('bad');
      try {
        const state = await ctx.invoke<AllowanceState>('read', [{ name }]);
        last = state;
        advance = state.advance;
        spend = state.spend;
        message.textContent = '';
        startPolling();
      } catch (error) {
        const reason = String(error);
        // A 401 here is about the account, not the connection: say so instead of repeating the status.
        const hint = reason.includes('401') ? ` ${S.unauthorized}` : '';
        message.textContent = `${last ? S.stale(reason) : reason}${hint}`;
        message.classList.add('bad');
      } finally {
        busy = false;
        paint();
      }
    }

    let polling = false;
    function startPolling(): void {
      if (polling) return;
      polling = true;
      ctx.interval(() => void pollLocal(), LOCAL_MS);
      ctx.interval(() => void refresh(), READ_MS);
      ctx.interval(paint, TICK_MS);
    }

    async function pollLocal(): Promise<void> {
      void paintModel();
      if (busy) return;
      try {
        const state = await ctx.invoke<LocalState>('local', [{ name }]);
        advance = state.advance;
        spend = state.spend;
        paint();
      } catch {
        // the gateway read already reports its own failures; a local miss changes nothing on screen
      }
    }

    /**
     * What the chosen model costs. The endpoint's own pricing table is an override and stays empty when
     * the module's built-in prices apply, so the rates are stated here instead.
     */
    async function paintModel(): Promise<void> {
      try {
        const state = await ctx.invoke<ModelState>('model', [{ name }]);
        modelLine.textContent = state.line;
      } catch {
        modelLine.textContent = '';
      }
    }

    await paintModel();
    await showState();
  },
};
