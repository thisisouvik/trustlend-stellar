"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { Loader2, Mail, Eye, EyeOff, ArrowLeft, KeyRound, ShieldCheck } from "lucide-react";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  PENDING_ROLE_KEY,
  getDashboardPath,
  isUserRole,
  normalizeUserRole,
  type UserRole,
} from "@/lib/auth/roles";

type AuthSelectableRole = "borrower" | "lender";

type AuthStep =
  | "sign-up"
  | "sign-in"
  | "forgot-password"
  | "verify-signup-otp"
  | "verify-signin-otp"
  | "verify-recovery-otp"
  | "update-password";

const ROLE_META: Record<UserRole, { label: string; emoji: string; tagline: string; color: string }> = {
  borrower: {
    label: "Borrower",
    emoji: "💸",
    tagline: "Access micro-loans built on your real financial behavior",
    color: "var(--purple)",
  },
  lender: {
    label: "Lender",
    emoji: "📈",
    tagline: "Earn transparent returns by funding verified borrowers",
    color: "#22cf9d",
  },
  admin: {
    label: "Admin",
    emoji: "🛡️",
    tagline: "Manage platform operations and verify users",
    color: "#ef4444",
  },
};

export function AuthPageClient() {
  const params = useSearchParams();
  const router = useRouter();

  const paramRole = params.get("role");
  const initialRole: AuthSelectableRole | null = (paramRole === "borrower" || paramRole === "lender") ? paramRole : null;

  const [role, setRole] = useState<AuthSelectableRole | null>(initialRole);
  const [authStep, setAuthStep] = useState<AuthStep>("sign-in");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "info" | "success"; text: string } | null>(null);

  const meta = role ? ROLE_META[role] : null;

  const persistRole = () => {
    if (typeof window !== "undefined") {
      if (role) {
        window.localStorage.setItem(PENDING_ROLE_KEY, role);
      } else {
        window.localStorage.removeItem(PENDING_ROLE_KEY);
      }
    }
  };

  const isInvalidRefreshTokenError = (value: unknown) => {
    const text = String(value ?? "").toLowerCase();
    return text.includes("invalid refresh token") || text.includes("refresh token not found");
  };

  const recoverLocalAuthState = async (supabase: NonNullable<ReturnType<typeof getBrowserSupabaseClient>>) => {
    await supabase.auth.signOut({ scope: "local" });
  };

  const getSupabaseOrFail = () => {
    const supabase = getBrowserSupabaseClient();
    if (!supabase) {
      setMessage({
        type: "error",
        text: "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
      });
      return null;
    }

    return supabase;
  };

  const handleGoogleSignIn = async () => {
    if (authStep === "sign-up" && !role) {
      setMessage({ type: "error", text: "Please select Borrower or Lender before continuing." });
      return;
    }

    setGoogleLoading(true);
    setMessage(null);

    const supabase = getSupabaseOrFail();
    if (!supabase) {
      setGoogleLoading(false);
      return;
    }

    persistRole();

    let error: { message: string } | null = null;

    try {
      const response = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/complete` },
      });
      error = response.error;
    } catch (caughtError) {
      if (isInvalidRefreshTokenError(caughtError)) {
        await recoverLocalAuthState(supabase);
        setMessage({ type: "info", text: "Session was stale. Please try Google sign-in again." });
        setGoogleLoading(false);
        return;
      }

      setMessage({ type: "error", text: "Unable to start Google sign-in right now." });
      setGoogleLoading(false);
      return;
    }

    if (error) {
      setMessage({ type: "error", text: error.message });
      setGoogleLoading(false);
    }
  };

  const handleSignUp = async () => {
    if (!email || !password || !fullName.trim()) {
      setMessage({ type: "error", text: "Name, email, and password are required." });
      return;
    }
    if (!role) {
      setMessage({ type: "error", text: "Please select Borrower or Lender before creating your account." });
      return;
    }
    if (password.length < 8) {
      setMessage({ type: "error", text: "Password must be at least 8 characters." });
      return;
    }

    setIsLoading(true);
    setMessage(null);
    const supabase = getSupabaseOrFail();
    if (!supabase) {
      setIsLoading(false);
      return;
    }

    persistRole();

    let error: { message: string } | null = null;

    try {
      const response = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          data: { account_type: role, full_name: fullName.trim() },
        },
      });
      error = response.error;
    } catch (caughtError) {
      if (isInvalidRefreshTokenError(caughtError)) {
        await recoverLocalAuthState(supabase);
        setMessage({ type: "info", text: "Session was stale. Try creating your account again." });
        setIsLoading(false);
        return;
      }

      setMessage({ type: "error", text: "Unable to send signup OTP right now." });
      setIsLoading(false);
      return;
    }

    setIsLoading(false);

    if (error) {
      setMessage({ type: "error", text: error.message });
      return;
    }

    setMessage({ type: "success", text: "Code sent! Check your email for the 6-digit OTP." });
    setOtp("");
    setAuthStep("verify-signup-otp");
  };

  const handleSignIn = async () => {
    if (!email) {
      setMessage({ type: "error", text: "Email is required." });
      return;
    }

    setIsLoading(true);
    setMessage(null);
    const supabase = getSupabaseOrFail();
    if (!supabase) {
      setIsLoading(false);
      return;
    }

    let error: { message: string } | null = null;

    try {
      const response = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
        },
      });
      error = response.error;
    } catch (caughtError) {
      if (isInvalidRefreshTokenError(caughtError)) {
        await recoverLocalAuthState(supabase);
        setMessage({ type: "info", text: "Session was stale. Try sending sign-in code again." });
        setIsLoading(false);
        return;
      }

      setMessage({ type: "error", text: "Unable to send sign-in OTP right now." });
      setIsLoading(false);
      return;
    }

    setIsLoading(false);

    if (error) {
      setMessage({ type: "error", text: error.message });
      return;
    }

    setMessage({ type: "success", text: "OTP sent. Enter the 6-digit code to continue." });
    setOtp("");
    setAuthStep("verify-signin-otp");
  };

  const handleForgotPassword = async () => {
    if (!email) {
      setMessage({ type: "error", text: "Please enter your email address first." });
      return;
    }

    setIsLoading(true);
    setMessage(null);
    const supabase = getSupabaseOrFail();
    if (!supabase) {
      setIsLoading(false);
      return;
    }

    let error: { message: string } | null = null;

    try {
      const response = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
        },
      });
      error = response.error;
    } catch (caughtError) {
      if (isInvalidRefreshTokenError(caughtError)) {
        await recoverLocalAuthState(supabase);
        setMessage({ type: "info", text: "Session was stale. Try sending recovery code again." });
        setIsLoading(false);
        return;
      }

      setMessage({ type: "error", text: "Unable to send recovery OTP right now." });
      setIsLoading(false);
      return;
    }

    setIsLoading(false);

    if (error) {
      setMessage({ type: "error", text: error.message });
      return;
    }

    setMessage({ type: "success", text: "Recovery code sent! Check your email." });
    setOtp("");
    setAuthStep("verify-recovery-otp");
  };

  const handleVerifyOtp = async (type: "signup" | "signin" | "recovery") => {
    if (!otp || otp.length < 6) {
      setMessage({ type: "error", text: "Please enter the 6-digit code." });
      return;
    }

    setIsLoading(true);
    setMessage(null);
    const supabase = getSupabaseOrFail();
    if (!supabase) {
      setIsLoading(false);
      return;
    }

    const otpType = "email";

    let data: { user?: { user_metadata?: Record<string, unknown> } } | null = null;
    let error: { message: string } | null = null;

    try {
      const response = await supabase.auth.verifyOtp({
        email,
        token: otp,
        type: otpType,
      });
      data = response.data as { user?: { user_metadata?: Record<string, unknown> } };
      error = response.error;
    } catch (caughtError) {
      if (isInvalidRefreshTokenError(caughtError)) {
        await recoverLocalAuthState(supabase);
        setMessage({ type: "info", text: "Session was stale. Please request a new OTP and try again." });
        setIsLoading(false);
        return;
      }

      setMessage({ type: "error", text: "OTP verification failed. Please try again." });
      setIsLoading(false);
      return;
    }

    setIsLoading(false);

    if (error) {
      setMessage({ type: "error", text: error.message });
      return;
    }

    if (type === "signup") {
      if (!role) {
        setMessage({ type: "error", text: "Please select a role and request a new signup code." });
        return;
      }

      const { data: updatedData, error: updateError } = await supabase.auth.updateUser({
        password,
        data: {
          ...data?.user?.user_metadata,
          account_type: role,
          full_name: fullName.trim(),
        },
      });

      if (updateError) {
        setMessage({ type: "error", text: updateError.message });
        return;
      }

      const nextRole = normalizeUserRole(updatedData.user?.user_metadata?.account_type);
      router.push(getDashboardPath(nextRole));
    } else if (type === "signin") {
      const nextRole = normalizeUserRole(data?.user?.user_metadata?.account_type);
      router.push(getDashboardPath(nextRole));
    } else {
      setMessage({ type: "success", text: "Code verified. Please enter a new password." });
      setAuthStep("update-password");
      setPassword("");
    }
  };

  const handleUpdatePassword = async () => {
    if (!password || password.length < 8) {
      setMessage({ type: "error", text: "New password must be at least 8 characters." });
      return;
    }

    setIsLoading(true);
    setMessage(null);
    const supabase = getSupabaseOrFail();
    if (!supabase) {
      setIsLoading(false);
      return;
    }

    let data: { user?: { user_metadata?: Record<string, unknown> } } | null = null;
    let error: { message: string } | null = null;

    try {
      const response = await supabase.auth.updateUser({
        password: password,
      });
      data = response.data as { user?: { user_metadata?: Record<string, unknown> } };
      error = response.error;
    } catch (caughtError) {
      if (isInvalidRefreshTokenError(caughtError)) {
        await recoverLocalAuthState(supabase);
        setMessage({ type: "info", text: "Session expired. Request a new recovery code and try again." });
        setIsLoading(false);
        return;
      }

      setMessage({ type: "error", text: "Unable to update password right now." });
      setIsLoading(false);
      return;
    }

    setIsLoading(false);

    if (error) {
      setMessage({ type: "error", text: error.message });
      return;
    }

    const nextRole = normalizeUserRole(data?.user?.user_metadata?.account_type);
    router.push(getDashboardPath(nextRole));
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (authStep === "sign-up") await handleSignUp();
    else if (authStep === "sign-in") await handleSignIn();
    else if (authStep === "forgot-password") await handleForgotPassword();
    else if (authStep === "verify-signup-otp") await handleVerifyOtp("signup");
    else if (authStep === "verify-signin-otp") await handleVerifyOtp("signin");
    else if (authStep === "verify-recovery-otp") await handleVerifyOtp("recovery");
    else if (authStep === "update-password") await handleUpdatePassword();
  };

  const renderLeftPanel = () => {
    if (authStep === "sign-up" || authStep === "verify-signup-otp") {
      return (
        <div className="auth-page-left-body">
          <div className="auth-page-role-badge" style={{ background: role === "lender" ? "rgba(34,207,157,0.12)" : "rgba(127,47,209,0.12)", borderColor: role === "lender" ? "rgba(34,207,157,0.35)" : "rgba(127,47,209,0.35)" }}>
            <span className="auth-page-role-emoji">{meta?.emoji ?? "👤"}</span>
            <span className="auth-page-role-badge-label" style={{ color: role === "lender" ? "#17a87a" : "#6e2fc1" }}>
              {meta ? `Joining as ${meta.label}` : "Choose your account type"}
            </span>
          </div>
          <p className="auth-page-left-tagline">{meta?.tagline ?? "Pick Borrower or Lender to tailor your dashboard and onboarding."}</p>
          <ul className="auth-page-trust-list" aria-label="Platform highlights">
            <li><span className="auth-page-trust-dot" />Behavior-based reputation score</li>
            <li><span className="auth-page-trust-dot" />No collateral required</li>
            <li><span className="auth-page-trust-dot" />Transparent on-chain audit trail</li>
            <li><span className="auth-page-trust-dot" />Role dashboard from day one</li>
          </ul>
        </div>
      );
    }

    // Sign in / Recovery / Password update forms
    return (
      <div className="auth-page-left-body">
        <div className="auth-page-role-badge" style={{ background: "rgba(255,255,255,0.1)", borderColor: "rgba(255,255,255,0.2)" }}>
          <span className="auth-page-role-emoji">👋</span>
          <span className="auth-page-role-badge-label" style={{ color: "#ffffff" }}>
            {authStep === "sign-in" ? "Welcome back" : "Account Recovery"}
          </span>
        </div>
        <p className="auth-page-left-tagline">
          {authStep === "sign-in" ? "Sign in to access your TrustLend dashboard" : "Securely regain access to your reputation profile"}
        </p>
      </div>
    );
  };

  return (
    <main className="auth-page-shell">
      {/* Left panel — branding */}
      <div className="auth-page-left" aria-hidden="true">
        <div className="auth-page-left-inner">
          <Link href="/" className="auth-page-logo">
            <span className="site-logo-orb" />
            <span className="font-display auth-page-logo-text">TrustLend</span>
          </Link>

          {renderLeftPanel()}

          {/* Decorative orbs */}
          <div className="auth-left-orb auth-left-orb-1" />
          <div className="auth-left-orb auth-left-orb-2" />
        </div>
      </div>

      {/* Right panel — form */}
      <div className="auth-page-right">
        <div className="auth-page-form-wrap">
          {/* Back link */}
          <button type="button" onClick={() => authStep === "sign-up" || authStep === "sign-in" ? router.push('/') : setAuthStep("sign-in")} className="auth-page-back bg-transparent border-0 cursor-pointer text-left p-0 mb-6">
            <ArrowLeft size={14} />
            {authStep === "sign-up" || authStep === "sign-in" ? "Back to home" : "Back to sign in"}
          </button>

          {/* Mode switch & Role picker only on entry screens */}
          {(authStep === "sign-in" || authStep === "sign-up") && (
            <>
              {/* Mode toggle */}
              <div className="auth-page-mode-toggle">
                <button
                  type="button"
                  id="mode-signin"
                  className={`auth-page-mode-btn${authStep === "sign-in" ? " auth-page-mode-btn--active" : ""}`}
                  onClick={() => { setAuthStep("sign-in"); setMessage(null); setOtp(""); }}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  id="mode-signup"
                  className={`auth-page-mode-btn${authStep === "sign-up" ? " auth-page-mode-btn--active" : ""}`}
                  onClick={() => { setAuthStep("sign-up"); setMessage(null); setOtp(""); }}
                >
                  Create account
                </button>
              </div>

            </>
          )}

          {/* Titles */}
          {authStep === "sign-up" && (
            <>
              <h1 className="auth-page-title font-display">{meta ? `Join as ${meta.label}` : "Create your account"}</h1>
              <p className="auth-page-subtitle">Set your password, then choose Borrower or Lender to continue.</p>
            </>
          )}
          {authStep === "sign-in" && (
            <>
              <h1 className="auth-page-title font-display">Welcome back</h1>
              <p className="auth-page-subtitle">Enter your email and we&apos;ll send a 6-digit sign-in OTP.</p>
            </>
          )}
          {authStep === "forgot-password" && (
            <>
              <h1 className="auth-page-title font-display">Reset password</h1>
              <p className="auth-page-subtitle">Enter your email and we&apos;ll send you a 6-digit code.</p>
            </>
          )}
          {(authStep === "verify-signup-otp" || authStep === "verify-signin-otp" || authStep === "verify-recovery-otp") && (
            <>
              <h1 className="auth-page-title font-display">Check your email</h1>
              <p className="auth-page-subtitle">We sent a 6-digit code to <strong>{email}</strong>.</p>
            </>
          )}
          {authStep === "update-password" && (
            <>
              <h1 className="auth-page-title font-display">New password</h1>
              <p className="auth-page-subtitle">Enter a strong password to secure your account.</p>
            </>
          )}

          {/* Google button (only on sign-up and sign-in) */}
          {(authStep === "sign-in" || authStep === "sign-up") && (
            <button
              type="button"
              id="google-auth-btn"
              className="auth-page-google-btn"
              onClick={handleGoogleSignIn}
              disabled={googleLoading || isLoading}
            >
              {googleLoading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
                  <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
                  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
                </svg>
              )}
              Continue with Google
            </button>
          )}

          {(authStep === "sign-in" || authStep === "sign-up") && (
            <div className="auth-page-divider" aria-hidden="true">
              <span>or continue with email</span>
            </div>
          )}

          {/* Form */}
          <form className="auth-page-form" onSubmit={handleSubmit} noValidate>
            {(authStep === "sign-up" || authStep === "sign-in" || authStep === "forgot-password") && (
              <>
                {authStep === "sign-up" && (
                  <div className="auth-page-field">
                    <label className="auth-page-label" htmlFor="auth-fullname">
                      Full name
                    </label>
                    <input
                      id="auth-fullname"
                      name="fullname"
                      type="text"
                      autoComplete="name"
                      required
                      className="auth-page-input"
                      placeholder="John Doe"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      disabled={isLoading}
                    />
                  </div>
                )}

                <div className="auth-page-field">
                  <label className="auth-page-label" htmlFor="auth-email">
                    Email address
                  </label>
                  <input
                    id="auth-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    className="auth-page-input"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isLoading}
                  />
                </div>

                {authStep === "sign-in" && (
                  <button
                    type="button"
                    onClick={() => {
                      setAuthStep("forgot-password");
                      setMessage(null);
                      setOtp("");
                    }}
                    className="auth-page-forgot bg-transparent border-0 cursor-pointer p-0 self-start"
                  >
                    Forgot password?
                  </button>
                )}
              </>
            )}

            {(authStep === "verify-signup-otp" || authStep === "verify-signin-otp" || authStep === "verify-recovery-otp") && (
              <div className="auth-page-field">
                <label className="auth-page-label" htmlFor="auth-otp">
                  6-Digit OTP Code
                </label>
                <input
                  id="auth-otp"
                  name="otp"
                  type="text"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  style={{ letterSpacing: "0.2em", fontSize: "1.2rem", textAlign: "center", fontWeight: "bold" }}
                  className="auth-page-input"
                  placeholder="000000"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, ""))}
                  disabled={isLoading}
                />
              </div>
            )}

            {(authStep === "sign-up" || authStep === "update-password") && (
              <div className="auth-page-field">
                <div className="auth-page-label-row">
                  <label className="auth-page-label" htmlFor="auth-password">
                    {authStep === "update-password" ? "New Password" : "Password"}
                  </label>
                </div>
                <div className="auth-page-input-wrap">
                  <input
                    id="auth-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    required
                    className="auth-page-input auth-page-input--padded"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    className="auth-page-eye-btn"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            )}

            {authStep === "sign-up" && (
              <div className="auth-page-role-picker" role="group" aria-label="Choose your role">
                <p className="auth-page-section-label">I am a</p>
                <div className="auth-page-role-tabs">
                  {(["borrower", "lender"] as AuthSelectableRole[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      id={`role-tab-${r}`}
                      className={`auth-page-role-tab${role === r ? " auth-page-role-tab--active" : ""}`}
                      onClick={() => { setRole(r); setMessage(null); }}
                      aria-pressed={role === r}
                    >
                      <span className="auth-page-role-tab-emoji">{ROLE_META[r].emoji}</span>
                      {ROLE_META[r].label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Feedback */}
            {message && (
              <p
                className={message.type === "error" ? "auth-page-error" : "auth-page-info"}
                style={message.type === "success" ? { background: "#e8fcf4", borderColor: "#a0e8cf", color: "#0c704c" } : {}}
                role="alert"
              >
                {message.type === "error" ? "⚠ " : message.type === "success" ? "✓ " : "✉ "}{message.text}
              </p>
            )}

            <button
              type="submit"
              id="auth-submit-btn"
              className="auth-page-submit mt-2"
              disabled={isLoading || googleLoading}
            >
              {isLoading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : authStep === "verify-signup-otp" || authStep === "verify-signin-otp" || authStep === "verify-recovery-otp" ? (
                <ShieldCheck size={16} />
              ) : authStep === "update-password" ? (
                <KeyRound size={16} />
              ) : (
                <Mail size={16} />
              )}
              {authStep === "sign-up"
                ? "Create account"
                : authStep === "sign-in"
                  ? "Send sign-in code"
                  : authStep === "forgot-password"
                    ? "Send recovery code"
                    : authStep === "update-password"
                      ? "Update password"
                      : "Verify code"}
            </button>
          </form>

          {(authStep === "sign-in" || authStep === "sign-up") && (
            <p className="auth-page-footnote">
              By continuing, you agree to TrustLend&apos;s{" "}
              <a href="#" className="auth-page-footnote-link">Terms</a> and{" "}
              <a href="#" className="auth-page-footnote-link">Privacy Policy</a>.
              Role decides your dashboard — you can switch later.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
