import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

function printResult(name, ok, detail) {
  const status = ok ? "PASS" : "FAIL";
  console.log(`${status.padEnd(5)} | ${name.padEnd(38)} | ${detail}`);
}

async function http(method, url, headers = {}, body) {
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });

  let payload = null;
  const text = await res.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  return { status: res.status, payload };
}

async function listAllUsers(supabase) {
  const users = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const batch = data?.users ?? [];
    users.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }

  return users;
}

async function ensureUser(supabase, email, role, fullName) {
  const allUsers = await listAllUsers(supabase);
  let user = allUsers.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());

  if (!user) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: "TempPass123!",
      email_confirm: true,
      user_metadata: { account_type: role, full_name: fullName },
    });
    if (error) throw error;
    user = data.user;
  }

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: user.id,
    full_name: fullName,
    role,
    kyc_status: "verified",
    risk_status: "low",
  });
  if (profileError) throw profileError;

  return user;
}

async function main() {
  const cwd = process.cwd();
  const envPath = path.join(cwd, ".env.local");
  const env = loadEnv(envPath);

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("Starting seeded E2E run...\n");

  const borrower = await ensureUser(supabase, "e2e.borrower@trustlend.local", "borrower", "E2E Borrower");
  const lender = await ensureUser(supabase, "e2e.lender@trustlend.local", "lender", "E2E Lender");
  const admin = await ensureUser(supabase, "souvikmandal2406@gmail.com", "admin", "E2E Admin");

  // Ensure borrower can request loans.
  const { error: repErr } = await supabase.from("reputation_snapshots").upsert({
    user_id: borrower.id,
    score_total: 300,
    repayment_score: 80,
    lending_score: 20,
    consistency_score: 90,
    external_score: 40,
    reputation_level: "silver",
  });
  if (repErr) throw repErr;

  let poolId = null;
  const { data: existingPool } = await supabase
    .from("lending_pools")
    .select("id")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (existingPool?.id) {
    poolId = existingPool.id;
  } else {
    const { data: createdPool, error: poolErr } = await supabase
      .from("lending_pools")
      .insert({
        name: "E2E Liquidity Pool",
        description: "Seeded pool for automated E2E",
        status: "active",
        currency: "XLM",
        apr_bps: 1200,
        total_liquidity: 10000,
        available_liquidity: 10000,
        total_borrowed: 0,
        created_by: lender.id,
      })
      .select("id")
      .single();
    if (poolErr) throw poolErr;
    poolId = createdPool.id;
  }

  const base = "http://localhost:3000";
  const borrowerHeaders = {
    "x-dev-user-id": borrower.id,
    "x-dev-role": "borrower",
    "x-dev-email": borrower.email,
  };
  const lenderHeaders = {
    "x-dev-user-id": lender.id,
    "x-dev-role": "lender",
    "x-dev-email": lender.email,
  };
  const adminHeaders = {
    "x-dev-user-id": admin.id,
    "x-dev-role": "admin",
    "x-dev-email": admin.email,
  };

  let pass = 0;
  let total = 0;
  const check = (name, ok, detail) => {
    total += 1;
    if (ok) pass += 1;
    printResult(name, ok, detail);
  };

  const bDash = await http("GET", `${base}/dashboard/borrower`, borrowerHeaders);
  check("Borrower dashboard", bDash.status === 200, `status=${bDash.status}`);

  const lDash = await http("GET", `${base}/dashboard/lender`, lenderHeaders);
  check("Lender dashboard", lDash.status === 200, `status=${lDash.status}`);

  const aDash = await http("GET", `${base}/dashboard/admin`, adminHeaders);
  check("Admin dashboard", aDash.status === 200, `status=${aDash.status}`);

  const apply = await http("POST", `${base}/api/loans/apply`, borrowerHeaders, {
    amount: 120,
    durationDays: 30,
  });
  const loanId = apply?.payload?.loan?.id;
  check("Borrower apply loan", apply.status === 201 && !!loanId, `status=${apply.status}`);

  const deposit = await http("POST", `${base}/api/pools/deposit`, lenderHeaders, {
    poolId,
    amount: 250,
  });
  const positionId = deposit?.payload?.position?.id;
  check("Lender deposit", deposit.status === 201 && !!positionId, `status=${deposit.status}`);

  const withdraw = await http("POST", `${base}/api/pools/withdraw`, lenderHeaders, {
    positionId,
    amount: 50,
  });
  check("Lender withdraw", withdraw.status === 200, `status=${withdraw.status}`);

  const repayPartial = await http("POST", `${base}/api/loans/repay`, borrowerHeaders, {
    loanId,
    amount: 30,
  });
  check("Borrower partial repayment", repayPartial.status === 201, `status=${repayPartial.status}`);

  const repayFull = await http("POST", `${base}/api/loans/repay`, borrowerHeaders, {
    loanId,
    amount: 500,
  });
  check("Borrower full repayment", repayFull.status === 201, `status=${repayFull.status}`);

  // Verify DB updates are real and persisted.
  const { data: loanRow } = await supabase
    .from("loans")
    .select("id, status, repaid_amount")
    .eq("id", loanId)
    .maybeSingle();
  check("Loan status persisted", !!loanRow && ["active", "repaid"].includes(loanRow.status), `status=${loanRow?.status ?? "none"}`);

  const { data: posRow } = await supabase
    .from("pool_positions")
    .select("id, principal_amount, withdrawn_amount")
    .eq("id", positionId)
    .maybeSingle();
  check(
    "Position update persisted",
    !!posRow && Number(posRow.withdrawn_amount ?? 0) >= 50,
    `withdrawn=${posRow?.withdrawn_amount ?? "none"}`,
  );

  const { data: ledgerRows } = await supabase
    .from("ledger_transactions")
    .select("id, category")
    .eq("user_id", lender.id)
    .in("category", ["deposit", "withdrawal"])
    .limit(20);
  check(
    "Ledger tx recorded",
    (ledgerRows ?? []).some((r) => r.category === "deposit") && (ledgerRows ?? []).some((r) => r.category === "withdrawal"),
    `rows=${(ledgerRows ?? []).length}`,
  );

  const adminKyc = await http("GET", `${base}/dashboard/admin/kyc`, adminHeaders);
  check("Admin KYC page", adminKyc.status === 200, `status=${adminKyc.status}`);

  const adminUsers = await http("GET", `${base}/dashboard/admin/users`, adminHeaders);
  check("Admin users page", adminUsers.status === 200, `status=${adminUsers.status}`);

  const roleMismatch = await http("POST", `${base}/api/pools/deposit`, borrowerHeaders, {
    poolId,
    amount: 10,
  });
  check("Role mismatch guard", roleMismatch.status === 307, `status=${roleMismatch.status}`);

  const invalidApply = await http("POST", `${base}/api/loans/apply`, borrowerHeaders, {
    amount: 0,
    durationDays: 30,
  });
  check("Input validation guard", invalidApply.status === 400, `status=${invalidApply.status}`);

  console.log("\nSummary");
  console.log(`Passed: ${pass}/${total}`);

  if (pass !== total) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("E2E run failed:", error.message);
  process.exit(1);
});
