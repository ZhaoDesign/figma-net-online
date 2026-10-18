const HELPER_BASE = "http://127.0.0.1:47821";
const RELEASES_URL = "https://github.com/ZhaoDesign/figma-net-online/releases";
const DEMO_MODE = new URLSearchParams(window.location.search).has("demo");
const TARGET_HOSTS = ["s3-alpha-sig.figma.com", "www.figma.com", "static.figma.com"];

const state = {
  mode: "fast",
  running: false,
  helperOnline: false,
  bestHosts: [],
  results: [],
  hosts: [],
  helper: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[character]));
}

function nowTime() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}

function addActivity(message, tone = "ok") {
  const feed = $("#activityFeed");
  if (feed.querySelector(".muted")) feed.innerHTML = "";
  const item = document.createElement("div");
  item.className = `activity-item ${tone}`;
  item.innerHTML = `<span class="activity-time">${nowTime()}</span><span>${escapeHtml(message)}</span>`;
  feed.prepend(item);
  while (feed.children.length > 8) feed.lastElementChild.remove();
}

let toastTimer;
function showToast(message, tone = "ok") {
  const toast = $("#toast");
  $("#toastText").textContent = message;
  toast.querySelector(".toast-icon").textContent = tone === "error" ? "!" : "✓";
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function setBusy(busy) {
  state.running = busy;
  $("#startButton").disabled = busy;
  $("#applyButton").disabled = busy || !state.bestHosts.length || !state.helperOnline;
  $("#resetButton").disabled = busy || !state.helperOnline;
  $("#helperDot").classList.toggle("is-busy", busy);
  if (busy) {
    $("#startButton span").textContent = "测速中…";
    $("#actionHint").textContent = "本地助手正在测试真实连接，请稍候";
    $("#signalStatus").textContent = "正在扫描线路";
  } else {
    $("#startButton span").textContent = "开始测速";
    $("#actionHint").textContent = state.helperOnline ? "准备测试本地 DNS 与常用线路" : "连接本地助手后开始真实测速";
    $("#helperDot").classList.remove("is-busy");
  }
}

function setHelperState(online, detail = {}) {
  state.helperOnline = online;
  state.helper = detail;
  const dot = $("#helperDot");
  dot.classList.toggle("is-online", online);
  dot.classList.remove("is-busy");
  $("#helperLabel").textContent = online ? `本地助手已连接 · ${detail.platformLabel || "Ready"}` : "检测本地助手";
  $("#actionHint").textContent = online ? "准备测试本地 DNS 与常用线路" : "连接本地助手后开始真实测速";
  $("#hostsPath").textContent = detail.hostsPath || $("#hostsPath").textContent;
  $("#resetButton").disabled = !online || state.running;
  $("#applyButton").disabled = !online || state.running || !state.bestHosts.length;
}

async function fetchHelper(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || 8000);
  try {
    const response = await fetch(`${HELPER_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `本地助手返回 ${response.status}`);
    return data;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function checkHelper({ announce = false } = {}) {
  try {
    const data = await fetchHelper("/api/status", { timeout: 1400 });
    setHelperState(true, data);
    await loadHosts();
    if (announce) showToast("本地助手已连接，可以开始测速");
    return true;
  } catch (error) {
    setHelperState(false);
    if (announce) showToast("还没有检测到本地助手", "error");
    return false;
  }
}

function openHelperModal() { $("#helperModal").hidden = false; document.body.style.overflow = "hidden"; }
function closeHelperModal() { $("#helperModal").hidden = true; document.body.style.overflow = ""; }

function renderHosts(data = {}) {
  const entries = data.figmaEntries || data.hosts || [];
  state.hosts = entries;
  $("#hostsPath").textContent = data.hostsPath || state.helper?.hostsPath || "/etc/hosts";
  const status = $("#hostsStatus");
  const list = $("#hostsList");
  if (!entries.length) {
    status.innerHTML = `<span class="hosts-status-icon">—</span><div><b>${state.helperOnline ? "未检测到 Figma 配置" : "尚未读取本机 Hosts"}</b><small>${state.helperOnline ? "当前没有应用线路覆盖" : "连接本地助手后自动检测"}</small></div>`;
    list.innerHTML = "";
    return;
  }
  status.innerHTML = `<span class="hosts-status-icon is-good">✓</span><div><b>已检测到 ${entries.length} 条 Figma 配置</b><small>当前线路正在作用于本机</small></div>`;
  list.innerHTML = entries.map((entry) => `<div class="host-entry"><span>${escapeHtml(entry.hostname)}</span><b>${escapeHtml(entry.ip)}</b></div>`).join("");
}

async function loadHosts() {
  if (!state.helperOnline) return;
  try {
    const data = await fetchHelper("/api/hosts", { timeout: 3000 });
    renderHosts(data);
    addActivity(data.figmaEntries?.length ? "已读取本机 Figma Hosts 配置" : "本机没有 Figma Hosts 配置", "ok");
  } catch (error) {
    renderHosts({});
    addActivity(`读取 Hosts 失败：${error.message}`, "error");
  }
}

function latencyTone(time) {
  if (!Number.isFinite(time)) return "dim";
  if (time < 120) return "good";
  if (time < 240) return "warn";
  return "dim";
}

function renderResults(results, meta = {}) {
  state.results = results || [];
  const body = $("#resultsBody");
  if (!state.results.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5"><div class="empty-state"><span class="empty-ring"></span><b>没有找到可用线路</b><small>请检查网络环境后重试</small></div></td></tr>`;
    $("#resultSummary").textContent = "未找到可用线路";
    $("#signalValue").textContent = "—";
    $("#signalLatency").textContent = "—";
    $("#signalRoute").textContent = "未选择";
    $("#signalStatus").textContent = "未找到线路";
    return;
  }
  body.innerHTML = state.results.map((item) => {
    const time = Number.isFinite(item.time) ? Math.round(item.time) : null;
    const tone = latencyTone(item.time);
    const label = tone === "good" ? "推荐" : tone === "warn" ? "可用" : "不可用";
    return `<tr><td>${escapeHtml(item.hostname)}</td><td><code>${escapeHtml(item.ip || "—")}</code></td><td>${escapeHtml(item.ipInfo || "未知地区")}</td><td>${time ? `<strong>${time} ms</strong>` : "—"}</td><td><span class="status-chip ${tone}">${label}</span></td></tr>`;
  }).join("");
  const best = state.results.filter((item) => Number.isFinite(item.time)).sort((a, b) => a.time - b.time)[0];
  if (best) {
    $("#signalValue").textContent = Math.round(best.time);
    $("#signalLatency").textContent = `${Math.round(best.time)} ms`;
    $("#signalRoute").textContent = best.ipInfo || "已选择";
    $("#signalStatus").textContent = "线路已就绪";
  } else {
    $("#signalValue").textContent = "—";
    $("#signalLatency").textContent = "—";
    $("#signalRoute").textContent = "未选择";
    $("#signalStatus").textContent = "未找到线路";
  }
  const duration = Number(meta.durationMs) || 0;
  const durationLabel = duration > 0 && duration < 1000 ? "<1" : duration ? Math.round(duration / 1000) : "—";
  $("#resultSummary").textContent = `${durationLabel} 秒 · ${state.results.length} 个域名完成`;
  $("#lastRun").textContent = `刚刚 ${nowTime()}`;
}

function renderDemo() {
  const demoResults = [
    { hostname: "s3-alpha-sig.figma.com", ip: "13.107.246.40", ipInfo: "中国/上海", time: 74 },
    { hostname: "www.figma.com", ip: "13.107.246.40", ipInfo: "中国/上海", time: 92 },
    { hostname: "static.figma.com", ip: "13.107.246.40", ipInfo: "中国/上海", time: 81 },
  ];
  state.bestHosts = demoResults.map(({ hostname, ip }) => ({ hostname, ip }));
  renderResults(demoResults, { durationMs: 15800 });
  $("#applyButton").disabled = true;
  $("#signalStatus").textContent = "预览结果";
  addActivity("演示模式：已加载一组本地示例结果", "ok");
}

async function runScan() {
  if (!state.helperOnline) { openHelperModal(); return; }
  setBusy(true);
  addActivity(`${state.mode === "fast" ? "快速" : "全面"}模式已启动`, "busy");
  try {
    const data = await fetchHelper(`/api/scan?mode=${encodeURIComponent(state.mode)}`, { timeout: state.mode === "full" ? 180000 : 120000 });
    state.bestHosts = data.bestHosts || [];
    renderResults(data.results || [], data);
    addActivity(`测速完成，找到 ${state.bestHosts.length} 条推荐线路`, "ok");
    $("#applyButton").disabled = !state.bestHosts.length;
    await loadHosts();
    showToast("测速完成，已生成最佳线路");
  } catch (error) {
    $("#signalStatus").textContent = "诊断失败";
    addActivity(`测速失败：${error.message}`, "error");
    showToast(error.message, "error");
  } finally { setBusy(false); }
}

async function applyHosts() {
  if (!state.helperOnline || !state.bestHosts.length) return;
  setBusy(true); addActivity("正在请求系统权限并应用最佳线路…", "busy");
  try {
    const data = await fetchHelper("/api/hosts/apply", { method: "POST", body: JSON.stringify({ hosts: state.bestHosts }), headers: { "Content-Type": "application/json" }, timeout: 30000 });
    renderHosts(data); addActivity("最佳线路已应用到本机 Hosts", "ok"); showToast("最佳线路已应用");
  } catch (error) { addActivity(`应用失败：${error.message}`, "error"); showToast(error.message, "error"); }
  finally { setBusy(false); }
}

async function resetHosts() {
  if (!state.helperOnline) return;
  setBusy(true); addActivity("正在清除 Figma Hosts 配置…", "busy");
  try { const data = await fetchHelper("/api/hosts/reset", { method: "POST", body: JSON.stringify({ hosts: TARGET_HOSTS }), headers: { "Content-Type": "application/json" }, timeout: 30000 }); renderHosts(data); addActivity("Figma Hosts 配置已重置", "ok"); showToast("已恢复系统默认解析"); }
  catch (error) { addActivity(`重置失败：${error.message}`, "error"); showToast(error.message, "error"); }
  finally { setBusy(false); }
}

function selectMode(button) {
  state.mode = button.dataset.mode;
  $$(".mode-option").forEach((option) => { const active = option === button; option.classList.toggle("is-active", active); option.setAttribute("aria-selected", active ? "true" : "false"); });
  $("#actionHint").textContent = state.mode === "fast" ? "准备测试本地 DNS 与常用线路" : "准备测试完整 DNS 服务商列表";
}

function bindEvents() {
  $$(".mode-option").forEach((button) => button.addEventListener("click", () => selectMode(button)));
  $("#startButton").addEventListener("click", runScan);
  $("#applyButton").addEventListener("click", applyHosts);
  $("#resetButton").addEventListener("click", resetHosts);
  $("#refreshHosts").addEventListener("click", () => state.helperOnline ? loadHosts() : openHelperModal());
  $("#helperButton").addEventListener("click", () => state.helperOnline ? checkHelper({ announce: true }) : openHelperModal());
  $("#closeModal").addEventListener("click", closeHelperModal);
  $("#helperModal").addEventListener("click", (event) => { if (event.target === $("#helperModal")) closeHelperModal(); });
  $("#retryHelper").addEventListener("click", async () => { const online = await checkHelper({ announce: true }); if (online) closeHelperModal(); });
  $("#macDownload").addEventListener("click", () => window.open(RELEASES_URL, "_blank", "noopener,noreferrer"));
  $("#winDownload").addEventListener("click", () => window.open(RELEASES_URL, "_blank", "noopener,noreferrer"));
  $("#learnButton").addEventListener("click", () => showToast("网页只读取 Figma 相关条目，不会上传完整 Hosts 文件"));
  $("#themeButton").addEventListener("click", () => { document.body.classList.toggle("light"); localStorage.setItem("fno-theme", document.body.classList.contains("light") ? "light" : "dark"); });
}

async function init() {
  if (localStorage.getItem("fno-theme") === "light") document.body.classList.add("light");
  bindEvents();
  setHelperState(false);
  if (DEMO_MODE) { renderDemo(); return; }
  await checkHelper();
}

init();
