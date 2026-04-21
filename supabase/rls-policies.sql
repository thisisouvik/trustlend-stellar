-- =============================================================================
-- TrustLend — Supabase RLS Policies
-- Run these in your Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- These replace the need for the service role key in most read queries.
-- =============================================================================

-- ── loans ─────────────────────────────────────────────────────────────────────

-- Borrowers see their own loans
CREATE POLICY "borrower_own_loans"
  ON loans FOR SELECT
  USING (borrower_id = auth.uid());

-- Lenders (and anyone authenticated) see open/approved loans in the marketplace
CREATE POLICY "lender_sees_open_loans"
  ON loans FOR SELECT
  USING (status IN ('requested', 'approved'));

-- Lenders see loans they directly funded (via ledger lookup is handled separately)
-- (The above two policies cover all cases for MVP)

-- ── profiles ──────────────────────────────────────────────────────────────────

-- Users see their own profile
CREATE POLICY "own_profile"
  ON profiles FOR SELECT
  USING (id = auth.uid());

-- Authenticated users can see the public fields of other profiles
-- (needed for marketplace: borrower name + wallet address)
CREATE POLICY "public_profile_read"
  ON profiles FOR SELECT
  USING (auth.role() = 'authenticated');

-- ── reputation_snapshots ──────────────────────────────────────────────────────

-- Users see their own reputation snapshot
CREATE POLICY "own_reputation"
  ON reputation_snapshots FOR SELECT
  USING (user_id = auth.uid());

-- Authenticated users can see others' trust scores (needed for marketplace)
CREATE POLICY "public_reputation_read"
  ON reputation_snapshots FOR SELECT
  USING (auth.role() = 'authenticated');

-- ── pool_positions ────────────────────────────────────────────────────────────

-- Lenders see only their own positions
CREATE POLICY "own_pool_positions"
  ON pool_positions FOR SELECT
  USING (lender_id = auth.uid());

-- ── lending_pools ─────────────────────────────────────────────────────────────

-- Anyone authenticated can see pools (needed for lender deposit form)
CREATE POLICY "authenticated_see_pools"
  ON lending_pools FOR SELECT
  USING (auth.role() = 'authenticated');

-- =============================================================================
-- IMPORTANT: After applying these policies, the service role key is only
-- needed for WRITE operations by admins (approving KYC, etc.) and for
-- counting total loans in admin metrics. All read queries on the lender
-- marketplace can switch back to the session-bound client.
-- =============================================================================
