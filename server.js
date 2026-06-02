const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "novels.json");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, "[]", "utf8");
}

function readJsonDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeJsonDb(data) {
  const tmpFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpFile, DB_FILE);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5_000_000) {
        req.destroy();
        reject(new Error("요청 본문이 너무 큽니다."));
      }
    });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return [String(value)].filter(Boolean);
}

function normalizeNovel(input, existing = {}) {
  const now = new Date().toISOString();
  const genre = String(input.genre || "").trim();
  const world = String(input.world || "").trim();
  const settings = normalizeArray(input.settings);
  const characters = normalizeArray(input.characters);
  const code = String(input.code || `${genre}${world.charAt(0)}${settings[0] || ""}${characters[0] || ""}`).trim();

  if (!String(input.title || "").trim()) throw new Error("제목은 필수입니다.");
  if (!genre || !world || settings.length === 0 || characters.length === 0) {
    throw new Error("장르, 세계관, 핵심 설정, 캐릭터 설정은 필수입니다.");
  }

  return {
    id: input.id || existing.id || crypto.randomUUID(),
    title: String(input.title).trim(),
    code,
    genre,
    world,
    settings,
    characters,
    keywords: normalizeArray(input.keywords).map(keyword => keyword.trim()).filter(Boolean),
    platform: String(input.platform || "").trim(),
    serialization: String(input.serialization || "").trim(),
    sourceUrl: String(input.sourceUrl || input.source_url || "").trim(),
    description: String(input.description || "").trim(),
    createdAt: input.createdAt || input.created_at || existing.createdAt || existing.created_at || now,
    updatedAt: now
  };
}

function toSupabaseRow(novel) {
  return {
    id: novel.id,
    title: novel.title,
    code: novel.code,
    genre: novel.genre,
    world: novel.world,
    settings: novel.settings,
    characters: novel.characters,
    keywords: novel.keywords,
    platform: novel.platform,
    serialization: novel.serialization,
    source_url: novel.sourceUrl,
    description: novel.description,
    created_at: novel.createdAt,
    updated_at: novel.updatedAt
  };
}

function fromSupabaseRow(row) {
  return {
    id: row.id,
    title: row.title,
    code: row.code,
    genre: row.genre,
    world: row.world,
    settings: normalizeArray(row.settings),
    characters: normalizeArray(row.characters),
    keywords: normalizeArray(row.keywords),
    platform: row.platform || "",
    serialization: row.serialization || "",
    sourceUrl: row.source_url || "",
    description: row.description || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.message || data?.hint || "Supabase 요청에 실패했습니다.");
  }

  return data;
}

async function dbListNovels() {
  if (!USE_SUPABASE) return readJsonDb();
  const rows = await supabaseRequest("novels?select=*&order=created_at.desc");
  return rows.map(fromSupabaseRow);
}

async function dbInsertNovel(input) {
  const novel = normalizeNovel(input);
  if (!USE_SUPABASE) {
    const db = readJsonDb();
    db.unshift(novel);
    writeJsonDb(db);
    return novel;
  }

  const rows = await supabaseRequest("novels?select=*", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(toSupabaseRow(novel))
  });
  return fromSupabaseRow(rows[0]);
}

async function dbInsertNovels(items) {
  const novels = items.map(item => normalizeNovel(item));
  if (!USE_SUPABASE) {
    const db = readJsonDb();
    writeJsonDb([...novels, ...db]);
    return novels.length;
  }

  if (novels.length === 0) return 0;
  await supabaseRequest("novels", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(novels.map(toSupabaseRow))
  });
  return novels.length;
}

async function dbUpdateNovel(id, input) {
  if (!USE_SUPABASE) {
    const db = readJsonDb();
    const index = db.findIndex(novel => novel.id === id);
    if (index === -1) return null;
    const novel = normalizeNovel({ ...input, id }, db[index]);
    db[index] = novel;
    writeJsonDb(db);
    return novel;
  }

  const existingRows = await supabaseRequest(`novels?id=eq.${encodeURIComponent(id)}&select=*`);
  if (existingRows.length === 0) return null;

  const novel = normalizeNovel({ ...input, id }, fromSupabaseRow(existingRows[0]));
  const rows = await supabaseRequest(`novels?id=eq.${encodeURIComponent(id)}&select=*`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(toSupabaseRow(novel))
  });
  return fromSupabaseRow(rows[0]);
}

async function dbDeleteNovel(id) {
  if (!USE_SUPABASE) {
    const db = readJsonDb();
    const next = db.filter(novel => novel.id !== id);
    writeJsonDb(next);
    return db.length - next.length;
  }

  const rows = await supabaseRequest(`novels?id=eq.${encodeURIComponent(id)}&select=id`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" }
  });
  return rows.length;
}

function inferPlatformFromUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    if (host.includes("kakao")) return "카카오페이지";
    if (host.includes("naver")) return "네이버시리즈";
    if (host.includes("ridibooks") || host.includes("ridi")) return "리디";
    if (host.includes("munpia")) return "문피아";
    if (host.includes("joara")) return "조아라";
    if (host.includes("novelpia")) return "노벨피아";
    return host;
  } catch {
    return "";
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageText(rawUrl) {
  if (!rawUrl) return "";
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("http 또는 https 링크만 분석할 수 있습니다.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 WebNovelClassifier/1.0" }
    });
    if (!response.ok) return "";
    return stripHtml(await response.text()).slice(0, 8000);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function pickOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

async function classifyNovel(input) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY가 설정되어 있지 않습니다. 서버 환경변수에 API 키를 넣어주세요.");
  }

  const url = String(input.url || "").trim();
  const pastedText = String(input.text || "").trim();
  const pageText = await fetchPageText(url);
  const platformFromUrl = inferPlatformFromUrl(url);

  if (!url && !pastedText) {
    throw new Error("작품 링크 또는 소개글을 입력해주세요.");
  }

  const prompt = `
웹소설 작품 정보를 아래 분류표에 맞춰 JSON으로 분류해줘.
불확실하면 가장 가능성이 높은 값 하나를 선택하고, evidence에 근거를 짧게 적어줘.

[대분류 장르]
11 로맨스, 12 판타지, 13 로맨스판타지, 14 무협, 15 미스터리·스릴러, 16 공포, 17 스포츠, 18 전쟁·밀리터리, 19 라이트노벨

[세계관]
10 현대, 20 시대, 30 이세계, 40 SF, 50 왕족·귀족, 60 학교·아카데미, 70 던전·헌터·게임, 80 이종족, 90 혼합

[핵심 설정]
1 회귀, 2 빙의, 3 환생, 4 성장, 5 피폐, 6 복수, 7 육아, 8 계약, 9 치유

[캐릭터 설정]
.21 집착형, .22 후회형, .23 능력형, .24 시원형, .25 섹시형, .26 냉정형, .27 병약형, .28 보호형, .29 성장형, .30 악역형

링크: ${url || "(없음)"}
추정 플랫폼: ${platformFromUrl || "(없음)"}
사용자 입력 소개글:
${pastedText || "(없음)"}

페이지에서 읽은 공개 텍스트:
${pageText || "(페이지 텍스트를 읽지 못했거나 없음)"}
`;

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["title", "platform", "serialization", "genre", "world", "settings", "characters", "keywords", "description", "evidence"],
    properties: {
      title: { type: "string" },
      platform: { type: "string" },
      serialization: { type: "string" },
      genre: { type: "string", enum: ["11", "12", "13", "14", "15", "16", "17", "18", "19"] },
      world: { type: "string", enum: ["10", "20", "30", "40", "50", "60", "70", "80", "90"] },
      settings: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] } },
      characters: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: [".21", ".22", ".23", ".24", ".25", ".26", ".27", ".28", ".29", ".30"] } },
      keywords: { type: "array", minItems: 0, maxItems: 6, items: { type: "string" } },
      description: { type: "string" },
      evidence: { type: "string" }
    }
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: "너는 한국 웹소설 분류 사서다. 반드시 제공된 분류표 코드만 사용하고, 출력은 스키마에 맞는 JSON으로만 한다."
        },
        { role: "user", content: prompt }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "web_novel_classification",
          strict: true,
          schema
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "AI 분류 요청에 실패했습니다.");

  const parsed = JSON.parse(pickOutputText(data));
  return {
    ...parsed,
    platform: parsed.platform || platformFromUrl,
    sourceUrl: url
  };
}

function serveStatic(req, res) {
  const safePath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, file) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(file);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/novels") {
      sendJson(res, 200, await dbListNovels());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/novels") {
      sendJson(res, 201, await dbInsertNovel(await readBody(req)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/novels/bulk") {
      const body = await readBody(req);
      const added = await dbInsertNovels(Array.isArray(body.items) ? body.items : []);
      sendJson(res, 201, { added });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ai/classify") {
      sendJson(res, 200, await classifyNovel(await readBody(req)));
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/novels/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/novels/", ""));
      const novel = await dbUpdateNovel(id, await readBody(req));
      if (!novel) {
        sendJson(res, 404, { error: "작품을 찾을 수 없습니다." });
        return;
      }
      sendJson(res, 200, novel);
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/novels/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/novels/", ""));
      sendJson(res, 200, { deleted: await dbDeleteNovel(id) });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "요청을 처리하지 못했습니다." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`웹소설 검색 DB 서버 실행 중: http://localhost:${PORT}`);
  console.log(USE_SUPABASE ? "저장소: Supabase 온라인 DB" : "저장소: 로컬 JSON DB");
});
