import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { InputKind, ModelSettings } from './model-settings.ts';

export const modelPanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const en = ctx.language !== 'zh' && ctx.language !== 'zh-Hant';
    const { ui } = ctx;
    const sheet = ui.sheet({ title: en ? 'Model inputs and pricing' : '模型输入与计价' });
    ctx.root.append(sheet.el);
    const label = ui.h('div', 'opencode-model-label');
    const inputTypes = ui.h('p', 'tdesc');
    const switches = ui.h('div', 'opencode-input-switches');
    switches.style.cssText = 'display:flex;flex-wrap:wrap;gap:16px 24px;align-items:center;margin:12px 0';
    switches.setAttribute('role', 'group');
    switches.setAttribute('aria-label', en ? 'Accepted input types' : '接受的输入类型');
    const formatDetails = ui.h('details');
    formatDetails.append(ui.h('summary', null, en ? 'Declared formats' : '查看模型声明的格式'), inputTypes);
    const info = ui.h('p', 'tdesc', en
      ? 'USD per million tokens. Automatic rates follow this model and account. Changes are saved with the connection.'
      : '单位：USD / 百万 token。自动价格随模型和账户更新，修改随端点保存。');
    const status = ui.msgline();
    const fields = ui.h('div', 'opencode-pricing');
    const mirror = ui.h('div');
    const mirrorTitle = en ? 'Show Go estimates under Actual spend' : ctx.language === 'zh-Hant'
      ? '同步 Go 折算額到「實際支出」' : '同步 Go 折算额到「实际支出」';
    const mirrorHint = en ? 'Applies to new calls. The amount is a subscription estimate. Manual Actual spend rates take precedence.' : ctx.language === 'zh-Hant'
      ? '對新呼叫生效。金額為訂閱估算，手動設定的實際支出費率優先。' : '对新调用生效。金额为订阅估算，手动设置的实际支出费率优先。';
    const advanced = ui.h('details', 'pricing-rules');
    const raw = ui.textarea({ rows: 10, cls: 'mono' });
    raw.setAttribute('aria-label', en ? 'Full pricing rules' : '完整计价规则');
    const apply = ui.button(en ? 'Apply custom rules' : '应用自定义规则', { onClick: () => void saveRaw() });
    const reset = ui.button(en ? 'Use automatic prices' : '恢复自动价格', { onClick: () => void resetPrices() });
    const actions = ui.rowbar(); actions.append(reset, status);
    advanced.append(ui.h('summary', null, en ? 'Full pricing rules (JSON)' : '完整计价规则（JSON）'), raw, apply);
    sheet.body.append(label, switches, formatDetails, info, mirror, fields, actions, advanced);
    let state: ModelSettings | undefined;
    let fingerprint = '';
    let busy = false;
    let saving = false;
    let jsonDirty = false;
    let rateDirty = false;
    const inputLabels: Record<InputKind, string> = en
      ? { image: 'Images', audio: 'Audio', video: 'Video', file: 'PDF / files' }
      : { image: '接受图片', audio: '接受音频', video: '接受视频', file: '接受 PDF／文件' };
    const names: Record<string, string> = {
      uncachedInput: '未缓存输入', output: '输出（含推理）', cachedInput: '缓存读取',
      'detail:cache_write': '缓存写入', 'detail:audio_input': '音频输入', 'detail:audio_output': '音频输出',
    };
    const report = (error: unknown) => { if (!ctx.signal.aborted) { status.textContent = String(error); status.classList.add('bad'); } };
    async function refresh() {
      if (busy || saving || jsonDirty || rateDirty) return;
      busy = true;
      try {
        const next = await ctx.invoke<ModelSettings>('pricing-state', [{ name: ctx.scope.instance }]);
        if (jsonDirty || rateDirty || saving || ctx.signal.aborted) return;
        const key = JSON.stringify(next);
        state = next;
        if (key === fingerprint) return;
        fingerprint = key;
        label.textContent = `${next.model || '—'} · ${next.automatic ? (en ? 'Automatic prices' : '自动价格') : (en ? 'Custom prices' : '含自定义价格')}`;
        inputTypes.textContent = next.input.join(', ') || (en ? 'Unknown. Fetch the model list to read declarations.' : '暂未获得声明，请获取模型列表。');
        switches.replaceChildren();
        for (const setting of next.inputs) {
          const toggle = ui.h('input', 'connection-switch');
          toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.checked = setting.enabled;
          toggle.disabled = !setting.available;
          toggle.setAttribute('aria-label', inputLabels[setting.kind]);
          const title = !setting.declared ? (en ? 'Not declared by this model' : '该模型未声明支持此类输入')
            : !setting.available ? ((setting.kind === 'audio' || setting.kind === 'video') && next.protocol !== 'gemini'
              ? (en ? 'This adapter sends audio/video only through the native Gemini protocol' : '适配器目前仅通过原生 Gemini 协议发送音视频')
              : (en ? `Not supported by ${next.protocol}` : `当前 ${next.protocol} 协议不支持此类输入`))
              : next.attachmentsEnabled ? (en ? 'Follows the model declaration; can be disabled manually' : '按模型声明自动启用，可手动关闭')
                : (en ? 'All attachments are disabled; enabling this restores automatic attachments' : '全部附件已关闭；开启此项将恢复自动附件');
          const wrapper = ui.field(inputLabels[setting.kind], toggle);
          wrapper.classList.add('connection-toggle'); wrapper.title = title;
          wrapper.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0';
          toggle.addEventListener('change', () => void saveSwitch('input-save', toggle, { kind: setting.kind }), { signal: ctx.signal });
          switches.append(wrapper);
        }
        mirror.replaceChildren();
        if (typeof next.mirrorGoSpend === 'boolean') {
          const toggle = ui.h('input', 'connection-switch');
          toggle.type = 'checkbox';
          toggle.checked = next.mirrorGoSpend;
          toggle.setAttribute('role', 'switch');
          toggle.setAttribute('aria-label', mirrorTitle);
          toggle.addEventListener('change', () => void saveSwitch('pricing-mirror', toggle), { signal: ctx.signal });
          const wrapper = ui.field(mirrorTitle, toggle);
          wrapper.classList.add('connection-toggle');
          mirror.append(wrapper, ui.h('p', 'tdesc', mirrorHint));
        }
        fields.replaceChildren();
        for (const [index, definition] of next.definitions.entries()) {
          const group = ui.h('div'); group.style.margin = '16px 0';
          group.append(ui.section(`${definition.currency} · ${definition.basis === 'equivalent' ? (en ? 'Subscription allowance' : '订阅额度计价') : (en ? 'Balance cost' : '余额费用计价')}`));
          const grid = ui.h('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:14px 20px';
          for (const rule of definition.rules) {
            const title = en ? rule.meter : names[rule.meter] ?? rule.meter.replace('detail:cache_write_', '缓存写入 / ');
            const input = ui.input({ type: 'number', value: String(rule.perMillion) });
            input.min = '0'; input.step = 'any'; input.setAttribute('aria-label', title);
            input.addEventListener('input', () => { rateDirty = true; }, { signal: ctx.signal });
            input.addEventListener('change', () => {
              if (!state || !input.checkValidity() || !input.value.trim()) return;
              const definitions = structuredClone(state.definitions).map(value => {
                const { timeWindows: _, ...editable } = value;
                return { ...editable, models: [state!.model], source: 'webui' };
              });
              definitions[index].rules.find(value => value.meter === rule.meter)!.perMillion = Number(input.value);
              void save(definitions);
            }, { signal: ctx.signal });
            grid.append(ui.field(title, input));
          }
          group.append(grid);
          if (definition.inputBands?.length || definition.timeWindows?.length) group.append(ui.msgline(en
            ? 'Context tiers / time windows are included in the full rules.' : '含上下文阶梯或时段规则，详见完整计价规则。'));
          fields.append(group);
        }
        if (!next.definitions.length) fields.append(ui.msgline(en ? 'No published price; only usage will be recorded.' : '暂无已知价格，仅记录用量。'));
        if (!jsonDirty) raw.value = JSON.stringify(next.definitions, null, 2);
      } catch (error) { report(error); }
      finally { busy = false; }
    }
    async function saveSwitch(method: 'input-save' | 'pricing-mirror', toggle: HTMLInputElement, args = {}) {
      if (!state || saving) { toggle.checked = !toggle.checked; return; }
      saving = true; toggle.disabled = true;
      try {
        await ctx.invoke(method, [{ ...args, name: ctx.scope.instance, model: state.model, enabled: toggle.checked }]);
        fingerprint = ''; status.textContent = en ? 'Connection draft updated' : '已更新端点草稿'; status.classList.remove('bad');
      } catch (error) { toggle.checked = !toggle.checked; report(error); }
      finally { saving = false; toggle.disabled = false; }
      await refresh();
    }
    async function save(definitions: unknown[], fromJson = false) {
      if (!state || saving) return;
      saving = true;
      try {
        await ctx.invoke('pricing-save', [{ name: ctx.scope.instance, model: state.model, definitions }]);
        rateDirty = false; if (fromJson) jsonDirty = false;
        fingerprint = ''; status.textContent = en ? 'Connection draft updated' : '已更新端点草稿'; status.classList.remove('bad');
      } catch (error) { report(error); }
      finally { saving = false; }
      await refresh();
    }
    async function saveRaw() {
      try { const value: unknown = JSON.parse(raw.value); if (!Array.isArray(value)) throw new Error('JSON array required'); await save(value, true); }
      catch (error) { report(error); }
    }
    async function resetPrices() {
      if (!state || saving) return;
      saving = true;
      try {
        await ctx.invoke('pricing-reset', [{ name: ctx.scope.instance, model: state.model }]);
        jsonDirty = false; rateDirty = false; fingerprint = ''; status.classList.remove('bad');
      } catch (error) { report(error); }
      finally { saving = false; }
      await refresh();
    }
    raw.addEventListener('input', () => { jsonDirty = true; }, { signal: ctx.signal });
    ctx.guardLeave(() => jsonDirty || rateDirty ? (en ? 'Unapplied model setting changes' : '模型设置尚未应用') : null);
    await refresh();
    ctx.interval(() => void refresh(), 1000);
  },
};
