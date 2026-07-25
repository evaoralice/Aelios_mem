#!/usr/bin/env node
// 诊断 Aelios → CF Gateway → ZenMux 链路
// 用法: node scripts/diagnose-upstream.mjs
// 需要环境变量: AI_GATEWAY_BASE_URL, CF_AIG_TOKEN (可选)

const BASE_URL = process.env.AI_GATEWAY_BASE_URL;
const CF_AIG_TOKEN = process.env.CF_AIG_TOKEN;

if (!BASE_URL) {
  console.error("❌ 缺少 AI_GATEWAY_BASE_URL 环境变量");
  process.exit(1);
}

console.log("=== 链路诊断 ===\n");
console.log("AI_GATEWAY_BASE_URL:", BASE_URL);
console.log("CF_AIG_TOKEN:", CF_AIG_TOKEN ? `${CF_AIG_TOKEN.slice(0, 8)}...` : "(未配)");
console.log("");

// Aelios 拼的 URL
const aeliosUrl = `${BASE_URL.replace(/\/+$/, "")}/compat/chat/completions`;
console.log("1️⃣  Aelios 会请求的 URL:", aeliosUrl);

// CF Gateway 标准 OpenAI 路径
const cfOpenaiUrl = `${BASE_URL.replace(/\/+$/, "").replace(/\/compat$/i, "")}/openai/chat/completions`;
console.log("2️⃣  CF Gateway 标准 OpenAI URL:", cfOpenaiUrl);
console.log("");

async function testUrl(label, url, headers) {
  console.log(`--- ${label} ---`);
  console.log("URL:", url);
  console.log("Headers:", JSON.stringify(headers));

  const body = JSON.stringify({
    model: "deepseek/deepseek-v4-pro",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
    stream: false,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    console.log("Status:", res.status, res.statusText);

    const text = await res.text();
    if (res.ok) {
      // 截取前 200 字符
      console.log("Response:", text.slice(0, 200));
      console.log("✅ 成功\n");
      return true;
    } else {
      console.log("Error:", text.slice(0, 500));
      console.log("❌ 失败\n");
      return false;
    }
  } catch (err) {
    console.log("Fetch error:", err.message);
    console.log("❌ 网络错误\n");
    return false;
  }
}

// 测试 1: Aelios 实际拼的 URL (带 /compat/)
// 测试 2: CF Gateway 标准 OpenAI 路径
// 测试 3: CF Gateway 路径 + cf-aig-authorization
// 测试 4: 直接连 ZenMux (不走 Gateway)

const headersBasic = {};
if (CF_AIG_TOKEN) {
  headersBasic["cf-aig-authorization"] = `Bearer ${CF_AIG_TOKEN}`;
}

console.log("=== 开始测试 ===\n");

// 测试 1: Aelios 实际拼的 URL
await testUrl("测试1: Aelios 拼的 URL (/compat/)", aeliosUrl, headersBasic);

// 测试 2: CF Gateway 标准 OpenAI 路径
await testUrl("测试2: CF Gateway 标准 OpenAI 路径 (/openai/)", cfOpenaiUrl, headersBasic);

// 测试 3: Aelios URL 但用 Authorization Bearer (而不是 cf-aig-authorization)
const headersBearer = {};
if (CF_AIG_TOKEN) {
  headersBearer["authorization"] = `Bearer ${CF_AIG_TOKEN}`;
}
await testUrl("测试3: Aelios URL + Authorization Bearer", aeliosUrl, headersBearer);

// 测试 4: 直接连 ZenMux (如果有 ZENMUX_API_KEY)
const ZENMUX_KEY = process.env.ZENMUX_API_KEY;
if (ZENMUX_KEY) {
  await testUrl(
    "测试4: 直接连 ZenMux",
    "https://zenmux.ai/api/v1/chat/completions",
    { "authorization": `Bearer ${ZENMUX_KEY}` }
  );
} else {
  console.log("--- 测试4: 跳过（需要 ZENMUX_API_KEY 环境变量）---\n");
}

console.log("=== 诊断完成 ===");
console.log("");
console.log("如果测试1失败但测试2成功 → Aelios 的 /compat/ 路径不对，需要改成 /openai/");
console.log("如果测试1/2都失败但测试4成功 → CF Gateway 的上游认证没配");
console.log("如果测试3成功 → 认证方式不对，应该用 Authorization 而不是 cf-aig-authorization");
console.log("如果全部失败 → 检查网络或 API key 是否有效");