<script lang="ts">
  /**
   * AgentSettingsModal — Agent 的提供商 / Key / 模型 / 行为设置。
   *
   * 结构与 `SettingsModal` 完全一致（左 navside + 右内容 + 底部动作），
   * 因为这两个面板是同一类东西：**设置**。堆成一长条会让「访问 / 模型 /
   * 行为 / 隐私」混在一起，找一项要滚半天。
   *
   * **挂在根级**（`App.svelte` 的 `.page` 上），不挂进 Agent 抽屉：
   * 抽屉是一个带 `z-index` 的层叠上下文，从它里面打开的 modal 会被困在那一层，
   * 右侧检查器（同 z）会盖住遮罩。根级还顺带保证「两个视图只有一个实例」。
   *
   * 提供商不是普通下拉：17 家挤在一个自绘下拉里既没有分组的视觉线索、
   * 也放不进品牌图。所以这里用「按国内 / 国外 / 自定义分组的选择列表」。
   */
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import Field from '../controls/Field.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import Checkbox from '../controls/Checkbox.svelte';
  import Select from '../controls/Select.svelte';
  import Icon from '../Icon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import { agentState, type AgentEffort } from './agent-state.svelte';
  import { PROVIDERS, MAX_STEPS_LIMIT } from '../../agent/llm/index';
  import { tr } from '../../i18n/index.svelte';

  type Section = 'access' | 'model' | 'behavior' | 'security';
  let section = $state<Section>('access');

  const SECTIONS: { id: Section; labelKey: 'agent.access' | 'agent.modelSection' | 'agent.behavior' | 'agent.security' }[] = [
    { id: 'access', labelKey: 'agent.access' },
    { id: 'model', labelKey: 'agent.modelSection' },
    { id: 'behavior', labelKey: 'agent.behavior' },
    { id: 'security', labelKey: 'agent.security' },
  ];

  const GROUPS: { id: 'cn' | 'intl' | 'custom'; labelKey: 'agent.providerGroup.cn' | 'agent.providerGroup.intl' | 'agent.providerGroup.custom' }[] = [
    { id: 'cn', labelKey: 'agent.providerGroup.cn' },
    { id: 'intl', labelKey: 'agent.providerGroup.intl' },
    { id: 'custom', labelKey: 'agent.providerGroup.custom' },
  ];

  const EFFORT_LABEL: Record<AgentEffort, 'agent.effort.off' | 'agent.effort.low' | 'agent.effort.high' | 'agent.effort.max'> = {
    off: 'agent.effort.off',
    low: 'agent.effort.low',
    high: 'agent.effort.high',
    max: 'agent.effort.max',
  };

  const providersIn = (group: string) => PROVIDERS.filter((p) => p.group === group);

  function close(): void {
    agentState.closeSettings();
  }
</script>

<Modal
  title={tr('agent.settings')}
  testid="agent-settings-modal"
  width="tall"
  flushBody
  onclose={close}
>
  {#snippet footer()}
    <Button label={tr('agent.settingsDone')} variant="accent" testid="agent-settings-done" onclick={close} />
  {/snippet}

  <div class="agent-set">
    <nav class="agent-set-nav" aria-label={tr('agent.settings')} data-testid="agent-settings-nav">
      {#each SECTIONS as s (s.id)}
        <button
          type="button"
          class="agent-set-nav-item"
          class:active={section === s.id}
          data-testid={`agent-settings-nav-${s.id}`}
          onclick={() => (section = s.id)}
        >
          {tr(s.labelKey)}
        </button>
      {/each}
    </nav>

    <div class="agent-set-pane" data-testid="agent-settings-panel">
      {#if section === 'access'}
        <div class="agent-pv-list" role="radiogroup" aria-label={tr('agent.provider')} data-testid="agent-provider-list">
          {#each GROUPS as g (g.id)}
            <div class="agent-pv-group">{tr(g.labelKey)}</div>
            {#each providersIn(g.id) as p (p.id)}
              <button
                type="button"
                class="agent-pv-item"
                class:active={agentState.prefs.providerId === p.id}
                role="radio"
                aria-checked={agentState.prefs.providerId === p.id}
                data-testid={`agent-provider-${p.id}`}
                onclick={() => agentState.setProvider(p.id)}
              >
                <ProviderLogo id={p.id} size={16} />
                <span class="agent-pv-name">{tr(p.labelKey)}</span>
                {#if agentState.prefs.providerId === p.id}<Icon name="check" size={11} />{/if}
              </button>
            {/each}
          {/each}
        </div>
        <p class="agent-hint">{tr('agent.providerHint')}</p>
        {#if agentState.needsProxy}
          <p class="agent-hint">{tr('agent.provider.proxyOnly')}</p>
        {/if}

        <Field label={tr('agent.key')}>
          <input
            class="agent-key-input"
            type="password"
            autocomplete="off"
            spellcheck="false"
            data-exempt
            data-testid="agent-key"
            placeholder="sk-…"
            value={agentState.apiKey}
            onchange={(e) => agentState.setApiKey((e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
        <p class="agent-hint">{tr('agent.keyHint')}</p>
        <div class="agent-row">
          <Checkbox
            checked={agentState.prefs.sessionOnly}
            label={tr('agent.sessionOnly')}
            testid="agent-session-only"
            onchange={(v) => agentState.setPrefs({ sessionOnly: v })}
          />
          <span class="agent-spacer"></span>
          <Button
            label={tr('agent.clearKey')}
            variant="ghost"
            testid="agent-clear-key"
            onclick={() => agentState.clearApiKey()}
          />
        </div>
      {:else if section === 'model'}
        <div class="agent-row">
          <span class="agent-lbl">{tr('agent.modelName')}</span>
          <div class="agent-ctl">
            <Select
              value={agentState.model}
              options={agentState.modelPresets.map((m) => ({ value: m, label: m }))}
              onchange={(v) => agentState.setModel(String(v))}
              editable
              ariaLabel={tr('agent.modelName')}
              testid="agent-model"
            />
          </div>
        </div>
        <p class="agent-hint">{tr('agent.modelHint')}</p>

        <div class="agent-row">
          <span class="agent-lbl">{tr('agent.effort')}</span>
          <div class="agent-ctl">
            <Select
              value={agentState.prefs.effort}
              options={agentState.efforts.map((e) => ({ value: e, label: tr(EFFORT_LABEL[e]) }))}
              onchange={(v) => agentState.setPrefs({ effort: v })}
              ariaLabel={tr('agent.effort')}
              testid="agent-effort"
            />
          </div>
        </div>
        <p class="agent-hint">
          {agentState.efforts.includes('off') ? tr('agent.effortHint') : tr('agent.effortAlwaysOn')}
        </p>

        <div class="agent-row">
          <span class="agent-lbl">{tr('agent.temperature')}</span>
          <div class="agent-ctl narrow">
            <NumberInput
              value={agentState.prefs.temperature}
              min={0}
              max={2}
              step={0.1}
              testid="agent-temperature"
              onchange={(v) => agentState.setPrefs({ temperature: Math.max(0, Math.min(2, v)) })}
            />
          </div>
        </div>
        <p class="agent-hint">{tr('agent.temperatureHint')}</p>

        <div class="agent-row">
          <span class="agent-lbl">{tr('agent.baseUrl')}</span>
          <div class="agent-ctl">
            <input
              class="agent-key-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              data-exempt
              data-testid="agent-base-url"
              placeholder={agentState.provider.baseUrl || 'https://…'}
              value={agentState.prefs.overrides[agentState.prefs.providerId]?.baseUrl ?? ''}
              onchange={(e) => agentState.setBaseUrl((e.currentTarget as HTMLInputElement).value)}
            />
          </div>
        </div>
        <p class="agent-hint">
          {tr(agentState.provider.baseUrlRequired ? 'agent.baseUrlRequired' : 'agent.baseUrlHint')}
        </p>

        <div class="agent-row">
          <span class="agent-lbl">{tr('agent.maxSteps')}</span>
          <div class="agent-ctl narrow">
            <NumberInput
              value={agentState.prefs.maxSteps}
              min={1}
              max={MAX_STEPS_LIMIT}
              step={10}
              testid="agent-max-steps"
              onchange={(v) =>
                agentState.setPrefs({ maxSteps: Math.max(1, Math.min(MAX_STEPS_LIMIT, Math.round(v))) })}
            />
          </div>
        </div>
      {:else if section === 'behavior'}
        <Checkbox
          checked={agentState.prefs.screenshots}
          label={tr('agent.screenshots')}
          testid="agent-screenshots"
          onchange={(v) => agentState.setPrefs({ screenshots: v })}
        />
        <p class="agent-hint">{tr('agent.screenshotsHint')}</p>
      {:else if section === 'security'}
        <Checkbox
          checked={agentState.prefs.mediaPoolConfirm}
          label={tr('agent.mediaPoolConfirm')}
          testid="agent-media-confirm"
          onchange={(v) => agentState.setPrefs({ mediaPoolConfirm: v })}
        />
        <p class="agent-hint">{tr('agent.mediaPoolConfirmHint')}</p>
        <p class="agent-hint risk">{tr('agent.pluginRiskHint')}</p>
        <p class="agent-hint">{tr('agent.privacyHint')}</p>
      {/if}
    </div>
  </div>
</Modal>

<style>
  /* navside 固定宽 + 内容列吃满；两者都必须能各自滚动/裁剪。 */
  .agent-set {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr);
    width: 100%;
    min-width: 0;
    min-height: 0;
  }
  .agent-set-nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--sp-4) var(--sp-3);
    background: var(--surface-2);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  .agent-set-nav-item {
    padding: 5px var(--sp-4);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }
  .agent-set-nav-item:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .agent-set-nav-item.active {
    background: var(--surface-3);
    color: var(--text-primary);
    font-weight: bold;
  }
  .agent-set-pane {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-5);
  }

  /* 提供商列表：两列，分组标题横跨两列。 */
  .agent-pv-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px 6px;
    margin-bottom: var(--sp-4);
  }
  .agent-pv-group {
    grid-column: 1 / -1;
    margin: var(--sp-3) 0 var(--sp-1);
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .agent-pv-group:first-child {
    margin-top: 0;
  }
  .agent-pv-item {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 4px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }
  .agent-pv-item:hover:not(.active) {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .agent-pv-item.active {
    background: var(--accent-weak);
    border-color: var(--accent);
    color: var(--accent);
  }
  .agent-pv-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-row {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    margin-bottom: var(--sp-3);
  }
  .agent-lbl {
    width: 108px;
    flex-shrink: 0;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
  }
  .agent-ctl {
    flex: 1;
    min-width: 0;
  }
  .agent-ctl.narrow {
    max-width: 140px;
  }
  .agent-key-input {
    width: 100%;
    height: 24px;
    padding: 0 var(--sp-2);
    background: var(--surface-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .agent-key-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .agent-spacer {
    flex: 1;
  }
  .agent-hint {
    margin: var(--sp-2) 0 var(--sp-4);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.55;
  }
  .agent-hint.risk {
    padding-left: var(--sp-2);
    border-left: 2px solid var(--warning);
    color: var(--text-secondary);
  }
</style>
