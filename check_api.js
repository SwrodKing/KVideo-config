const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置区 ===
const CONFIG_PATH = path.join(__dirname, "KVideo-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const README_PATH = path.join(__dirname, "README.md");

const MAX_DAYS = 30;
const WARN_STREAK = 3; 
const ENABLE_SEARCH_TEST = true;
const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 10; 
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 500;

// === 1. 加载配置 ===
if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ 配置文件不存在:", CONFIG_PATH);
    process.exit(1);
}
const configArray = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const apiEntries = configArray.map((s) => ({
    name: s.name,
    api: s.baseUrl,
    id: s.id || "-", // 对应原版中的地址/备注列
    disabled: s.enabled === false,
}));

// === 2. 读取历史记录 ===
let history = [];
if (fs.existsSync(REPORT_PATH)) {
    const old = fs.readFileSync(REPORT_PATH, "utf-8");
    const match = old.match(/```json\n([\s\S]+?)\n```/);
    if (match) { try { history = JSON.parse(match[1]); } catch (e) {} }
}

const nowCST = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16) + " CST";

// === 3. 工具函数 ===
const delay = ms => new Promise(r => setTimeout(r, ms));

const safeGet = async (url) => {
    for (let i = 1; i <= MAX_RETRY; i++) {
        try {
            const res = await axios.get(url, { timeout: TIMEOUT_MS });
            return res.status === 200;
        } catch (e) { if (i < MAX_RETRY) await delay(RETRY_DELAY_MS); }
    }
    return false;
};

const testSearch = async (api, keyword) => {
    for (let i = 1; i <= MAX_RETRY; i++) {
        try {
            const url = `${api}?wd=${encodeURIComponent(keyword)}`;
            const res = await axios.get(url, { timeout: TIMEOUT_MS });
            if (res.status !== 200 || !res.data || !res.data.list) return "❌";
            return res.data.list.length ? "✅" : "无结果";
        } catch (e) { if (i < MAX_RETRY) await delay(RETRY_DELAY_MS); }
    }
    return "❌";
};

const queueRun = async (tasks, limit) => {
    const results = [];
    const executing = new Set();
    for (const [i, task] of tasks.entries()) {
        const p = task().then(res => results[i] = res);
        executing.add(p);
        p.finally(() => executing.delete(p));
        if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
    return results;
};

// === 4. 主逻辑 ===
(async () => {
    console.log(`⏳ 正在按照原版格式检测 ${apiEntries.length} 个接口...`);

    const todayResults = await queueRun(apiEntries.map(s => async () => {
        if (s.disabled) return { api: s.api, success: false, searchStatus: "禁用" };
        const ok = await safeGet(s.api);
        const searchStatus = (ok && ENABLE_SEARCH_TEST) ? await testSearch(s.api, SEARCH_KEYWORD) : "-";
        return { api: s.api, success: ok, searchStatus };
    }), CONCURRENT_LIMIT);

    history.push({ date: new Date().toISOString().slice(0, 10), results: todayResults });
    if (history.length > MAX_DAYS) history.shift();

    // === 统计分析 ===
    const statsList = apiEntries.map(s => {
        let ok = 0, fail = 0, streak = 0;
        
        // 统计历史成功/失败
        history.forEach(day => {
            const r = day.results.find(x => x.api === s.api);
            if (r) { r.success ? ok++ : fail++; }
        });

        // 计算当前连跪
        for (let i = history.length - 1; i >= 0; i--) {
            const r = history[i].results.find(x => x.api === s.api);
            if (r && r.success) break;
            streak++;
        }

        // 7天趋势
        const trend = history.slice(-7).map(day => {
            const r = day.results.find(x => x.api === s.api);
            return r ? (r.success ? "✅" : "❌") : "-";
        }).join("");

        const latest = todayResults.find(r => r.api === s.api);
        const total = ok + fail;
        const successRate = total > 0 ? ((ok / total) * 100).toFixed(1) + "%" : "-";

        let status = "✅";
        if (s.disabled) status = "🚫";
        else if (streak >= WARN_STREAK) status = "🚨";
        else if (!latest?.success) status = "❌";

        return { 
            ...s, status, ok, fail, successRate, trend, 
            searchStatus: latest?.searchStatus || "❌" 
        };
    }).sort((a, b) => {
        const order = { "🚨": 1, "❌": 2, "✅": 3, "🚫": 4 };
        return order[a.status] - order[b.status];
    });

    // === 5. 生成原版 Markdown 格式 ===
    let md = `# 源接口健康检测报告\n\n最近更新时间：${nowCST}\n\n`;
    md += `**总源数:** ${apiEntries.length} | **检测关键词:** ${SEARCH_KEYWORD}\n\n`;
    md += "| 状态 | 资源名称 | ID/备注 | API接口 | 搜索功能 | 成功 | 失败 | 成功率 | 最近7天趋势 |\n";
    md += "|------|---------|---------|---------|---------|-----:|-----:|-------:|--------------|\n";

    statsList.forEach(s => {
        md += `| ${s.status} | ${s.name} | ${s.id} | [Link](${s.api}) | ${s.searchStatus} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} |\n`;
    });

    md += `\n<details>\n<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n`;
    md += "```json\n" + JSON.stringify(history, null, 2) + "\n```\n";
    md += `</details>\n`;

    // 写入文件
    fs.writeFileSync(REPORT_PATH, md);

    // 同步到 README.md
    if (fs.existsSync(README_PATH)) {
        let readme = fs.readFileSync(README_PATH, "utf-8");
        const startTag = "";
        const endTag = "";
        const regex = new RegExp(`${startTag}[\\s\\S]*${endTag}`);
        
        // 首页仅显示表格部分，不显示历史 JSON 详情
        const tableOnly = md.split("<details>")[0];
        const newReadme = readme.replace(regex, `${startTag}\n\n${tableOnly}\n${endTag}`);
        fs.writeFileSync(README_PATH, newReadme);
    }

  console.log("📄 报告已生成:", REPORT_PATH);
})();
