/**
 * settings.mjs — the configuration contract of dsh-whale-sway, declared once.
 *
 * Every parameter the plugin exposes is described here: its id (which is its
 * field name in the Host Config schema and in the profile patch), its type and
 * bounds, its default, which control renders it, and the bilingual copy that
 * control shows. This file is the single source of truth for three consumers:
 *
 *   - `index.js` (the Host half) builds its schemastery `Config` from
 *     `SETTINGS_FIELDS`, so the DSH settings domain can project a form for the
 *     plugin's Loader entry;
 *   - `client.js` (the browser half) carries the same table plus
 *     `SETTINGS_I18N`, so the Plugins page renders the controls and the
 *     animation normalizes whatever the Host accepted;
 *   - `tools/sync-settings.mjs` splices both literals into those two files and
 *     `--check` fails when either drifts from this table.
 *
 * The defaults named here are the plugin's out-of-the-box motion: the values
 * `client.js` runs with before any user override exists. A field's default is
 * therefore also the value a reset restores.
 *
 * Copy rules for this file: every label and hint is a statement of what the
 * parameter is, in the deployment's own voice. No second person, no imperative
 * addressed at a reader, no marketing.
 */

import { MODES, MODE_IDS, DEFAULT_MODE } from './modes.mjs';

/** The Loader entry id: the plugin's Host Config namespace and settings namespace. */
export const SETTINGS_NAMESPACE = 'dsh-whale-sway';

/**
 * The groups the settings page stacks, in order. A group is a heading and the
 * fields that belong under it; the page renders one heading per group.
 */
export const SETTINGS_GROUPS = [
  {
    id: 'sway',
    label: { zh: '摆动', en: 'Sway' },
  },
  {
    id: 'speed',
    label: { zh: '速度', en: 'Speed' },
  },
  {
    id: 'sampling',
    label: { zh: '速率取样', en: 'Rate sampling' },
  },
];

/** The segment copy of one sway mode, taken from the mode registry's own names. */
function modeOptions() {
  return MODES.map((mode) => ({
    value: mode.id,
    label: { zh: mode.shortLabel, en: mode.shortLabelEn },
  }));
}

/**
 * Every configurable parameter, in page order. `group` names the heading it
 * renders under; `control` says which primitive renders it (`segmented`,
 * `switch`, or `number`); the type, bounds, and default are what the Host
 * schema and the client's normalization both enforce.
 */
export const SETTINGS_FIELDS = [
  {
    id: 'mode',
    group: 'sway',
    control: 'segmented',
    type: 'enum',
    values: [...MODE_IDS],
    default: DEFAULT_MODE,
    options: modeOptions(),
    label: { zh: '摆动方式', en: 'Sway style' },
    hint: {
      zh: '运行指示器中鲸尾摆动的素材与幅度。',
      en: 'The artwork and amplitude the whale tail swings with in the running indicator.',
    },
  },
  {
    id: 'enabled',
    group: 'sway',
    control: 'switch',
    type: 'boolean',
    default: true,
    label: { zh: '启用动画', en: 'Animate the indicator' },
    hint: {
      zh: '关闭后运行指示器保持出厂画面。',
      en: 'Turning this off leaves the shipped running indicator untouched.',
    },
  },
  {
    id: 'minPeriodMs',
    group: 'speed',
    control: 'number',
    type: 'number',
    default: 190,
    min: 60,
    max: 5000,
    step: 10,
    label: { zh: '最快周期（毫秒）', en: 'Fastest cycle (ms)' },
    hint: {
      zh: '峰值速率下整轮摆动的时长。',
      en: 'Full sway duration at the peak token rate.',
    },
  },
  {
    id: 'maxPeriodMs',
    group: 'speed',
    control: 'number',
    type: 'number',
    default: 1500,
    min: 120,
    max: 10000,
    step: 10,
    label: { zh: '最慢周期（毫秒）', en: 'Slowest cycle (ms)' },
    hint: {
      zh: '空闲或等待工具调用时整轮摆动的时长。',
      en: 'Full sway duration while idle or waiting on a tool call.',
    },
  },
  {
    id: 'rateRef',
    group: 'speed',
    control: 'number',
    type: 'number',
    default: 9,
    min: 1,
    max: 400,
    step: 1,
    label: { zh: '参考速率（tok/s）', en: 'Reference rate (tok/s)' },
    hint: {
      zh: '速率达到该值时，整轮摆动时长减半。',
      en: 'Token rate at which the full sway cycle halves.',
    },
  },
  {
    id: 'maxRate',
    group: 'sampling',
    control: 'number',
    type: 'number',
    default: 160,
    min: 1,
    max: 100000,
    step: 1,
    label: { zh: '速率上限（tok/s）', en: 'Rate ceiling (tok/s)' },
    hint: {
      zh: '估算速率的上限，使一次批量重排无法把摆动拉到极端。',
      en: 'Upper bound on the estimated rate, so one bulk re-render cannot peg the sway.',
    },
  },
  {
    id: 'charsPerToken',
    group: 'sampling',
    control: 'number',
    type: 'number',
    default: 1.7,
    min: 0.1,
    max: 20,
    step: 0.1,
    label: { zh: '每 token 字符数', en: 'Characters per token' },
    hint: {
      zh: '由已渲染文本增量估算 token 速率时的换算系数。',
      en: 'Divisor used to read a token rate from the text the indicator streams.',
    },
  },
  {
    id: 'sampleMs',
    group: 'sampling',
    control: 'number',
    type: 'number',
    default: 200,
    min: 20,
    max: 5000,
    step: 10,
    label: { zh: '取样间隔（毫秒）', en: 'Sampling interval (ms)' },
    hint: {
      zh: '两次文本长度观测之间的间隔。',
      en: 'Interval between two text-length observations.',
    },
  },
  {
    id: 'smooth',
    group: 'sampling',
    control: 'number',
    type: 'number',
    default: 0.4,
    min: 0.05,
    max: 1,
    step: 0.05,
    label: { zh: '平滑系数', en: 'Smoothing weight' },
    hint: {
      zh: '每次新观测折算进当前速率的权重，取值 0 到 1。',
      en: 'Weight each fresh measurement carries in the current rate, from 0 to 1.',
    },
  },
];

/**
 * The copy the settings page's own chrome renders: the form frame's save and
 * failure lines, the per-field badges, and the one-liner the plugin's row shows
 * in the Plugins list. Keys are flat, exactly as `t()` addresses them.
 */
export const SETTINGS_COPY = {
  'page.summary': {
    zh: '按实时 token 速率逐帧摆动的运行指示器鲸尾。',
    en: 'The running-indicator whale tail, stepping frames with the live token rate.',
  },
  'page.unavailable': {
    zh: '该插件当前未加载，暂时没有可配置项。',
    en: 'This plugin is not loaded, so it has no configuration at the moment.',
  },
  'page.readOnly': {
    zh: '本部署的设置为只读。',
    en: 'This deployment stores settings read-only.',
  },
  'page.save': { zh: '保存', en: 'Save' },
  'page.saving': { zh: '保存中…', en: 'Saving…' },
  'page.saveFailed': {
    zh: '本部署没有接受这些值，改动已保留。',
    en: 'The deployment did not accept these values; the edits were kept.',
  },
  'page.overridden': { zh: '已覆盖', en: 'Overridden' },
  'page.reset': { zh: '恢复默认', en: 'Reset to default' },
  'page.invalidNumber': {
    zh: '仅接受数字；留空表示使用默认值。',
    en: 'Only a number is accepted; an empty field uses the default.',
  },
};

/** One field by id. Throws on an unknown id. */
export function findSetting(id) {
  const field = SETTINGS_FIELDS.find((entry) => entry.id === id);
  if (!field) {
    throw new Error(`unknown setting "${id}" (known: ${SETTINGS_FIELDS.map((f) => f.id).join(', ')})`);
  }
  return field;
}

/** Every field id, in page order. */
export const SETTING_IDS = SETTINGS_FIELDS.map((field) => field.id);

/**
 * The default configuration as the runtime reads it: field id to default. It is
 * serializable and stable, so the client's literal and this table compare by
 * value.
 */
export function defaultConfig() {
  const config = {};
  for (const field of SETTINGS_FIELDS) config[field.id] = field.default;
  return config;
}

/**
 * The locale dictionary the page registers, one flat key per string. Keys are
 * `group.<id>`, `field.<id>.label`, `field.<id>.hint`,
 * `field.mode.option.<value>`, and the `SETTINGS_COPY` page strings; `t()`
 * resolves them by exact key. Keys are emitted in page order, then copy order,
 * so the generated literal in `client.js` is stable.
 */
export function settingsDictionary() {
  const zh = {};
  const en = {};
  for (const group of SETTINGS_GROUPS) {
    zh[`group.${group.id}`] = group.label.zh;
    en[`group.${group.id}`] = group.label.en;
  }
  for (const field of SETTINGS_FIELDS) {
    zh[`field.${field.id}.label`] = field.label.zh;
    en[`field.${field.id}.label`] = field.label.en;
    zh[`field.${field.id}.hint`] = field.hint.zh;
    en[`field.${field.id}.hint`] = field.hint.en;
    for (const option of field.options ?? []) {
      zh[`field.${field.id}.option.${option.value}`] = option.label.zh;
      en[`field.${field.id}.option.${option.value}`] = option.label.en;
    }
  }
  return { zh, en };
}
