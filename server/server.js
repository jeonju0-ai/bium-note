const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
require("dotenv").config();

function ensureEnvVar(key, generator) {
  const envPath = path.join(__dirname, ".env");
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const regex = new RegExp(`^${key}=`, "m");
  if (regex.test(envContent)) return process.env[key];
  const value = generator();
  envContent = envContent.trimEnd() + `\n${key}=${value}\n`;
  fs.writeFileSync(envPath, envContent, "utf8");
  process.env[key] = value;
  return value;
}

const BIUM_TOKEN  = ensureEnvVar("BIUM_TOKEN",  () => crypto.randomBytes(3).toString("hex"));
const BIUM_SECRET = ensureEnvVar("BIUM_SECRET", () => crypto.randomBytes(16).toString("hex"));

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function getVaultPath() {
  if (process.env.VAULT_PATH) return process.env.VAULT_PATH;
  const home = os.homedir();
  if (process.platform === "darwin") {
    const icloud = path.join(home, "Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Vault/0.Inbox");
    if (fs.existsSync(path.dirname(icloud))) return icloud;
  }
  return path.join(home, "Documents/Obsidian Vault/0.Inbox");
}

const VAULT = getVaultPath();
const PORT = process.env.PORT || 3458;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function askGemini(text, duration) {
  return new Promise((resolve) => {
    if (!GEMINI_API_KEY) { resolve(null); return; }

    const prompt = `당신은 따뜻하고 다정한 마음 친구입니다. 아래는 ${duration}분 명상을 마친 후 솔직하게 적은 마음일기예요.

이 사람의 감정과 상태를 진심으로 공감하고, 판단 없이 있는 그대로 받아들여 주세요. 분석하거나 조언하지 말고, 마치 가장 친한 친구가 따뜻하게 안아주듯이 응답해 주세요.

응답할 때:
- 먼저 감정을 그대로 인정하고 공감해 주세요 ("그랬구나", "그 마음 충분히 이해해" 등)
- 그 감정을 느끼는 것이 자연스럽고 괜찮다는 것을 전해 주세요
- 마지막으로 따뜻한 응원 한 마디로 마무리해 주세요

3~4문장, 친근하고 부드러운 한국어 말투로. 존댓말 쓰지 말고 편하게.

마음일기: "${text}"`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    });

    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const result = json?.candidates?.[0]?.content?.parts?.[0]?.text || null;
          resolve(result);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// 마음일기 저장
app.post("/save", async (req, res) => {
  const { text, duration } = req.body;
  if (!text?.trim()) return res.json({ ok: false, error: "내용 없음" });

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const filename = `비움_${stamp}.md`;
  const filepath = path.join(VAULT, filename);

  const gemini = await askGemini(text.trim(), duration || "?");

  const sections = [
    `# ${text.trim().slice(0, 60)}`,
    "",
    `> 🧘 ${duration || "?"}분 명상 후`,
    "",
    text.trim(),
    "",
    "---",
  ];

  if (gemini) {
    sections.push("", "💭 **Gemini 마음 확장:**", "", gemini, "", "---");
  }

  sections.push(`*${now.toLocaleString("ko-KR")}*`);

  const content = sections.join("\n");

  try {
    if (!fs.existsSync(VAULT)) fs.mkdirSync(VAULT, { recursive: true });
    fs.writeFileSync(filepath, content, "utf8");
    console.log(`[저장] ${filename}${gemini ? " + Gemini ✓" : ""}`);
    res.json({ ok: true, filename, gemini: gemini || null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 기록 조회
app.get("/history", (req, res) => {
  try {
    if (!fs.existsSync(VAULT)) return res.json({ ok: true, items: [] });
    const files = fs.readdirSync(VAULT)
      .filter(f => f.startsWith("비움_") && f.endsWith(".md"))
      .sort().reverse().slice(0, 30);

    const items = files.map(filename => {
      const raw = fs.readFileSync(path.join(VAULT, filename), "utf8");
      const lines = raw.split("\n");
      const title = lines[0].replace(/^# /, "");
      const durationMatch = raw.match(/🧘 (\S+)분 명상 후/);
      const duration = durationMatch ? durationMatch[1] : null;
      const body = lines.slice(4).join("\n").split("---")[0].trim();
      const geminiMatch = raw.match(/💭 \*\*Gemini 마음 확장:\*\*\n\n([\s\S]*?)\n\n---/);
      const gemini = geminiMatch ? geminiMatch[1].trim() : null;
      return { filename, title, duration, body, gemini };
    });

    res.json({ ok: true, items });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 삭제
app.delete("/delete", (req, res) => {
  const { filename } = req.body;
  if (!filename || !filename.startsWith("비움_") || !filename.endsWith(".md")) {
    return res.json({ ok: false, error: "잘못된 파일명" });
  }
  const filepath = path.join(VAULT, filename);
  if (!fs.existsSync(filepath)) return res.json({ ok: false, error: "파일 없음" });
  try {
    fs.unlinkSync(filepath);
    console.log(`[삭제] ${filename}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/ping", (req, res) => res.json({ ok: true, vault: VAULT, gemini: !!GEMINI_API_KEY }));

app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log(`  비움노트 서버 실행 중`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  저장 경로: ${VAULT}`);
  console.log(`  Gemini: ${GEMINI_API_KEY ? "✓ 활성" : "✗ 없음"}`);
  console.log("================================");
  console.log("");
  console.log("  [폰 앱 연결 방법]");
  console.log(`  토큰: ${BIUM_TOKEN}`);
  console.log("  → 폰 앱 설정에 위 토큰을 입력하세요");
  console.log("");
  console.log("  [외부 접속 등록 방법]");
  console.log("  1. cloudflared tunnel --url http://localhost:3458");
  console.log("  2. node register.js https://xxxx.trycloudflare.com");
  console.log("================================");
});
