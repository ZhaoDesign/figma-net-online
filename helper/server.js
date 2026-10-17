const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.FIGMA_NET_PORT || 47821);
const VERSION = "0.1.0";
const ALLOWED_ORIGINS = new Set([
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "https://figma-net-online.zhaojianbin2002.chatgpt.site",
]);

const TARGETS = [
  { hostname: "s3-alpha-sig.figma.com", testUrl: "https://s3-alpha.figma.com/profile/9b3f693e-0677-4743-89ff-822b9f6b72be" },
  { hostname: "www.figma.com", testUrl: "https://www.figma.com/api/statsig/bootstrap?" },
  { hostname: "static.figma.com", testUrl: "https://static.figma.com/app/icon/1/icon-192.png" },
];

const DNS_SERVERS = [
  { ip: null, name: "本地 DNS (系统默认)", fast: true },
  { ip: "223.5.5.5", name: "阿里 DNS", fast: true },
  { ip: "223.6.6.6", name: "阿里 DNS (备用)", fast: true },
  { ip: "119.29.29.29", name: "腾讯 DNS (DNSPod)", fast: true },
  { ip: "119.28.28.28", name: "腾讯 DNS (备用)" },
  { ip: "180.184.1.1", name: "字节跳动 DNS", fast: true },
  { ip: "180.184.2.2", name: "字节跳动 DNS (备用)" },
  { ip: "180.76.76.76", name: "百度 DNS" },
  { ip: "114.114.114.114", name: "114 DNS", fast: true },
  { ip: "1.2.4.8", name: "CNNIC SDNS" },
  { ip: "210.2.4.8", name: "CNNIC SDNS (备用)" },
  { ip: "101.226.4.6", name: "360 安全 DNS" },
  { ip: "101.6.6.6", name: "清华大学 TUNA DNS" },
  { ip: "8.8.8.8", name: "Google DNS" },
  { ip: "8.8.4.4", name: "Google DNS (备用)" },
  { ip: "1.1.1.1", name: "Cloudflare DNS" },
  { ip: "1.0.0.1", name: "Cloudflare DNS (备用)" },
  { ip: "9.9.9.9", name: "Quad9 DNS" },
  { ip: "4.2.2.1", name: "Level3 DNS" },
  { ip: "202.96.128.86", name: "上海电信" },
  { ip: "202.106.0.20", name: "北京电信" },
  { ip: "202.106.196.115", name: "北京联通" },
  { ip: "210.22.84.3", name: "上海联通" },
  { ip: "211.136.192.6", name: "中国移动" },
  { ip: "211.136.112.50", name: "上海移动" },
  { ip: "211.136.17.107", name: "北京移动" },
];

function hostsPath() {
  if (process.platform === "win32") return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts");
  return "/etc/hosts";
}

function json(response, status, payload, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function friendlyPlatform() {
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  return process.platform;
}

function parseEntries(content) {
  const entries = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) return;
    for (const hostname of parts.slice(1)) {
      if (hostname.startsWith("#")) break;
      if (hostname.toLowerCase().includes("figma")) entries.push({ ip: parts[0], hostname, line: index + 1 });
    }
  });
  return entries;
}

function readHosts() {
  const file = hostsPath();
  try {
    const content = fs.readFileSync(file, "utf8");
    return { hostsPath: file, figmaEntries: parseEntries(content), error: null };
  } catch (error) {
    return { hostsPath: file, figmaEntries: [], error: error.message };
  }
}

function withRemovedTargets(content) {
  const targetNames = new Set(TARGETS.map((item) => item.hostname));
  const lines = content.split(/\r?\n/);
  return lines.filter((line) => {
    if (line.includes("# Figma Net Online BEGIN") || line.includes("# Figma Net Online END")) return false;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    const parts = trimmed.split(/\s+/);
    return !parts.slice(1).some((name) => targetNames.has(name));
  }).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

function updateHosts(entries) {
  const file = hostsPath();
  const current = fs.readFileSync(file, "utf8");
  const cleaned = withRemovedTargets(current);
  const block = ["# Figma Net Online BEGIN", ...entries.map((entry) => `${entry.ip} ${entry.hostname}`), "# Figma Net Online END"].join("\n");
  fs.writeFileSync(file, `${cleaned}\n${block}\n`, "utf8");
  return readHosts();
}

function resetHosts() {
  const file = hostsPath();
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, withRemovedTargets(current), "utf8");
  return readHosts();
}

function resolveWithServer(hostname, server) {
  if (!server) {
    return dns.promises.lookup(hostname, { all: true }).then((items) => items.map((item) => item.address));
  }
  const resolver = new dns.promises.Resolver();
  resolver.setServers([server]);
  return resolver.resolve4(hostname);
}

async function resolveCandidates(hostname, dnsList) {
  const responses = await Promise.all(dnsList.map(async (server) => {
    try { return await resolveWithServer(hostname, server.ip); } catch { return []; }
  }));
  return [...new Set(responses.flat().filter((ip) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)))];
}

function requestByIp(urlString, ip, timeout = 5500) {
  return new Promise((resolve) => {
    const started = performance.now();
    const parsed = new URL(urlString);
    const request = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      servername: parsed.hostname,
      lookup(_hostname, _options, callback) { callback(null, ip, 4); },
      headers: { "User-Agent": "FigmaNetOnline/0.1", Accept: "*/*" },
      timeout,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(performance.now() - started));
    });
    request.once("error", () => resolve(Infinity));
    request.once("timeout", () => { request.destroy(); resolve(Infinity); });
    request.end();
  });
}

async function raceIps(urlString, ips, trials) {
  const uniqueIps = [...new Set(ips)];
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < uniqueIps.length) {
      const ip = uniqueIps[cursor++];
      const times = [];
      for (let i = 0; i < trials; i += 1) times.push(await requestByIp(urlString, ip));
      const finite = times.filter(Number.isFinite);
      results.push({ ip, time: finite.length ? finite.reduce((sum, item) => sum + item, 0) / finite.length : Infinity });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, uniqueIps.length) }, worker));
  const best = results.filter((item) => Number.isFinite(item.time)).sort((a, b) => a.time - b.time)[0];
  if (!best) return { ip: null, time: null, ipInfo: "无可用服务器" };
  best.ipInfo = await getIpInfo(best.ip);
  return best;
}

function getIpInfo(ip) {
  return new Promise((resolve) => {
    const request = https.get(`https://api.ip.sb/geoip/${encodeURIComponent(ip)}`, { timeout: 2200, headers: { "User-Agent": "FigmaNetOnline/0.1" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => { try { const data = JSON.parse(body); resolve([data.country, data.city].filter(Boolean).join("/") || "未知地区"); } catch { resolve("未知地区"); } });
    });
    request.once("error", () => resolve("未知地区"));
    request.once("timeout", () => { request.destroy(); resolve("未知地区"); });
  });
}

async function scan(mode) {
  const started = performance.now();
  const dnsList = DNS_SERVERS.filter((item) => mode !== "fast" || item.fast);
  const trials = mode === "fast" ? 2 : 3;
  const results = [];
  for (const target of TARGETS) {
    const ips = await resolveCandidates(target.hostname, dnsList);
    const best = await raceIps(target.testUrl, ips, trials);
    results.push({ hostname: target.hostname, ...best });
  }
  return {
    mode,
    dnsCount: dnsList.length,
    durationMs: performance.now() - started,
    results,
    bestHosts: results.filter((item) => item.ip).map(({ hostname, ip }) => ({ hostname, ip })),
  };
}

function body(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; if (data.length > 1_000_000) reject(new Error("请求内容过大")); });
    request.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("请求格式错误")); } });
    request.on("error", reject);
  });
}

function validHosts(items) {
  const allowed = new Set(TARGETS.map((item) => item.hostname));
  return Array.isArray(items) && items.length > 0 && items.every((item) => allowed.has(item.hostname) && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(item.ip));
}

async function route(request, response) {
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(response, 403, { message: "未允许的网页来源" }, origin);
  if (request.method === "OPTIONS") return json(response, 204, {}, origin);
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, { connected: true, version: VERSION, platform: process.platform, platformLabel: friendlyPlatform(), hostsPath: hostsPath() }, origin);
    if (request.method === "GET" && url.pathname === "/api/hosts") return json(response, 200, readHosts(), origin);
    if (request.method === "GET" && url.pathname === "/api/scan") return json(response, 200, await scan(url.searchParams.get("mode") === "full" ? "full" : "fast"), origin);
    if (request.method === "POST" && url.pathname === "/api/hosts/apply") {
      const payload = await body(request);
      if (!validHosts(payload.hosts)) return json(response, 400, { message: "线路数据无效" }, origin);
      return json(response, 200, updateHosts(payload.hosts), origin);
    }
    if (request.method === "POST" && url.pathname === "/api/hosts/reset") return json(response, 200, resetHosts(), origin);
    return json(response, 404, { message: "接口不存在" }, origin);
  } catch (error) {
    const message = error.code === "EACCES" || error.code === "EPERM" ? "没有权限修改 Hosts，请以管理员权限启动本地助手。" : error.message;
    return json(response, 500, { message }, origin);
  }
}

const server = http.createServer((request, response) => { route(request, response).catch((error) => json(response, 500, { message: error.message }, request.headers.origin)); });
server.listen(PORT, "127.0.0.1", () => console.log(`Figma Net Online helper ${VERSION} listening on http://127.0.0.1:${PORT}`));
