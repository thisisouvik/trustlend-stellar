-- TrustLend task completion RPC
-- Awards trust points through a security-definer function so task claims do not depend on reputation_events insert RLS.

create or replace function public.complete_platform_task(p_task_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  task_points integer;
  task_title text;
begin
  if current_user_id is null then
    raise exception 'not authenticated';
  end if;

  select t.points, t.title
  into task_points, task_title
  from (
    values
      ('task_stellar_basics', 30, 'Learn: How Stellar Payments Work'),
      ('task_credit_score', 25, 'Learn: How Your Trust Score Is Calculated'),
      ('task_defi_lending', 35, 'Learn: DeFi Lending vs Traditional Banking')
  ) as t(task_id, points, title)
  where t.task_id = p_task_id;

  if task_points is null then
    raise exception 'Task not found';
  end if;

  if exists (
    select 1
    from public.reputation_events
    where user_id = current_user_id
      and source_type = 'task_completion'
      and source_key = p_task_id
  ) then
    raise exception 'Task already completed. Each task can only be claimed once.';
  end if;

  insert into public.reputation_events (
    user_id,
    source_type,
    source_key,
    points_delta,
    reason
  )
  values (
    current_user_id,
    'task_completion',
    p_task_id,
    task_points,
    'Completed: ' || task_title
  );

  return task_points;
end;
$$;

grant execute on function public.complete_platform_task(text) to authenticated;
-- TrustLend hotfix: ensure activate_loan_funding RPC exists and is visible to PostgREST
-- Apply this in Supabase SQL editor if lenders see:
-- "Could not find the function public.activate_loan_funding(...) in the schema cache"

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
      funded_at = coalesce(funded_at, p_approved_at),
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

-- Force PostgREST schema cache reload so RPC is discoverable immediately.
notify pgrst, 'reload schema';
