create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  blob jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

revoke all on table public.user_settings from anon;
revoke all on table public.user_settings from authenticated;
grant select, insert, update, delete on table public.user_settings to authenticated;

create policy "Users read their own settings"
on public.user_settings
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users insert their own settings"
on public.user_settings
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users update their own settings"
on public.user_settings
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users delete their own settings"
on public.user_settings
for delete
to authenticated
using ((select auth.uid()) = user_id);

create function public.set_user_settings_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_user_settings_updated_at() from public;

create trigger set_user_settings_updated_at
before insert or update on public.user_settings
for each row execute function public.set_user_settings_updated_at();

-- auth.admin.deleteUser requires a service-role key and therefore cannot run
-- in a public desktop client. Keep the privileged delete in a non-exposed
-- schema and expose only an authenticated, invoker-rights wrapper.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create function private.delete_own_account_internal()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'Authentication required';
  end if;

  delete from auth.users where id = caller;
  if not found then
    raise exception 'Account not found';
  end if;
end;
$$;

revoke all on function private.delete_own_account_internal() from public;
grant execute on function private.delete_own_account_internal() to authenticated;

create function public.delete_own_account()
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.delete_own_account_internal();
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;
