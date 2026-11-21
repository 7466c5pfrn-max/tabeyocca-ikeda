-- 使うのは夫婦2人だけなので、招待コードをやめ、ログインしたら1つの家庭に自動で入るようにする。
-- 新規登録（サインアップ）はダッシュボードで無効にしておくこと。念のため家庭の人数も2人までに制限する。

create or replace function public.enter_household(p_display_name text)
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

  select household_id into hid from public.household_members
  where user_id = auth.uid() limit 1;
  if hid is not null then
    return hid;
  end if;

  select id into hid from public.households order by created_at limit 1;
  if hid is null then
    insert into public.households default values returning id into hid;
  elsif (select count(*) from public.household_members where household_id = hid) >= 2 then
    raise exception 'household is full';
  end if;

  insert into public.household_members (household_id, user_id, display_name)
  values (hid, auth.uid(), coalesce(trim(p_display_name), ''));
  return hid;
end;
$$;

revoke all on function public.enter_household(text) from public, anon;
grant execute on function public.enter_household(text) to authenticated;

drop function if exists public.create_household(text, text);
drop function if exists public.join_household(text, text);
