import Anthropic from 'npm:@anthropic-ai/sdk@1.6.0';
import { betaJSONSchemaOutputFormat } from 'npm:@anthropic-ai/sdk@1.6.0/helpers/beta/json-schema';
import { createClient } from 'npm:@supabase/supabase-js@2';

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
    event: 'read-receipt-error',
    request_id: requestId,
    stage,
    error: errorMessage(error),
    ...details
  }));
}

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type MediaType = typeof MEDIA_TYPES[number];
// base64 で約 6MB（元画像で約 4.5MB）まで。画面側で縮小してから送る。
const MAX_IMAGE_LENGTH = 6_000_000;

const COLORS = ['red', 'yellow', 'green', 'other'] as const;
const ZONES = ['fresh', 'pantry'] as const;
const LOCATIONS = ['fridge', 'vegetable', 'freezer', 'pantry'] as const;

const ReceiptSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          receipt_text: { type: 'string' },
          name: { type: 'string' },
          quantity: { type: 'string' },
          category: { type: 'string' },
          color: { type: 'string', enum: [...COLORS] },
          zone: { type: 'string', enum: [...ZONES] },
          location: { type: 'string', enum: [...LOCATIONS] },
          days: { type: 'integer' },
          uncertain: { type: 'boolean' }
        },
        required: ['receipt_text', 'name', 'quantity', 'category', 'color', 'zone', 'location', 'days', 'uncertain'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
  additionalProperties: false
} as const;

function promptFor(knownFoods: string[]) {
  return `これはスーパーなどのレシートの写真です。家の冷蔵庫・ストック管理アプリに登録するため、買った食品を書き出してください。

ルール:
- レシートに印字されている品目だけを書き出す。印字にない品目を足したり、推測で補ったりしない。
- 食品・飲料以外（レジ袋、洗剤、日用品、割引・ポイント・小計・合計・税の行など）は除く。
- receipt_text にはレシートの表記をそのまま入れる（例: "ﾄﾘﾑﾈﾆｸ"）。
- name には家庭で普通に呼ぶ食材名を入れる（例: "鶏むね肉"）。ブランド名や容量は外す。略称から食材が特定できないときは、レシートの表記をカタカナに直したものを name にし、uncertain を true にする。
- 次の「この家の食材マスタ」に同じ食材があれば、その名前をそのまま name に使う。
- quantity は個数や容量がわかれば入れる（例: "2個", "300g", "1パック"）。わからなければ空文字。同じ品目が複数行あれば1つにまとめて個数を足す。
- zone は冷蔵・冷凍で日々使うものなら "fresh"、米・乾物・乾麺・缶詰・レトルト・粉類・常温の調味料などのストックなら "pantry"。
- location は fresh なら "fridge"（冷蔵）、"vegetable"（野菜室）、"freezer"（冷凍食品）のいずれか。pantry なら "pantry"。
- color は三色食品群: "red"（肉・魚・卵・乳製品・豆・大豆製品）、"yellow"（ごはん・パン・麺・いも・油脂・砂糖）、"green"（野菜・果物・きのこ・海藻）、それ以外（調味料・飲み物・菓子など）は "other"。
- category は次から選ぶ。fresh: 肉, 魚, 卵, 乳製品, 豆腐・大豆製品, ハム・ソーセージ, ごはん・パン, 麺, いも, 葉物野菜, 根菜, その他の野菜, きのこ, 果物, 海藻, 調味料, 飲み物, その他。pantry: 米・穀物, 乾麺・パスタ, 粉類, 乾物, 缶詰・瓶詰, レトルト, 調味料, その他。
- days は fresh のとき、買った日から使い切るまでの目安の日数（冷蔵の生肉なら2〜3、葉物野菜なら3〜4、冷凍食品なら30）。pantry のときは 0。
- 写真がレシートでない、または読めないときは items を空にする。

この家の食材マスタ: ${knownFoods.length ? knownFoods.join('、') : '（まだなし）'}`;
}

function cleanItems(value: unknown) {
  const items = Array.isArray(value) ? value.slice(0, 80) : [];
  return items.map(raw => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const zone = ZONES.includes(item.zone as never) ? item.zone as string : 'fresh';
    const location = LOCATIONS.includes(item.location as never) ? item.location as string : 'fridge';
    const days = Number.isInteger(item.days) ? Math.min(Math.max(item.days as number, 0), 365) : 0;
    return {
      receipt_text: text(item.receipt_text, 100),
      name: text(item.name, 60),
      quantity: text(item.quantity, 30),
      category: text(item.category, 30),
      color: COLORS.includes(item.color as never) ? item.color as string : 'other',
      zone,
      // fresh なのに常温、pantry なのに冷蔵、といった食い違いは区分に合わせて直す。
      location: zone === 'pantry' ? 'pantry' : (location === 'pantry' ? 'fridge' : location),
      days: zone === 'pantry' ? 0 : (days || 7),
      uncertain: item.uncertain === true
    };
  }).filter(item => item.name);
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
    const image = typeof input.image === 'string' ? input.image : '';
    const mediaType = input.media_type as MediaType;
    if (!image || !MEDIA_TYPES.includes(mediaType)) {
      return json({ error: 'image and media_type are required', request_id: requestId }, 400);
    }
    if (image.length > MAX_IMAGE_LENGTH) {
      return json({ error: 'Image is too large', request_id: requestId }, 413);
    }
    const knownFoods = (Array.isArray(input.known_foods) ? input.known_foods : [])
      .map(name => text(name, 60)).filter(Boolean).slice(0, 300);

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      logError(requestId, 'anthropic_environment', new Error('Anthropic API key is missing'));
      return json({ error: 'Receipt reading is not configured', request_id: requestId }, 503);
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
        output_config: { effort: 'medium', format: betaJSONSchemaOutputFormat(ReceiptSchema) },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: promptFor(knownFoods) }
          ]
        }]
      });
    } catch (error) {
      logError(requestId, 'anthropic_request', error);
      const status = error instanceof Anthropic.APIError && typeof error.status === 'number' ? error.status : null;
      return json({ error: status ? `Anthropic API returned HTTP ${status}` : 'Anthropic API request failed', request_id: requestId }, 502);
    }

    if (response.stop_reason === 'refusal') {
      logError(requestId, 'anthropic_refusal', new Error('Request was declined'), { stop_details: response.stop_details });
      return json({ error: 'The receipt could not be read', request_id: requestId }, 422);
    }
    if (!response.parsed_output) {
      logError(requestId, 'anthropic_response', new Error('No parsed output'), { stop_reason: response.stop_reason });
      return json({ error: 'Invalid Anthropic response', request_id: requestId }, 502);
    }
    return json({ items: cleanItems(response.parsed_output.items) });
  } catch (error) {
    logError(requestId, 'unhandled', error);
    return json({ error: 'Unexpected server error', request_id: requestId }, 500);
  }
});
