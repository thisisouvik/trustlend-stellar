-- A referee may be permanently attributed to one referrer only. The initial
-- schema already declares this index; IF NOT EXISTS also protects databases
-- provisioned from an older/custom baseline.
CREATE UNIQUE INDEX IF NOT EXISTS "referrals_referee_id_key"
  ON public.referrals USING btree ("referee_id");
--> statement-breakpoint

-- Keep claim validation and creation in the database's atomic write boundary.
CREATE OR REPLACE FUNCTION public.record_referral(
  p_referee_id uuid,
  p_referral_code text
)
RETURNS TABLE (referral_id uuid, referrer_id uuid, status public.referral_status)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_referrer_id uuid;
  v_code text;
  v_referral_id uuid;
  v_status public.referral_status;
BEGIN
  v_code := upper(trim(p_referral_code));
  IF v_code IS NULL OR v_code = '' THEN RAISE EXCEPTION 'Referral code is required'; END IF;
  SELECT id INTO v_referrer_id FROM public.profiles WHERE referral_code = v_code;
  IF v_referrer_id IS NULL THEN RAISE EXCEPTION 'Unknown referral code'; END IF;
  IF v_referrer_id = p_referee_id THEN RAISE EXCEPTION 'Cannot refer yourself'; END IF;

  INSERT INTO public.referrals (referrer_id, referee_id, referral_code, status)
  VALUES (v_referrer_id, p_referee_id, v_code, 'pending')
  ON CONFLICT (referee_id) DO NOTHING
  RETURNING id INTO v_referral_id;

  IF v_referral_id IS NULL THEN
    SELECT r.id, r.referrer_id, r.status INTO v_referral_id, v_referrer_id, v_status
      FROM public.referrals r WHERE r.referee_id = p_referee_id;
    referral_id := v_referral_id;
    referrer_id := v_referrer_id;
    status := v_status;
  ELSE
    referral_id := v_referral_id;
    referrer_id := v_referrer_id;
    status := 'pending'::public.referral_status;
  END IF;
  RETURN NEXT;
END;
$$;
