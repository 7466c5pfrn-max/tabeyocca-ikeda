-- たべよっか 初期スキーマ。全てのデータは household_id で家庭ごとに分け、
-- RLS で同じ家庭のメンバーだけが読み書きできるようにする。

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'わが家',
  invite_code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default '',
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index if not exists household_members_user_idx on public.household_members (user_id);

-- RLS の中で household_members を参照すると再帰するため、security definer で判定する。
create or replace function public.is_household_member(hid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members
    where household_id = hid and user_id = auth.uid()
  );
$$;

-- 食材マスタ。在庫とレシピの材料をここにひも付け、別名で表記ゆれを吸収する。
create table if not exists public.foods (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}',
  color text not null default 'other' check (color in ('red', 'yellow', 'green', 'other')),
  category text not null default '',
  zone text not null default 'fresh' check (zone in ('fresh', 'pantry')),
  location text not null default 'fridge' check (location in ('fridge', 'vegetable', 'freezer', 'pantry')),
  default_days integer check (default_days is null or default_days > 0),
  created_at timestamptz not null default now(),
  unique (household_id, name)
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  food_id uuid references public.foods(id) on delete set null,
  name text not null,
  color text not null default 'other' check (color in ('red', 'yellow', 'green', 'other')),
  category text not null default '',
  -- fresh: 冷蔵・冷凍（残り日数で促す） / pantry: 米・乾物などのストック（見返す用）
  zone text not null default 'fresh' check (zone in ('fresh', 'pantry')),
  location text not null default 'fridge' check (location in ('fridge', 'vegetable', 'freezer', 'pantry')),
  quantity text not null default '',
  added_at date not null default current_date,
  use_by date,
  source text not null default 'manual' check (source in ('manual', 'voice', 'receipt')),
  status text not null default 'active' check (status in ('active', 'used', 'discarded')),
  added_by uuid default auth.uid() references auth.users(id) on delete set null,
  finished_at timestamptz,
  finished_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists items_household_active_idx
  on public.items (household_id, zone, use_by) where status = 'active';

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  servings text not null default '',
  minutes integer check (minutes is null or minutes > 0),
  steps jsonb not null default '[]'::jsonb,
  source_type text not null default 'manual' check (source_type in ('manual', 'url', 'image')),
  source_url text,
  -- Storage の recipe-images バケット内のパス（{household_id}/...）
  source_images text[] not null default '{}',
  source_note text not null default '',
  is_favorite boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  food_id uuid references public.foods(id) on delete set null,
  name text not null,
  amount text not null default '',
  is_seasoning boolean not null default false,
  position integer not null default 0
);

create index if not exists recipe_ingredients_recipe_idx on public.recipe_ingredients (recipe_id, position);

create table if not exists public.cook_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  recipe_id uuid references public.recipes(id) on delete set null,
  cooked_at timestamptz not null default now(),
  cooked_by uuid default auth.uid() references auth.users(id) on delete set null
);

-- ---------- RLS ----------

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.foods enable row level security;
alter table public.items enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.cook_log enable row level security;

-- 家庭の作成と参加は下の RPC 経由に限り、直接の insert は許さない。
drop policy if exists "members read household" on public.households;
create policy "members read household"
on public.households for select to authenticated
using (public.is_household_member(id));

drop policy if exists "members rename household" on public.households;
create policy "members rename household"
on public.households for update to authenticated
using (public.is_household_member(id))
with check (public.is_household_member(id));

drop policy if exists "members read members" on public.household_members;
create policy "members read members"
on public.household_members for select to authenticated
using (public.is_household_member(household_id));

drop policy if exists "update own member row" on public.household_members;
create policy "update own member row"
on public.household_members for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "members manage foods" on public.foods;
create policy "members manage foods"
on public.foods for all to authenticated
using (public.is_household_member(household_id))
with check (public.is_household_member(household_id));

drop policy if exists "members manage items" on public.items;
create policy "members manage items"
on public.items for all to authenticated
using (public.is_household_member(household_id))
with check (public.is_household_member(household_id));

drop policy if exists "members manage recipes" on public.recipes;
create policy "members manage recipes"
on public.recipes for all to authenticated
using (public.is_household_member(household_id))
with check (public.is_household_member(household_id));

drop policy if exists "members manage recipe_ingredients" on public.recipe_ingredients;
create policy "members manage recipe_ingredients"
on public.recipe_ingredients for all to authenticated
using (exists (
  select 1 from public.recipes r
  where r.id = recipe_id and public.is_household_member(r.household_id)
))
with check (exists (
  select 1 from public.recipes r
  where r.id = recipe_id and public.is_household_member(r.household_id)
));

drop policy if exists "members manage cook_log" on public.cook_log;
create policy "members manage cook_log"
on public.cook_log for all to authenticated
using (public.is_household_member(household_id))
with check (public.is_household_member(household_id));

-- ---------- 家庭の作成・参加 ----------

create or replace function public.create_household(p_name text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  hid uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  insert into public.households (name)
  values (coalesce(nullif(trim(p_name), ''), 'わが家'))
  returning id into hid;
  insert into public.household_members (household_id, user_id, display_name)
  values (hid, auth.uid(), coalesce(trim(p_display_name), ''));
  return hid;
end;
$$;

create or replace function public.join_household(p_invite_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  hid uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select id into hid from public.households
  where invite_code = upper(trim(p_invite_code));
  if hid is null then
    raise exception 'invite code not found';
  end if;
  insert into public.household_members (household_id, user_id, display_name)
  values (hid, auth.uid(), coalesce(trim(p_display_name), ''))
  on conflict (household_id, user_id) do update set display_name = excluded.display_name;
  return hid;
end;
$$;

revoke all on function public.create_household(text, text) from public, anon;
revoke all on function public.join_household(text, text) from public, anon;
grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;

-- ---------- Storage（レシピ画像） ----------

insert into storage.buckets (id, name, public)
values ('recipe-images', 'recipe-images', false)
on conflict (id) do nothing;

-- パスの先頭フォルダを household_id とし、そのメンバーだけが扱える。
drop policy if exists "members manage recipe images" on storage.objects;
create policy "members manage recipe images"
on storage.objects for all to authenticated
using (
  bucket_id = 'recipe-images'
  and (storage.foldername(name))[1] in (
    select household_id::text from public.household_members where user_id = auth.uid()
  )
)
with check (
  bucket_id = 'recipe-images'
  and (storage.foldername(name))[1] in (
    select household_id::text from public.household_members where user_id = auth.uid()
  )
);

-- ---------- Realtime ----------

alter publication supabase_realtime add table public.items;
alter publication supabase_realtime add table public.recipes;
