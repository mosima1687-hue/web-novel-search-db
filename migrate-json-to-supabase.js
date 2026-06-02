const fs = require("fs");
const path = require("path");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DB_FILE = path.join(__dirname, "data", "novels.json");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return [String(value)].filter(Boolean);
}

function toSupabaseRow(novel) {
  return {
    id: novel.id,
    title: novel.title,
    code: novel.code,
    genre: novel.genre,
    world: novel.world,
    settings: normalizeArray(novel.settings),
    characters: normalizeArray(novel.characters),
    keywords: normalizeArray(novel.keywords),
    platform: novel.platform || "",
    serialization: novel.serialization || "",
    source_url: novel.sourceUrl || novel.source_url || "",
    description: novel.description || "",
    created_at: novel.createdAt || novel.created_at || new Date().toISOString(),
    updated_at: novel.updatedAt || novel.updated_at || new Date().toISOString()
  };
}

async function main() {
  const novels = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  if (novels.length === 0) {
    console.log("옮길 로컬 데이터가 없습니다.");
    return;
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/novels`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(novels.map(toSupabaseRow))
  });

  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }

  console.log(`${novels.length}건을 Supabase로 옮겼습니다.`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
