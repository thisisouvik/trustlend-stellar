import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { getDashboardPath, normalizeUserRole } from "@/lib/auth/roles";

// ── In-memory rate limiter (resets on server restart) ─────────────────────────
// For production, replace with Redis/Upstash for persistence across instances.
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;   // 1-minute window
const MAX_REQUESTS = 30;     // 30 API requests per IP per minute
// SECURITY: bypass is disabled in production regardless of env var
const DEV_BYPASS_ENABLED =
  process.env.NODE_ENV !== "production" &&
  process.env.ENABLE_DEV_AUTH_BYPASS === "true";

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getRateLimitKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // ── ① Short-circuit for static assets — no auth check needed ────────────────
  const isStatic =
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|css|js|map)$/.test(pathname);
  if (isStatic) return NextResponse.next({ request });

  const bypassUserId = request.headers.get("x-dev-user-id")?.trim() ?? "";
  const bypassRoleRaw = request.headers.get("x-dev-role")?.trim();
  const bypassActive = DEV_BYPASS_ENABLED && !!bypassUserId && isValidUuid(bypassUserId);

  // ── ② Rate limiting on API routes ───────────────────────────────────────────
  if (pathname.startsWith("/api/")) {
    const key = getRateLimitKey(request);
    const now = Date.now();
    const record = requestCounts.get(key);

    if (!record || now > record.resetAt) {
      requestCounts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      record.count++;
      if (record.count > MAX_REQUESTS) {
        return NextResponse.json(
          { error: "Too many requests, please slow down." },
          {
            status: 429,
            headers: { "Retry-After": String(Math.ceil((record.resetAt - now) / 1000)) },
          }
        );
      }
    }
  }

  // ── ③ Supabase cookie-based session check (NO NETWORK CALL) ─────────────────
  // We use getSession() here because it reads the JWT from the cookie locally.
  // getUser() makes a live Supabase network call on every request and is the
  // cause of the 10 s connect-timeout errors. Full JWT verification happens
  // inside requireAuthenticatedUser() in each protected page/API route.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
      },
    },
  });

  // ✅ getSession() = local cookie read, NO network round-trip
  const { data: { session } } = await supabase.auth.getSession();

  const effectiveUser = bypassActive
    ? {
        id: bypassUserId,
        user_metadata: { account_type: normalizeUserRole(bypassRoleRaw) },
      }
    : session?.user ?? null;

  const isDashboardPath = pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  const isAuthEntryPath = pathname === "/auth";

  if (isDashboardPath && !effectiveUser) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/auth";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  if (isAuthEntryPath && effectiveUser) {
    const redirectUrl = request.nextUrl.clone();
    const role = normalizeUserRole(effectiveUser.user_metadata?.account_type);
    redirectUrl.pathname = getDashboardPath(role);
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};