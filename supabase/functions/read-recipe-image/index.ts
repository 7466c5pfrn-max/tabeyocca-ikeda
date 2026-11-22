import Anthropic from 'npm:@anthropic-ai/sdk@1.6.0';
import { betaJSONSchemaOutputFormat } from 'npm:@anthropic-ai/sdk@1.6.0/helpers/beta/json-schema';
import { createClient } from 'npm:@supabase/supabase-js@2';

// 雑誌や本のレシピの写真を書き起こす。書いてあることだけを書き出し、レシピを作ったり補ったりはしない。

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const text = (value: unknown, maxLength: number) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function logError(requestId: string, stage: string, error: unknown, details: Record<string, unknown> = {}) {
  console.error(JSON.stringify({
    event: 'read-recipe-image-error',
    request_id: requestId,
    stage,
    error: errorMessage(error),
    ...details
  }));
}

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type MediaType = typeof MEDIA_TYPES[number];
const MAX_IMAGES = 4;
// base64 で1枚約 6MB まで。画面側で縮小してから送る。
const MAX_IMAGE_LENGTH = 6_000_000;

const RecipeSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    title: { type: 'string' },
    servings: { type: 'string' },
    minutes: { type: 'integer' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          amount: { type: 'string' },
          is_seasoning: { type: 'boolean' },
          unclear: { type: 'boolean' }
        },
        required: ['name', 'amount', 'is_seasoning', 'unclear'],
        additionalProperties: false
      }
    },
    steps: { type: 'array', items: { type: 'string' } }
  },
  required: ['found', 'title', 'servings', 'minutes', 'ingredients', 'steps'],
  additionalProperties: false
} as const;

const PROMPT = `これは雑誌や料理本などに載っているレシピの写真です（複数枚のときは同じレシピの続きです）。家庭のレシピ帳に保存するため、書いてある内容を書き起こしてください。

ルール:
- 写真に書いてあることだけを書き起こす。書いていない材料・分量・手順を補ったり、作り方を考えたりしない。
- 読めない文字や写真から切れている部分は推測で埋めない。材料なら unclear を true にし、読めた部分だけを書く。手順の文中で読めない箇所は「［読めない］」と書く。
- title は料理名。servings は「2人分」のような分量の表記（無ければ空文字）。minutes は調理時間の分数（書いていなければ 0）。
- ingredients は材料を書いてある順に。name は材料名、amount は分量（「大さじ1」「200g」「少々」など）。「A」「★」のような合わせ調味料の見出し記号は外す。
- is_seasoning は、塩・こしょう・砂糖・しょうゆ・みりん・酒・酢・みそ・油・だし・片栗粉・小麦粉・水などの調味料や下ごしらえ用のものなら true、肉・魚・野菜・卵・豆腐・麺・米などの食材なら false。
- steps は手順を1つずつ。番号は付けない。
- 写真にレシピが写っていないときは found を false にし、ほかは空にする。`;

function cleanRecipe(value: Record<string, unknown>) {
  const ingredients = Array.isArray(value.ingredients) ? value.ingredients.slice(0, 60) : [];
  const steps = Array.isArray(value.steps) ? value.steps.slice(0, 40) : [];
  const minutes = Number.isInteger(value.minutes) ? value.minutes as number : 0;
  return {
    title: text(value.title, 120),
    servings: text(value.servings, 40),
    minutes: minutes > 0 && minutes < 1440 ? minutes : null,
    ingredients: ingredients.map(raw => {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return {
        name: text(item.name, 80),
        amount: text(item.amount, 40),
        is_seasoning: item.is_seasoning === true,
        unclear: item.unclear === true
      };
    }).filter(item => item.name || item.amount),
    steps: steps.map(step => text(step, 500)).filter(Boolean)
  };
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
    const images = (Array.isArray(input.images) ? input.images : []).slice(0, MAX_IMAGES + 1);
    if (!images.length || images.length > MAX_IMAGES) {
      return json({ error: `images must have 1 to ${MAX_IMAGES} items`, request_id: requestId }, 400);
    }
    const blocks: Anthropic.Beta.BetaImageBlockParam[] = [];
    for (const raw of images) {
      const image = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const data = typeof image.data === 'string' ? image.data : '';
      const mediaType = image.media_type as MediaType;
      if (!data || !MEDIA_TYPES.includes(mediaType)) {
        return json({ error: 'each image needs data and media_type', request_id: requestId }, 400);
      }
      if (data.length > MAX_IMAGE_LENGTH) return json({ error: 'Image is too large', request_id: requestId }, 413);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      logError(requestId, 'anthropic_environment', new Error('Anthropic API key is missing'));
      return json({ error: 'Recipe reading is not configured', request_id: requestId }, 503);
    }
    const anthropic = new Anthropic({ apiKey });

    let response;
    try {
      // 安全判定で断られたときは、サーバー側で別のモデルに自動で引き継ぐ。
      response = await anthropic.beta.messages.parse({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: betaJSONSchemaOutputFormat(RecipeSchema) },
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: PROMPT }] }]
      });
    } catch (error) {
      logError(requestId, 'anthropic_request', error);
      const status = error instanceof Anthropic.APIError && typeof error.status === 'number' ? error.status : null;
      return json({ error: status ? `Anthropic API returned HTTP ${status}` : 'Anthropic API request failed', request_id: requestId }, 502);
    }

    if (response.stop_reason === 'refusal') {
      logError(requestId, 'anthropic_refusal', new Error('Request was declined'), { stop_details: response.stop_details });
      return json({ error: 'The recipe could not be read', request_id: requestId }, 422);
    }
    if (!response.parsed_output) {
      logError(requestId, 'anthropic_response', new Error('No parsed output'), { stop_reason: response.stop_reason });
      return json({ error: 'Invalid Anthropic response', request_id: requestId }, 502);
    }
    if (!response.parsed_output.found) return json({ found: false });
    return json({ found: true, ...cleanRecipe(response.parsed_output as Record<string, unknown>) });
  } catch (error) {
    logError(requestId, 'unhandled', error);
    return json({ error: 'Unexpected server error', request_id: requestId }, 500);
  }
});
