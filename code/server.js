const http = require("node:http");
const fs = require("node:fs/promises");
const fss = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Database = require("better-sqlite3");

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "tickets.db");
const ATTACHMENTS_DIR = path.join(ROOT, "attachments");
const OCR_DIR = path.join(ROOT, "tools");
const OCR_BIN = path.join(OCR_DIR, "ocr");
const OCR_SRC = path.join(OCR_DIR, "ocr.swift");

// ── Database ────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_id TEXT UNIQUE NOT NULL,
    reporter TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    description TEXT DEFAULT '',
    context TEXT DEFAULT '',
    menu_path TEXT DEFAULT '',
    report_time TEXT DEFAULT '',
    status TEXT DEFAULT '待处理',
    external_id TEXT DEFAULT '',
    handler TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    priority TEXT DEFAULT '中',
    ai_source TEXT DEFAULT 'local',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ticket_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_local_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    FOREIGN KEY (ticket_local_id) REFERENCES tickets(local_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ticket_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_local_id TEXT NOT NULL,
    log_entry TEXT NOT NULL,
    FOREIGN KEY (ticket_local_id) REFERENCES tickets(local_id) ON DELETE CASCADE
  );
`);

// ── Seed data ───────────────────────────────────────────────────────
const SEED_DATA = [
  {
    localId: "LOC-7f3a2b1c-9d4e-4a8b-b6c2-1e5d8f9a0c3e",
    reporter: "张三",
    summary: "无法修改密码，提示账号异常",
    description: "用户在设置 - 账号 - 修改密码页面输入旧密码和新密码后，页面提示账号异常，无法继续保存。",
    context: "用户近期更换过手机号，反馈发生在内部测试环境。",
    menuPath: "设置 - 账号 - 修改密码",
    reportTime: "2026-05-29 09:16",
    createdAt: "2026-05-29 09:24",
    status: "待处理",
    externalId: "JIRA-1842",
    handler: "李雷",
    remark: "已确认后端返回 403，需要排查账号安全策略。",
    priority: "高",
    aiSource: "local",
    attachments: ["聊天截图_密码异常.png"],
    logs: [
      "09:24 创建工单，来源 local",
      "09:26 填写外部工单号 JIRA-1842",
    ],
  },
  {
    localId: "LOC-a22ce813-c810-4d35-9a83-2c14d78f6221",
    reporter: "Mia",
    summary: "导出报表缺少外部工单号列",
    description: "运营导出本周问题报表时发现第一列不是本地工单号，且外部工单号缺失，无法和 Jira 数据对齐。",
    context: "月报整理场景，筛选条件为已处理和待验证。",
    menuPath: "工单列表 - 导出数据",
    reportTime: "2026-05-29 08:42",
    createdAt: "2026-05-29 09:02",
    status: "已处理",
    externalId: "TAPD-7781",
    handler: "王宁",
    remark: "已调整导出字段顺序，等待核对。",
    priority: "中",
    aiSource: "mixed",
    attachments: ["导出字段截图.webp"],
    logs: [
      "09:02 创建工单，来源 mixed",
      "09:35 状态从 待处理 变更为 已处理",
    ],
  },
  {
    localId: "LOC-b91a77dd-461f-4774-913b-4e917af85266",
    reporter: "陈晨",
    summary: "图片粘贴后缩略图无法删除",
    description: "粘贴多张聊天截图后，第二张缩略图右上角的删除按钮无响应。",
    context: "Mac 端，使用触控板点击删除按钮。",
    menuPath: "新建输入框 - 图片缩略图",
    reportTime: "2026-05-28 17:21",
    createdAt: "2026-05-28 17:40",
    status: "待验证",
    externalId: "ZD-2450",
    handler: "赵一",
    remark: "前端事件冒泡已修复，需要回归多图场景。",
    priority: "高",
    aiSource: "local",
    attachments: ["多图粘贴.png", "删除按钮.png"],
    logs: [
      "17:40 创建工单，来源 local",
      "18:12 状态从 待处理 变更为 已处理",
      "18:13 状态从 已处理 变更为 待验证",
    ],
  },
  {
    localId: "LOC-d3c19eed-2e9d-4b01-aaa5-bd7327f24291",
    reporter: "Neo",
    summary: "云端兜底开关提示不够明确",
    description: "用户首次打开联网 LLM 兜底时，没有明确意识到文本和图片会发送到外部服务。",
    context: "安全评审提出的交互改进项。",
    menuPath: "设置 - AI 识别",
    reportTime: "2026-05-28 14:05",
    createdAt: "2026-05-28 14:12",
    status: "待反馈",
    externalId: "JIRA-1836",
    handler: "沈洁",
    remark: "已增加合规确认弹窗，准备反馈评审结论。",
    priority: "紧急",
    aiSource: "cloud",
    attachments: [],
    logs: [
      "14:12 创建工单，来源 cloud",
      "15:20 状态从 待验证 变更为 待反馈",
    ],
  },
];

function seedIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) AS cnt FROM tickets").get();
  if (count.cnt > 0) return;

  const insertTicket = db.prepare(`
    INSERT INTO tickets
      (local_id, reporter, summary, description, context, menu_path,
       report_time, status, external_id, handler, remark,
       priority, ai_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAtt = db.prepare(
    "INSERT INTO ticket_attachments (ticket_local_id, file_name) VALUES (?, ?)"
  );
  const insertLog = db.prepare(
    "INSERT INTO ticket_logs (ticket_local_id, log_entry) VALUES (?, ?)"
  );

  const tx = db.transaction(() => {
    for (const t of SEED_DATA) {
      insertTicket.run(
        t.localId, t.reporter, t.summary, t.description, t.context,
        t.menuPath, t.reportTime, t.status, t.externalId, t.handler,
        t.remark, t.priority, t.aiSource, t.createdAt, t.createdAt
      );
      for (const a of t.attachments) insertAtt.run(t.localId, a);
      for (const l of t.logs) insertLog.run(t.localId, l);
    }
  });
  tx();
  console.log("已写入种子数据（4 条示例工单）");
}
seedIfEmpty();

// ── Prepared statements ─────────────────────────────────────────────
const allTicketsStmt = db.prepare("SELECT * FROM tickets ORDER BY created_at DESC");
const getTicketStmt = db.prepare("SELECT * FROM tickets WHERE local_id = ?");
const getAttsStmt = db.prepare("SELECT file_name FROM ticket_attachments WHERE ticket_local_id = ?");
const getLogsStmt = db.prepare("SELECT log_entry FROM ticket_logs WHERE ticket_local_id = ?");

const insertTicketStmt = db.prepare(`
  INSERT INTO tickets
    (local_id, reporter, summary, description, context, menu_path,
     report_time, status, external_id, handler, remark,
     priority, ai_source, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertAttStmt = db.prepare(
  "INSERT INTO ticket_attachments (ticket_local_id, file_name) VALUES (?, ?)"
);
const insertLogStmt = db.prepare(
  "INSERT INTO ticket_logs (ticket_local_id, log_entry) VALUES (?, ?)"
);

const deleteAttsStmt = db.prepare("DELETE FROM ticket_attachments WHERE ticket_local_id = ?");
const deleteLogsStmt = db.prepare("DELETE FROM ticket_logs WHERE ticket_local_id = ?");

const updateTicketStmt = db.prepare(`
  UPDATE tickets SET
    reporter = ?, summary = ?, description = ?, context = ?, menu_path = ?,
    report_time = ?, status = ?, external_id = ?, handler = ?, remark = ?,
    priority = ?, ai_source = ?, updated_at = ?
  WHERE local_id = ?
`);

// ── Helpers ─────────────────────────────────────────────────────────
function rowToTicket(row) {
  const localId = row.local_id;
  return {
    localId,
    reporter: row.reporter,
    summary: row.summary,
    description: row.description,
    context: row.context,
    menuPath: row.menu_path,
    reportTime: row.report_time,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    externalId: row.external_id,
    handler: row.handler,
    remark: row.remark,
    priority: row.priority,
    aiSource: row.ai_source,
    attachments: getAttsStmt.all(localId).map((r) => r.file_name),
    logs: getLogsStmt.all(localId).map((r) => r.log_entry),
  };
}

function loadAllTickets() {
  return allTicketsStmt.all().map(rowToTicket);
}

function loadTicket(localId) {
  const row = getTicketStmt.get(localId);
  return row ? rowToTicket(row) : null;
}

function nowString() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── MIME / static ───────────────────────────────────────────────────
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("请求 JSON 无法解析"));
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const target = path.normalize(path.join(ROOT, pathname));
  if (!target.startsWith(ROOT)) {
    send(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(target);
    send(res, 200, data, mimeTypes[path.extname(target)] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found");
  }
}

// ── AI Recognition (unchanged logic) ────────────────────────────────
function chatCompletionsUrl(baseUrl) {
  const clean = String(baseUrl || "").replace(/\/+$/, "");
  if (clean.endsWith("/chat/completions")) return clean;
  return `${clean}/chat/completions`;
}

function isDeepSeek(config) {
  return (
    config.provider === "deepseek" ||
    String(config.baseUrl || "").includes("api.deepseek.com") ||
    String(config.model || "").startsWith("deepseek-v4")
  );
}

// 智谱视觉模型（GLM-4V 系列，含免费版 glm-4v-flash / glm-4.6v-flash 等）
function isZhipuVisionModel(config) {
  const model = String(config.model || "");
  return /^glm-4v/i.test(model) || /glm-4\.\d+v/i.test(model);
}

// 本地 Ollama（走原生 /api/chat，可精细控制推理参数）
function isOllama(config) {
  return config.provider === "ollama" || String(config.baseUrl || "").includes("11434");
}

function ollamaChatUrl(baseUrl) {
  const clean = String(baseUrl || "")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  return `${clean}/api/chat`;
}

function stripDataUrlPrefix(url) {
  return String(url || "").replace(/^data:[^,]+,/, "");
}

const RECOGNITION_SYSTEM_PROMPT =
  "你是工单结构化识别助手。你需要读中文聊天记录，提取可维护的工单字段。必须只输出 JSON 对象。";

// ── macOS 系统 OCR（Vision 框架）────────────────────────────────────
let ocrCompilePromise = null;

async function compileOcrBinary() {
  // 命令行工具链里可能装有多个 SDK，取第一个能编译通过的
  const sdkCandidates = [
    "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk",
    "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk",
  ];
  let lastError = "未知错误";
  for (const sdk of sdkCandidates) {
    try {
      await execFileAsync(
        "/usr/bin/swiftc",
        ["-O", "-sdk", sdk, "-module-cache-path", path.join(os.tmpdir(), "ticketdesk-swift-cache"), OCR_SRC, "-o", OCR_BIN],
        { timeout: 180000 }
      );
      return OCR_BIN;
    } catch (error) {
      lastError = error.message;
    }
  }
  throw new Error(`OCR 工具编译失败：${lastError}`);
}

async function ensureOcrBinary() {
  try {
    await fs.access(OCR_BIN);
    return OCR_BIN;
  } catch {
    // 首次使用时自动编译一次
  }
  if (!ocrCompilePromise) {
    ocrCompilePromise = compileOcrBinary().catch((error) => {
      ocrCompilePromise = null;
      throw error;
    });
  }
  return ocrCompilePromise;
}

// 把前端传来的 data URL 图片写入临时文件，调用系统 OCR 提取文字
async function runSystemOcr(dataUrls) {
  const binary = await ensureOcrBinary();
  const tempFiles = [];
  try {
    for (let i = 0; i < dataUrls.length; i++) {
      const match = String(dataUrls[i] || "").match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
      if (!match) continue;
      const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase().replace(/[^a-z]/g, "");
      const file = path.join(os.tmpdir(), `ticketdesk-ocr-${process.pid}-${Date.now()}-${i}.${ext}`);
      await fs.writeFile(file, Buffer.from(match[2], "base64"));
      tempFiles.push(file);
    }
    if (!tempFiles.length) return { text: "", ms: 0 };

    const { stdout } = await execFileAsync(binary, tempFiles, {
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout);
    return { text: String(payload.text || ""), ms: Number(payload.ms || 0) };
  } finally {
    for (const file of tempFiles) {
      fs.unlink(file).catch(() => {});
    }
  }
}

function parseJsonFromModel(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("模型未返回 JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizePriority(value) {
  return ["低", "中", "高", "紧急"].includes(value) ? value : "中";
}

function normalizeRecognition(result, currentTime) {
  return {
    reporter: result.reporter || "",
    summary: String(result.summary || "待补充问题概括").slice(0, 40),
    description: result.description || "待补充",
    context: result.context || "待补充",
    menuPath: result.menuPath || result.menu_path || "待补充",
    reportTime: result.reportTime || result.report_time || currentTime,
    priority: normalizePriority(result.priority || "中"),
    confidence: Number(result.confidence || 0.8),
    rawNotes: result.notes || "",
  };
}

async function recognize(req, res) {
  try {
    const { config = {}, text = "", images = [], currentTime = "" } = await readJson(req);
    if (!config.baseUrl || !config.model) {
      send(res, 400, "请先在设置里填写 Base URL 和模型名称");
      return;
    }
    if (config.provider !== "ollama" && !config.apiKey) {
      send(res, 400, "请先在设置里填写 API Key");
      return;
    }

    let ocrTexts = [];
    let isGlmOcrProcess = false;
    let targetModel = config.model;
    let targetBaseUrl = config.baseUrl;

    if (config.model === "glm-ocr") {
      isGlmOcrProcess = true;
      targetModel = "glm-4-flash";
      if (images.length > 0) {
        for (let i = 0; i < Math.min(images.length, 4); i++) {
          try {
            const ocrResponse = await fetch("https://open.bigmodel.cn/api/paas/v4/layout_parsing", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.apiKey}`,
              },
              body: JSON.stringify({ model: "glm-ocr", file: images[i] }),
            });
            if (ocrResponse.ok) {
              const payload = await ocrResponse.json();
              if (payload.text) ocrTexts.push(payload.text);
            }
          } catch (err) {
            console.error(`GLM-OCR error for image ${i}:`, err);
          }
        }
      }
    }

    let mergedText = text;
    if (ocrTexts.length > 0) {
      mergedText = `${text}\n\n[截图OCR识别内容]:\n${ocrTexts.join("\n\n")}`;
    }

    // macOS 系统 OCR：毫秒级提取截图文字。开启后不再把图片交给模型，
    // 只把提取出的文字送去做字段结构化，速度提升明显。
    const ocrMode = config.ocrMode || "auto";
    const deepSeek = isDeepSeek(config);
    const wantsSystemOcr =
      images.length > 0 && (ocrMode === "on" || (ocrMode === "auto" && isOllama(config)));
    let systemOcrText = "";
    let systemOcrMs = 0;
    if (wantsSystemOcr) {
      try {
        const ocr = await runSystemOcr(images.slice(0, 4));
        systemOcrText = ocr.text;
        systemOcrMs = ocr.ms;
      } catch (error) {
        console.error("系统 OCR 失败，回退为模型直接识图：", error.message);
      }
    }
    if (systemOcrText) {
      mergedText = `${text}\n\n[截图文字识别（macOS 系统 OCR）]:\n${systemOcrText}`;
    }

    // 已经拿到截图文字就不再传图，走纯文本链路（更快）
    const hasOcrText = Boolean(systemOcrText.trim());
    const useImages = images.length > 0 && !hasOcrText;
    const zhipuVision = isZhipuVisionModel(config);
    const useTextOnlyPrompt = deepSeek || isGlmOcrProcess || !useImages;

    const prompt = `请从下面的中文聊天记录文字${useTextOnlyPrompt ? "" : "和截图"}中识别工单信息。只返回 JSON，不要解释。
${hasOcrText ? `\n注意："[截图文字识别（macOS 系统 OCR）]"这一段是从用户截图里提取出来的聊天原文，请把它当作聊天正文来提取字段。反馈人通常在首行、@ 后面或署名位置。\n` : ""}

字段：
- reporter: 反馈人姓名或昵称，无法判断则空字符串
- summary: 30 字以内的问题概括
- description: 详细问题描述，合并截图/聊天里的关键诉求
- context: 问题背景或前置条件
- menuPath: 涉及的系统、页面、菜单或操作路径
- reportTime: 反馈时间，无法判断则使用 ${currentTime}
- priority: 低/中/高/紧急
- confidence: 0 到 1 的识别置信度
- notes: 简短识别依据

输入文字：
${mergedText || "无额外文字，仅截图"}

注意：如果只有截图且没有可读文字，请在 JSON 中如实将无法判断的字段留空或写"待补充"。`;

    const content = useTextOnlyPrompt
      ? prompt
      : [
          { type: "text", text: prompt },
          ...images.slice(0, 4).map((url) => ({ type: "image_url", image_url: { url } })),
        ];

    let message = "";

    if (isOllama(config)) {
      // 本地 Ollama：走原生 /api/chat，关闭思考、限制上下文与输出长度、保活模型常驻。
      // 实测比 OpenAI 兼容接口快约 3 倍，也避免思考模型把结果只写进 thinking 字段。
      const base64Images = useImages
        ? images.slice(0, 4).map(stripDataUrlPrefix).filter(Boolean)
        : [];
      const upstream = await fetch(ollamaChatUrl(targetBaseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: targetModel,
          messages: [
            { role: "system", content: RECOGNITION_SYSTEM_PROMPT },
            { role: "user", content: prompt, ...(base64Images.length ? { images: base64Images } : {}) },
          ],
          think: false,
          format: "json",
          keep_alive: config.keepAlive || "30m",
          options: {
            num_ctx: Number(config.numCtx || 8192),
            num_predict: Number(config.numPredict || 500),
            temperature: 0.1,
          },
          stream: false,
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => "");
        send(res, upstream.status, errText || `Ollama 返回 ${upstream.status}`);
        return;
      }

      const payload = await upstream.json();
      const msg = payload.message || {};
      message = String(msg.content || "").trim() || String(msg.thinking || "").trim();
    } else {
      const requestBody = {
        model: targetModel,
        messages: [
          { role: "system", content: RECOGNITION_SYSTEM_PROMPT },
          { role: "user", content },
        ],
      };

      if (deepSeek) {
        requestBody.thinking = { type: config.thinking === "enabled" ? "enabled" : "disabled" };
      }
      // GLM-4V 视觉模型文档未标注 JSON 结构化输出支持，跳过 response_format，
      // 依赖严格系统提示 + 宽松 JSON 提取，避免接口直接报错。
      if (!zhipuVision) {
        requestBody.response_format = { type: "json_object" };
      }
      if (!deepSeek) {
        requestBody.temperature = 0.1;
      }

      const upstream = await fetch(chatCompletionsUrl(targetBaseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => "");
        send(res, upstream.status, errText || `上游接口返回 ${upstream.status}`);
        return;
      }

      const payload = await upstream.json();
      const choice = payload.choices?.[0]?.message || {};
      message = String(choice.content || "").trim() || String(choice.reasoning_content || "").trim();
    }

    if (!message) {
      send(res, 502, "上游模型没有返回内容");
      return;
    }

    send(
      res,
      200,
      JSON.stringify({
        data: normalizeRecognition(parseJsonFromModel(message), currentTime),
        ocrText: systemOcrText,
        ocrMs: systemOcrMs,
        note: isGlmOcrProcess
          ? `智谱 GLM-OCR 已成功解析并提取 ${ocrTexts.length} 张截图中的文字，并使用 glm-4-flash 进行了工单字段结构化。`
          : hasOcrText
            ? `macOS 系统 OCR 已提取截图文字（${systemOcrMs}ms），由${
                config.provider === "ollama" ? `本地模型 ${config.model}` : "云端模型"
              }完成字段结构化`
          : config.provider === "ollama"
            ? `Ollama 本地模型已识别${images.length ? "图片与" : ""}文本`
          : zhipuVision
            ? `智谱 ${config.model} 已直接识别${images.length ? "图片与" : ""}文本`
          : deepSeek
            ? images.length
              ? "DeepSeek V4 官方文本接口已识别文字；截图未直接发送给模型"
              : "DeepSeek V4 已识别文本"
            : images.length
              ? `本地代理已发送 ${Math.min(images.length, 4)} 张截图进行识别`
              : "本地代理已发送文本进行识别",
      }),
      "application/json; charset=utf-8"
    );
  } catch (error) {
    send(res, 500, error.message || "联网识别失败");
  }
}

// 预热本地模型：提前把模型加载进内存并保活，避免首次识别等 30 秒以上
async function handleWarmup(req, res) {
  try {
    const { config = {} } = await readJson(req);
    if (!isOllama(config) || !config.baseUrl || !config.model) {
      send(res, 400, "仅本地 Ollama 支持预热");
      return;
    }
    const upstream = await fetch(ollamaChatUrl(config.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "ping" }],
        keep_alive: config.keepAlive || "30m",
        options: { num_predict: 1, num_ctx: 2048 },
        stream: false,
      }),
    });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      send(res, upstream.status, errText || "预热失败");
      return;
    }
    await upstream.json();
    send(res, 200, JSON.stringify({ ok: true, model: config.model }), "application/json; charset=utf-8");
  } catch (error) {
    send(res, 500, error.message || "预热失败");
  }
}

// ── Ticket CRUD ────────────────────────────────────────────────────
// 独立的系统 OCR 接口：只提取截图文字，不依赖任何模型
async function handleSystemOcr(req, res) {
  try {
    const { images = [] } = await readJson(req);
    if (!Array.isArray(images) || !images.length) {
      send(res, 400, "缺少图片数据");
      return;
    }
    const startedAt = Date.now();
    const result = await runSystemOcr(images.slice(0, 4));
    send(
      res,
      200,
      JSON.stringify({
        ok: true,
        text: result.text,
        ms: result.ms,
        totalMs: Date.now() - startedAt,
      }),
      "application/json; charset=utf-8"
    );
  } catch (error) {
    send(res, 500, error.message || "系统 OCR 失败");
  }
}

async function handleCreateTicket(req, res) {
  try {
    const body = await readJson(req);
    const localId = body.localId || `LOC-${crypto.randomUUID()}`;
    const now = body.createdAt || body.updatedAt || nowString();

    const tx = db.transaction(() => {
      insertTicketStmt.run(
        localId,
        body.reporter || "",
        body.summary || "",
        body.description || "",
        body.context || "",
        body.menuPath || "",
        body.reportTime || now,
        body.status || "待处理",
        body.externalId || "",
        body.handler || "",
        body.remark || "",
        body.priority || "中",
        body.aiSource || "local",
        now,
        now
      );

      if (Array.isArray(body.attachments)) {
        for (const name of body.attachments) {
          insertAttStmt.run(localId, String(name));
        }
      }

      if (Array.isArray(body.logs)) {
        for (const entry of body.logs) {
          insertLogStmt.run(localId, String(entry));
        }
      }
    });
    tx();

    const ticket = loadTicket(localId);
    send(res, 201, JSON.stringify(ticket), "application/json; charset=utf-8");
  } catch (error) {
    send(res, 500, error.message || "保存工单失败");
  }
}

async function handleUpdateTicket(req, res, localId) {
  try {
    const existing = loadTicket(localId);
    if (!existing) {
      send(res, 404, "工单不存在");
      return;
    }

    const body = await readJson(req);
    const now = body.updatedAt || nowString();

    const tx = db.transaction(() => {
      updateTicketStmt.run(
        body.reporter ?? existing.reporter,
        body.summary ?? existing.summary,
        body.description ?? existing.description,
        body.context ?? existing.context,
        body.menuPath ?? existing.menuPath,
        body.reportTime ?? existing.reportTime,
        body.status ?? existing.status,
        body.externalId ?? existing.externalId,
        body.handler ?? existing.handler,
        body.remark ?? existing.remark,
        body.priority ?? existing.priority,
        body.aiSource ?? existing.aiSource,
        now,
        localId
      );

      // Replace attachments if provided
      if (Array.isArray(body.attachments)) {
        deleteAttsStmt.run(localId);
        for (const name of body.attachments) {
          insertAttStmt.run(localId, String(name));
        }
      }

      // Append logs if provided (keep existing, add new)
      if (Array.isArray(body.logs)) {
        // frontend sends full logs array; server replaces entirely
        deleteLogsStmt.run(localId);
        for (const entry of body.logs) {
          insertLogStmt.run(localId, String(entry));
        }
      }
    });
    tx();

    const updated = loadTicket(localId);
    send(res, 200, JSON.stringify(updated), "application/json; charset=utf-8");
  } catch (error) {
    send(res, 500, error.message || "更新工单失败");
  }
}

async function handleListTickets(req, res) {
  try {
    const tickets = loadAllTickets();
    send(res, 200, JSON.stringify(tickets), "application/json; charset=utf-8");
  } catch (error) {
    send(res, 500, error.message || "读取工单列表失败");
  }
}

// ── Attachment file storage ────────────────────────────────────────
async function handleSaveAttachments(req, res) {
  try {
    const body = await readJson(req);
    const { localId, files } = body; // files: [{ name, dataUrl }]
    if (!localId || !Array.isArray(files)) {
      send(res, 400, "缺少 localId 或 files");
      return;
    }

    const dir = path.join(ATTACHMENTS_DIR, localId);
    await fs.mkdir(dir, { recursive: true });

    const saved = [];
    for (const f of files) {
      const match = f.dataUrl.match(/^data:image\/(png|jpeg|webp|gif);base64,(.+)$/);
      if (!match) continue;
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const buf = Buffer.from(match[2], "base64");
      const safeName = f.name || `screenshot_${saved.length + 1}.${ext}`;
      const filePath = path.join(dir, safeName);
      await fs.writeFile(filePath, buf);
      saved.push(safeName);
    }

    send(res, 200, JSON.stringify({ saved }), "application/json; charset=utf-8");
  } catch (error) {
    send(res, 500, error.message || "保存附件失败");
  }
}

// ── Router ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // API routes
  if (req.method === "GET" && pathname === "/api/status") {
    send(res, 200, JSON.stringify({ ok: true, port: PORT, startedAt: new Date().toISOString() }), "application/json; charset=utf-8");
    return;
  }
  if (req.method === "POST" && pathname === "/api/shutdown") {
    send(res, 200, "本地服务已关闭");
    setTimeout(() => server.close(() => process.exit(0)), 120);
    return;
  }
  if (req.method === "POST" && pathname === "/api/recognize") {
    recognize(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/warmup") {
    handleWarmup(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/ocr") {
    handleSystemOcr(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/save-attachments") {
    handleSaveAttachments(req, res);
    return;
  }

  // Ticket CRUD
  if (req.method === "GET" && pathname === "/api/tickets") {
    handleListTickets(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/tickets") {
    handleCreateTicket(req, res);
    return;
  }

  // PATCH /api/tickets/:localId
  const patchMatch = pathname.match(/^\/api\/tickets\/(LOC-[a-f0-9-]+)$/);
  if (req.method === "PATCH" && patchMatch) {
    handleUpdateTicket(req, res, patchMatch[1]);
    return;
  }

  // GET /api/tickets/:localId
  const getMatch = pathname.match(/^\/api\/tickets\/(LOC-[a-f0-9-]+)$/);
  if (req.method === "GET" && getMatch) {
    const ticket = loadTicket(getMatch[1]);
    if (ticket) {
      send(res, 200, JSON.stringify(ticket), "application/json; charset=utf-8");
    } else {
      send(res, 404, "工单不存在");
    }
    return;
  }

  // Serve attachment files
  if (req.method === "GET" && pathname.startsWith("/attachments/")) {
    const filePath = path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ATTACHMENTS_DIR)) {
      send(res, 403, "Forbidden");
      return;
    }
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
      }[ext] || "application/octet-stream";
      send(res, 200, data, mime);
    } catch {
      send(res, 404, "Not found");
    }
    return;
  }

  // Static files
  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  send(res, 405, "Method not allowed");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`工单记录已启动：http://127.0.0.1:${PORT}`);
});
