"use client";

import { FormEvent, useState } from "react";
import { Loader2, Mail, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  PENDING_ROLE_KEY,
  getDashboardPath,
  isUserRole,
  normalizeUserRole,
  type UserRole,
} from "@/lib/auth/roles";

type AuthMethod = "google" | "email";
type EmailMode = "sign-in" | "sign-up";

interface AuthAccessButtonProps {
  className?: string;
  buttonLabel?: string;
}

export function AuthAccessButton({ className, buttonLabel = "Sign in" }: AuthAccessButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<UserRole>("borrower");
  const [method, setMethod] = useState<AuthMethod>("google");
  const [emailMode, setEmailMode] = useState<EmailMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const closeModal = () => {
    setOpen(false);
    setMessage(null);
    setIsLoading(false);
  };

  const persistPendingRole = () => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(PENDING_ROLE_KEY, role);
  };

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setMessage(null);

    const supabase = getBrowserSupabaseClient();
    if (!supabase) {
      setMessage("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your environment.");
      setIsLoading(false);
      return;
    }

    persistPendingRole();

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/complete`,
      },
    });

    if (error) {
      setMessage(error.message);
      setIsLoading(false);
      return;
    }

    if (data.url) {
      window.location.assign(data.url);
      return;
    }

    setMessage("Unable to start Google authentication flow.");
    setIsLoading(false);
  };

  const handleEmailSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setIsLoading(true);
    setMessage(null);

    const supabase = getBrowserSupabaseClient();
    if (!supabase) {
      setMessage("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your environment.");
      setIsLoading(false);
      return;
    }

    if (!email || !password) {
      setMessage("Email and password are required.");
      setIsLoading(false);
      return;
    }

    if (emailMode === "sign-up" && password.length < 8) {
      setMessage("Password must be at least 8 characters.");
      setIsLoading(false);
      return;
    }

    persistPendingRole();

    if (emailMode === "sign-up") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/complete`,
          data: {
            account_type: role,
          },
        },
      });

      if (error) {
        setMessage(error.message);
        setIsLoading(false);
        return;
      }

      if (!data.session) {
        setMessage("Check your email and confirm your account to complete sign in.");
        setIsLoading(false);
        return;
      }

      const nextRole = normalizeUserRole(data.user?.user_metadata?.account_type);
      router.push(getDashboardPath(nextRole));
      closeModal();
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setMessage(error.message);
      setIsLoading(false);
      return;
    }

    let nextRole: UserRole = role;
    const currentMetaRole = data.user?.user_metadata?.account_type;

    if (isUserRole(currentMetaRole)) {
      nextRole = currentMetaRole;
    } else {
      const { error: updateError } = await supabase.auth.updateUser({
        data: {
          ...data.user?.user_metadata,
          account_type: role,
        },
      });

      if (updateError) {
        setMessage(updateError.message);
        setIsLoading(false);
        return;
      }

      nextRole = role;
    }

    router.push(getDashboardPath(nextRole));
    closeModal();
  };

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <span className="auth-trigger-text">{buttonLabel}</span>
      </button>

      {open ? (
        <div className="auth-overlay" onClick={closeModal} role="presentation">
          <div
            className="auth-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Sign in to TrustLend"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="auth-close" onClick={closeModal} aria-label="Close">
              <X size={16} />
            </button>

            <p className="auth-kicker">Auth setup</p>
            <h2 className="auth-title font-display">Choose role and sign in</h2>

            <div className="auth-role-toggle">
              <button
                type="button"
                className={role === "borrower" ? "auth-chip auth-chip-active" : "auth-chip"}
                onClick={() => setRole("borrower")}
              >
                Borrower
              </button>
              <button
                type="button"
                className={role === "lender" ? "auth-chip auth-chip-active" : "auth-chip"}
                onClick={() => setRole("lender")}
              >
                Lender
              </button>
            </div>

            <div className="auth-method-toggle">
              <button
                type="button"
                className={method === "google" ? "auth-chip auth-chip-active" : "auth-chip"}
                onClick={() => setMethod("google")}
              >
                Google
              </button>
              <button
                type="button"
                className={method === "email" ? "auth-chip auth-chip-active" : "auth-chip"}
                onClick={() => setMethod("email")}
              >
                Email
              </button>
            </div>

            {method === "google" ? (
              <button type="button" className="auth-primary" onClick={handleGoogleSignIn} disabled={isLoading}>
                {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
                <span>Continue with Google as {role}</span>
              </button>
            ) : (
              <form className="auth-form" onSubmit={handleEmailSubmit}>
                <div className="auth-email-mode-toggle">
                  <button
                    type="button"
                    className={emailMode === "sign-in" ? "auth-chip auth-chip-active" : "auth-chip"}
                    onClick={() => setEmailMode("sign-in")}
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    className={emailMode === "sign-up" ? "auth-chip auth-chip-active" : "auth-chip"}
                    onClick={() => setEmailMode("sign-up")}
                  >
                    Sign up
                  </button>
                </div>

                <label className="auth-label" htmlFor="email-auth-input">
                  Email
                </label>
                <input
                  id="email-auth-input"
                  name="email"
                  className="auth-input"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />

                <label className="auth-label" htmlFor="password-auth-input">
                  Password
                </label>
                <input
                  id="password-auth-input"
                  name="password"
                  className="auth-input"
                  type="password"
                  autoComplete={emailMode === "sign-in" ? "current-password" : "new-password"}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />

                <button type="submit" className="auth-primary" disabled={isLoading}>
                  {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
                  <span>{emailMode === "sign-up" ? "Create account" : "Sign in"}</span>
                </button>
              </form>
            )}

            <p className="auth-footnote">
              Role decides your entry dashboard. You can update it later from profile settings.
            </p>
            {message ? <p className="auth-error">{message}</p> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
