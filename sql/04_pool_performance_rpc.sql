/**
 * MIGRATION: 04_pool_performance_rpc.sql
 * 
 * PURPOSE: Add optimized RPC function for fetching lending pools with filters
 * to replace waterfall queries in pool admin operations.
 * 
 * ISSUE: #39 - Optimize Supabase database query performance for large pool lists
 * 
 * PERFORMANCE IMPROVEMENTS:
 * - Consolidates multiple sequential queries into ONE RPC call
 * - Enables atomic operations for pool status changes
 * - Reduces network round-trips from N to 1
 * - Returns pre-filtered, pre-sorted data from database
 */

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: get_lending_pools_paginated
-- ─────────────────────────────────────────────────────────────────────────────
-- 
-- Fetches paginated lending pools with optional status filter.
-- Returns only explicit columns (no SELECT *) for better performance.
-- 
-- USAGE:
--   SELECT * FROM public.get_lending_pools_paginated(
--     status_filter := 'active',
--     page_limit := 10,
--     page_offset := 0,
--     order_by_col := 'created_at',
--     order_asc := false
--   );

drop function if exists public.get_lending_pools_paginated(
  public.pool_status,
  integer,
  integer,
  text,
  boolean
) cascade;

create or replace function public.get_lending_pools_paginated(
  status_filter public.pool_status default null,
  page_limit integer default 10,
  page_offset integer default 0,
  order_by_col text default 'created_at',
  order_asc boolean default false
)
returns table (
  id uuid,
  name text,
  description text,
  status public.pool_status,
  apr_bps integer,
  total_liquidity numeric,
  available_liquidity numeric,
  total_borrowed numeric,
  created_at timestamptz,
  updated_at timestamptz,
  total_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  with filtered_pools as (
    select
      lending_pools.id,
      lending_pools.name,
      lending_pools.description,
      lending_pools.status,
      lending_pools.apr_bps,
      lending_pools.total_liquidity,
      lending_pools.available_liquidity,
      lending_pools.total_borrowed,
      lending_pools.created_at,
      lending_pools.updated_at,
      count(*) over () as total_count
    from public.lending_pools
    where (status_filter is null or status = status_filter)
  ),
  ordered_pools as (
    select * from filtered_pools
    order by
      case
        when order_by_col = 'created_at' and order_asc then created_at asc
        when order_by_col = 'created_at' and not order_asc then created_at desc
        when order_by_col = 'available_liquidity' and order_asc then available_liquidity asc
        when order_by_col = 'available_liquidity' and not order_asc then available_liquidity desc
        when order_by_col = 'total_liquidity' and order_asc then total_liquidity asc
        when order_by_col = 'total_liquidity' and not order_asc then total_liquidity desc
        else created_at desc
      end
    limit page_limit
    offset page_offset
  )
  select * from ordered_pools;
$$;

-- Grant execute to service role and authenticated users (admin check is in application)
grant execute on function public.get_lending_pools_paginated(
  public.pool_status,
  integer,
  integer,
  text,
  boolean
) to service_role, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: get_active_pools_with_liquidity
-- ─────────────────────────────────────────────────────────────────────────────
-- 
-- Optimized for auto-matching: fetch active pools with sufficient liquidity
-- in a single query, pre-sorted by available liquidity (descending).
-- 
-- USAGE:
--   SELECT * FROM public.get_active_pools_with_liquidity(
--     min_liquidity := 1000
--   );
-- 
-- PERFORMANCE NOTE:
-- - Uses index: idx_lending_pools_status (or composite status + available_liquidity)
-- - Returns ONLY active pools sorted by available liquidity
-- - Replaces client-side filtering in runAutoMatch action

drop function if exists public.get_active_pools_with_liquidity(numeric) cascade;

create or replace function public.get_active_pools_with_liquidity(
  min_liquidity numeric default 0
)
returns table (
  id uuid,
  name text,
  description text,
  status public.pool_status,
  apr_bps integer,
  total_liquidity numeric,
  available_liquidity numeric,
  total_borrowed numeric,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select
    lending_pools.id,
    lending_pools.name,
    lending_pools.description,
    lending_pools.status,
    lending_pools.apr_bps,
    lending_pools.total_liquidity,
    lending_pools.available_liquidity,
    lending_pools.total_borrowed,
    lending_pools.created_at,
    lending_pools.updated_at
  from public.lending_pools
  where status = 'active'
    and (min_liquidity = 0 or available_liquidity > min_liquidity)
  order by available_liquidity desc;
$$;

grant execute on function public.get_active_pools_with_liquidity(numeric)
  to service_role, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RECOMMENDED INDEX ADDITIONS FOR OPTIMAL RPC PERFORMANCE
-- ─────────────────────────────────────────────────────────────────────────────
-- 
-- Run these in Supabase SQL editor to add recommended indexes:

-- 1. Composite index for status + available_liquidity (used by get_active_pools_with_liquidity)
--    Speeds up auto-matching and pool selection queries
create index if not exists idx_lending_pools_status_available
on public.lending_pools (status, available_liquidity desc);

-- 2. Index on created_at for default sort order
--    Optimizes pagination when sorting by created_at
create index if not exists idx_lending_pools_created_at_desc
on public.lending_pools (created_at desc);

-- 3. Index on available_liquidity for alternative sort
--    Allows users to sort pools by available liquidity
create index if not exists idx_lending_pools_available_liquidity_desc
on public.lending_pools (available_liquidity desc);

-- Notify PostgREST to reload schema so new functions are discoverable
notify pgrst, 'reload schema';
