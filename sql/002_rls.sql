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

drop policy if exists rep_events_write_service on public.reputation_events;
create policy rep_events_write_service
on public.reputation_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists rep_snapshots_select_own on public.reputation_snapshots;
create policy rep_snapshots_select_own
on public.reputation_snapshots
for select
using (auth.uid() = user_id);

drop policy if exists rep_snapshots_write_service on public.reputation_snapshots;
create policy rep_snapshots_write_service
on public.reputation_snapshots
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

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

drop policy if exists tasks_write_service on public.tasks;
create policy tasks_write_service
on public.tasks
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- =========================
-- Lending pools and positions
-- =========================

drop policy if exists pools_select_authenticated on public.lending_pools;
create policy pools_select_authenticated
on public.lending_pools
for select
using (auth.role() = 'authenticated');

drop policy if exists pools_write_service on public.lending_pools;
create policy pools_write_service
on public.lending_pools
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

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
using (auth.uid() = borrower_id);

drop policy if exists loans_insert_own on public.loans;
create policy loans_insert_own
on public.loans
for insert
with check (auth.uid() = borrower_id);

drop policy if exists loans_update_service on public.loans;
create policy loans_update_service
on public.loans
for update
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

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

drop policy if exists repayments_write_service on public.loan_repayments;
create policy repayments_write_service
on public.loan_repayments
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- =========================
-- Risk and fraud
-- =========================

drop policy if exists risk_assessments_select_own on public.risk_assessments;
create policy risk_assessments_select_own
on public.risk_assessments
for select
using (auth.uid() = user_id);

drop policy if exists risk_assessments_write_service on public.risk_assessments;
create policy risk_assessments_write_service
on public.risk_assessments
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists fraud_signals_select_own on public.fraud_signals;
create policy fraud_signals_select_own
on public.fraud_signals
for select
using (auth.uid() = user_id);

drop policy if exists fraud_signals_write_service on public.fraud_signals;
create policy fraud_signals_write_service
on public.fraud_signals
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- =========================
-- Ledger and chain mapping
-- =========================

drop policy if exists ledger_select_own on public.ledger_transactions;
create policy ledger_select_own
on public.ledger_transactions
for select
using (auth.uid() = user_id);

drop policy if exists ledger_insert_own on public.ledger_transactions;
create policy ledger_insert_own
on public.ledger_transactions
for insert
with check (auth.uid() = user_id);

drop policy if exists ledger_write_service on public.ledger_transactions;
create policy ledger_write_service
on public.ledger_transactions
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists chain_events_select_authenticated on public.chain_events;
create policy chain_events_select_authenticated
on public.chain_events
for select
using (auth.role() = 'authenticated');

drop policy if exists chain_events_write_service on public.chain_events;
create policy chain_events_write_service
on public.chain_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- =========================
-- External verification
-- =========================

drop policy if exists external_verifications_select_own on public.external_verifications;
create policy external_verifications_select_own
on public.external_verifications
for select
using (auth.uid() = user_id);

drop policy if exists external_verifications_write_service on public.external_verifications;
create policy external_verifications_write_service
on public.external_verifications
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');