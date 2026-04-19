-- TrustLend MVP Security Hardening
-- Purpose:
-- 1) Prevent users from self-escalating role/kyc/risk via profile updates.
-- 2) Keep normal profile field updates working for authenticated users.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to authenticated;

-- Security-definer function to compare immutable/sensitive profile fields
-- against the existing stored row without hitting RLS recursion.
create or replace function public.profile_sensitive_fields_unchanged(
  _id uuid,
  _role public.app_role,
  _kyc public.kyc_status,
  _risk public.risk_status
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = _id
      and p.role = _role
      and (
        p.kyc_status = _kyc
        or (
          p.kyc_status in ('pending', 'rejected')
          and _kyc = 'submitted'
        )
      )
      and p.risk_status = _risk
  );
$$;

grant execute on function public.profile_sensitive_fields_unchanged(uuid, public.app_role, public.kyc_status, public.risk_status) to authenticated;

-- Replace update-own policy with a version that prevents sensitive field tampering.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles
for update
using (auth.uid() = id)
with check (
  auth.uid() = id
  and public.profile_sensitive_fields_unchanged(id, role, kyc_status, risk_status)
);

drop policy if exists profiles_admin_select_all on public.profiles;
create policy profiles_admin_select_all
on public.profiles
for select
using (public.is_admin());

drop policy if exists profiles_admin_update_all on public.profiles;
create policy profiles_admin_update_all
on public.profiles
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists loans_admin_select_all on public.loans;
create policy loans_admin_select_all
on public.loans
for select
using (public.is_admin());

drop policy if exists loans_admin_update_all on public.loans;
create policy loans_admin_update_all
on public.loans
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists pools_admin_read_all on public.lending_pools;
create policy pools_admin_read_all
on public.lending_pools
for select
using (public.is_admin());

drop policy if exists pools_admin_write_all on public.lending_pools;
create policy pools_admin_write_all
on public.lending_pools
for all
using (public.is_admin())
with check (public.is_admin());
