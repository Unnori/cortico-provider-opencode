// src/webui/model-panel.ts
var modelPanel = {
  mount: async (ctx) => {
    const en2 = ctx.language !== "zh" && ctx.language !== "zh-Hant";
    const { ui } = ctx;
    const sheet = ui.sheet({ title: en2 ? "Model inputs and pricing" : "\u6A21\u578B\u8F93\u5165\u4E0E\u8BA1\u4EF7" });
    ctx.root.append(sheet.el);
    const label = ui.h("div", "opencode-model-label");
    const inputTypes = ui.h("p", "tdesc");
    const switches = ui.h("div", "opencode-input-switches");
    switches.style.cssText = "display:flex;flex-wrap:wrap;gap:16px 24px;align-items:center;margin:12px 0";
    switches.setAttribute("role", "group");
    switches.setAttribute("aria-label", en2 ? "Accepted input types" : "\u63A5\u53D7\u7684\u8F93\u5165\u7C7B\u578B");
    const formatDetails = ui.h("details");
    formatDetails.append(ui.h("summary", null, en2 ? "Declared formats" : "\u67E5\u770B\u6A21\u578B\u58F0\u660E\u7684\u683C\u5F0F"), inputTypes);
    const info = ui.h("p", "tdesc", en2 ? "USD per million tokens. Automatic rates follow this model and account. Changes are saved with the connection." : "\u5355\u4F4D\uFF1AUSD / \u767E\u4E07 token\u3002\u81EA\u52A8\u4EF7\u683C\u968F\u6A21\u578B\u548C\u8D26\u6237\u66F4\u65B0\uFF0C\u4FEE\u6539\u968F\u7AEF\u70B9\u4FDD\u5B58\u3002");
    const status = ui.msgline();
    const fields = ui.h("div", "opencode-pricing");
    const mirror = ui.h("div");
    const mirrorTitle = en2 ? "Show Go estimates under Actual spend" : ctx.language === "zh-Hant" ? "\u540C\u6B65 Go \u6298\u7B97\u984D\u5230\u300C\u5BE6\u969B\u652F\u51FA\u300D" : "\u540C\u6B65 Go \u6298\u7B97\u989D\u5230\u300C\u5B9E\u9645\u652F\u51FA\u300D";
    const mirrorHint = en2 ? "Applies to new calls. The amount is a subscription estimate. Manual Actual spend rates take precedence." : ctx.language === "zh-Hant" ? "\u5C0D\u65B0\u547C\u53EB\u751F\u6548\u3002\u91D1\u984D\u70BA\u8A02\u95B1\u4F30\u7B97\uFF0C\u624B\u52D5\u8A2D\u5B9A\u7684\u5BE6\u969B\u652F\u51FA\u8CBB\u7387\u512A\u5148\u3002" : "\u5BF9\u65B0\u8C03\u7528\u751F\u6548\u3002\u91D1\u989D\u4E3A\u8BA2\u9605\u4F30\u7B97\uFF0C\u624B\u52A8\u8BBE\u7F6E\u7684\u5B9E\u9645\u652F\u51FA\u8D39\u7387\u4F18\u5148\u3002";
    const advanced = ui.h("details", "pricing-rules");
    const raw = ui.textarea({ rows: 10, cls: "mono" });
    raw.setAttribute("aria-label", en2 ? "Full pricing rules" : "\u5B8C\u6574\u8BA1\u4EF7\u89C4\u5219");
    const apply = ui.button(en2 ? "Apply custom rules" : "\u5E94\u7528\u81EA\u5B9A\u4E49\u89C4\u5219", { onClick: () => void saveRaw() });
    const reset = ui.button(en2 ? "Use automatic prices" : "\u6062\u590D\u81EA\u52A8\u4EF7\u683C", { onClick: () => void resetPrices() });
    const actions = ui.rowbar();
    actions.append(reset, status);
    advanced.append(ui.h("summary", null, en2 ? "Full pricing rules (JSON)" : "\u5B8C\u6574\u8BA1\u4EF7\u89C4\u5219\uFF08JSON\uFF09"), raw, apply);
    sheet.body.append(label, switches, formatDetails, info, mirror, fields, actions, advanced);
    let state;
    let fingerprint = "";
    let busy = false;
    let saving = false;
    let jsonDirty = false;
    let rateDirty = false;
    const inputLabels = en2 ? { image: "Images", audio: "Audio", video: "Video", file: "PDF / files" } : { image: "\u63A5\u53D7\u56FE\u7247", audio: "\u63A5\u53D7\u97F3\u9891", video: "\u63A5\u53D7\u89C6\u9891", file: "\u63A5\u53D7 PDF\uFF0F\u6587\u4EF6" };
    const names = {
      uncachedInput: "\u672A\u7F13\u5B58\u8F93\u5165",
      output: "\u8F93\u51FA\uFF08\u542B\u63A8\u7406\uFF09",
      cachedInput: "\u7F13\u5B58\u8BFB\u53D6",
      "detail:cache_write": "\u7F13\u5B58\u5199\u5165",
      "detail:audio_input": "\u97F3\u9891\u8F93\u5165",
      "detail:audio_output": "\u97F3\u9891\u8F93\u51FA"
    };
    const report = (error) => {
      if (!ctx.signal.aborted) {
        status.textContent = String(error);
        status.classList.add("bad");
      }
    };
    async function refresh() {
      if (busy || saving || jsonDirty || rateDirty) return;
      busy = true;
      try {
        const next = await ctx.invoke("pricing-state", [{ name: ctx.scope.instance }]);
        if (jsonDirty || rateDirty || saving || ctx.signal.aborted) return;
        const key = JSON.stringify(next);
        state = next;
        if (key === fingerprint) return;
        fingerprint = key;
        label.textContent = `${next.model || "\u2014"} \xB7 ${next.automatic ? en2 ? "Automatic prices" : "\u81EA\u52A8\u4EF7\u683C" : en2 ? "Custom prices" : "\u542B\u81EA\u5B9A\u4E49\u4EF7\u683C"}`;
        inputTypes.textContent = next.input.join(", ") || (en2 ? "Unknown. Fetch the model list to read declarations." : "\u6682\u672A\u83B7\u5F97\u58F0\u660E\uFF0C\u8BF7\u83B7\u53D6\u6A21\u578B\u5217\u8868\u3002");
        switches.replaceChildren();
        for (const setting of next.inputs) {
          const toggle = ui.h("input", "connection-switch");
          toggle.type = "checkbox";
          toggle.setAttribute("role", "switch");
          toggle.checked = setting.enabled;
          toggle.disabled = !setting.available;
          toggle.setAttribute("aria-label", inputLabels[setting.kind]);
          const title = !setting.declared ? en2 ? "Not declared by this model" : "\u8BE5\u6A21\u578B\u672A\u58F0\u660E\u652F\u6301\u6B64\u7C7B\u8F93\u5165" : !setting.available ? (setting.kind === "audio" || setting.kind === "video") && next.protocol !== "gemini" ? en2 ? "This adapter sends audio/video only through the native Gemini protocol" : "\u9002\u914D\u5668\u76EE\u524D\u4EC5\u901A\u8FC7\u539F\u751F Gemini \u534F\u8BAE\u53D1\u9001\u97F3\u89C6\u9891" : en2 ? `Not supported by ${next.protocol}` : `\u5F53\u524D ${next.protocol} \u534F\u8BAE\u4E0D\u652F\u6301\u6B64\u7C7B\u8F93\u5165` : next.attachmentsEnabled ? en2 ? "Follows the model declaration; can be disabled manually" : "\u6309\u6A21\u578B\u58F0\u660E\u81EA\u52A8\u542F\u7528\uFF0C\u53EF\u624B\u52A8\u5173\u95ED" : en2 ? "All attachments are disabled; enabling this restores automatic attachments" : "\u5168\u90E8\u9644\u4EF6\u5DF2\u5173\u95ED\uFF1B\u5F00\u542F\u6B64\u9879\u5C06\u6062\u590D\u81EA\u52A8\u9644\u4EF6";
          const wrapper = ui.field(inputLabels[setting.kind], toggle);
          wrapper.classList.add("connection-toggle");
          wrapper.title = title;
          wrapper.style.cssText = "display:flex;align-items:center;gap:10px;margin:0";
          toggle.addEventListener("change", () => void saveSwitch("input-save", toggle, { kind: setting.kind }), { signal: ctx.signal });
          switches.append(wrapper);
        }
        mirror.replaceChildren();
        if (typeof next.mirrorGoSpend === "boolean") {
          const toggle = ui.h("input", "connection-switch");
          toggle.type = "checkbox";
          toggle.checked = next.mirrorGoSpend;
          toggle.setAttribute("role", "switch");
          toggle.setAttribute("aria-label", mirrorTitle);
          toggle.addEventListener("change", () => void saveSwitch("pricing-mirror", toggle), { signal: ctx.signal });
          const wrapper = ui.field(mirrorTitle, toggle);
          wrapper.classList.add("connection-toggle");
          mirror.append(wrapper, ui.h("p", "tdesc", mirrorHint));
        }
        fields.replaceChildren();
        for (const [index, definition] of next.definitions.entries()) {
          const group = ui.h("div");
          group.style.margin = "16px 0";
          group.append(ui.section(`${definition.currency} \xB7 ${definition.basis === "equivalent" ? en2 ? "Subscription allowance" : "\u8BA2\u9605\u989D\u5EA6\u8BA1\u4EF7" : en2 ? "Balance cost" : "\u4F59\u989D\u8D39\u7528\u8BA1\u4EF7"}`));
          const grid = ui.h("div");
          grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:14px 20px";
          for (const rule of definition.rules) {
            const title = en2 ? rule.meter : names[rule.meter] ?? rule.meter.replace("detail:cache_write_", "\u7F13\u5B58\u5199\u5165 / ");
            const input = ui.input({ type: "number", value: String(rule.perMillion) });
            input.min = "0";
            input.step = "any";
            input.setAttribute("aria-label", title);
            input.addEventListener("input", () => {
              rateDirty = true;
            }, { signal: ctx.signal });
            input.addEventListener("change", () => {
              if (!state || !input.checkValidity() || !input.value.trim()) return;
              const definitions = structuredClone(state.definitions).map((value) => {
                const { timeWindows: _, ...editable } = value;
                return { ...editable, models: [state.model], source: "webui" };
              });
              definitions[index].rules.find((value) => value.meter === rule.meter).perMillion = Number(input.value);
              void save(definitions);
            }, { signal: ctx.signal });
            grid.append(ui.field(title, input));
          }
          group.append(grid);
          if (definition.inputBands?.length || definition.timeWindows?.length) group.append(ui.msgline(en2 ? "Context tiers / time windows are included in the full rules." : "\u542B\u4E0A\u4E0B\u6587\u9636\u68AF\u6216\u65F6\u6BB5\u89C4\u5219\uFF0C\u8BE6\u89C1\u5B8C\u6574\u8BA1\u4EF7\u89C4\u5219\u3002"));
          fields.append(group);
        }
        if (!next.definitions.length) fields.append(ui.msgline(en2 ? "No published price; only usage will be recorded." : "\u6682\u65E0\u5DF2\u77E5\u4EF7\u683C\uFF0C\u4EC5\u8BB0\u5F55\u7528\u91CF\u3002"));
        if (!jsonDirty) raw.value = JSON.stringify(next.definitions, null, 2);
      } catch (error) {
        report(error);
      } finally {
        busy = false;
      }
    }
    async function saveSwitch(method, toggle, args = {}) {
      if (!state || saving) {
        toggle.checked = !toggle.checked;
        return;
      }
      saving = true;
      toggle.disabled = true;
      try {
        await ctx.invoke(method, [{ ...args, name: ctx.scope.instance, model: state.model, enabled: toggle.checked }]);
        fingerprint = "";
        status.textContent = en2 ? "Connection draft updated" : "\u5DF2\u66F4\u65B0\u7AEF\u70B9\u8349\u7A3F";
        status.classList.remove("bad");
      } catch (error) {
        toggle.checked = !toggle.checked;
        report(error);
      } finally {
        saving = false;
        toggle.disabled = false;
      }
      await refresh();
    }
    async function save(definitions, fromJson = false) {
      if (!state || saving) return;
      saving = true;
      try {
        await ctx.invoke("pricing-save", [{ name: ctx.scope.instance, model: state.model, definitions }]);
        rateDirty = false;
        if (fromJson) jsonDirty = false;
        fingerprint = "";
        status.textContent = en2 ? "Connection draft updated" : "\u5DF2\u66F4\u65B0\u7AEF\u70B9\u8349\u7A3F";
        status.classList.remove("bad");
      } catch (error) {
        report(error);
      } finally {
        saving = false;
      }
      await refresh();
    }
    async function saveRaw() {
      try {
        const value = JSON.parse(raw.value);
        if (!Array.isArray(value)) throw new Error("JSON array required");
        await save(value, true);
      } catch (error) {
        report(error);
      }
    }
    async function resetPrices() {
      if (!state || saving) return;
      saving = true;
      try {
        await ctx.invoke("pricing-reset", [{ name: ctx.scope.instance, model: state.model }]);
        jsonDirty = false;
        rateDirty = false;
        fingerprint = "";
        status.classList.remove("bad");
      } catch (error) {
        report(error);
      } finally {
        saving = false;
      }
      await refresh();
    }
    raw.addEventListener("input", () => {
      jsonDirty = true;
    }, { signal: ctx.signal });
    ctx.guardLeave(() => jsonDirty || rateDirty ? en2 ? "Unapplied model setting changes" : "\u6A21\u578B\u8BBE\u7F6E\u5C1A\u672A\u5E94\u7528" : null);
    await refresh();
    ctx.interval(() => void refresh(), 1e3);
  }
};

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
var client_default = { panels: { allowance: allowancePanel, "model-settings": modelPanel } };
export {
  client_default as default
};
