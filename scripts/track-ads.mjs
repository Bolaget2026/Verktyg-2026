// track-ads.mjs
// Körs dagligen av GitHub Actions. Hämtar aktuella annonser för de fyra
// yrkeskategorierna, sparar dem i en evig historik (history.json) och
// bygger en uppföljningslista (followup.json) med annonser vars sista
// ansökningsdag var för 3–10 dagar sedan.
//
// Körs med: node scripts/track-ads.mjs
// Kräver inga externa paket – bara Node 18+ (globalt fetch).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const PAGE_SIZE = 100;
const SEARCH_BASE = "https://jobsearch.api.jobtechdev.se/search";

// Samma bekräftade occupation-group id:n som i platsbanken.html.
const OCCUPATION_CONFIG = {
  "Kurator":               { id: "dJXy_Rpq_a2u", maxPages: 7 },
  "Socialsekreterare":     { id: "pok1_ipJ_yzD", maxPages: 7 },
  "Biståndsbedömare":      { id: "5uP5_Ugw_aVE", maxPages: 5 },
  "Övrigt socialt arbete": { id: "n6iX_f2z_XfE", maxPages: 20 }
};

// Samma heuristik som widgeten för att plocka ut chefens kontaktuppgifter
// och sortera bort fackliga kontakter.
const UNION_KEYWORDS = [
  "vision", "ssr", "saco", "kommunal", "fackförbundet", "fackliga",
  "lärarförbundet", "vårdförbundet", "akademikerförbundet", "unionen",
  "seko", "naturvetarna", "jusek", "akavia", "ingenjörer", "dik"
];
const MANAGER_KEYWORDS = ["chef", "ledare", "ansvarig"];

function getManagerContact(hit) {
  const contacts = hit.application_contacts || [];
  const isUnion = (c) => {
    const text = ((c.contact_type || "") + " " + (c.name || "")).toLowerCase();
    return UNION_KEYWORDS.some((k) => text.includes(k));
  };
  const hasManagerHint = (c) => {
    const text = ((c.contact_type || "") + " " + (c.name || "")).toLowerCase();
    return MANAGER_KEYWORDS.some((k) => text.includes(k));
  };
  const candidates = contacts.filter((c) => !isUnion(c));
  const chosen = candidates.find(hasManagerHint) || candidates[0] || null;
  if (!chosen) return null;

  let name = (chosen.name || "").trim();
  let role = chosen.contact_type || "";
  const parts = name.split(",");
  if (parts.length > 1 && !role) {
    role = parts.slice(1).join(",").trim();
    name = parts[0].trim();
  }
  return { name: name || null, role: role || null, phone: chosen.telephone || null, email: chosen.email || null };
}

function buildUrl(occupationId, offset) {
  const params = new URLSearchParams();
  params.append("occupation-group", occupationId);
  params.append("limit", String(PAGE_SIZE));
  params.append("offset", String(offset));
  return SEARCH_BASE + "?" + params.toString();
}

async function fetchAllForCategory(label, config) {
  const maxHits = config.maxPages * PAGE_SIZE;
  let offset = 0;
  let total = Infinity;
  const hits = [];
  while (offset < total && offset < maxHits) {
    const res = await fetch(buildUrl(config.id, offset));
    if (!res.ok) throw new Error("HTTP " + res.status + " (" + label + ")");
    const data = await res.json();
    total = (data.total && data.total.value) || 0;
    const pageHits = data.hits || [];
    hits.push(...pageHits);
    if (pageHits.length === 0) break;
    offset += PAGE_SIZE;
  }
  return hits;
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function main() {
  const dataDir = path.resolve("data");
  const historyPath = path.join(dataDir, "history.json");
  const followupPath = path.join(dataDir, "followup.json");
  await mkdir(dataDir, { recursive: true });

  const today = new Date();
  const todayIso = toIsoDate(today);

  console.log("Hämtar annonser för " + todayIso + " …");

  const allHits = [];
  for (const [label, config] of Object.entries(OCCUPATION_CONFIG)) {
    const hits = await fetchAllForCategory(label, config);
    hits.forEach((hit) => { hit._categoryLabel = label; });
    allHits.push(...hits);
    console.log("  " + label + ": " + hits.length + " träffar");
  }

  // Dedupa (en annons kan i teorin dyka upp i flera kategorier)
  const byId = new Map();
  allHits.forEach((hit) => byId.set(hit.id, hit));

  const history = await readJsonSafe(historyPath, {});

  let newCount = 0;
  let updatedCount = 0;

  byId.forEach((hit, id) => {
    const mgr = getManagerContact(hit);
    const record = {
      id,
      headline: hit.headline || null,
      employer: (hit.employer && hit.employer.name) || null,
      municipality: (hit.workplace_address && hit.workplace_address.municipality) || null,
      region: (hit.workplace_address && hit.workplace_address.region) || null,
      category: hit._categoryLabel,
      publication_date: hit.publication_date || null,
      application_deadline: hit.application_deadline || null,
      webpage_url: hit.webpage_url || null,
      manager_name: mgr && mgr.name,
      manager_role: mgr && mgr.role,
      manager_phone: mgr && mgr.phone,
      manager_email: mgr && mgr.email,
      first_seen: today.toISOString(),
      last_seen: today.toISOString()
    };

    if (history[id]) {
      history[id].last_seen = today.toISOString();
      // Uppdatera fält som kan ändras medan annonsen är live (t.ex. förlängt datum)
      history[id].application_deadline = record.application_deadline;
      history[id].manager_name = record.manager_name;
      history[id].manager_role = record.manager_role;
      history[id].manager_phone = record.manager_phone;
      history[id].manager_email = record.manager_email;
      updatedCount++;
    } else {
      history[id] = record;
      newCount++;
    }
  });

  console.log("Historik: " + newCount + " nya, " + updatedCount + " uppdaterade. Totalt " + Object.keys(history).length + " annonser.");

  await writeFile(historyPath, JSON.stringify(history, null, 2) + "\n", "utf-8");

  // ---- Uppföljningslista: annonser vars sista ansökningsdag var 3–10 dagar sedan ----
  const MIN_DAYS = 3;
  const MAX_DAYS = 10;
  const msPerDay = 24 * 60 * 60 * 1000;

  const followup = Object.values(history)
    .filter((r) => r.application_deadline)
    .map((r) => {
      const deadline = new Date(r.application_deadline);
      const daysSince = Math.floor((today.getTime() - deadline.getTime()) / msPerDay);
      return { ...r, days_since_expiry: daysSince };
    })
    .filter((r) => r.days_since_expiry >= MIN_DAYS && r.days_since_expiry <= MAX_DAYS)
    .sort((a, b) => a.days_since_expiry - b.days_since_expiry);

  console.log("Uppföljningslista: " + followup.length + " annonser (gick ut " + MIN_DAYS + "–" + MAX_DAYS + " dagar sedan).");

  await writeFile(followupPath, JSON.stringify({ generated_at: today.toISOString(), ads: followup }, null, 2) + "\n", "utf-8");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
