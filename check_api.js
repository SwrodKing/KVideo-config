const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置 ===
const CONFIG_PATH = path.join(__dirname, "KVideo-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const MAX_DAYS = 30;
const WARN_STREAK = 3;
const ENABLE_SEARCH_TEST = true;
const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 10; 
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 500;

// === 加载配置 (适配数组格式) ===
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ 配置文件不存在:", CONFIG_PATH);
  process.exit(1);
}
const configArray = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// 映射新字段: api -> baseUrl, detail -> id
const apiEntries = configArray.map((s) => ({
  name: s.name,
  api: s.baseUrl,
  detail: s.id || "-", 
  disabled: s.enabled === false,
}));

// === 读取历史记录 ===
let history = [];
if (fs.existsSync(REPORT_PATH)) {
  const old = fs.readFileSync(REPORT_PATH, "utf-8");
  const match = old.match(/```json\n([\s\S]+?)\n```/);
  if (match) {
    try { history = JSON.parse(match[1]); } catch (e) {}
  }
}

const nowCST = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16) + " CST";

// === 工具函数 ===
const delay = ms => new Promise(r => setTimeout(r, ms));

const safeGet = async (url) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await axios.get(url, { timeout: TIMEOUT_MS });
      return res.status === 200;
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
      else return false;
    }
  }
};

const testSearch = async (api, keyword) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const url = `${api}?wd=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: TIMEOUT_MS });
      if (res.status !== 200 || !res.data || typeof res.data !== "object") return "❌";
      const list = res.data.list || [];
      if (!list.length) return "无结果";
      return JSON.stringify(list).includes(keyword) ? "✅" : "不匹配";
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
      else return "❌";
    }
  }
};

const queueRun = (tasks, limit) => {
  let index = 0, active = 0;
  const results = [];
  return new Promise(resolve => {
    const next = () => {
      while (active < limit && index < tasks.length) {
        const i = index++; active++;
        tasks[i]().then(res => results[i] = res).finally(() => { active--; next(); });
      }
      if (index >= tasks.length && active === 0) resolve(results);
    };
    next();
  });
};

// === 主逻辑 ===
(async () => {
  console.log("⏳ 正在按照原版格式进行健康检测...");

  const tasks = apiEntries.map(({ name, api, disabled }) => async () => {
    if (disabled) return { name, api, success: false, searchStatus: "禁用" };
    const ok = await safeGet(api);
    const searchStatus = ENABLE_SEARCH_TEST ? await testSearch(api, SEARCH_KEYWORD) : "-";
    return { name, api, success: ok, searchStatus };
  });

  const todayResults = await queueRun(tasks, CONCURRENT_LIMIT);
  history.push({ date: new Date().toISOString().slice(0, 10), results: todayResults });
  if (history.length > MAX_DAYS) history = history.slice(-MAX_DAYS);

  // === 统计和生成报告 (保持原样) ===
  const stats = {};
  for (const { name, api, detail, disabled } of apiEntries) {
    stats[api] = { name, api, detail, disabled, ok: 0, fail: 0, streak: 0, trend: "", searchStatus: "-", status: "❌" };

    history.forEach(day => {
      const rec = day.results.find(x => x.api === api);
      if (rec) rec.success ? stats[api].ok++ : stats[api].fail++;
    });

    for (let i = history.length - 1; i >= 0; i--) {
      const rec = history[i].results.find(x => x.api === api);
      if (!rec || rec.success) break;
      stats[api].streak++;
    }

    const total = stats[api].ok + stats[api].fail;
    stats[api].successRate = total > 0 ? ((stats[api].ok / total) * 100).toFixed(1) + "%" : "-";
    stats[api].trend = history.slice(-7).map(day => {
      const r = day.results.find(x => x.api === api);
      return r ? (r.success ? "✅" : "❌") : "-";
    }).join("");

    const latest = todayResults.find(x => x.api === api);
    if (latest) stats[api].searchStatus = latest.searchStatus;

    if (disabled) stats[api].status = "🚫";
    else if (stats[api].streak >= WARN_STREAK) stats[api].status = "🚨";
    else if (latest?.success) stats[api].status = "✅";
  }

  // === 计算聚合统计信息 ===
  const totalCount = apiEntries.length;
  const successCount = Object.values(stats).filter(s => s.status === "✅").length;
  const failCount = totalCount - successCount - Object.values(stats).filter(s => s.status === "🚫").length;
  const avgRate = totalCount > 0 ? (Object.values(stats).reduce((acc, s) => acc + parseFloat(s.successRate || 0), 0) / totalCount).toFixed(1) : 0;

  const perfect = Object.values(stats).filter(s => parseFloat(s.successRate) === 100).length;
  const high = Object.values(stats).filter(s => parseFloat(s.successRate) >= 80 && parseFloat(s.successRate) < 100).length;
  const medium = Object.values(stats).filter(s => parseFloat(s.successRate) >= 50 && parseFloat(s.successRate) < 80).length;
  const low = Object.values(stats).filter(s => parseFloat(s.successRate) < 50).length;

// === 生成 Markdown 报告 ===
  let md = `# API 健康报告（每日自动检测API状态）\n\n`;
  md += `## API 状态（最近更新：${nowCST}）\n\n`;
  md += `- 总 API 数量：${totalCount}\n`;
  md += `- 成功 API 数量：${successCount}\n`;
  md += `- 失败 API 数量：${failCount}\n`;
  md += `- 平均可用率：${avgRate}%\n`;
  md += `- 完美可用率（100%）：${perfect} 个\n`;
  md += `- 高可用率（80%-99%）：${high} 个\n`;
  md += `- 中等可用率（50%-79%）：${medium} 个\n`;
  md += `- 低可用率（<50%）：${low} 个\n\n`;

  md += `**检测关键词:** ${SEARCH_KEYWORD}\n\n`;
  md += "| 状态 | 资源名称 | ID/备注 | API接口 | 搜索功能 | 成功 | 失败 | 成功率 | 最近7天趋势 |\n";
  md += "|------|---------|---------|---------|---------|-----:|-----:|-------:|--------------|\n";

  const sorted = Object.values(stats).sort((a, b) => {
    const order = { "🚨": 1, "❌": 2, "✅": 3, "🚫": 4 };
    return order[a.status] - order[b.status];
  });

  sorted.forEach(s => {
    md += `| ${s.status} | ${s.name} | ${s.detail} | [Link](${s.api}) | ${s.searchStatus} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} |\n`;
  });

  const reportFileContent = md + `\n<details>\n<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n` + "```json\n" + JSON.stringify(history, null, 2) + "\n```\n" + `</details>\n`;

  fs.writeFileSync(REPORT_PATH, reportFileContent, "utf-8");

  console.log("📄 报告与首页已成功更新！");
})();
