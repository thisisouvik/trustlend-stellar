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
