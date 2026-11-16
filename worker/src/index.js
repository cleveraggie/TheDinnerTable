const MAX_HTML_BYTES = 1_000_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12_000;

const corsHeaders = origin => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
});

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" }
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "null";
  const allowed = String(env.ALLOWED_ORIGINS || "*").split(",").map(x => x.trim());
  return allowed.includes("*") || allowed.includes(origin) ? origin : null;
}

function isPublicHttpUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

async function fetchPage(url) {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isPublicHttpUrl(current.href)) throw new Error("The link must point to a public website.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "TheDinnerTableRecipeImporter/1.0" }
      });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location || hop === MAX_REDIRECTS) throw new Error("The recipe page redirected too many times.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`The recipe website returned ${response.status}.`);
    const type = response.headers.get("Content-Type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error("That link did not return a recipe webpage.");
    const declared = Number(response.headers.get("Content-Length") || 0);
    if (declared > MAX_HTML_BYTES) throw new Error("The webpage is too large to import.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Could not read the recipe webpage.");
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) { await reader.cancel(); throw new Error("The webpage is too large to import."); }
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return { html: new TextDecoder().decode(joined), finalUrl: current.href };
  }
  throw new Error("Could not reach the recipe webpage.");
}

function findRecipe(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) { const found = findRecipe(item, seen); if (found) return found; }
    return null;
  }
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some(type => String(type || "").split("/").pop() === "Recipe")) return value;
  for (const child of Object.values(value)) { const found = findRecipe(child, seen); if (found) return found; }
  return null;
}

function flattenInstructions(raw) {
  const out = [];
  const walk = value => {
    if (typeof value === "string") { if (value.trim()) out.push(value.trim()); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    if (value.name && Array.isArray(value.itemListElement)) out.push(`${value.name}:`);
    if (value.text) walk(value.text);
    else if (value.itemListElement) walk(value.itemListElement);
  };
  walk(raw);
  return out;
}

function categoryFrom(raw) {
  const value = String(Array.isArray(raw) ? raw.join(" ") : raw || "").toLowerCase();
  if (/dessert|cake|cookie|pudding|brownie/.test(value)) return "Dessert";
  if (/side|salad|vegetable/.test(value)) return "Side";
  if (/snack|appetizer|starter/.test(value)) return "Snack";
  if (/breakfast|brunch/.test(value)) return "Breakfast";
  if (/drink|beverage|cocktail/.test(value)) return "Drink";
  if (/main|entree|dinner/.test(value)) return "Entree";
  return "Other";
}

function fromSchema(schema, source) {
  const ingredients = Array.isArray(schema.recipeIngredient) ? schema.recipeIngredient.map(String).map(x => x.trim()).filter(Boolean) : [];
  const instructions = flattenInstructions(schema.recipeInstructions);
  if (!ingredients.length && !instructions.length) return null;
  return {
    name: String(schema.name || "Imported recipe").trim(),
    source,
    category: categoryFrom(schema.recipeCategory || schema.name),
    ingredients,
    instructions,
    notes: String(schema.description || "").trim()
  };
}

function parseStructuredHtml(html, source) {
  const scripts = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^.*?>/s, "").replace(/<\/script\s*>$/i, "").trim();
    try { const recipe = fromSchema(findRecipe(JSON.parse(body)), source); if (recipe) return recipe; } catch { /* try another JSON-LD block */ }
  }
  return null;
}

function markdownSection(lines, pattern) {
  const start = lines.findIndex(line => /^#{1,6}\s/.test(line) && pattern.test(line.replace(/^#{1,6}\s*/, "")));
  if (start < 0) return [];
  const level = (lines[start].match(/^#+/) || ["##"])[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      const sublevel = (lines[i].match(/^#+/) || [""])[0].length;
      if (sublevel <= level) break;
      continue;
    }
    let line = lines[i].trim().replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").replace(/\s+#+$/, "").trim();
    if (line && !/^source\s*:/i.test(line)) out.push(line);
  }
  return out;
}

function fromReader(content, title, source) {
  const lines = String(content || "").split(/\r?\n/);
  const heading = lines.find(line => /^#\s+/.test(line));
  const name = String(title || (heading ? heading.replace(/^#\s+/, "") : "")).trim();
  const ingredients = markdownSection(lines, /ingredient|what you(?:'|’)ll need|you will need/i);
  const instructions = markdownSection(lines, /direction|instruction|method|preparation|steps|how to make/i);
  if (!name || (!ingredients.length && !instructions.length)) return null;
  return { name, source, category: categoryFrom(name), ingredients, instructions, notes: "" };
}

async function fromReaderService(url) {
  const response = await fetch(`https://r.jina.ai/${url}`, { headers: { "Accept": "application/json" } });
  if (!response.ok) throw new Error(`Reader service returned ${response.status}.`);
  const body = await response.json();
  const data = body.data || body;
  return fromReader(data.content, data.title, url);
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    const corsOrigin = origin || "null";
    if (request.method === "OPTIONS") return new Response(null, { status: origin ? 204 : 403, headers: corsHeaders(corsOrigin) });
    if (!origin) return json({ error: "This app origin is not allowed. Set ALLOWED_ORIGINS in Worker settings." }, 403, corsOrigin);
    if (request.method !== "POST") return json({ error: "Use POST with a JSON body containing a recipe URL." }, 405, corsOrigin);
    try {
      const body = await request.json();
      if (typeof body.url !== "string" || body.url.length > 2048 || !isPublicHttpUrl(body.url)) {
        return json({ error: "Enter a public http or https recipe URL." }, 400, corsOrigin);
      }
      const { html, finalUrl } = await fetchPage(body.url);
      let recipe = parseStructuredHtml(html, finalUrl);
      if (!recipe) recipe = await fromReaderService(finalUrl);
      if (!recipe) return json({ error: "The page could not be parsed into clear ingredients and directions. It may require sign-in or use an unsupported layout." }, 422, corsOrigin);
      return json({ recipe }, 200, corsOrigin);
    } catch (error) {
      return json({ error: error?.message || "Recipe import failed." }, 502, corsOrigin);
    }
  }
};
