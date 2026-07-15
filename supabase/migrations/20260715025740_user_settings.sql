create schema if not exists "private";

revoke all on schema "private" from public;
grant usage on schema "private" to authenticated;


  create table "public"."user_settings" (
    "user_id" uuid not null,
    "blob" jsonb not null default '{}'::jsonb,
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."user_settings" enable row level security;

CREATE UNIQUE INDEX user_settings_pkey ON public.user_settings USING btree (user_id);

alter table "public"."user_settings" add constraint "user_settings_pkey" PRIMARY KEY using index "user_settings_pkey";

alter table "public"."user_settings" add constraint "user_settings_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."user_settings" validate constraint "user_settings_user_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.delete_own_account_internal()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function private.delete_own_account_internal() from public;
grant execute on function private.delete_own_account_internal() to authenticated;

CREATE OR REPLACE FUNCTION public.delete_own_account()
 RETURNS void
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.delete_own_account_internal();
$function$
;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;

CREATE OR REPLACE FUNCTION public.set_user_settings_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

revoke all on function public.set_user_settings_updated_at() from public;

revoke all on table "public"."user_settings" from anon;
revoke all on table "public"."user_settings" from authenticated;
grant select, insert, update, delete on table "public"."user_settings" to authenticated;


  create policy "Users delete their own settings"
  on "public"."user_settings"
  as permissive
  for delete
  to authenticated
using ((( SELECT auth.uid() AS uid) = user_id));



  create policy "Users insert their own settings"
  on "public"."user_settings"
  as permissive
  for insert
  to authenticated
with check ((( SELECT auth.uid() AS uid) = user_id));



  create policy "Users read their own settings"
  on "public"."user_settings"
  as permissive
  for select
  to authenticated
using ((( SELECT auth.uid() AS uid) = user_id));



  create policy "Users update their own settings"
  on "public"."user_settings"
  as permissive
  for update
  to authenticated
using ((( SELECT auth.uid() AS uid) = user_id))
with check ((( SELECT auth.uid() AS uid) = user_id));


CREATE TRIGGER set_user_settings_updated_at BEFORE INSERT OR UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.set_user_settings_updated_at();
