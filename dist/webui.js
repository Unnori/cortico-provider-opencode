// src/webui/allowance-panel.ts
var READ_MS = 5 * 6e4;
var LOCAL_MS = 5e3;
var TICK_MS = 1e3;
var zh = {
  title: "\u8BA2\u9605\u989D\u5EA6",
  refresh: "\u7ACB\u5373\u5237\u65B0",
  reading: "\u6B63\u5728\u67E5\u8BE2\u2026",
  rolling: "\u6BCF 5 \u5C0F\u65F6",
  weekly: "\u6BCF\u5468",
  monthly: "\u6BCF\u6708",
  resetsIn: (text) => `${text}\u540E\u91CD\u7F6E`,
  resetsAtLimit: "\u5DF2\u8FBE\u4E0A\u9650",
  localSpend: (usd2) => `\u672C\u673A\u81EA\u4E0A\u6B21\u67E5\u8BE2 ${usd2}`,
  estimated: "\u542B\u672C\u673A\u6D88\u8017\u4F30\u7B97",
  readAt: (time) => `\u67E5\u8BE2\u4E8E ${time}`,
  stale: (reason) => `\u4E0A\u6B21\u6570\u636E(${reason})`,
  unauthorized: "\u989D\u5EA6\u63A5\u53E3\u62D2\u6536\u4E86\u8FD9\u4E2A\u5BC6\u94A5:\u63A8\u7406\u80FD\u7528\u4E0D\u7B49\u4E8E\u989D\u5EA6\u80FD\u8BFB\u3002\u786E\u8BA4\u8FD9\u4E2A\u5DE5\u4F5C\u533A\u6709 Go \u8BA2\u9605,\u6216\u6539\u7528 OpenCode \u91CC\u540C\u4E00\u4E2A\u5BC6\u94A5\u3002"
};
var zhHant = {
  title: "\u8A02\u95B1\u984D\u5EA6",
  refresh: "\u7ACB\u5373\u91CD\u65B0\u6574\u7406",
  reading: "\u6B63\u5728\u67E5\u8A62\u2026",
  rolling: "\u6BCF 5 \u5C0F\u6642",
  weekly: "\u6BCF\u9031",
  monthly: "\u6BCF\u6708",
  resetsIn: (text) => `${text}\u5F8C\u91CD\u7F6E`,
  resetsAtLimit: "\u5DF2\u9054\u4E0A\u9650",
  localSpend: (usd2) => `\u672C\u6A5F\u81EA\u4E0A\u6B21\u67E5\u8A62 ${usd2}`,
  estimated: "\u542B\u672C\u6A5F\u6D88\u8017\u4F30\u7B97",
  readAt: (time) => `\u67E5\u8A62\u65BC ${time}`,
  stale: (reason) => `\u4E0A\u6B21\u8CC7\u6599(${reason})`,
  unauthorized: "\u984D\u5EA6\u4ECB\u9762\u62D2\u6536\u4E86\u9019\u500B\u91D1\u9470:\u63A8\u7406\u80FD\u7528\u4E0D\u7B49\u65BC\u984D\u5EA6\u80FD\u8B80\u3002\u78BA\u8A8D\u9019\u500B\u5DE5\u4F5C\u5340\u6709 Go \u8A02\u95B1,\u6216\u6539\u7528 OpenCode \u88E1\u540C\u4E00\u500B\u91D1\u9470\u3002"
};
var en = {
  title: "Subscription allowance",
  refresh: "Refresh now",
  reading: "Reading\u2026",
  rolling: "Every 5 hours",
  weekly: "Weekly",
  monthly: "Monthly",
  resetsIn: (text) => `resets in ${text}`,
  resetsAtLimit: "at the limit",
  localSpend: (usd2) => `${usd2} spent here since the last read`,
  estimated: "includes this machine\u2019s spend",
  readAt: (time) => `read at ${time}`,
  stale: (reason) => `last read (${reason})`,
  unauthorized: "The usage endpoint refused this key: a key that can generate is not always a key that can read allowance. Check that this workspace has a Go subscription, or use the key OpenCode itself uses."
};
function textFor(language) {
  if (language === "zh") return zh;
  if (language === "zh-Hant") return zhHant;
  return en;
}
var WINDOWS = ["rolling", "weekly", "monthly"];
function usd(value) {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}
function duration(ms) {
  if (ms <= 0) return "0s";
  const minutes = Math.floor(ms / 6e4);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
var allowancePanel = {
  mount: async (ctx) => {
    const { ui } = ctx;
    const S = textFor(ctx.language);
    const name = ctx.scope.instance ?? "";
    const card = ui.sheet({ title: S.title });
    const bars = /* @__PURE__ */ new Map();
    for (const window of WINDOWS) {
      const bar2 = ui.progress({ max: 100, value: 0, label: S[window] });
      bars.set(window, bar2);
      card.el.append(bar2.el);
    }
    const message = ui.msgline();
    const modelLine = ui.h("div", "sh-desc");
    const footnote = ui.h("div", "sh-desc");
    const refreshButton = ui.button(S.refresh, { size: "sm", variant: "plain", onClick: () => void refresh() });
    const bar = ui.rowbar();
    bar.append(refreshButton, message);
    card.el.append(modelLine, bar, footnote);
    ctx.root.append(card.el);
    let last = null;
    let advance = { rolling: null, weekly: null, monthly: null };
    let spend = {};
    let busy = false;
    function paint() {
      const now = Date.now();
      for (const window of WINDOWS) {
        const bar2 = bars.get(window);
        const reported = last?.usage[window];
        const extra = advance[window] ?? 0;
        const percent = reported ? Math.min(100, reported.percent + extra) : 0;
        bar2.setValue(percent);
        if (!reported) {
          bar2.setLabel(S[window]);
          continue;
        }
        const left = Date.parse(reported.resetsAt) - now;
        const state = reported.status === "rate-limited" ? S.resetsAtLimit : S.resetsIn(duration(left));
        bar2.setLabel(`${S[window]} \xB7 ${state}`);
      }
      const total = Object.values(spend).reduce((sum, value) => sum + value, 0);
      const parts = [];
      if (total > 0) parts.push(S.localSpend(usd(total)));
      if (last && Object.values(advance).some((value) => value !== null && value > 0)) parts.push(S.estimated);
      if (last) parts.push(S.readAt(new Date(last.readAt).toLocaleTimeString()));
      footnote.textContent = parts.join(" \xB7 ");
    }
    async function showState() {
      try {
        const state = await ctx.invoke("state", [{ name }]);
        message.classList.remove("bad");
        message.textContent = state.ready ? "" : state.reason ?? "";
        return state.ready;
      } catch (error) {
        message.textContent = String(error);
        message.classList.add("bad");
        return false;
      }
    }
    async function refresh() {
      if (busy) return;
      if (!await showState()) return;
      busy = true;
      message.textContent = S.reading;
      message.classList.remove("bad");
      try {
        const state = await ctx.invoke("read", [{ name }]);
        last = state;
        advance = state.advance;
        spend = state.spend;
        message.textContent = "";
        startPolling();
      } catch (error) {
        const reason = String(error);
        const hint = reason.includes("401") ? ` ${S.unauthorized}` : "";
        message.textContent = `${last ? S.stale(reason) : reason}${hint}`;
        message.classList.add("bad");
      } finally {
        busy = false;
        paint();
      }
    }
    let polling = false;
    function startPolling() {
      if (polling) return;
      polling = true;
      ctx.interval(() => void pollLocal(), LOCAL_MS);
      ctx.interval(() => void refresh(), READ_MS);
      ctx.interval(paint, TICK_MS);
    }
    async function pollLocal() {
      void paintModel();
      if (busy) return;
      try {
        const state = await ctx.invoke("local", [{ name }]);
        advance = state.advance;
        spend = state.spend;
        paint();
      } catch {
      }
    }
    async function paintModel() {
      try {
        const state = await ctx.invoke("model", [{ name }]);
        modelLine.textContent = state.line;
      } catch {
        modelLine.textContent = "";
      }
    }
    await paintModel();
    await showState();
  }
};

// src/webui/client.ts
var client_default = { panels: { allowance: allowancePanel } };
export {
  client_default as default
};
