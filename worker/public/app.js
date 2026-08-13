const TOKEN_KEY = "arenaHeroAdminToken";
const GROUP_LABELS = {
  runtime: "运行时",
  control: "地图控制",
  workers: "工人与经济",
  combat: "战斗与防守",
  memory: "记忆与滞后",
};
const POSTURE_LABELS = {
  RECOVER: "恢复",
  ECONOMY: "经济",
  HOLD: "固守",
  CONTEST: "争夺",
  ATTACK: "进攻",
  REGROUP: "重整",
  GUARDED: "戒备",
  SURVIVAL: "生存",
  RESPAWNING: "重生中",
};
const BACKEND_LABELS = {
  typescript_primary: "TypeScript 主路径",
  python_shadow: "Python Shadow",
  python_primary: "Python 主路径",
};
const SUBMITTED_BACKEND_LABELS = {
  typescript: "TypeScript",
  python: "Python",
  safe_fallback: "最小安全计划",
};
const TASK_LABELS = {
  economy: "经济",
  defense: "防守",
  contest: "争夺",
  attack: "进攻",
  explore: "探索",
};

const state = { schema: null, config: null };
const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const document = await response
    .json()
    .catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(document.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return document;
}

function normalizedAdminToken() {
  let token = $("adminToken").value.trim();
  token = token.replace(/^ADMIN_CONTROL_SECRET\s*=\s*/i, "");
  token = token.replace(/^Bearer\s+/i, "").trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token;
}

function tokenHeaders() {
  const token = normalizedAdminToken();
  if (!token) throw new Error("请先输入 ADMIN_CONTROL_SECRET");
  $("adminToken").value = token;
  sessionStorage.setItem(TOKEN_KEY, token);
  return { Authorization: `Bearer ${token}` };
}

function adminErrorMessage(error) {
  return error.status === 404
    ? "管理员 Secret 未配置或 Token 不正确"
    : error.message;
}

function showToast(message, error = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function renderConfig() {
  const container = $("configGroups");
  container.replaceChildren();
  for (const [group, label] of Object.entries(GROUP_LABELS)) {
    const fields = state.schema.numericFields.filter(
      (field) => field.group === group,
    );
    const card = document.createElement("section");
    card.className = "config-group";
    const heading = document.createElement("h3");
    heading.textContent = label;
    const grid = document.createElement("div");
    grid.className = "field-grid";
    for (const field of fields) {
      const wrapper = document.createElement("label");
      wrapper.className = "field";
      const title = document.createElement("span");
      title.textContent = field.label;
      const input = document.createElement("input");
      input.type = "number";
      input.min = field.min;
      input.max = field.max;
      input.step = field.step;
      input.value = state.config[field.key];
      input.dataset.configKey = field.key;
      input.addEventListener("input", () => {
        state.config[field.key] = Number(input.value);
      });
      wrapper.append(title, input);
      grid.append(wrapper);
    }
    card.append(heading, grid);
    container.append(card);
  }
  renderWeights();
}

function renderWeights() {
  const table = $("weightsTable");
  const headRow = document.createElement("tr");
  headRow.append(document.createElement("th"));
  for (const task of state.schema.postureWeights.tasks) {
    const th = document.createElement("th");
    th.textContent = TASK_LABELS[task] || task;
    headRow.append(th);
  }
  table.tHead.replaceChildren(headRow);
  table.tBodies[0].replaceChildren();
  for (const posture of state.schema.postureWeights.postures) {
    const row = document.createElement("tr");
    const label = document.createElement("td");
    label.textContent = POSTURE_LABELS[posture] || posture;
    row.append(label);
    for (const task of state.schema.postureWeights.tasks) {
      const cell = document.createElement("td");
      const input = document.createElement("input");
      input.type = "number";
      input.min = state.schema.postureWeights.min;
      input.max = state.schema.postureWeights.max;
      input.step = state.schema.postureWeights.step;
      input.value = state.config.postureTaskWeights[posture][task];
      input.addEventListener("input", () => {
        state.config.postureTaskWeights[posture][task] = Number(input.value);
      });
      cell.append(input);
      row.append(cell);
    }
    table.tBodies[0].append(row);
  }
}

async function loadConfig() {
  const [schema, config] = await Promise.all([
    requestJSON("/api/schema"),
    requestJSON("/api/config"),
  ]);
  state.schema = schema;
  state.config = config;
  renderConfig();
}

async function saveConfig() {
  try {
    const result = await requestJSON("/api/config", {
      method: "PUT",
      headers: tokenHeaders(),
      body: JSON.stringify(state.config),
    });
    state.config = result.config;
    renderConfig();
    showToast("配置已保存，将在下一 Tick 生效");
  } catch (error) {
    showToast(adminErrorMessage(error), true);
  }
}

async function control(action) {
  try {
    const result = await requestJSON("/api/control", {
      method: "POST",
      headers: tokenHeaders(),
      body: JSON.stringify({ action }),
    });
    showToast(`Agent 已切换为 ${result.desired}`);
    await refreshStatus();
  } catch (error) {
    showToast(adminErrorMessage(error), true);
  }
}

async function saveBackend() {
  try {
    const backend = $("strategyBackend").value;
    const failureThreshold = Number($("failureThreshold").value);
    const result = await requestJSON("/api/backend", {
      method: "PUT",
      headers: tokenHeaders(),
      body: JSON.stringify({ backend, failureThreshold }),
    });
    showToast(
      `策略后端已切换为 ${BACKEND_LABELS[result.backend] || result.backend}`,
    );
    await refreshStatus();
  } catch (error) {
    showToast(adminErrorMessage(error), true);
  }
}

function renderShadow(shadow) {
  if (!shadow) return "—";
  const result = shadow.matched ? "一致" : "有差异";
  const compared = shadow.comparedTicks ?? 1;
  const mismatched = shadow.mismatchedTicks ?? (shadow.matched ? 0 : 1);
  return `${result} · ${mismatched}/${compared} Tick · 单位 ${shadow.unitActionDifferences} · Core ${shadow.coreActionDifferent ? 1 : 0} · 摘要 ${shadow.summaryDifferent ? 1 : 0} · 记忆 ${shadow.memoryMetadataDifferent ? 1 : 0}`;
}

async function refreshStatus() {
  try {
    const status = await requestJSON("/api/status");
    $("desiredState").textContent = status.desired || "—";
    $("phaseState").textContent = status.phase || "—";
    $("tickState").textContent = status.tick ?? "—";
    $("postureState").textContent =
      POSTURE_LABELS[status.summary?.posture] || status.summary?.posture || "—";
    $("backendState").textContent =
      BACKEND_LABELS[status.backend] || status.backend || "—";
    $("strategyBackend").value = status.backend || "typescript_primary";
    $("failureThreshold").value = status.strategyFailureThreshold ?? 3;
    $("submittedBackendState").textContent =
      SUBMITTED_BACKEND_LABELS[status.strategy?.submittedBackend] ||
      status.strategy?.submittedBackend ||
      "—";
    $("strategyVersionState").textContent = status.strategy
      ? `${status.strategy.strategyVersion} / ${status.strategy.contractVersion}`
      : "—";
    $("latencyState").textContent =
      status.strategy?.latencyMs === undefined
        ? "—"
        : `${Math.round(status.strategy.latencyMs)} ms`;
    $("lastSuccessTick").textContent = status.strategy?.lastSuccessTick ?? "—";
    $("failureState").textContent = status.strategy
      ? `${status.strategy.consecutiveFailures}${status.strategy.blocked ? "（已阻塞）" : ""}`
      : "—";
    $("strategyError").textContent = status.strategy?.lastError || "—";
    $("shadowState").textContent = renderShadow(status.strategy?.shadow);
    const badge = $("connectionBadge");
    badge.textContent = status.authBlocked
      ? "认证被阻止"
      : status.connected
        ? "已连接"
        : status.desired === "stopped"
          ? "已停止"
          : "等待连接";
    badge.classList.toggle("online", Boolean(status.connected));
    badge.classList.toggle(
      "blocked",
      Boolean(status.authBlocked || status.strategy?.blocked),
    );
  } catch {
    $("connectionBadge").textContent = "状态读取失败";
    $("connectionBadge").classList.add("blocked");
  }
}

function bindEvents() {
  $("adminToken").value = sessionStorage.getItem(TOKEN_KEY) || "";
  $("saveToken").addEventListener("click", () => {
    const token = $("adminToken").value.trim();
    if (!token) {
      showToast("请输入 ADMIN_CONTROL_SECRET", true);
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, token);
    showToast("管理员 Token 已保存到当前会话");
  });
  $("saveConfig").addEventListener("click", saveConfig);
  $("resetConfig").addEventListener("click", () => {
    state.config = clone(state.schema.defaults);
    renderConfig();
    showToast("已恢复默认值，点击保存后生效");
  });
  $("startAgent").addEventListener("click", () => control("start"));
  $("stopAgent").addEventListener("click", () => control("stop"));
  $("saveBackend").addEventListener("click", saveBackend);
}

async function main() {
  bindEvents();
  try {
    await loadConfig();
  } catch (error) {
    showToast(`配置加载失败：${error.message}`, true);
  }
  await refreshStatus();
  setInterval(refreshStatus, 10_000);
}

void main();
