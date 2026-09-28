// ── State ────────────────────────────────────────────────────────────
const statuses = ["全部", "待处理", "已处理", "待验证", "待反馈"];
const statusColors = {
  待处理: "var(--status-pending)",
  已处理: "var(--status-done)",
  待验证: "var(--status-verify)",
  待反馈: "var(--status-feedback)",
};

const priorityRank = {
  紧急: 4,
  高: 3,
  中: 2,
  低: 1,
};

let activeStatus = "全部";
let activeTicketId = null;
let draftAttachments = [];
let attachmentSequence = 0;
let tickets = [];
let lastOcrText = "";
let lastOcrMs = 0;
let highlightTicketId = null;
const pendingEdits = new Map();

// ── Data access ─────────────────────────────────────────────────────
async function loadTickets() {
  try {
    const res = await fetch("/api/tickets");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tickets = await res.json();
  } catch (err) {
    console.error("加载工单失败:", err);
    tickets = [];
  }
}

async function syncTickets() {
  await loadTickets();
  renderAll();
}

async function saveTicketToServer(ticket) {
  // Check if ticket already exists on server
  const existing = tickets.find((t) => t.localId === ticket.localId);
  const method = existing ? "PATCH" : "POST";
  const url = existing ? `/api/tickets/${ticket.localId}` : "/api/tickets";

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ticket),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function saveAttachmentsToDisk(localId, items) {
  if (!items.length) return;
  const files = await Promise.all(
    items.map(async (item) => ({
      name: item.name,
      dataUrl: await fileToDataUrl(item.file),
    }))
  );
  await fetch("/api/save-attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localId, files }),
  });
}

// ── DOM refs ────────────────────────────────────────────────────────
const navEl = document.querySelector("#statusNav");
const serviceStatusEl = document.querySelector("#serviceStatus");
const serviceToggleButtonEl = document.querySelector("#serviceToggleButton");
const listEl = document.querySelector("#ticketList");
const detailEl = document.querySelector("#ticketDetail");
const searchEl = document.querySelector("#globalSearch");
const sortEl = document.querySelector("#sortSelect");
const emptyEl = document.querySelector("#emptyState");
const composerEl = document.querySelector("#composer");
const inputEl = document.querySelector("#ticketInput");
const fileInputEl = document.querySelector("#fileInput");
const sendButtonEl = document.querySelector(".send-button");
const parseStatusEl = document.querySelector("#parseStatus");
const settingsDialog = document.querySelector("#settingsDialog");
const exportDialog = document.querySelector("#exportDialog");
const exportCountEl = document.querySelector("#exportCount");
const toastEl = document.querySelector("#toast");
const attachmentRowEl = document.querySelector("#attachmentRow");
const recognitionModeEl = document.querySelector("#recognitionMode");
const ocrModeInputEl = document.querySelector("#ocrModeInput");
const providerRowEl = document.querySelector("#providerRow");
const providerInputEl = document.querySelector("#providerInput");
const baseUrlInputEl = document.querySelector("#baseUrlInput");
const apiKeyRowEl = document.querySelector("#apiKeyRow");
const apiKeyInputEl = document.querySelector("#apiKeyInput");
const modelInputEl = document.querySelector("#modelInput");
const thinkingRowEl = document.querySelector("#thinkingRow");
const thinkingInputEl = document.querySelector("#thinkingInput");
const timeoutInputEl = document.querySelector("#timeoutInput");
const dataMaskInputEl = document.querySelector("#dataMaskInput");
const themeToggleEl = document.querySelector("#themeToggle");
const draftButtonEl = document.querySelector("#draftButton");

const exportColumns = [
  ["localId", "本地工单号"],
  ["externalId", "外部工单号"],
  ["status", "状态"],
  ["priority", "优先级"],
  ["reporter", "反馈人"],
  ["summary", "问题概括"],
  ["description", "问题描述"],
  ["context", "问题背景"],
  ["menuPath", "操作菜单"],
  ["reportTime", "反馈时间"],
  ["handler", "处理人"],
  ["remark", "处理备注"],
  ["aiSource", "AI 来源"],
  ["attachmentCount", "附件数量"],
  ["createdAt", "创建时间"],
  ["updatedAt", "更新时间"],
];

const START_COMMAND = "cd code && node server.js";

// ── Utilities ───────────────────────────────────────────────────────
function shortCode(localId) {
  if (!localId) return "";
  return `LOC-${localId.replace("LOC-", "").slice(0, 6).toUpperCase()}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nowString() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toastEl.classList.remove("show"), 1800);
}

// ── Filtering / rendering ──────────────────────────────────────────
function getFilteredTickets() {
  const query = searchEl.value.trim().toLowerCase();
  return tickets
    .filter((ticket) => activeStatus === "全部" || ticket.status === activeStatus)
    .filter((ticket) => {
      if (!query) return true;
      return [
        ticket.localId,
        shortCode(ticket.localId),
        ticket.externalId,
        ticket.reporter,
        ticket.summary,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => {
      if (sortEl.value === "reportDesc") return b.reportTime.localeCompare(a.reportTime);
      if (sortEl.value === "priorityDesc") return priorityRank[b.priority] - priorityRank[a.priority];
      return b.createdAt.localeCompare(a.createdAt);
    });
}

function renderNav() {
  navEl.innerHTML = statuses
    .map((status) => {
      const count =
        status === "全部" ? tickets.length : tickets.filter((ticket) => ticket.status === status).length;
      return `
        <button class="nav-item ${status === activeStatus ? "active" : ""}" type="button" data-status="${status}">
          <span>${status}</span>
          <span class="count-pill">${count}</span>
        </button>
      `;
    })
    .join("");

  const today = tickets.filter((ticket) => {
    const date = ticket.createdAt ? ticket.createdAt.slice(0, 10) : "";
    return date === nowString().slice(0, 10);
  });
  document.querySelector("#todayCount").textContent = today.length;
  document.querySelector("#listTotal").textContent = tickets.length;
  renderServiceStatus();
}

function renderServiceStatus() {
  const chip = serviceStatusEl.closest(".service-chip");
  const setStatus = (short, full, state) => {
    serviceStatusEl.textContent = short;
    if (chip) {
      chip.dataset.state = state;
      chip.title = full;
    }
  };

  if (location.protocol === "file:") {
    setStatus("未连接本地服务", "文件模式：联网识别不可用，请用 node server.js 启动", "offline");
    serviceToggleButtonEl.textContent = "复制启动命令";
    return;
  }

  const config = getAiConfig();
  if (config.mode === "ollama") {
    setStatus(`本地 Ollama · ${config.model}`, `本地服务已启动：Ollama 本地识别（${config.model}）`, "local");
  } else if (config.provider === "deepseek") {
    setStatus("DeepSeek V4", "本地服务已启动：DeepSeek V4 文本识别", "cloud");
  } else if (config.provider === "zhipu") {
    setStatus("智谱 GLM-4V-Flash", "本地服务已启动：智谱 GLM-4V-Flash 免费图片识别", "cloud");
  } else {
    setStatus("联网识别可用", "本地服务已启动：联网识别可用", "cloud");
  }
  serviceToggleButtonEl.textContent = "关闭本地服务";
}

function renderList() {
  const filtered = getFilteredTickets();
  emptyEl.hidden = filtered.length > 0;

  // If current selection is not in filtered results, select the first one
  if (filtered.length && !filtered.some((ticket) => ticket.localId === activeTicketId)) {
    activeTicketId = filtered[0].localId;
  }

  listEl.innerHTML = filtered
    .map((ticket) => {
      const isActive = ticket.localId === activeTicketId;
      const isNew = ticket.localId === highlightTicketId;
      return `
        <button class="ticket-card ${isActive ? "active" : ""} ${isNew ? "is-new" : ""}" type="button" data-id="${ticket.localId}" style="--status-color: ${statusColors[ticket.status]}">
          <span class="card-rail" aria-hidden="true"></span>
          <div class="card-topline">
            <span class="local-code" title="${escapeHtml(ticket.localId)}">${escapeHtml(shortCode(ticket.localId))}</span>
            <span class="status-pill">${escapeHtml(ticket.status)}</span>
          </div>
          <h3>${escapeHtml(ticket.summary)}</h3>
          <div class="card-meta">
            <span>${escapeHtml(ticket.reporter || "待补充")}</span>
            <span>${escapeHtml(ticket.reportTime)}</span>
            <span class="external-id">${escapeHtml(ticket.externalId || "待补充外部号")}</span>
          </div>
          <div class="card-foot">
            <span class="priority-chip" data-priority="${escapeHtml(ticket.priority)}">
              <span class="priority-dot" aria-hidden="true"></span>${escapeHtml(ticket.priority)}
            </span>
            <span class="source-tag">${escapeHtml(ticket.aiSource)}</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderDetail() {
  const ticket = tickets.find((item) => item.localId === activeTicketId);
  if (!ticket) {
    detailEl.innerHTML = `<div class="empty-state compact"><strong>请选择一条工单</strong><span>详情会在这里展开。</span></div>`;
    return;
  }

  const attCount = Array.isArray(ticket.attachments) ? ticket.attachments.length : 0;
  const logCount = Array.isArray(ticket.logs) ? ticket.logs.length : 0;
  const pendingCount = ["reporter", "summary", "menuPath", "description", "context"].filter((name) =>
    isEmptyField(ticket[name])
  ).length;

  detailEl.innerHTML = `
    <div class="drawer-head">
      <div class="drawer-id">
        <code title="${escapeHtml(ticket.localId)}">${escapeHtml(ticket.localId)}</code>
        <button class="copy-button" type="button" data-copy="${escapeHtml(ticket.localId)}">复制</button>
      </div>
      <button class="icon-button drawer-toggle" id="drawerToggle" type="button" aria-label="收起详情面板" title="收起详情面板">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>
    </div>

    <div class="segment" role="group" aria-label="状态切换">
      ${["待处理", "已处理", "待验证", "待反馈"]
        .map(
          (status) => `
          <button class="segment-button ${ticket.status === status ? "active" : ""}" type="button" data-next-status="${status}">
            ${status}
          </button>
        `
        )
        .join("")}
    </div>

    <div class="detail-meta">
      <span class="priority-chip" data-priority="${escapeHtml(ticket.priority)}">
        <span class="priority-dot" aria-hidden="true"></span>${escapeHtml(ticket.priority)}
      </span>
      <span class="source-tag">${escapeHtml(ticket.aiSource)}</span>
      <span class="hint">创建于 ${escapeHtml(ticket.createdAt)}</span>
    </div>

    <section class="field-group">
      <div class="group-head">
        <h3>识别字段</h3>
        ${
          pendingCount
            ? `<span class="group-flag">待补充 ${pendingCount} 项</span>`
            : `<span class="group-ok">已完整</span>`
        }
      </div>
      <div class="field-grid">
        ${field("反馈人", "reporter", ticket.reporter)}
        ${field("反馈时间", "reportTime", ticket.reportTime)}
        ${field("问题概括", "summary", ticket.summary, true)}
        ${field("操作菜单", "menuPath", ticket.menuPath, true)}
        ${field("问题背景", "context", ticket.context, true, true)}
        ${field("问题描述", "description", ticket.description, true, true)}
      </div>
    </section>

    <section class="field-group">
      <div class="group-head"><h3>人工维护</h3></div>
      <div class="field-grid">
        ${field("外部工单号", "externalId", ticket.externalId)}
        ${field("处理人", "handler", ticket.handler)}
        ${priorityField(ticket.priority)}
        ${field("处理备注", "remark", ticket.remark, true, true)}
      </div>
    </section>

    <section class="field-group">
      <div class="group-head">
        <h3>截图附件</h3>
        <span class="group-note">${attCount ? `${attCount} 张` : "无"}</span>
      </div>
      <div class="attachment-list">
        ${
          attCount
            ? ticket.attachments
                .map(
                  (item) => `
            <div class="attachment-item">
              <span class="attachment-thumb">IMG</span>
              <span>${escapeHtml(item)}</span>
              <span>保存在本地</span>
            </div>
          `
                )
                .join("")
            : `<div class="attachment-item"><span>暂无附件</span><span>可从底部输入框添加</span></div>`
        }
      </div>
    </section>

    <section class="field-group">
      <div class="group-head">
        <h3>操作日志</h3>
        <span class="group-note">${logCount} 条</span>
      </div>
      <div class="log-list">
        ${(ticket.logs || [])
          .map((item) => `<div class="log-item"><span>${escapeHtml(item)}</span></div>`)
          .join("")}
      </div>
    </section>

    <div class="save-bar" id="saveBar" hidden>
      <span class="save-count" id="saveCount">已修改 0 项</span>
      <button class="ghost-button" id="discardButton" type="button">放弃</button>
      <button class="primary-button" id="saveButton" type="button">保存修改</button>
    </div>
  `;
  syncSaveBar();
}

function isEmptyField(value) {
  const text = String(value ?? "").trim();
  return !text || text === "待补充";
}

function field(label, name, value, wide = false, textarea = false) {
  const safeValue = value || "";
  const empty = isEmptyField(safeValue);
  const stateChip = empty ? `<span class="field-state">待补充</span>` : "";
  const classes = `field${wide ? " wide" : ""}${empty ? " is-empty" : ""}`;
  if (textarea) {
    return `
      <div class="${classes}">
        <label>${escapeHtml(label)}${stateChip}</label>
        <textarea data-ticket-field="${escapeHtml(name)}" placeholder="待补充">${escapeHtml(safeValue)}</textarea>
      </div>
    `;
  }
  return `
    <div class="${classes}">
      <label>${escapeHtml(label)}${stateChip}</label>
      <input data-ticket-field="${escapeHtml(name)}" type="text" value="${escapeHtml(safeValue)}" placeholder="待补充" />
    </div>
  `;
}

function priorityField(value) {
  return `
    <div class="field">
      <label>优先级</label>
      <select data-ticket-field="priority">
        ${["低", "中", "高", "紧急"]
          .map((item) => `<option value="${item}" ${item === value ? "selected" : ""}>${item}</option>`)
          .join("")}
      </select>
    </div>
  `;
}

function renderAll() {
  renderNav();
  renderList();
  renderDetail();
}

// ── Settings ────────────────────────────────────────────────────────
function getAiConfig() {
  const mode = recognitionModeEl.value;
  return {
    mode,
    provider: mode === "ollama" ? "ollama" : providerInputEl.value,
    ocrMode: ocrModeInputEl.value,
    baseUrl: baseUrlInputEl.value.trim().replace(/\/+$/, ""),
    apiKey: apiKeyInputEl.value.trim(),
    model: modelInputEl.value.trim(),
    thinking: thinkingInputEl.value,
    timeoutSeconds: Number(timeoutInputEl.value || 15),
    maskData: dataMaskInputEl.checked,
  };
}

function saveAiConfig() {
  const config = getAiConfig();
  localStorage.setItem(
    "ticketDeskAiConfig",
    JSON.stringify({
      mode: config.mode,
      provider: config.provider,
      ocrMode: config.ocrMode,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      thinking: config.thinking,
      timeoutSeconds: config.timeoutSeconds,
      maskData: config.maskData,
    })
  );
  renderServiceStatus();
}

function loadAiConfig() {
  const raw = localStorage.getItem("ticketDeskAiConfig");
  if (!raw) return;
  try {
    const config = JSON.parse(raw);
    const mode = config.mode || (config.fallbackMode === "local_only" ? "ollama" : "cloud");
    recognitionModeEl.value = mode;
    ocrModeInputEl.value = config.ocrMode || "auto";
    if (mode === "ollama") {
      providerInputEl.value = "zhipu";
      baseUrlInputEl.value = config.baseUrl || "http://127.0.0.1:11434/v1";
      apiKeyInputEl.value = "";
      modelInputEl.value = config.model || "qwen3-vl:4b";
      thinkingInputEl.value = config.thinking || "disabled";
      timeoutInputEl.value = config.timeoutSeconds || 60;
      dataMaskInputEl.checked = config.maskData ?? true;
    } else {
      providerInputEl.value = ["deepseek", "qwen", "kimi", "glm-ocr", "openai_compatible"].includes(config.provider)
        ? config.provider
        : "zhipu";
      baseUrlInputEl.value = config.baseUrl || "https://open.bigmodel.cn/api/paas/v4";
      apiKeyInputEl.value = config.apiKey || "";
      modelInputEl.value = config.model || "glm-4v-flash";
      thinkingInputEl.value = config.thinking || "disabled";
      timeoutInputEl.value = config.timeoutSeconds || 15;
      dataMaskInputEl.checked = config.maskData ?? true;
    }
    syncSettingsVisibility();
  } catch {
    localStorage.removeItem("ticketDeskAiConfig");
  }
}

function applyRecognitionPreset() {
  if (recognitionModeEl.value === "ollama") {
    baseUrlInputEl.value = "http://127.0.0.1:11434/v1";
    modelInputEl.value = "qwen3-vl:4b";
    thinkingInputEl.value = "disabled";
    timeoutInputEl.value = "60";
  }
}

function syncSettingsVisibility() {
  const localMode = recognitionModeEl.value === "ollama";
  providerRowEl.hidden = localMode;
  apiKeyRowEl.hidden = localMode;
  thinkingRowEl.hidden = localMode || providerInputEl.value !== "deepseek";
}

// 预热本地模型：提前把模型读进内存并保活，避免第一次识别等模型加载
async function warmupLocalModel(notify = true) {
  const config = getAiConfig();
  if (config.mode !== "ollama" || !config.baseUrl || !config.model) return;
  try {
    const res = await fetch("/api/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    if (notify) {
      showToast(res.ok ? "本地模型已预热，识别更快" : "模型预热失败，请检查 Ollama");
    }
  } catch {
    if (notify) showToast("模型预热失败，请检查 Ollama 是否已启动");
  }
}

function applyProviderPreset() {
  const provider = providerInputEl.value;
  if (provider === "zhipu") {
    baseUrlInputEl.value = "https://open.bigmodel.cn/api/paas/v4";
    modelInputEl.value = "glm-4v-flash";
    thinkingInputEl.value = "disabled";
  } else if (provider === "deepseek") {
    baseUrlInputEl.value = "https://api.deepseek.com";
    modelInputEl.value = "deepseek-v4-flash";
    thinkingInputEl.value = "disabled";
  } else if (provider === "qwen") {
    baseUrlInputEl.value = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    modelInputEl.value = "qwen-vl-max";
    thinkingInputEl.value = "disabled";
  } else if (provider === "kimi") {
    baseUrlInputEl.value = "https://api.moonshot.cn/v1";
    modelInputEl.value = "moonshot-v1-8k";
    thinkingInputEl.value = "disabled";
  } else if (provider === "glm-ocr") {
    baseUrlInputEl.value = "https://open.bigmodel.cn/api/paas/v4";
    modelInputEl.value = "glm-ocr";
    thinkingInputEl.value = "disabled";
  }
  if (provider === "deepseek") {
    thinkingRowEl.hidden = false;
  } else {
    thinkingRowEl.hidden = true;
  }
  saveAiConfig();
}

// ── Export ──────────────────────────────────────────────────────────
function exportRows() {
  return getFilteredTickets().map((ticket) => ({
    ...ticket,
    attachmentCount: Array.isArray(ticket.attachments) ? ticket.attachments.length : 0,
    updatedAt: ticket.updatedAt || ticket.createdAt,
  }));
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function htmlCell(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestampForFile() {
  return new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

function downloadCsv() {
  const rows = exportRows();
  const header = exportColumns.map(([, label]) => csvCell(label)).join(",");
  const body = rows
    .map((row) => exportColumns.map(([key]) => csvCell(row[key])).join(","))
    .join("\n");
  downloadBlob(`\ufeff${header}\n${body}`, `工单记录_${timestampForFile()}.csv`, "text/csv;charset=utf-8");
  showToast(`已导出 ${rows.length} 条 CSV`);
}

function downloadExcel() {
  const rows = exportRows();
  const head = exportColumns.map(([, label]) => `<th>${htmlCell(label)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${exportColumns.map(([key]) => `<td>${htmlCell(row[key])}</td>`).join("")}</tr>`
    )
    .join("");
  const workbook = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="UTF-8" />
        <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>工单记录</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
      </head>
      <body>
        <table>
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </body>
    </html>
  `;
  downloadBlob(workbook, `工单记录_${timestampForFile()}.xls`, "application/vnd.ms-excel;charset=utf-8");
  showToast(`已导出 ${rows.length} 条 Excel`);
}

// ── Attachments ─────────────────────────────────────────────────────
function isSupportedImage(file) {
  return file.type.startsWith("image/");
}

function imageExtension(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function addAttachments(files, sourceLabel) {
  const images = Array.from(files).filter(isSupportedImage);
  if (!images.length) {
    showToast("请选择或粘贴图片文件");
    return;
  }

  images.forEach((file) => {
    attachmentSequence += 1;
    const fallbackName = `${sourceLabel || "截图"}_${attachmentSequence}.${imageExtension(file.type)}`;
    draftAttachments.push({
      id: `draft-${attachmentSequence}`,
      file,
      name: file.name || fallbackName,
      url: URL.createObjectURL(file),
    });
  });
  renderDraftAttachments();
  showToast(`已添加 ${images.length} 张截图`);
}

function removeAttachment(id) {
  const target = draftAttachments.find((item) => item.id === id);
  if (target?.url) URL.revokeObjectURL(target.url);
  draftAttachments = draftAttachments.filter((item) => item.id !== id);
  renderDraftAttachments();
}

function clearDraftAttachments() {
  draftAttachments.forEach((item) => URL.revokeObjectURL(item.url));
  draftAttachments = [];
  renderDraftAttachments();
}

function renderDraftAttachments() {
  attachmentRowEl.innerHTML = draftAttachments
    .map(
      (item) => `
        <div class="attachment-chip" data-attachment-id="${item.id}">
          ${
            item.url
              ? `<img src="${item.url}" alt="${item.name}" />`
              : `<span class="attachment-placeholder">IMG</span>`
          }
          <span class="attachment-name" title="${item.name}">${item.name}</span>
          <button class="remove-attachment" type="button" aria-label="删除 ${item.name}" data-remove-attachment="${item.id}">×</button>
        </div>
      `
    )
    .join("");
}

function insertTextAtCursor(text) {
  if (!text) return;
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? inputEl.value.length;
  const prefix = inputEl.value.slice(0, start);
  const suffix = inputEl.value.slice(end);
  const spacer = prefix && !prefix.endsWith("\n") ? "\n" : "";
  inputEl.value = `${prefix}${spacer}${text}${suffix}`;
  const cursor = start + spacer.length + text.length;
  inputEl.setSelectionRange(cursor, cursor);
}

function handleImagePaste(event) {
  const clipboard = event.clipboardData;
  if (!clipboard) return;

  const files = Array.from(clipboard.files || []);
  const itemFiles = Array.from(clipboard.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const pastedImages = (files.length ? files : itemFiles).filter(isSupportedImage);

  if (!pastedImages.length) return;

  event.preventDefault();
  event.stopPropagation();
  addAttachments(pastedImages, "粘贴截图");
  insertTextAtCursor(clipboard.getData("text/plain"));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (file.type === "image/png" || file.type === "image/jpeg" || file.type === "image/jpg") {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
      return;
    }

    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      resolve(dataUrl);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(img.src);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    };
  });
}

// 识别专用：把截图等比缩到最长边 1280px 的 JPEG。
// 视觉模型的耗时与图片像素量强相关，实测 2560px 大图比 1280px 慢一倍以上。
function fileToRecognitionImage(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const maxEdge = 1280;
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      // JPEG 不支持透明，先铺白底，避免透明区域变黑
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      fileToDataUrl(file).then(resolve).catch(() => resolve(""));
    };
    img.src = objectUrl;
  });
}

// ── AI Recognition ──────────────────────────────────────────────────
function localRecognition(text) {
  return {
    reporter: inferReporter(text),
    summary: text.replace(/\s+/g, " ").slice(0, 28) || "待补充问题概括",
    description: text || "待补充",
    context: "由用户输入内容自动生成，待核对。",
    menuPath: inferMenu(text),
    reportTime: nowString(),
    priority: "中",
    confidence: 0.35,
  };
}

function normalizePriority(value) {
  return ["低", "中", "高", "紧急"].includes(value) ? value : "中";
}

// 直接调用系统 OCR 提取当前待创建工单的截图文字（不需要任何模型）
async function extractOcrText() {
  if (!draftAttachments.length) return "";
  try {
    const images = (
      await Promise.all(draftAttachments.slice(0, 4).map((item) => fileToRecognitionImage(item.file)))
    ).filter(Boolean);
    if (!images.length) return "";
    const res = await fetch("/api/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images }),
    });
    if (!res.ok) return "";
    const payload = await res.json();
    lastOcrMs = Number(payload.ms || 0);
    return String(payload.text || "");
  } catch {
    return "";
  }
}

// 本地草稿：如果已经用系统 OCR 提取过截图文字，就把文字带进描述，避免白丢信息
function draftRecognition(text) {
  const base = localRecognition(text);
  if (lastOcrText) {
    const ocrBlock = `[截图文字识别]\n${lastOcrText}`;
    base.description = text ? `${text}\n\n${ocrBlock}` : ocrBlock;
    base.context = "由 macOS 系统 OCR 提取的截图文字生成，待核对。";
    if (!text) {
      base.summary = lastOcrText.replace(/\s+/g, " ").slice(0, 28) || base.summary;
    }
  }
  return base;
}

function normalizeRecognition(result, fallbackText) {
  const local = localRecognition(fallbackText);
  return {
    reporter: result.reporter || local.reporter,
    summary: (result.summary || local.summary).slice(0, 40),
    description: result.description || local.description,
    context: result.context || local.context,
    menuPath: result.menuPath || result.menu_path || local.menuPath,
    reportTime: result.reportTime || result.report_time || local.reportTime,
    priority: normalizePriority(result.priority || local.priority),
    confidence: Number(result.confidence || 0.8),
    rawNotes: result.notes || "",
  };
}

async function recognizeWithCloud(text) {
  const config = getAiConfig();
  if (location.protocol === "file:") {
    throw new Error("请通过本地服务启动原型后再使用联网识别：node server.js");
  }
  if (!config.baseUrl || !config.model) {
    throw new Error("请在设置里填写 Base URL 和模型名称");
  }
  if (config.provider !== "ollama" && !config.apiKey) {
    throw new Error("请在设置里填写 API Key 后再进行联网识别");
  }

  const safeText = config.maskData && config.provider !== "ollama" ? maskSensitiveText(text) : text;
  const images = (
    await Promise.all(draftAttachments.slice(0, 4).map((item) => fileToRecognitionImage(item.file)))
  ).filter(Boolean);
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(),
    Math.max(config.timeoutSeconds, 5) * 1000
  );

  try {
    const response = await fetch("/api/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, text: safeText, images, currentTime: nowString() }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      if (config.provider === "ollama" && errorText.includes("not found")) {
        throw new Error(
          `Ollama 未找到模型 ${config.model}，请先在终端运行：ollama pull ${config.model}`
        );
      }
      throw new Error(
        `联网识别失败：HTTP ${response.status}${errorText ? ` ${errorText.slice(0, 180)}` : ""}`
      );
    }
    const payload = await response.json();
    if (!payload.data) throw new Error("联网识别没有返回结构化字段");
    lastOcrText = String(payload.ocrText || "");
    lastOcrMs = Number(payload.ocrMs || 0);
    return {
      data: normalizeRecognition(payload.data, text),
      source: "cloud",
      ocrText: lastOcrText,
      ocrMs: lastOcrMs,
      note:
        payload.note ||
        (images.length
          ? `本地代理已发送 ${images.length} 张截图进行识别`
          : "本地代理已发送文本进行识别"),
    };
  } catch (error) {
    if (error.name === "TypeError" || String(error.message).includes("fetch")) {
      throw new Error(
        config.provider === "ollama"
          ? "无法连接到本地 Ollama，请确认已启动并拉取了视觉模型"
          : "网络连接失败，请检查网络后重试"
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function maskSensitiveText(text) {
  return text
    .replace(/(\b1[3-9]\d)\d{4}(\d{4}\b)/g, "$1****$2")
    .replace(/([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***$3")
    .replace(/(\b\d{6})\d{8}(\d{4}\b)/g, "$1********$2")
    .replace(/(\b\d{6})\d{6,9}(\d{4}\b)/g, "$1******$2");
}

function inferReporter(text) {
  const atMatch = text.match(/@([\u4e00-\u9fa5A-Za-z0-9_-]{2,12})/);
  if (atMatch) return atMatch[1];
  const feedbackMatch = text.match(/([\u4e00-\u9fa5A-Za-z]{2,12})(反馈|说|提到)/);
  return feedbackMatch ? feedbackMatch[1] : "待补充";
}

function inferMenu(text) {
  const menuMatch = text.match(/([\u4e00-\u9fa5A-Za-z]+)\s*[-/]\s*([\u4e00-\u9fa5A-Za-z]+)/);
  return menuMatch ? menuMatch[0] : "待补充";
}

// ── Ticket creation ─────────────────────────────────────────────────
async function createTicketFromInput(text, recognitionResult) {
  const uuid = crypto.randomUUID();
  const now = nowString();
  const recognition = recognitionResult?.data || localRecognition(text);
  const source = recognitionResult?.source || "local";
  const note = recognitionResult?.note || "本地草稿";
  const localId = `LOC-${uuid}`;

  const attachmentNames = draftAttachments.map(
    (item) => item.name || `粘贴截图_${draftAttachments.indexOf(item) + 1}.png`
  );

  const ticket = {
    localId,
    reporter: recognition.reporter,
    summary: recognition.summary,
    description: recognition.description,
    context: recognition.context,
    menuPath: recognition.menuPath,
    reportTime: recognition.reportTime || now,
    createdAt: now,
    updatedAt: now,
    status: "待处理",
    externalId: "",
    handler: "",
    remark: "",
    priority: recognition.priority,
    aiSource: source,
    attachments: attachmentNames,
    logs: [`${now.slice(11)} 创建工单，来源 ${source}，${note}`],
  };

  try {
    // Save ticket to SQLite
    await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ticket),
    });

    // Save actual image files to disk
    if (draftAttachments.length > 0) {
      const files = await Promise.all(
        draftAttachments.map(async (item) => ({
          name: item.name || `screenshot_${draftAttachments.indexOf(item) + 1}.png`,
          dataUrl: await fileToDataUrl(item.file),
        }))
      );
      await fetch("/api/save-attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localId, files }),
      });
    }
  } catch (err) {
    console.error("保存到服务器失败:", err);
    // Even if server save fails, add to local cache for the session
    tickets.unshift(ticket);
  }

  activeStatus = "全部";
  inputEl.value = "";
  clearDraftAttachments();

  // Always sync from server to get the canonical state
  await syncTickets();
  activeTicketId = localId;
  highlightTicketId = localId;
  clearPendingEdits();
  setDrawerOpen(true, false);
  renderAll();
  listEl
    .querySelector(`.ticket-card[data-id="${localId}"]`)
    ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  window.setTimeout(() => {
    highlightTicketId = null;
    renderList();
  }, 2600);
}

// ── 详情抽屉与快捷键 ────────────────────────────────────────────────
function setDrawerOpen(open, persist = true) {
  document.body.classList.toggle("drawer-closed", !open);
  if (persist) localStorage.setItem("ticketDeskDrawer", open ? "open" : "closed");
}

function moveSelection(step) {
  const list = getFilteredTickets();
  if (!list.length) return;
  const index = list.findIndex((ticket) => ticket.localId === activeTicketId);
  const nextIndex = Math.min(list.length - 1, Math.max(0, (index === -1 ? 0 : index) + step));
  if (nextIndex === index) return;
  activeTicketId = list[nextIndex].localId;
  setDrawerOpen(true, false);
  clearPendingEdits();
  renderList();
  renderDetail();
  listEl
    .querySelector(`.ticket-card[data-id="${activeTicketId}"]`)
    ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key;
  const target = event.target;
  const typing =
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable);

  if (meta && (key === "k" || key === "K")) {
    event.preventDefault();
    inputEl.focus();
    return;
  }

  if (key === "Escape") {
    if (settingsDialog.open || exportDialog.open) return;
    if (pendingEdits.size) {
      clearPendingEdits();
      renderDetail();
      showToast("已放弃未保存的修改");
    } else if (!document.body.classList.contains("drawer-closed")) {
      setDrawerOpen(false);
    }
    return;
  }

  if (typing || meta || event.altKey) return;
  if (key === "j" || key === "J") {
    event.preventDefault();
    moveSelection(1);
  } else if (key === "k" || key === "K") {
    event.preventDefault();
    moveSelection(-1);
  }
});

// ── Event handlers ──────────────────────────────────────────────────
navEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-status]");
  if (!button) return;
  activeStatus = button.dataset.status;
  renderAll();
});

listEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-id]");
  if (!button) return;
  activeTicketId = button.dataset.id;
  setDrawerOpen(true, false);
  clearPendingEdits();
  renderList();
  renderDetail();
});

detailEl.addEventListener("click", async (event) => {
  if (event.target.closest("#drawerToggle")) {
    setDrawerOpen(false);
    return;
  }

  if (event.target.closest("#saveButton")) {
    await applyPendingEdits();
    return;
  }

  if (event.target.closest("#discardButton")) {
    clearPendingEdits();
    renderDetail();
    showToast("已放弃未保存的修改");
    return;
  }

  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    await navigator.clipboard?.writeText(copyButton.dataset.copy).catch(() => undefined);
    showToast("已复制本地工单号");
    return;
  }

  const statusButton = event.target.closest("[data-next-status]");
  if (statusButton) {
    const ticket = tickets.find((item) => item.localId === activeTicketId);
    if (!ticket || ticket.status === statusButton.dataset.nextStatus) return;
    const oldStatus = ticket.status;
    const now = nowString();

    // Update locally
    ticket.status = statusButton.dataset.nextStatus;
    ticket.updatedAt = now;
    ticket.logs.unshift(`${now.slice(11)} 状态从 ${oldStatus} 变更为 ${ticket.status}`);

    // Save to server
    try {
      await fetch(`/api/tickets/${ticket.localId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ticket),
      });
    } catch (err) {
      console.error("状态更新失败:", err);
    }

    await syncTickets();
    showToast("状态已更新");
  }
});

// 字段修改先记在本地，点「保存修改」才落库，避免失焦误存
function markFieldEdit(event) {
  const control = event.target.closest("[data-ticket-field]");
  if (!control) return;

  const ticket = tickets.find((item) => item.localId === activeTicketId);
  if (!ticket) return;

  const fieldName = control.dataset.ticketField;
  const value = control.value;
  const original = String(ticket[fieldName] ?? "");

  if (value.trim() === original.trim()) {
    pendingEdits.delete(fieldName);
  } else {
    pendingEdits.set(fieldName, value);
  }
  control.closest(".field")?.classList.toggle("is-dirty", pendingEdits.has(fieldName));
  syncSaveBar();
}

function syncSaveBar() {
  const bar = document.querySelector("#saveBar");
  if (!bar) return;
  bar.hidden = pendingEdits.size === 0;
  const countEl = document.querySelector("#saveCount");
  if (countEl) countEl.textContent = `已修改 ${pendingEdits.size} 项`;
}

function clearPendingEdits() {
  pendingEdits.clear();
  syncSaveBar();
}

async function applyPendingEdits() {
  const ticket = tickets.find((item) => item.localId === activeTicketId);
  if (!ticket || pendingEdits.size === 0) return;

  const now = nowString();
  const changes = [];
  for (const [fieldName, rawValue] of pendingEdits) {
    const newValue = String(rawValue).trim();
    const oldValue = ticket[fieldName] || "";
    if (oldValue === newValue) continue;
    ticket[fieldName] = newValue;
    changes.push(`字段 ${fieldName} 从"${oldValue || "空"}"改为"${newValue || "空"}"`);
  }
  pendingEdits.clear();

  if (!changes.length) {
    renderDetail();
    return;
  }

  ticket.updatedAt = now;
  ticket.logs.unshift(...changes.map((item) => `${now.slice(11)} ${item}`));

  try {
    await fetch(`/api/tickets/${ticket.localId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ticket),
    });
  } catch (err) {
    console.error("字段更新失败:", err);
  }

  await syncTickets();
  showToast(`已保存 ${changes.length} 项修改`);
}

detailEl.addEventListener("input", markFieldEdit);
detailEl.addEventListener("change", markFieldEdit);

searchEl.addEventListener("input", renderAll);
sortEl.addEventListener("change", renderAll);

// 识别进度：显示实时秒数，让等待过程可感知
let parseTicker = null;
function startParseProgress(label) {
  const startedAt = Date.now();
  const tick = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    parseStatusEl.textContent = `${label}（已用 ${seconds} 秒）`;
  };
  window.clearInterval(parseTicker);
  tick();
  parseTicker = window.setInterval(tick, 1000);
}
function stopParseProgress() {
  window.clearInterval(parseTicker);
  parseTicker = null;
}

composerEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text && draftAttachments.length === 0) {
    showToast("请输入反馈文本或添加截图");
    return;
  }
  const config = getAiConfig();
  lastOcrText = "";
  lastOcrMs = 0;
  sendButtonEl.disabled = true;
  sendButtonEl.textContent = "识别中...";
  draftButtonEl.hidden = true;
  composerEl.classList.add("loading");
  startParseProgress(config.mode === "ollama" ? "正在本地识别" : "正在联网识别");

  try {
    const recognition = await recognizeWithCloud(text);
    await createTicketFromInput(text, recognition);
    stopParseProgress();
    parseStatusEl.textContent = recognition.ocrText
      ? `创建成功。macOS 系统 OCR 提取 ${recognition.ocrText.length} 字（${recognition.ocrMs}ms），已保存到数据库`
      : "创建成功，已生成本地工单号并持久化到 SQLite";
    showToast("工单已创建并保存到数据库");
  } catch (error) {
    stopParseProgress();
    const message =
      error.name === "AbortError"
        ? "识别超时，当前内容与截图已保留，可重试或直接创建草稿"
        : `${error.message}，当前内容与截图已保留，可重试或直接创建草稿`;
    parseStatusEl.textContent = message;
    showToast("识别失败，输入内容已保留");
    draftButtonEl.hidden = false;
  } finally {
    stopParseProgress();
    composerEl.classList.remove("loading");
    sendButtonEl.disabled = false;
    sendButtonEl.textContent = "创建工单";
  }
});

draftButtonEl.addEventListener("click", async () => {
  const text = inputEl.value.trim();
  if (!text && draftAttachments.length === 0) {
    showToast("请输入反馈文本或添加截图");
    return;
  }
  draftButtonEl.hidden = true;
  parseStatusEl.textContent = "正在生成本地草稿...";
  if (!lastOcrText && draftAttachments.length) {
    parseStatusEl.textContent = "正在用 macOS 系统 OCR 提取截图文字...";
    lastOcrText = await extractOcrText();
  }
  await createTicketFromInput(text, {
    data: draftRecognition(text),
    source: "local",
    note: lastOcrText ? "用户跳过识别，使用系统 OCR 文字生成本地草稿" : "用户跳过识别，生成本地草稿",
  });
  parseStatusEl.textContent = "已生成本地草稿并保存";
  showToast("已创建本地草稿");
});

composerEl.addEventListener("paste", handleImagePaste);
inputEl.addEventListener("paste", handleImagePaste);

composerEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  composerEl.classList.add("drag-over");
});

composerEl.addEventListener("dragleave", (event) => {
  if (!composerEl.contains(event.relatedTarget)) {
    composerEl.classList.remove("drag-over");
  }
});

composerEl.addEventListener("drop", (event) => {
  event.preventDefault();
  composerEl.classList.remove("drag-over");
  addAttachments(event.dataTransfer?.files || [], "拖拽截图");
});

inputEl.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    composerEl.requestSubmit();
  }
});

document.querySelector("#attachButton").addEventListener("click", () => {
  fileInputEl.click();
});

fileInputEl.addEventListener("change", () => {
  addAttachments(fileInputEl.files || [], "本地截图");
  fileInputEl.value = "";
});

serviceToggleButtonEl.addEventListener("click", () => {
  if (location.protocol === "file:") {
    copyStartCommand();
    return;
  }
  shutdownLocalService();
});

async function copyStartCommand() {
  await navigator.clipboard?.writeText(START_COMMAND).catch(() => undefined);
  showToast("已复制启动命令，到终端粘贴运行");
  parseStatusEl.textContent = `启动命令：${START_COMMAND}`;
}

async function shutdownLocalService() {
  try {
    serviceToggleButtonEl.disabled = true;
    const response = await fetch("/api/shutdown", { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    serviceStatusEl.textContent = "本地服务正在关闭";
    serviceToggleButtonEl.textContent = "复制启动命令";
    showToast("本地服务已关闭");
  } catch (error) {
    showToast(error.message || "关闭服务失败");
  } finally {
    serviceToggleButtonEl.disabled = false;
  }
}

attachmentRowEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-attachment]");
  if (!button) return;
  removeAttachment(button.dataset.removeAttachment);
});

document.querySelector("#settingsButton").addEventListener("click", () => {
  saveAiConfig();
  settingsDialog.showModal();
});

document.querySelector("#exportButton").addEventListener("click", () => {
  const count = getFilteredTickets().length;
  exportCountEl.textContent = `${count} 条工单`;
  exportDialog.showModal();
});

document.querySelector("#downloadCsvButton").addEventListener("click", () => {
  downloadCsv();
  exportDialog.close();
});

document.querySelector("#downloadExcelButton").addEventListener("click", () => {
  downloadExcel();
  exportDialog.close();
});

settingsDialog.addEventListener("input", saveAiConfig);
settingsDialog.addEventListener("change", saveAiConfig);
providerInputEl.addEventListener("change", () => {
  applyProviderPreset();
  syncSettingsVisibility();
  saveAiConfig();
});
recognitionModeEl.addEventListener("change", () => {
  applyRecognitionPreset();
  syncSettingsVisibility();
  saveAiConfig();
  if (recognitionModeEl.value === "cloud") {
    showToast("已切换到联网识别，请确认数据合规要求");
  } else {
    warmupLocalModel();
  }
});

// ── Theme ───────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  if (themeToggleEl) {
    const label = theme === "dark" ? "切换到日间模式" : "切换到夜间模式";
    themeToggleEl.setAttribute("aria-label", label);
    themeToggleEl.setAttribute("title", label);
  }
}

function initTheme() {
  let theme = localStorage.getItem("ticketDeskTheme");
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  applyTheme(theme);
  themeToggleEl?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("ticketDeskTheme", next);
    applyTheme(next);
  });
}

// ── Startup ─────────────────────────────────────────────────────────
initTheme();
if (localStorage.getItem("ticketDeskDrawer") === "closed") {
  setDrawerOpen(false, false);
}
loadAiConfig();
syncSettingsVisibility();
if (!localStorage.getItem("ticketDeskAiConfig")) {
  applyProviderPreset();
}
// 本地模式启动时静默预热模型
if (getAiConfig().mode === "ollama") {
  warmupLocalModel(false);
}
loadTickets().then(() => {
  // Set initial selection to first ticket
  if (tickets.length > 0 && !activeTicketId) {
    activeTicketId = tickets[0].localId;
  }
  renderAll();
});
