-- TrustLend RLS policies for Supabase
-- Apply after 001_schema.sql

-- =========================
-- Enable RLS
-- =========================

alter table public.profiles enable row level security;
alter table public.reputation_events enable row level security;
alter table public.reputation_snapshots enable row level security;
alter table public.tasks enable row level security;
alter table public.lending_pools enable row level security;
alter table public.pool_positions enable row level security;
alter table public.loans enable row level security;
alter table public.loan_repayments enable row level security;
alter table public.risk_assessments enable row level security;
alter table public.fraud_signals enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.chain_events enable row level security;
alter table public.external_verifications enable row level security;

-- =========================
-- Profiles
-- =========================

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles
for select
using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

-- =========================
-- Reputation data
-- =========================

drop policy if exists rep_events_select_own on public.reputation_events;
create policy rep_events_select_own
on public.reputation_events
for select
using (auth.uid() = user_id);

drop policy if exists rep_events_select_admin_all on public.reputation_events;
create policy rep_events_select_admin_all
on public.reputation_events
for select
using (public.is_admin());

drop policy if exists rep_events_write_admin on public.reputation_events;
create policy rep_events_write_admin
on public.reputation_events
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists rep_snapshots_select_own on public.reputation_snapshots;
create policy rep_snapshots_select_own
on public.reputation_snapshots
for select
using (auth.uid() = user_id);

drop policy if exists rep_snapshots_select_admin_all on public.reputation_snapshots;
create policy rep_snapshots_select_admin_all
on public.reputation_snapshots
for select
using (public.is_admin());

drop policy if exists rep_snapshots_write_admin on public.reputation_snapshots;
create policy rep_snapshots_write_admin
on public.reputation_snapshots
for all
using (public.is_admin())
with check (public.is_admin());

-- =========================
-- Tasks
-- =========================

drop policy if exists tasks_select_related on public.tasks;
create policy tasks_select_related
on public.tasks
for select
using (auth.uid() = creator_id or auth.uid() = assigned_to);

drop policy if exists tasks_insert_creator on public.tasks;
create policy tasks_insert_creator
on public.tasks
for insert
with check (auth.uid() = creator_id);

drop policy if exists tasks_update_creator_or_assignee on public.tasks;
create policy tasks_update_creator_or_assignee
on public.tasks
for update
using (auth.uid() = creator_id or auth.uid() = assigned_to)
with check (auth.uid() = creator_id or auth.uid() = assigned_to);

drop policy if exists tasks_write_admin on public.tasks;
create policy tasks_write_admin
on public.tasks
for all
using (public.is_admin())
with check (public.is_admin());

-- =========================
-- Lending pools and positions
-- =========================

drop policy if exists pools_select_authenticated on public.lending_pools;
create policy pools_select_authenticated
on public.lending_pools
for select
using (auth.role() = 'authenticated');

drop policy if exists pools_select_admin_all on public.lending_pools;
create policy pools_select_admin_all
on public.lending_pools
for select
using (public.is_admin());

drop policy if exists pools_write_admin on public.lending_pools;
create policy pools_write_admin
on public.lending_pools
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists pool_positions_select_own on public.pool_positions;
create policy pool_positions_select_own
on public.pool_positions
for select
using (auth.uid() = lender_id);

drop policy if exists pool_positions_insert_own on public.pool_positions;
create policy pool_positions_insert_own
on public.pool_positions
for insert
with check (auth.uid() = lender_id);

drop policy if exists pool_positions_update_own on public.pool_positions;
create policy pool_positions_update_own
on public.pool_positions
for update
using (auth.uid() = lender_id)
with check (auth.uid() = lender_id);

-- =========================
-- Loans and repayments
-- =========================

drop policy if exists loans_select_own on public.loans;
create policy loans_select_own
on public.loans
for select
using (
  auth.uid() = borrower_id
  or public.is_admin()
  or exists (
    select 1
    from public.ledger_transactions lt
    where lt.ref_type = 'loan_fund'
      and lt.ref_id = loans.id
      and (
        lt.user_id = auth.uid()
        or coalesce(lt.metadata->>'lenderUserId', '') = auth.uid()::text
      )
  )
);

drop policy if exists loans_select_admin_all on public.loans;
create policy loans_select_admin_all
on public.loans
for select
using (public.is_admin());

drop policy if exists loans_insert_own on public.loans;
create policy loans_insert_own
on public.loans
for insert
with check (auth.uid() = borrower_id);

drop policy if exists loans_update_admin on public.loans;
create policy loans_update_admin
on public.loans
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists repayments_select_related_loan on public.loan_repayments;
create policy repayments_select_related_loan
on public.loan_repayments
for select
using (
  exists (
    select 1 from public.loans l
    where l.id = loan_id and l.borrower_id = auth.uid()
  )
  or auth.uid() = payer_id
);

drop policy if exists repayments_select_admin_all on public.loan_repayments;
create policy repayments_select_admin_all
on public.loan_repayments
for select
using (public.is_admin());

drop policy if exists repayments_insert_own on public.loan_repayments;
create policy repayments_insert_own
on public.loan_repayments
for insert
with check (
  auth.uid() = payer_id
  and exists (
    select 1 from public.loans l
    where l.id = loan_id and l.borrower_id = auth.uid()
  )
);

drop policy if exists repayments_write_admin on public.loan_repayments;
create policy repayments_write_admin
on public.loan_repayments
for all
using (public.is_admin())
with check (public.is_admin());

-- =========================
-- Risk and fraud
-- =========================

drop policy if exists risk_assessments_select_own on public.risk_assessments;
create policy risk_assessments_select_own
on public.risk_assessments
for select
using (auth.uid() = user_id);

drop policy if exists risk_assessments_write_admin on public.risk_assessments;
create policy risk_assessments_write_admin
on public.risk_assessments
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists fraud_signals_select_own on public.fraud_signals;
create policy fraud_signals_select_own
on public.fraud_signals
for select
using (auth.uid() = user_id);

drop policy if exists fraud_signals_write_admin on public.fraud_signals;
create policy fraud_signals_write_admin
on public.fraud_signals
for all
using (public.is_admin())
with check (public.is_admin());

-- =========================
-- Ledger and chain mapping
-- =========================

drop policy if exists ledger_select_own on public.ledger_transactions;
create policy ledger_select_own
on public.ledger_transactions
for select
using (
  auth.uid() = user_id
  or coalesce(metadata->>'lenderUserId', '') = auth.uid()::text
);

drop policy if exists ledger_select_admin_all on public.ledger_transactions;
create policy ledger_select_admin_all
on public.ledger_transactions
for select
using (public.is_admin());

drop policy if exists ledger_insert_own on public.ledger_transactions;
create policy ledger_insert_own
on public.ledger_transactions
for insert
with check (auth.uid() = user_id);

drop policy if exists ledger_write_admin on public.ledger_transactions;
create policy ledger_write_admin
on public.ledger_transactions
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists chain_events_select_authenticated on public.chain_events;
create policy chain_events_select_authenticated
on public.chain_events
for select
using (auth.role() = 'authenticated');

drop policy if exists chain_events_write_admin on public.chain_events;
create policy chain_events_write_admin
on public.chain_events
for all
using (public.is_admin())
with check (public.is_admin());

-- =========================
-- External verification
-- =========================

drop policy if exists external_verifications_select_own on public.external_verifications;
create policy external_verifications_select_own
on public.external_verifications
for select
using (auth.uid() = user_id);

drop policy if exists external_verifications_write_admin on public.external_verifications;
create policy external_verifications_write_admin
on public.external_verifications
for all
using (public.is_admin())
with check (public.is_admin());
-- TrustLend RLS Fix v2: Eliminate infinite recursion + fix "new row violates RLS" on UPDATE
-- 

-- =====================================================================
-- Step 1: Drop ALL conflicting policies on profiles
-- =====================================================================

DROP POLICY IF EXISTS profiles_select_own           ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own           ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_select_all     ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_update_all     ON public.profiles;
DROP POLICY IF EXISTS profiles_service_all          ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile"        ON public.profiles;
DROP POLICY IF EXISTS "Users can view own KYC status"     ON public.profiles;
DROP POLICY IF EXISTS "Admins can view all profiles"      ON public.profiles;
DROP POLICY IF EXISTS "Admins can view all KYC documents" ON public.profiles;
DROP POLICY IF EXISTS "Users can only update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile"      ON public.profiles;
DROP POLICY IF EXISTS "Admins can update KYC status"      ON public.profiles;
DROP POLICY IF EXISTS "Admins can update all profiles"    ON public.profiles;

-- =====================================================================
-- Step 2: Create a SECURITY DEFINER function to safely check admin role
-- This bypasses RLS when checking the caller's own role â†’ no recursion.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- =====================================================================
-- Step 3: Recreate clean, non-recursive policies
-- =====================================================================

-- SELECT: users see only their own row
CREATE POLICY profiles_select_own
ON public.profiles
FOR SELECT
USING (auth.uid() = id);

-- SELECT: admins see all rows (via security-definer fn â€” no recursion)
CREATE POLICY profiles_admin_select_all
ON public.profiles
FOR SELECT
USING (public.is_admin());

-- The app layer uses session-bound writes, so this is defense-in-depth.
CREATE POLICY profiles_update_own
ON public.profiles
FOR UPDATE
USING (auth.uid() = id);

-- UPDATE: admins can update any row
CREATE POLICY profiles_admin_update_all
ON public.profiles
FOR UPDATE
USING (public.is_admin());

-- ALL: admin bypasses RLS for backend jobs / server actions
CREATE POLICY profiles_admin_all
ON public.profiles
FOR ALL
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- =====================================================================
-- Step 4: Add date_of_birth column if it doesn't exist (for legal KYC)
-- =====================================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS date_of_birth date;

-- =====================================================================
-- Step 5: Ensure kyc_submitted_at column exists (used by kyc-upload.ts)
-- =====================================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS kyc_submitted_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS government_id_ipfs_hash text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS government_id_url text;
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
-- TrustLend KYC Storage RLS
-- Grants authenticated users access to their own KYC uploads without using a service-role key.

-- Ensure the KYC bucket exists and remains private.
insert into storage.buckets (id, name, public)
values ('kyc-documents', 'kyc-documents', false)
on conflict (id) do update
set public = excluded.public;

-- storage.objects already has RLS managed by Supabase Storage internals.

drop policy if exists "Users can upload their own KYC" on storage.objects;
create policy "Users can upload their own KYC"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'kyc-documents'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists "Users can view own KYC documents" on storage.objects;
create policy "Users can view own KYC documents"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'kyc-documents'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists "Admins can view all KYC documents" on storage.objects;
create policy "Admins can view all KYC documents"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'kyc-documents'
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = 'admin'
  )
);

drop policy if exists "Documents cannot be deleted" on storage.objects;
create policy "Documents cannot be deleted"
on storage.objects
for delete
to authenticated
using (false);
-- TrustLend migration: remove service-role dependence from app flows.
-- Replaces privileged writes with guarded RPCs and a reputation snapshot trigger.

-- -----------------------------------------------------------------------------
-- Marketplace reads
-- -----------------------------------------------------------------------------

drop policy if exists loans_select_open_authenticated on public.loans;
create policy loans_select_open_authenticated
on public.loans
for select
using (
  auth.role() = 'authenticated'
  and status in ('requested', 'approved')
);

-- -----------------------------------------------------------------------------
-- Reputation events and snapshots
-- -----------------------------------------------------------------------------

drop policy if exists rep_events_insert_own on public.reputation_events;
create policy rep_events_insert_own
on public.reputation_events
for insert
with check (auth.uid() = user_id);

create or replace function public.sync_reputation_snapshot_from_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_repayment_score integer := 0;
  existing_lending_score integer := 0;
  existing_consistency_score integer := 0;
  existing_external_score integer := 0;
  existing_level text := 'bronze';
  total_points integer := 0;
  computed_total integer := 250;
begin
  if new.user_id is null then
    return new;
  end if;

  select
    coalesce(score_total, 250),
    coalesce(repayment_score, 0),
    coalesce(lending_score, 0),
    coalesce(consistency_score, 0),
    coalesce(external_score, 0),
    coalesce(reputation_level, 'bronze')
  into computed_total, existing_repayment_score, existing_lending_score, existing_consistency_score, existing_external_score, existing_level
  from public.reputation_snapshots
  where user_id = new.user_id;

  select coalesce(sum(points_delta), 0)
  into total_points
  from public.reputation_events
  where user_id = new.user_id;

  computed_total := greatest(0, least(750, 250 + total_points));

  insert into public.reputation_snapshots (
    user_id,
    score_total,
    repayment_score,
    lending_score,
    consistency_score,
    external_score,
    reputation_level,
    calculated_at,
    updated_at
  )
  values (
    new.user_id,
    computed_total,
    existing_repayment_score,
    existing_lending_score,
    existing_consistency_score,
    existing_external_score,
    existing_level,
    now(),
    now()
  )
  on conflict (user_id) do update
    set score_total = excluded.score_total,
        repayment_score = excluded.repayment_score,
        lending_score = excluded.lending_score,
        consistency_score = excluded.consistency_score,
        external_score = excluded.external_score,
        reputation_level = excluded.reputation_level,
        calculated_at = excluded.calculated_at,
        updated_at = excluded.updated_at;

  return new;
end;
$$;

drop trigger if exists trg_reputation_events_snapshot on public.reputation_events;
create trigger trg_reputation_events_snapshot
after insert on public.reputation_events
for each row execute function public.sync_reputation_snapshot_from_event();

grant execute on function public.sync_reputation_snapshot_from_event() to authenticated;

create or replace function public.seed_reputation_snapshot(
  p_user_id uuid,
  p_initial_score integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  insert into public.reputation_snapshots (
    user_id,
    score_total,
    updated_at
  )
  values (
    p_user_id,
    greatest(0, least(750, p_initial_score)),
    now()
  )
  on conflict (user_id) do update
    set score_total = excluded.score_total,
        updated_at = excluded.updated_at;
end;
$$;

grant execute on function public.seed_reputation_snapshot(uuid, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- Loan funding and repayment transitions
-- -----------------------------------------------------------------------------

create or replace function public.activate_loan_funding(
  p_loan_id uuid,
  p_lender_id uuid,
  p_approved_at timestamptz,
  p_due_at timestamptz
)
returns public.loans
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_loan public.loans;
begin
  if auth.uid() is distinct from p_lender_id then
    raise exception 'not authorized';
  end if;

  update public.loans
  set status = 'active',
      approved_at = p_approved_at,
      due_at = p_due_at
  where id = p_loan_id
    and status in ('requested', 'approved')
    and borrower_id <> p_lender_id
  returning * into updated_loan;

  if not found then
    raise exception 'loan not available for funding';
  end if;

  return updated_loan;
end;
$$;

grant execute on function public.activate_loan_funding(uuid, uuid, timestamptz, timestamptz) to authenticated;

create or replace function public.record_loan_repayment(
  p_loan_id uuid,
  p_payer_id uuid,
  p_repaid_amount numeric,
  p_new_status public.loan_status
)
returns public.loans
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_loan public.loans;
begin
  if auth.uid() is distinct from p_payer_id then
    raise exception 'not authorized';
  end if;

  update public.loans
  set repaid_amount = p_repaid_amount,
      status = p_new_status
  where id = p_loan_id
    and borrower_id = p_payer_id
    and status <> 'defaulted'
  returning * into updated_loan;

  if not found then
    raise exception 'loan not available for repayment';
  end if;

  return updated_loan;
end;
$$;

grant execute on function public.record_loan_repayment(uuid, uuid, numeric, public.loan_status) to authenticated;

-- -----------------------------------------------------------------------------
-- Lender dashboard metrics without service-role reads
-- -----------------------------------------------------------------------------

create or replace function public.get_lender_dashboard_metrics(p_user_id uuid)
returns table (
  deployed_capital numeric,
  total_earnings numeric,
  active_positions integer,
  default_rate numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with pool_stats as (
    select
      coalesce(sum(principal_amount), 0) as deployed_capital,
      coalesce(sum(earned_interest), 0) as total_earnings,
      count(*) filter (where status = 'active')::integer as active_positions
    from public.pool_positions
    where lender_id = p_user_id
  ),
  p2p_funds as (
    select
      coalesce(sum(amount), 0) as deployed_capital,
      count(*) filter (where l.status in ('requested', 'approved', 'funded', 'active'))::integer as active_positions
    from public.ledger_transactions lt
    left join public.loans l on l.id = lt.ref_id
    where lt.user_id = p_user_id
      and lt.ref_type = 'loan_fund'
  ),
  p2p_repayments as (
    select coalesce(sum(amount), 0) as total_repaid
    from public.ledger_transactions
    where ref_type = 'loan_repay'
      and coalesce(metadata->>'lenderUserId', '') = p_user_id::text
  ),
  loan_stats as (
    select
      count(*) filter (where status = 'defaulted')::numeric as bad,
      count(*) filter (where status in ('repaid', 'defaulted'))::numeric as closed
    from public.loans
  )
  select
    coalesce((select deployed_capital from pool_stats), 0) + coalesce((select deployed_capital from p2p_funds), 0) as deployed_capital,
    coalesce((select total_earnings from pool_stats), 0) + greatest(0, coalesce((select total_repaid from p2p_repayments), 0) - coalesce((select deployed_capital from p2p_funds), 0)) as total_earnings,
    coalesce((select active_positions from pool_stats), 0) + coalesce((select active_positions from p2p_funds), 0) as active_positions,
    case
      when coalesce((select closed from loan_stats), 0) > 0 then
        (coalesce((select bad from loan_stats), 0) / coalesce((select closed from loan_stats), 1)) * 100
      else 0
    end as default_rate;
$$;

grant execute on function public.get_lender_dashboard_metrics(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Marketplace summary data without broad profile access
-- -----------------------------------------------------------------------------

create or replace function public.get_marketplace_loans()
returns table (
  id uuid,
  principal_amount numeric,
  apr_bps integer,
  duration_days integer,
  borrower_id uuid,
  borrower_name text,
  borrower_wallet text,
  trust_score integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.principal_amount,
    l.apr_bps,
    l.duration_days,
    l.borrower_id,
    case
      when coalesce(nullif(p.full_name, ''), '') <> '' then p.full_name
      else 'Borrower ' || left(l.borrower_id::text, 6)
    end as borrower_name,
    coalesce(p.wallet_address, '') as borrower_wallet,
    coalesce(rs.score_total, 250) as trust_score
  from public.loans l
  left join public.profiles p on p.id = l.borrower_id
  left join public.reputation_snapshots rs on rs.user_id = l.borrower_id
  where l.status in ('requested', 'approved')
  order by l.created_at asc;
$$;

grant execute on function public.get_marketplace_loans() to authenticated;
