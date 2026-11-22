import { createClient } from 'npm:@supabase/supabase-js@2';

// レシピサイトのページに埋め込まれた schema.org/Recipe（JSON-LD）を読む。AI は使わない。

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function logError(requestId: string, stage: string, error: unknown, details: Record<string, unknown> = {}) {
  console.error(JSON.stringify({
    event: 'import-recipe-url-error',
    request_id: requestId,
    stage,
    error: errorMessage(error),
    ...details
  }));
}

const MAX_HTML_BYTES = 5_000_000;
const AMOUNT_HINT = /[0-9０-９½¼¾]|少々|適量|適宜|ひとつまみ|お好み|大さじ|小さじ|カップ|個|本|枚|片|束|袋|丁|株|切れ|尾|房|かけ|玉|合|cc|ml|g\b|kg/i;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function clean(value: unknown, maxLength = 500) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isRecipe(node: Json): node is { [key: string]: Json } {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const type = node['@type'];
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
}

function findRecipe(node: Json): { [key: string]: Json } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRecipe(child);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (isRecipe(node)) return node;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage']) {
    const found = findRecipe(node[key] ?? null);
    if (found) return found;
  }
  return null;
}

// PT1H20M のような ISO 8601 の時間を分にする。
function minutesOf(value: Json): number | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/i);
  if (!m) return null;
  const total = (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0);
  return total > 0 ? total : null;
}

// 「鶏むね肉 300g」を名前と分量に分ける。分量らしくなければ全体を名前にする。
// 「(A)」「★」のような合わせ調味料の見出し記号は外す。
const GROUP_MARK = /^(?:[(（][A-Za-zＡ-Ｚａ-ｚ0-9０-９★☆●◎◆]{1,2}[)）]|[★☆●◎◆・※*＊])[\s\u3000]*/;
function splitIngredient(raw: string) {
  const line = raw.replace(GROUP_MARK, '');
  const m = line.match(/^(.+?)[\s　]+([^\s　]+(?:[\s　]*[^\s　]+)?)$/);
  if (m && AMOUNT_HINT.test(m[2])) return { name: m[1].trim(), amount: m[2].trim() };
  return { name: line, amount: '' };
}

function stepsOf(value: Json): string[] {
  if (!value) return [];
  if (typeof value === 'string') return value.split(/\r?\n|<br\s*\/?>/i).map(s => clean(s)).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(stepsOf);
  if (typeof value === 'object') {
    if (value['@type'] === 'HowToSection' || Array.isArray(value.itemListElement)) return stepsOf(value.itemListElement ?? null);
    return [clean(value.text ?? value.name ?? '')].filter(Boolean);
  }
  return [];
}

function recipeFrom(node: { [key: string]: Json }) {
  const yieldValue = Array.isArray(node.recipeYield) ? node.recipeYield[0] : node.recipeYield;
  const minutes = minutesOf(node.totalTime ?? null)
    ?? (() => {
      const sum = (minutesOf(node.prepTime ?? null) ?? 0) + (minutesOf(node.cookTime ?? null) ?? 0);
      return sum || null;
    })();
  const rawIngredients = Array.isArray(node.recipeIngredient) ? node.recipeIngredient
    : Array.isArray(node.ingredients) ? node.ingredients : [];
  return {
    title: clean(node.name, 120),
    servings: clean(yieldValue ?? '', 40),
    minutes,
    ingredients: rawIngredients.map(line => clean(line, 120)).filter(Boolean).slice(0, 60).map(splitIngredient),
    steps: stepsOf(node.recipeInstructions ?? null).slice(0, 40)
  };
}

function checkUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  // 内部向けのアドレスには取りに行かない。
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return null;
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  return url;
}

Deno.serve(async request => {
  const requestId = crypto.randomUUID();
  try {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (request.method !== 'POST') return json({ error: 'Method not allowed', request_id: requestId }, 405);

    const authorization = request.headers.get('Authorization');
    const token = authorization?.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Authentication required', request_id: requestId }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !supabaseAnonKey) {
      logError(requestId, 'supabase_environment', new Error('Supabase environment is incomplete'));
      return json({ error: 'Authentication service is not configured', request_id: requestId }, 500);
    }
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      logError(requestId, 'supabase_auth', userError || new Error('User not found'));
      return json({ error: 'Authentication required', request_id: requestId }, 401);
    }

    let input: Record<string, unknown>;
    try {
      input = await request.json();
    } catch (error) {
      logError(requestId, 'request_json', error);
      return json({ error: 'Invalid JSON body', request_id: requestId }, 400);
    }
    const url = checkUrl(input.url);
    if (!url) return json({ error: 'URL が正しくありません', request_id: requestId }, 400);

    let html: string;
    let finalUrl = url.toString();
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        logError(requestId, 'page_http', new Error(`HTTP ${response.status}`), { url: url.toString() });
        return json({ error: `ページを開けませんでした（HTTP ${response.status}）`, request_id: requestId }, 422);
      }
      finalUrl = response.url || finalUrl;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_HTML_BYTES) return json({ error: 'ページが大きすぎます', request_id: requestId }, 422);
      html = new TextDecoder().decode(buffer);
    } catch (error) {
      logError(requestId, 'page_fetch', error, { url: url.toString() });
      return json({ error: 'ページを開けませんでした', request_id: requestId }, 422);
    }

    let recipe: { [key: string]: Json } | null = null;
    for (const m of html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        recipe = findRecipe(JSON.parse(m[1].trim()));
      } catch {
        continue;
      }
      if (recipe) break;
    }
    if (!recipe) {
      return json({ error: 'このページからレシピを読み取れませんでした。写真から登録するか、手で入力してください。', request_id: requestId }, 422);
    }
    const result = recipeFrom(recipe);
    if (!result.title && !result.ingredients.length) {
      return json({ error: 'このページからレシピを読み取れませんでした。写真から登録するか、手で入力してください。', request_id: requestId }, 422);
    }
    return json({ ...result, source_url: finalUrl });
  } catch (error) {
    logError(requestId, 'unhandled', error);
    return json({ error: 'Unexpected server error', request_id: requestId }, 500);
  }
});
