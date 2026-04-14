"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";

interface GoogleContinueButtonProps {
  className?: string;
}

export function GoogleContinueButton({ className }: GoogleContinueButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setMessage(null);

    const supabase = getBrowserSupabaseClient();
    if (!supabase) {
      setMessage("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your environment.");
      setIsLoading(false);
      return;
    }

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
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

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={isLoading}
        className={className}
      >
        {isLoading ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            <span>Redirecting...</span>
          </>
        ) : (
          <>
            <span className="google-mark" aria-hidden="true">
              G
            </span>
            <span>Continue with Google</span>
          </>
        )}
      </button>

      {message ? <p className="text-xs text-red-500">{message}</p> : null}
    </div>
  );
}
