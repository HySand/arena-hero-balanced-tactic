"use strict";

const UNIT_META = {
  WORKER: { glyph: "W", name: "工人", cost: 5 },
  VANGUARD: { glyph: "V", name: "先锋", cost: 10 },
  RANGER: { glyph: "R", name: "游侠", cost: 12 },
};

const CONTROL_ACTION_OPTIONS = {
  CORE: [
    ["WAIT", "待命"],
    ["SPAWN", "生产单位"],
    ["REPAIR_SHIELD", "修复护盾"],
    ["START_MOVE", "开始迁移"],
    ["CANCEL_MOVE", "取消迁移"],
    ["PICKUP_BEACON", "拾取 Beacon"],
    ["DROP_BEACON", "放下 Beacon"],
  ],
  WORKER: [
    ["MOVE", "移动"],
    ["HARVEST", "采集"],
    ["DEPOSIT", "交付资源"],
    ["WAIT", "待命"],
    ["PICKUP_BEACON", "拾取 Beacon"],
    ["DROP_BEACON", "放下 Beacon"],
  ],
  VANGUARD: [
    ["MOVE", "移动"],
    ["SWEEP", "横扫"],
    ["WAIT", "待命"],
    ["PICKUP_BEACON", "拾取 Beacon"],
    ["DROP_BEACON", "放下 Beacon"],
  ],
  RANGER: [
    ["MOVE", "移动"],
    ["SHOOT", "射击可见目标"],
    ["WAIT", "待命"],
    ["PICKUP_BEACON", "拾取 Beacon"],
    ["DROP_BEACON", "放下 Beacon"],
  ],
};

const CONTROL_RECEIPT_NAMES = {
  applied: "已执行",
  rejected: "已拒绝",
  expired: "已过期",
  superseded: "已被更新指令替换",
};

const ADAPTIVE_ACTION_NAMES = {
  WARMUP: "收集样本",
  COOLDOWN: "冷却观察",
  EXPAND_SEARCH: "扩大找矿",
  TIGHTEN_ROUTES: "缩短路线",
  GROW_WORKERS: "增加工人",
  CONSERVE: "收缩经济",
  HOLD: "保持当前",
  DISABLED: "已关闭",
};

const ADAPTIVE_REASON_NAMES = {
  collecting_samples: "样本尚未达到预热数量",
  recent_adjustment: "刚完成一次调整，等待新结果",
  resource_scarcity: "连续没有可采候选矿",
  failures_or_long_cycles: "失败偏多或往返周期过长",
  healthy_throughput: "吞吐与忙碌率都处于健康水平",
  storage_often_full: "Core 仓库经常处于满载状态",
  safety_pressure: "附近威胁或近期工人损失",
  low_throughput: "有矿可采但单位工人上交效率偏低",
  metrics_stable: "指标处于稳定区间",
  stable_or_at_limit: "指标稳定或调整值已到边界",
  disabled_by_config: "已使用固定配置",
};

const state = {
  config: null,
  schema: null,
  status: null,
  dirty: false,
  filter: "ALL",
  draggedIndex: null,
  controlDirection: "UP",
  controlQueue: { pending: [], last_receipt: null },
};

const THEME_STORAGE_KEY = "arenaHeroTheme";
const THEME_DEFAULTS = {
  dark: {
    accent: "#55dfc3",
    background: "#080b12",
    panel: "#111622",
    card: "#1c2638",
  },
  light: {
    accent: "#147d92",
    background: "#e7eff7",
    panel: "#ffffff",
    card: "#edf2f7",
  },
  midnight: {
    accent: "#72a7ff",
    background: "#071525",
    panel: "#0c1d31",
    card: "#142a45",
  },
};

const PRODUCTION_STYLES = {
  peace: {
    help: "17 工人持续寻矿，1 先锋机动支援，1 游侠守卫 Core；保持 19 人口，保持人口上限以内稳定运行。",
    production: {
      enabled: true,
      order: [
        { unit_type: "WORKER", target: 17 },
        { unit_type: "VANGUARD", target: 1 },
        { unit_type: "RANGER", target: 1 },
      ],
      reserve_resources: 5,
      max_population: 19,
      after_plan: "hold",
    },
    workerTarget: 17,
    rangerGuard: [1, 1],
    coreMigration: false,
  },
  combat: {
    help: "8 工人维持经济，5 先锋压制近战，6 游侠提供火力；保持 19 人口，保持人口上限以内稳定运行。",
    production: {
      enabled: true,
      order: [
        { unit_type: "VANGUARD", target: 5 },
        { unit_type: "RANGER", target: 6 },
        { unit_type: "WORKER", target: 8 },
      ],
      reserve_resources: 5,
      max_population: 19,
      after_plan: "hold",
    },
    workerTarget: 8,
    rangerGuard: [1, 2],
    coreMigration: true,
  },
};

const PEACE_ECONOMY_FALLBACK = {
  max_economy_scouts: 12,
  max_scout_bonus: 2,
  window_ticks: 24,
  warmup_ticks: 12,
  adjustment_cooldown_ticks: 3,
  radius_step: 8,
  min_resource_radius: 24,
  max_resource_radius: 96,
  scarcity_ticks: 3,
  long_cycle_ticks: 80,
  low_throughput_per_worker: 0.0058,
  healthy_throughput_per_worker: 0.0232,
  max_harvest_failure_rate: 0.15,
  storage_full_ratio: 0.4,
  worker_target: 17,
};

const PACING_PRESETS = {
  safe: {
    label: "保守采集",
    help: "先把 Core 周围的资源采干净，暂停自动进攻，适合刚开始或附近有危险时。",
    values: {
      enabled: true,
      early_ticks: 90,
      mid_ticks: 220,
      early_population: 6,
      mid_population: 12,
      early_resource_radius: 8,
      mid_resource_radius: 18,
      late_resource_radius: 30,
      early_exploration_radius: 8,
      mid_exploration_radius: 18,
      late_exploration_radius: 30,
      early_worker_scouts: 1,
      mid_worker_scouts: 2,
      late_worker_scouts: 4,
      offense_enabled: false,
      offense_after_ticks: 260,
      offense_min_resources: 55,
      offense_min_population: 14,
      offense_min_vanguards: 3,
      offense_min_rangers: 2,
      offense_min_defenders: 6,
      offense_radius: 28,
    },
  },
  balanced: {
    label: "平衡扩张",
    help: "推荐默认方案：前期采近矿，中期逐步扩大，后期资源和兵力达标才会进攻。",
    values: null,
  },
  aggressive: {
    label: "积极进攻",
    help: "更早扩大探索范围并准备进攻，但仍会保留资源、人口和守军门槛。",
    values: {
      enabled: true,
      early_ticks: 50,
      mid_ticks: 140,
      early_population: 5,
      mid_population: 9,
      early_resource_radius: 12,
      mid_resource_radius: 28,
      late_resource_radius: 50,
      early_exploration_radius: 14,
      mid_exploration_radius: 30,
      late_exploration_radius: 54,
      early_worker_scouts: 2,
      mid_worker_scouts: 4,
      late_worker_scouts: 7,
      offense_enabled: true,
      offense_after_ticks: 140,
      offense_min_resources: 30,
      offense_min_population: 9,
      offense_min_vanguards: 2,
      offense_min_rangers: 1,
      offense_min_defenders: 3,
      offense_radius: 42,
    },
  },
};

const $ = (id) => document.getElementById(id);
const deepClone = (value) => JSON.parse(JSON.stringify(value));
const ADMIN_TOKEN_KEY = "arena-hero-admin-token";

function administratorAuthorization() {
  let token = sessionStorage.getItem(ADMIN_TOKEN_KEY)?.trim();
  if (!token) {
    token = window.prompt("请输入 ADMIN_CONTROL_SECRET")?.trim();
    if (!token) throw new Error("已取消管理员操作");
    sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  }
  return `Bearer ${token}`;
}

async function requestJSON(url, options = {}) {
  const { administrator = false, ...requestOptions } = options;
  const headers = {
    "Content-Type": "application/json",
    ...(requestOptions.headers || {}),
    ...(administrator
      ? { Authorization: administratorAuthorization() }
      : {}),
  };
  const response = await fetch(url, {
    cache: "no-store",
    ...requestOptions,
    headers,
  });
  let document;
  try {
    document = await response.json();
  } catch {
    document = { error: `HTTP ${response.status}` };
  }
  if (!response.ok) {
    if (administrator && response.status === 404) {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      throw new Error("管理员密钥无效");
    }
    throw new Error(document.error || `HTTP ${response.status}`);
  }
  return document;
}

function pathGet(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function pathSet(object, path, value) {
  const parts = path.split(".");
  const final = parts.pop();
  const parent = parts.reduce((value, key) => value[key], object);
  parent[final] = value;
}

function numericValue(input) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : 0;
}

function setDirty(dirty = true) {
  state.dirty = dirty;
  $("dirtyLabel").textContent = dirty ? "有未保存的修改" : "配置已同步";
  $("saveHint").textContent = dirty
    ? "保存后将在下一个 Arena Hero Turn 自动生效。"
    : "当前页面与 strategy_config.json 一致。";
  document.title = `${dirty ? "● " : ""}Arena Hero · 战术控制台`;
}

let toastTimer;
function showToast(message, error = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function normalizeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value.toLowerCase() : fallback;
}

function colorChannels(color) {
  const normalized = normalizeColor(color, "#000000").slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
}

function relativeLuminance(color) {
  const channels = colorChannels(color).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function mixColor(first, second, secondWeight) {
  const left = colorChannels(first);
  const right = colorChannels(second);
  const mixed = left.map((value, index) => Math.round(
    value * (1 - secondWeight) + right[index] * secondWeight,
  ));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function readableText(background) {
  const dark = "#101820";
  const light = "#ffffff";
  return contrastRatio(dark, background) >= contrastRatio(light, background) ? dark : light;
}

function mutedText(foreground, background, preferredWeight, minimumRatio = 4.5) {
  for (let weight = preferredWeight; weight >= 0; weight -= 0.02) {
    const candidate = mixColor(foreground, background, weight);
    if (contrastRatio(candidate, background) >= minimumRatio) return candidate;
  }
  return foreground;
}

function contrastColor(color, background, minimumRatio = 4.5) {
  const normalized = normalizeColor(color, readableText(background));
  if (contrastRatio(normalized, background) >= minimumRatio) return normalized;
  const target = readableText(background);
  for (let weight = 0.12; weight <= 1; weight += 0.12) {
    const candidate = mixColor(normalized, target, weight);
    if (contrastRatio(candidate, background) >= minimumRatio) return candidate;
  }
  return target;
}

function themeFromControls() {
  return {
    accent: $("accentColor").value,
    background: $("backgroundColor").value,
    panel: $("panelColor").value,
    card: $("cardColor").value,
  };
}

function applyTheme(theme, colors, { persist = true } = {}) {
  const fallback = THEME_DEFAULTS[theme] || THEME_DEFAULTS.dark;
  const selectedTheme = (THEME_DEFAULTS[theme] || theme === "custom") ? theme : "dark";
  const palette = {
    accent: normalizeColor(colors?.accent, fallback.accent),
    background: normalizeColor(colors?.background, fallback.background),
    panel: normalizeColor(colors?.panel, fallback.panel),
    card: normalizeColor(colors?.card, fallback.card),
  };
  const input = mixColor(palette.panel, palette.background, 0.32);
  const subpanel = mixColor(palette.panel, palette.card, 0.42);
  const pageText = readableText(palette.background);
  const panelText = readableText(palette.panel);
  const cardText = readableText(palette.card);
  const inputText = readableText(input);
  const subpanelText = readableText(subpanel);
  const accentOnPanel = contrastColor(palette.accent, palette.panel);
  const accentOnCard = contrastColor(palette.accent, palette.card);
  const accentSoft = mixColor(palette.accent, palette.card, 0.82);
  const amber = contrastColor(cardText === "#101820" ? "#8a5a00" : "#f1bd65", palette.card);
  const purple = contrastColor(cardText === "#101820" ? "#6245ad" : "#a990ff", palette.card);
  const red = contrastColor(cardText === "#101820" ? "#a62f4e" : "#ff7993", palette.card);
  const root = document.documentElement;

  root.dataset.theme = selectedTheme;
  root.style.colorScheme = inputText === "#101820" ? "light" : "dark";
  const variables = {
    "--user-accent": palette.accent,
    "--user-bg": palette.background,
    "--user-panel": palette.panel,
    "--user-card": palette.card,
    "--user-input": input,
    "--user-subpanel": subpanel,
    "--bg": palette.background,
    "--panel": palette.panel,
    "--panel-strong": palette.card,
    "--text": pageText,
    "--muted": mutedText(pageText, palette.background, 0.42),
    "--muted-strong": mutedText(pageText, palette.background, 0.24),
    "--panel-text": panelText,
    "--panel-muted": mutedText(panelText, palette.panel, 0.42),
    "--panel-muted-strong": mutedText(panelText, palette.panel, 0.24),
    "--card-text": cardText,
    "--card-muted": mutedText(cardText, palette.card, 0.42),
    "--card-muted-strong": mutedText(cardText, palette.card, 0.24),
    "--input-text": inputText,
    "--input-muted": mutedText(inputText, input, 0.38),
    "--subpanel-text": subpanelText,
    "--subpanel-muted": mutedText(subpanelText, subpanel, 0.42),
    "--subpanel-muted-strong": mutedText(subpanelText, subpanel, 0.24),
    "--line": mixColor(panelText, palette.panel, 0.84),
    "--line-strong": mixColor(panelText, palette.panel, 0.7),
    "--card-line": mixColor(cardText, palette.card, 0.84),
    "--input-line": mixColor(inputText, input, 0.78),
    "--accent-ink": accentOnPanel,
    "--accent-on-card": accentOnCard,
    "--accent-soft": accentSoft,
    "--accent-soft-text": readableText(accentSoft),
    "--accent-line": mixColor(accentOnCard, palette.card, 0.62),
    "--amber": amber,
    "--amber-soft": mixColor(amber, palette.card, 0.88),
    "--amber-line": mixColor(amber, palette.card, 0.68),
    "--purple": purple,
    "--red": red,
    "--shadow": pageText === "#101820"
      ? "0 20px 55px rgba(34, 60, 84, 0.16)"
      : "0 20px 55px rgba(0, 0, 0, 0.32)",
    "--button-text": readableText(palette.accent),
  };
  Object.entries(variables).forEach(([name, value]) => root.style.setProperty(name, value));

  $("themePreset").value = selectedTheme;
  $("accentColor").value = palette.accent;
  $("backgroundColor").value = palette.background;
  $("panelColor").value = palette.panel;
  $("cardColor").value = palette.card;
  if (persist) {
    try {
      localStorage.setItem(
        THEME_STORAGE_KEY,
        JSON.stringify({ theme: selectedTheme, ...palette }),
      );
    } catch {
      // Private browsing can disable localStorage; the current page still keeps the theme.
    }
  }
}

function loadTheme() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || "null");
  } catch {
    saved = null;
  }
  const theme = saved?.theme || $("themePreset").value || "dark";
  const defaults = THEME_DEFAULTS[theme] || THEME_DEFAULTS.dark;
  applyTheme(
    theme,
    {
      accent: saved?.accent || defaults.accent,
      background: saved?.background || defaults.background,
      panel: saved?.panel || defaults.panel,
      card: saved?.card || defaults.card,
    },
    { persist: false },
  );
}

function defaultPacingValues() {
  return deepClone(state.schema?.defaults?.pacing || {});
}

function pacingPresetValues(presetName) {
  const preset = PACING_PRESETS[presetName];
  if (!preset) return null;
  return preset.values || defaultPacingValues();
}

function pacingMatchesPreset(presetName) {
  const values = pacingPresetValues(presetName);
  if (!values || !state.config?.pacing) return false;
  return Object.entries(values).every(
    ([key, value]) => state.config.pacing[key] === value,
  );
}

function syncPacingPreset() {
  const select = $("pacingPreset");
  const help = $("pacingPresetHelp");
  if (!select || !help || !state.config) return;
  const matched = Object.keys(PACING_PRESETS).find(pacingMatchesPreset);
  select.value = matched || "custom";
  help.textContent = matched
    ? PACING_PRESETS[matched].help
    : "当前是手动设置。推荐先用“平衡扩张”，再按需要调整下面的数字。";
}

function applyPacingPreset(presetName) {
  if (!state.config?.pacing || !PACING_PRESETS[presetName]) return;
  const preset = PACING_PRESETS[presetName];
  const values = preset.values || defaultPacingValues();
  Object.entries(values).forEach(([key, value]) => {
    state.config.pacing[key] = value;
  });
  renderConfig();
  $("pacingPreset").value = presetName;
  $("pacingPresetHelp").textContent = preset.help;
  setDirty();
}

function productionMatchesStyle(styleName) {
  const style = PRODUCTION_STYLES[styleName];
  const production = state.config?.production;
  if (!style || !production) return false;
  return production.enabled === style.production.enabled
    && production.reserve_resources === style.production.reserve_resources
    && production.max_population === style.production.max_population
    && production.after_plan === style.production.after_plan
    && JSON.stringify(production.order) === JSON.stringify(style.production.order);
}

function syncProductionStyle() {
  if (!state.config) return;
  const matched = Object.keys(PRODUCTION_STYLES).find(productionMatchesStyle);
  document.querySelectorAll("[data-production-style]").forEach((button) => {
    const active = button.dataset.productionStyle === matched;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  let help = matched
    ? PRODUCTION_STYLES[matched].help
    : "当前是自定义编制。可继续手动调整，或选择一个后期风格重新套用。";
  if (matched === "peace") {
    const training = state.config.extensions?.peace_economy_training;
    if (training) {
      help += ` 训练样本 ${training.sample_count} Tick，置信度 ${training.confidence}。`;
    }
  }
  $("productionStyleHelp").textContent = help;
}

function applyProductionStyle(styleName) {
  const style = PRODUCTION_STYLES[styleName];
  if (!style || !state.config) return;
  state.config.production = deepClone(style.production);
  if (styleName === "peace") {
    const training = {
      ...PEACE_ECONOMY_FALLBACK,
      ...(state.config.extensions?.peace_economy_training || {}),
    };
    state.config.workers.max_economy_scouts = training.max_economy_scouts;
    [
      "window_ticks",
      "warmup_ticks",
      "adjustment_cooldown_ticks",
      "radius_step",
      "min_resource_radius",
      "max_resource_radius",
      "scarcity_ticks",
      "long_cycle_ticks",
      "low_throughput_per_worker",
      "healthy_throughput_per_worker",
      "max_harvest_failure_rate",
      "storage_full_ratio",
      "max_scout_bonus",
    ].forEach((key) => {
      state.config.adaptive_economy[key] = training[key];
    });
  }
  state.config.adaptive_economy.worker_target_min = style.workerTarget;
  state.config.adaptive_economy.worker_target_max = style.workerTarget;
  [
    state.config.rangers.guard_numerator,
    state.config.rangers.guard_denominator,
  ] = style.rangerGuard;
  state.config.core.migration_enabled = style.coreMigration;
  renderConfig();
  setDirty();
}

function bindStaticControls() {
  $("themePreset").addEventListener("change", (event) => {
    const theme = event.target.value;
    applyTheme(theme, THEME_DEFAULTS[theme] || themeFromControls());
  });
  ["accentColor", "backgroundColor", "panelColor", "cardColor"].forEach((id) => {
    $(id).addEventListener("input", () => applyTheme("custom", themeFromControls()));
  });
  $("pacingPreset").addEventListener("change", (event) => {
    applyPacingPreset(event.target.value);
  });
  document.querySelectorAll("[data-production-style]").forEach((button) => {
    button.addEventListener("click", () => {
      applyProductionStyle(button.dataset.productionStyle);
    });
  });

  $("productionEnabled").addEventListener("change", (event) => {
    state.config.production.enabled = event.target.checked;
    setDirty();
    syncProductionStyle();
    updateProductionSummary();
  });
  $("reserveResources").addEventListener("input", (event) => {
    state.config.production.reserve_resources = numericValue(event.target);
    setDirty();
    syncProductionStyle();
  });
  $("maxPopulation").addEventListener("input", (event) => {
    state.config.production.max_population = numericValue(event.target);
    setDirty();
    syncProductionStyle();
    updateProductionSummary();
  });
  $("afterPlan").addEventListener("change", (event) => {
    state.config.production.after_plan = event.target.value;
    setDirty();
    syncProductionStyle();
    updateProductionSummary();
  });

  document.querySelectorAll("[data-path]").forEach((input) => {
    const eventName = input.type === "checkbox" ? "change" : "input";
    input.addEventListener(eventName, () => {
      pathSet(
        state.config,
        input.dataset.path,
        input.type === "checkbox" ? input.checked : numericValue(input),
      );
      if (input.dataset.path.startsWith("pacing.")) {
        $("pacingPreset").value = "custom";
        $("pacingPresetHelp").textContent = "当前是手动设置。你可以继续修改下面的数字，或重新选择一个预设。";
      }
      setDirty();
    });
  });

  $("saveButton").addEventListener("click", saveConfig);
  $("dockSaveButton").addEventListener("click", saveConfig);
  $("resetButton").addEventListener("click", resetConfig);
  $("refreshButton").addEventListener("click", async () => {
    await Promise.all([loadConfig(), refreshStatus(), refreshControlStatus()]);
    showToast("已从磁盘刷新");
  });
  $("controlTarget").addEventListener("change", updateControlActions);
  $("controlAction").addEventListener("change", updateControlParameters);
  document.querySelectorAll("[data-control-direction]").forEach((button) => {
    button.addEventListener("click", () => {
      state.controlDirection = button.dataset.controlDirection;
      renderDirectionButtons();
    });
  });
  $("sendControlButton").addEventListener("click", sendControlCommand);
  $("clearControlButton").addEventListener("click", clearControlQueue);
  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll(".filter").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderUnits();
    });
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

function renderConfig() {
  if (!state.config) return;
  const production = state.config.production;
  $("productionEnabled").checked = production.enabled;
  $("reserveResources").value = production.reserve_resources;
  $("maxPopulation").value = production.max_population;
  $("afterPlan").value = production.after_plan;
  document.querySelectorAll("[data-path]").forEach((input) => {
    const value = pathGet(state.config, input.dataset.path);
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value;
  });
  syncPacingPreset();
  syncProductionStyle();
  renderProductionList();
  updateProductionSummary();
}

function dynamicUnitCost(unitType, population) {
  const base = UNIT_META[unitType]?.cost ?? 0;
  if (population < 20) return base;
  const exponent = Math.floor((population - 20) / 5) + 1;
  return Math.round(base * (1.3 ** exponent));
}

function renderProductionList() {
  const list = $("productionList");
  list.replaceChildren();
  state.config.production.order.forEach((step, index) => {
    const meta = UNIT_META[step.unit_type];
    const item = document.createElement("div");
    item.className = "production-item";
    item.draggable = true;
    item.dataset.index = String(index);

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.title = "拖动排序";

    const glyph = document.createElement("span");
    glyph.className = "unit-glyph";
    glyph.textContent = meta.glyph;

    const title = document.createElement("div");
    title.className = "unit-title";
    const strong = document.createElement("strong");
    strong.textContent = meta.name;
    const cost = document.createElement("span");
    cost.textContent = `基础成本 ${meta.cost}`;
    title.append(strong, cost);

    const target = document.createElement("div");
    target.className = "target-control";
    const targetLabel = document.createElement("label");
    targetLabel.textContent = "最低数量";
    const targetInput = document.createElement("input");
    targetInput.type = "number";
    targetInput.min = "0";
    targetInput.max = "100";
    targetInput.step = "1";
    targetInput.value = step.target;
    targetInput.setAttribute("aria-label", `${meta.name}最低数量`);
    targetInput.addEventListener("input", () => {
      step.target = numericValue(targetInput);
      setDirty();
      syncProductionStyle();
      updateProductionSummary();
    });
    target.append(targetLabel, targetInput);

    const reorder = document.createElement("div");
    reorder.className = "stage-order";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "reorder-button";
    up.textContent = "↑";
    up.title = "向前移动";
    up.disabled = index === 0;
    up.addEventListener("click", () => moveProductionStep(index, index - 1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "reorder-button";
    down.textContent = "↓";
    down.title = "向后移动";
    down.disabled = index === state.config.production.order.length - 1;
    down.addEventListener("click", () => moveProductionStep(index, index + 1));
    reorder.append(up, down);

    item.append(handle, glyph, title, target, reorder);
    item.addEventListener("dragstart", () => {
      state.draggedIndex = index;
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      state.draggedIndex = null;
      item.classList.remove("dragging");
    });
    item.addEventListener("dragover", (event) => event.preventDefault());
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      if (state.draggedIndex === null) return;
      moveProductionStep(state.draggedIndex, index);
    });
    list.append(item);
  });
}

function moveProductionStep(from, to) {
  const order = state.config.production.order;
  if (from < 0 || to < 0 || from >= order.length || to >= order.length || from === to) return;
  const [step] = order.splice(from, 1);
  order.splice(to, 0, step);
  setDirty();
  syncProductionStyle();
  renderProductionList();
  updateProductionSummary();
}

function updateProductionSummary() {
  if (!state.config) return;
  const counts = state.status?.counts || { WORKER: 0, VANGUARD: 0, RANGER: 0 };
  let cost = 0;
  let firstMissing = null;
  let targetPopulation = 0;
  let simulatedPopulation = Number(state.status?.population ?? 0);
  state.config.production.order.forEach((step) => {
    const missing = Math.max(0, step.target - (counts[step.unit_type] || 0));
    for (let index = 0; index < missing; index += 1) {
      cost += dynamicUnitCost(step.unit_type, simulatedPopulation);
      simulatedPopulation += 1;
    }
    targetPopulation += step.target;
    if (!firstMissing && missing > 0) firstMissing = `${UNIT_META[step.unit_type].name} × ${missing}`;
  });
  $("productionCost").textContent = `${cost} 资源`;
  $("productionPopulation").textContent = `${targetPopulation} / ${state.config.production.max_population}`;
  $("productionStatus").textContent = !state.config.production.enabled
    ? "计划已停用"
    : firstMissing || (state.config.production.after_plan === "hold" ? "计划完成 · 保持" : "计划完成 · 平衡扩张");
}

async function loadConfig() {
  try {
    const [config, schema] = await Promise.all([
      requestJSON("/api/config"),
      state.schema ? Promise.resolve(state.schema) : requestJSON("/api/schema"),
    ]);
    state.config = config;
    state.schema = schema;
    renderConfig();
    setDirty(false);
  } catch (error) {
    showToast(`读取配置失败：${error.message}`, true);
  }
}

async function saveConfig() {
  if (!state.config) return;
  const buttons = [$("saveButton"), $("dockSaveButton")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await requestJSON("/api/config", {
      method: "PUT",
      administrator: true,
      body: JSON.stringify(state.config),
    });
    state.config = result.config;
    renderConfig();
    setDirty(false);
    showToast(result.message || "配置已保存");
  } catch (error) {
    showToast(`保存失败：${error.message}`, true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function resetConfig() {
  if (!state.schema?.defaults) return;
  state.config = deepClone(state.schema.defaults);
  renderConfig();
  setDirty();
  showToast("已恢复默认值，点击保存后生效");
}

function formatPosition(position) {
  return Array.isArray(position) ? `(${position[0]}, ${position[1]})` : "—";
}

function renderStatus() {
  const status = state.status;
  const online = Boolean(status?.online);
  const stale = Boolean(status?.stale);
  const connection = $("connectionPill");
  connection.classList.toggle("online", online);
  connection.classList.toggle("stale", !online && stale && status?.tick);
  $("connectionText").textContent = online
    ? `战术在线 · ${status.age_seconds ?? 0}s 前更新`
    : status?.tick
      ? `状态过期 · ${status.age_seconds ?? "—"}s`
      : "等待战术状态";
  $("liveBadge").textContent = online ? "实时" : "离线";
  $("liveBadge").classList.toggle("online", online);

  $("metricPosture").textContent = status?.posture || "—";
  $("metricThreat").textContent = `威胁分 ${status?.threat_score ?? "—"}`;
  $("metricTick").textContent = status?.tick ?? "—";
  $("metricAccepted").textContent = status?.accepted ? "计划已接受" : "等待已接受计划";
  $("metricResources").textContent = status?.resources ?? "—";
  $("metricCapacity").textContent = status?.resource_capacity ?? "—";
  $("metricPricing").textContent = "生产价格按人口动态计算";
  $("metricPopulation").textContent = status?.population ?? "—";
  const counts = status?.counts || {};
  $("metricCounts").textContent = `W ${counts.WORKER ?? "—"} · V ${counts.VANGUARD ?? "—"} · R ${counts.RANGER ?? "—"}`;
  $("metricCoreShield").textContent = status?.core ? `${status.core.shield} SH / ${status.core.hp} HP` : "—";
  $("metricCorePosition").textContent = `位置 ${formatPosition(status?.core?.position)}`;
  const phaseNames = { EARLY: "前期", MID: "中期", LATE: "后期" };
  $("metricPhase").textContent = phaseNames[status?.strategy_phase] || status?.strategy_phase || "—";
  const effectiveRadius = status?.effective_resource_radius ?? 0;
  const radiusLimit = status?.resource_radius_limit ?? status?.resource_radius ?? "∞";
  const map = status?.map_memory || {};
  $("metricPhaseNote").textContent = `矿 ${effectiveRadius}/${radiusLimit} · 探 ${status?.exploration_radius ?? "—"} · 地图 ${map.known_cells ?? 0} 格 / ${map.obstacles ?? 0} 障碍`;

  renderOperation();

  renderCore();
  renderUnits();
  renderResources();
  renderEvents();
  updateProductionSummary();
}

function renderOperation() {
  const status = state.status;
  const online = Boolean(status?.online);
  const accepted = Boolean(status?.accepted);
  const mode = $("operationMode");
  const hint = $("operationHint");
  const source = $("operationSource");
  mode.textContent = online ? "Agent 在线" : "Agent 离线";
  mode.classList.toggle("online", online);
  source.textContent = accepted
    ? `AGENT 自动计划 · Tick ${status?.tick ?? "—"}`
    : "AGENT 等待下一次计划";
  hint.textContent = online
    ? "选择一个对象，指令会在下一个可用 Tick 覆盖它的自动动作一次。"
    : "本地战术未在线，启动 tactic 后才能发送机器人指令。";
  renderControlTargets();
  renderControlQueue();
}

function selectedControlTarget() {
  const option = $("controlTarget").selectedOptions[0];
  if (!option?.dataset.targetId) return null;
  return {
    value: option.value,
    targetType: option.dataset.targetType,
    targetId: option.dataset.targetId,
    unitType: option.dataset.unitType || null,
  };
}

function renderControlTargets() {
  const select = $("controlTarget");
  const previous = select.value;
  select.replaceChildren();
  const status = state.status;
  if (status?.core) {
    const option = document.createElement("option");
    option.value = `CORE:${status.core.id}`;
    option.dataset.targetType = "CORE";
    option.dataset.targetId = status.core.id;
    option.textContent = `Core ${status.core.id.slice(0, 8)} · ${formatPosition(status.core.position)}`;
    select.append(option);
  }
  const units = status?.units || [];
  ["WORKER", "VANGUARD", "RANGER"].forEach((unitType) => {
    const matching = units.filter((unit) => unit.unit_type === unitType);
    if (!matching.length) return;
    const group = document.createElement("optgroup");
    group.label = UNIT_META[unitType].name;
    matching.forEach((unit) => {
      const option = document.createElement("option");
      option.value = `UNIT:${unit.id}`;
      option.dataset.targetType = "UNIT";
      option.dataset.targetId = unit.id;
      option.dataset.unitType = unit.unit_type;
      option.textContent = `${UNIT_META[unitType].name} ${unit.short_id} · ${formatPosition(unit.position)}`;
      group.append(option);
    });
    select.append(group);
  });
  if (!select.options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "等待实时单位";
    select.append(option);
  } else if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
  updateControlActions();
}

function updateControlActions() {
  const target = selectedControlTarget();
  const select = $("controlAction");
  const previous = select.value;
  select.replaceChildren();
  const type = target?.targetType === "CORE" ? "CORE" : target?.unitType;
  const actions = CONTROL_ACTION_OPTIONS[type] || [["WAIT", "待命"]];
  actions.forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  });
  if (actions.some(([value]) => value === previous)) select.value = previous;
  updateControlParameters();
}

function renderDirectionButtons() {
  document.querySelectorAll("[data-control-direction]").forEach((button) => {
    button.classList.toggle("active", button.dataset.controlDirection === state.controlDirection);
    button.setAttribute("aria-pressed", button.classList.contains("active") ? "true" : "false");
  });
}

function renderControlEnemies() {
  const select = $("controlEnemy");
  const previous = select.value;
  select.replaceChildren();
  const enemies = state.status?.visible_enemies || [];
  enemies.forEach((enemy) => {
    const option = document.createElement("option");
    option.value = enemy.id;
    option.dataset.enemyId = enemy.id;
    option.dataset.x = String(enemy.position?.[0] ?? 0);
    option.dataset.y = String(enemy.position?.[1] ?? 0);
    const name = enemy.kind === "CORE"
      ? "敌方 Core"
      : `敌方 ${UNIT_META[enemy.unit_type]?.name || enemy.unit_type || "单位"}`;
    option.textContent = `${name} ${enemy.short_id} · ${formatPosition(enemy.position)}`;
    select.append(option);
  });
  if (!select.options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "当前没有可见敌人";
    select.append(option);
  } else if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
}

function updateControlParameters() {
  const action = $("controlAction").value;
  $("controlDirectionGroup").hidden = !["MOVE", "SWEEP", "START_MOVE"].includes(action);
  $("controlSpawnGroup").hidden = action !== "SPAWN";
  $("controlShootGroup").hidden = action !== "SHOOT";
  if (action === "SHOOT") renderControlEnemies();
  renderDirectionButtons();
  const target = selectedControlTarget();
  $("sendControlButton").disabled = !state.status?.online
    || !target
    || (action === "SHOOT" && !$("controlEnemy").value);
}

async function sendControlCommand() {
  const target = selectedControlTarget();
  const tick = Number(state.status?.tick);
  if (!target || !Number.isInteger(tick) || tick < 1) {
    showToast("没有可用的实时目标", true);
    return;
  }
  const action = $("controlAction").value;
  const command = {
    target_type: target.targetType,
    target_id: target.targetId,
    action,
    observed_tick: tick,
  };
  if (["MOVE", "SWEEP", "START_MOVE"].includes(action)) {
    command.direction = state.controlDirection;
  } else if (action === "SPAWN") {
    command.unit_type = $("controlSpawnType").value;
  } else if (action === "SHOOT") {
    const enemy = $("controlEnemy").selectedOptions[0];
    if (!enemy?.dataset.enemyId) {
      showToast("当前没有可射击的可见目标", true);
      return;
    }
    command.enemy_id = enemy.dataset.enemyId;
    command.expected_cell = [Number(enemy.dataset.x), Number(enemy.dataset.y)];
  }
  const button = $("sendControlButton");
  button.disabled = true;
  try {
    const result = await requestJSON("/api/control", {
      method: "POST",
      administrator: true,
      body: JSON.stringify(command),
    });
    showToast(result.message || "指令已排队");
    await refreshControlStatus();
  } catch (error) {
    showToast(`发送失败：${error.message}`, true);
  } finally {
    updateControlParameters();
  }
}

async function clearControlQueue() {
  try {
    const result = await requestJSON("/api/control", {
      method: "DELETE",
      administrator: true,
    });
    showToast(result.removed ? `已撤销 ${result.removed} 条待执行指令` : "没有待执行指令");
    await refreshControlStatus();
  } catch (error) {
    showToast(`撤销失败：${error.message}`, true);
  }
}

function renderControlQueue() {
  const queue = state.controlQueue || { pending: [], last_receipt: null };
  const pending = queue.pending || [];
  $("controlQueueStatus").textContent = pending.length
    ? `待执行 ${pending.length} 条`
    : "无待执行指令";
  const receipt = queue.last_receipt;
  $("controlReceipt").textContent = receipt
    ? `${CONTROL_RECEIPT_NAMES[receipt.status] || receipt.status} · ${receipt.action || "—"} · Tick ${receipt.applied_tick ?? "—"}`
    : "尚未发送";
  $("clearControlButton").disabled = pending.length === 0;
}

async function refreshControlStatus() {
  try {
    state.controlQueue = await requestJSON("/api/control");
  } catch (error) {
    state.controlQueue = { pending: [], last_receipt: null, error: error.message };
  }
  renderControlQueue();
}

function selectControlTarget(targetType, targetId) {
  const select = $("controlTarget");
  const value = `${targetType}:${targetId}`;
  if (![...select.options].some((option) => option.value === value)) return;
  select.value = value;
  updateControlActions();
  $("controlTarget").focus();
  $("controlTarget").scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderCore() {
  const container = $("coreStatus");
  container.replaceChildren();
  const core = state.status?.core;
  if (!core) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.status?.message || "Core 当前不可用";
    container.append(empty);
    return;
  }
  const first = document.createElement("div");
  first.className = "core-row";
  const name = document.createElement("div");
  name.className = "core-name";
  const orb = document.createElement("span");
  orb.className = "core-orb";
  const title = document.createElement("strong");
  title.textContent = `Core ${core.state}`;
  name.append(orb, title);
  const health = document.createElement("span");
  health.className = "core-meta";
  health.textContent = `${core.shield} SH · ${core.hp} HP`;
  first.append(name, health);
  const second = document.createElement("div");
  second.className = "core-row core-meta";
  const position = document.createElement("span");
  position.textContent = `${formatPosition(core.position)}${core.destination ? ` → ${formatPosition(core.destination)}` : ""}`;
  const action = document.createElement("span");
  action.textContent = core.action || "WAIT";
  const control = document.createElement("button");
  control.type = "button";
  control.className = "unit-control-button";
  control.textContent = "操控";
  control.addEventListener("click", () => selectControlTarget("CORE", core.id));
  second.append(position, action, control);
  container.append(first, second);
}

function renderUnits() {
  const list = $("unitList");
  list.replaceChildren();
  const units = (state.status?.units || []).filter(
    (unit) => state.filter === "ALL" || unit.unit_type === state.filter,
  );
  if (!units.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "当前筛选没有单位";
    list.append(empty);
    return;
  }
  units.forEach((unit) => {
    const meta = UNIT_META[unit.unit_type] || { name: unit.unit_type, glyph: "?" };
    const card = document.createElement("article");
    card.className = "unit-card";
    const head = document.createElement("div");
    head.className = "unit-card-head";
    const name = document.createElement("strong");
    name.textContent = `${meta.name} ${unit.short_id}`;
    const hp = document.createElement("span");
    hp.textContent = `HP ${unit.hp ?? "—"}${unit.cargo ? ` · 货 ${unit.cargo}` : ""}`;
    head.append(name, hp);
    const role = document.createElement("div");
    role.className = "unit-role";
    role.textContent = `${unit.role} · ${formatPosition(unit.position)}`;
    const action = document.createElement("div");
    action.className = "unit-action";
    action.textContent = unit.action || "WAIT";
    const foot = document.createElement("div");
    foot.className = "unit-card-foot";
    const resource = document.createElement("span");
    resource.textContent = unit.resource_target ? `矿 ${formatPosition(unit.resource_target)}` : "";
    const scout = document.createElement("span");
    scout.textContent = unit.scout_target ? `目标 ${formatPosition(unit.scout_target)}` : "";
    const control = document.createElement("button");
    control.type = "button";
    control.className = "unit-control-button";
    control.textContent = "操控";
    control.addEventListener("click", () => selectControlTarget("UNIT", unit.id));
    foot.append(resource, scout, control);
    card.append(head, role, action, foot);
    list.append(card);
  });
}

function fillTags(container, positions) {
  container.replaceChildren();
  if (!positions?.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "暂无";
    container.append(empty);
    return;
  }
  positions.slice(0, 80).forEach((position) => {
    const tag = document.createElement("span");
    tag.className = "resource-tag";
    tag.textContent = formatPosition(position);
    container.append(tag);
  });
}

function renderResources() {
  const visible = state.status?.visible_resources || [];
  const remembered = state.status?.remembered_resources || [];
  $("resourceCount").textContent = String(remembered.length);
  const preferredRadius = state.status?.resource_radius ?? "∞";
  const assignmentLimit = state.status?.resource_radius_limit ?? preferredRadius;
  $("resourcePlan").textContent = `可采候选 ${state.status?.resource_candidate_count ?? 0} · 本回合采集分配 ${state.status?.resource_assignment_count ?? 0} · 有效半径 ${state.status?.effective_resource_radius ?? 0}/${assignmentLimit} · 近矿首选 ${preferredRadius}`;
  const adaptive = state.status?.adaptive_economy;
  const action = ADAPTIVE_ACTION_NAMES[adaptive?.action] || adaptive?.action || "等待运行";
  const reason = ADAPTIVE_REASON_NAMES[adaptive?.reason] || adaptive?.reason || "暂无反馈样本";
  const radiusDelta = Number(adaptive?.radius_delta || 0);
  const signedRadius = radiusDelta > 0 ? `+${radiusDelta}` : String(radiusDelta);
  $("adaptiveStatus").textContent = action;
  $("adaptiveMetrics").textContent = adaptive
    ? `单位工人吞吐 ${Number(adaptive.throughput_per_worker || 0).toFixed(3)} · 忙碌率 ${Math.round(Number(adaptive.utilization || 0) * 100)}% · 失败率 ${Math.round(Number(adaptive.harvest_failure_rate || 0) * 100)}% · 平均周期 ${Number(adaptive.average_cycle_ticks || 0).toFixed(1)} Tick · 样本 ${adaptive.sample_count ?? 0}`
    : "等待战术运行后显示吞吐、忙碌率和采集周期。";
  $("adaptivePlan").textContent = adaptive
    ? `自动优化：${action} · ${reason} · 半径修正 ${signedRadius} · 额外侦察 ${adaptive.scout_bonus ?? 0} · 工人目标 ${adaptive.worker_target ?? "—"}`
    : "自动优化：等待运行数据";
  fillTags($("visibleResources"), visible);
  fillTags($("rememberedResources"), remembered);
}

function renderEvents() {
  const list = $("eventList");
  list.replaceChildren();
  const events = [...(state.status?.events || [])].reverse();
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无事件";
    list.append(empty);
    return;
  }
  events.forEach((event) => {
    const item = document.createElement("div");
    item.className = "event-item";
    const title = document.createElement("strong");
    title.textContent = event.event_type || "UNKNOWN";
    const detail = document.createElement("span");
    detail.textContent = [event.reason_code, formatPosition(event.position)]
      .filter((value) => value && value !== "—")
      .join(" · ") || "已结算";
    item.append(title, detail);
    list.append(item);
  });
}

async function refreshStatus() {
  try {
    state.status = await requestJSON("/api/status");
    renderStatus();
  } catch (error) {
    state.status = { online: false, stale: true, message: error.message };
    renderStatus();
  }
}

async function init() {
  bindStaticControls();
  loadTheme();
  await Promise.all([loadConfig(), refreshStatus(), refreshControlStatus()]);
  setInterval(() => {
    refreshStatus();
    refreshControlStatus();
  }, 2500);
}

init();
