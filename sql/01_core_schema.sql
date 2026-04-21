-- TrustLend core schema for Supabase
-- Apply first

create extension if not exists pgcrypto;

-- =========================
-- Enums
-- =========================

do $$ begin
  create type public.app_role as enum ('borrower', 'lender', 'admin');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.kyc_status as enum ('pending', 'submitted', 'verified', 'rejected');
exception
  when duplicate_object then null;
end $$;

alter type public.kyc_status add value if not exists 'submitted';

do $$ begin
  create type public.risk_status as enum ('low', 'medium', 'high', 'blocked');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.loan_status as enum ('requested', 'approved', 'funded', 'active', 'repaid', 'defaulted', 'cancelled');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.pool_status as enum ('active', 'paused', 'closed');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.position_status as enum ('active', 'closed');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.tx_status as enum ('pending', 'confirmed', 'failed', 'cancelled');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.verification_status as enum ('pending', 'verified', 'rejected', 'expired');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.task_status as enum ('open', 'assigned', 'completed', 'verified', 'cancelled');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.task_difficulty as enum ('easy', 'medium', 'hard');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.risk_decision as enum ('allow', 'manual_review', 'reject');
exception
  when duplicate_object then null;
end $$;

-- =========================
-- Utility functions
-- =========================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  derived_role public.app_role;
begin
  derived_role := case
    when new.raw_user_meta_data ->> 'account_type' in ('borrower', 'lender', 'admin')
      then (new.raw_user_meta_data ->> 'account_type')::public.app_role
    else 'borrower'::public.app_role
  end;

  insert into public.profiles (
    id,
    full_name,
    role,
    kyc_status,
    risk_status
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    derived_role,
    'pending'::public.kyc_status,
    'medium'::public.risk_status
  )
  on conflict (id) do nothing;

  return new;
exception
  when others then
    return new;
end;
$$;

-- =========================
-- Core identity/profile
-- =========================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role public.app_role not null default 'borrower',
  wallet_address text,
  country_code text,
  phone text,
  kyc_status public.kyc_status not null default 'pending',
  risk_status public.risk_status not null default 'medium',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_profiles_wallet_address on public.profiles(wallet_address);
create index if not exists idx_profiles_kyc_status on public.profiles(kyc_status);
create index if not exists idx_profiles_risk_status on public.profiles(risk_status);

-- =========================
-- Reputation
-- =========================

create table if not exists public.reputation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_type text not null,
  source_id uuid,
  source_key text,
  points_delta integer not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_rep_events_user_id_created_at on public.reputation_events(user_id, created_at desc);
create index if not exists idx_rep_events_source on public.reputation_events(source_type, source_id);
create index if not exists idx_rep_events_source_key on public.reputation_events(source_type, source_key);

create table if not exists public.reputation_snapshots (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  score_total integer not null default 0,
  repayment_score integer not null default 0,
  lending_score integer not null default 0,
  consistency_score integer not null default 0,
  external_score integer not null default 0,
  reputation_level text not null default 'bronze',
  calculated_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =========================
-- Tasks
-- =========================

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  assigned_to uuid references public.profiles(id) on delete set null,
  title text not null,
  description text,
  category text,
  reward_xlm numeric(20, 6) not null default 0 check (reward_xlm >= 0),
  difficulty public.task_difficulty not null default 'easy',
  status public.task_status not null default 'open',
  completion_deadline timestamptz,
  completion_date timestamptz,
  proof_submission text,
  creator_rating smallint check (creator_rating between 1 and 5),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tasks_creator_id on public.tasks(creator_id);
create index if not exists idx_tasks_assigned_to on public.tasks(assigned_to);
create index if not exists idx_tasks_status on public.tasks(status);
create index if not exists idx_tasks_created_at on public.tasks(created_at desc);

-- =========================
-- Lending pools and positions
-- =========================

create table if not exists public.lending_pools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status public.pool_status not null default 'active',
  currency text not null default 'XLM',
  apr_bps integer not null check (apr_bps >= 0 and apr_bps <= 100000),
  total_liquidity numeric(20, 6) not null default 0,
  available_liquidity numeric(20, 6) not null default 0,
  total_borrowed numeric(20, 6) not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_lending_pools_status on public.lending_pools(status);

create table if not exists public.pool_positions (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.lending_pools(id) on delete cascade,
  lender_id uuid not null references public.profiles(id) on delete cascade,
  status public.position_status not null default 'active',
  principal_amount numeric(20, 6) not null check (principal_amount >= 0),
  earned_interest numeric(20, 6) not null default 0 check (earned_interest >= 0),
  withdrawn_amount numeric(20, 6) not null default 0 check (withdrawn_amount >= 0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pool_positions_lender_id on public.pool_positions(lender_id);
create index if not exists idx_pool_positions_pool_id on public.pool_positions(pool_id);

-- =========================
-- Loans and repayments
-- =========================

create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  borrower_id uuid not null references public.profiles(id) on delete cascade,
  pool_id uuid not null references public.lending_pools(id) on delete restrict,
  status public.loan_status not null default 'requested',
  principal_amount numeric(20, 6) not null check (principal_amount > 0),
  apr_bps integer not null check (apr_bps >= 0 and apr_bps <= 100000),
  duration_days integer not null check (duration_days > 0),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  funded_at timestamptz,
  due_at timestamptz,
  closed_at timestamptz,
  repaid_amount numeric(20, 6) not null default 0 check (repaid_amount >= 0),
  defaulted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_loans_borrower_id on public.loans(borrower_id);
create index if not exists idx_loans_pool_id on public.loans(pool_id);
create index if not exists idx_loans_status on public.loans(status);
create index if not exists idx_loans_due_at on public.loans(due_at);

create table if not exists public.loan_repayments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  payer_id uuid not null references public.profiles(id) on delete restrict,
  amount numeric(20, 6) not null check (amount > 0),
  paid_at timestamptz not null default now(),
  tx_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_loan_repayments_loan_id on public.loan_repayments(loan_id);
create index if not exists idx_loan_repayments_payer_id on public.loan_repayments(payer_id);

-- =========================
-- Risk and fraud
-- =========================

create table if not exists public.risk_assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  score numeric(5, 2) not null check (score >= 0 and score <= 100),
  decision public.risk_decision not null,
  reasons jsonb not null default '[]'::jsonb,
  assessed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_risk_assessments_user_id_assessed_at on public.risk_assessments(user_id, assessed_at desc);

create table if not exists public.fraud_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  signal_type text not null,
  severity smallint not null check (severity between 1 and 5),
  payload jsonb not null default '{}'::jsonb,
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_fraud_signals_user_id_created_at on public.fraud_signals(user_id, created_at desc);
create index if not exists idx_fraud_signals_resolved on public.fraud_signals(resolved);

-- =========================
-- Ledger and chain mapping
-- =========================

create table if not exists public.ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null,
  amount numeric(20, 6) not null,
  currency text not null default 'XLM',
  status public.tx_status not null default 'pending',
  ref_type text,
  ref_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ledger_transactions_user_id_created_at on public.ledger_transactions(user_id, created_at desc);
create index if not exists idx_ledger_transactions_status on public.ledger_transactions(status);

create table if not exists public.chain_events (
  id uuid primary key default gen_random_uuid(),
  tx_hash text not null,
  contract_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  happened_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tx_hash, event_type)
);

create index if not exists idx_chain_events_contract_id on public.chain_events(contract_id);
create index if not exists idx_chain_events_happened_at on public.chain_events(happened_at desc);

-- =========================
-- External verification
-- =========================

create table if not exists public.external_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  verification_type text not null,
  status public.verification_status not null default 'pending',
  verified_at timestamptz,
  payload_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_external_verifications_user_id on public.external_verifications(user_id);
create index if not exists idx_external_verifications_status on public.external_verifications(status);

-- =========================
-- Triggers
-- =========================

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_reputation_snapshots_updated_at on public.reputation_snapshots;
create trigger trg_reputation_snapshots_updated_at
before update on public.reputation_snapshots
for each row execute function public.set_updated_at();

drop trigger if exists trg_tasks_updated_at on public.tasks;
create trigger trg_tasks_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

drop trigger if exists trg_lending_pools_updated_at on public.lending_pools;
create trigger trg_lending_pools_updated_at
before update on public.lending_pools
for each row execute function public.set_updated_at();

drop trigger if exists trg_pool_positions_updated_at on public.pool_positions;
create trigger trg_pool_positions_updated_at
before update on public.pool_positions
for each row execute function public.set_updated_at();

drop trigger if exists trg_loans_updated_at on public.loans;
create trigger trg_loans_updated_at
before update on public.loans
for each row execute function public.set_updated_at();

drop trigger if exists trg_ledger_transactions_updated_at on public.ledger_transactions;
create trigger trg_ledger_transactions_updated_at
before update on public.ledger_transactions
for each row execute function public.set_updated_at();

drop trigger if exists trg_external_verifications_updated_at on public.external_verifications;
create trigger trg_external_verifications_updated_at
before update on public.external_verifications
for each row execute function public.set_updated_at();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user_profile();
-- Add wallet_address support to profiles table
-- Apply for existing databases created before wallet_address was introduced.

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS wallet_address TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_wallet_address
ON public.profiles(wallet_address);
-- TrustLend task-completion reputation key migration
-- Stores task slugs in source_key so task completion events do not depend on UUID casting.

alter table public.reputation_events
  add column if not exists source_key text;

create index if not exists idx_rep_events_source_key
  on public.reputation_events(source_type, source_key);
-- TRUSTLEND: KYC (Know Your Customer) Verification Schema
-- Add these columns to the existing 'profiles' table in Supabase

-- 1. Add KYC verification columns to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS government_id_ipfs_hash VARCHAR(255);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS government_id_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS kyc_verified_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT;

-- 2. Add indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_profiles_kyc_status ON profiles(kyc_status);
CREATE INDEX IF NOT EXISTS idx_profiles_kyc_submitted_at ON profiles(kyc_submitted_at);

-- 2.1 Ensure enum supports new workflow status used by upload/review flow
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'kyc_status' AND n.nspname = 'public'
  ) THEN
    ALTER TYPE public.kyc_status ADD VALUE IF NOT EXISTS 'submitted';
  END IF;
END $$;

-- 3. Row Level Security (RLS) Policy: Only admins can view unverified KYC documents
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Users can view own KYC status" ON profiles;
DROP POLICY IF EXISTS "Admins can view all KYC documents" ON profiles;
DROP POLICY IF EXISTS "Users can only update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Admins can view all profiles" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Admins can update KYC status" ON profiles;

-- New RLS Policies:

-- Policy 1: Users can view only their own basic profile
CREATE POLICY "Users can view own profile"
  ON profiles
  FOR SELECT
  USING (auth.uid() = id);

-- Policy 2: Admins can view all profiles including sensitive KYC data
CREATE POLICY "Admins can view all profiles"
  ON profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
      AND profiles.role = 'admin'
    )
  );

-- Policy 3: Users can update only their own profile
CREATE POLICY "Users can update own profile"
  ON profiles
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Policy 4: Admins can update KYC status
CREATE POLICY "Admins can update KYC status"
  ON profiles
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
      AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
      AND profiles.role = 'admin'
    )
  );

-- 4. Create view for admin KYC dashboard (optional but useful)
DROP VIEW IF EXISTS admin_kyc_queue;

CREATE OR REPLACE VIEW admin_kyc_queue AS
SELECT 
  id,
  full_name,
  kyc_status,
  government_id_ipfs_hash,
  government_id_url,
  kyc_submitted_at,
  kyc_verified_at,
  kyc_rejection_reason
FROM profiles
WHERE kyc_status IN ('submitted', 'rejected', 'verified')
ORDER BY kyc_submitted_at DESC;

-- GRANT admin_kyc_queue view access in Supabase dashboard
-- (This is automatic for authenticated users, but restrict to admins via application logic)
