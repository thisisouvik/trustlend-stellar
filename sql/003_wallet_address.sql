-- Add wallet_address support to profiles table
-- Apply for existing databases created before wallet_address was introduced.

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS wallet_address TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_wallet_address
ON public.profiles(wallet_address);
