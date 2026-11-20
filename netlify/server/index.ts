import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { otpCodes, sessions, transactions, users } from "../../db/schema.ts";

export const config = { path: "/api/*" };

// ---------------------------------------------------------------------------
// Demo rules. Everything in this app is simulated: OTPs are shown on screen,
// balances are fake, and no payment provider or SMS gateway is ever contacted.
// ---------------------------------------------------------------------------
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_DAYS = 7;
const REMEMBER_DAYS = 30;
const WELCOME_BONUS_PAISE = 5_000_00; // ₹5,000 demo credit
const MAX_TXN_PAISE = 50_000_00; // ₹50,000 per demo transaction
const MAX_BALANCE_PAISE = 10_00_000_00; // ₹10,00,000 demo wallet cap
const ADD_METHODS = ["Demo UPI", "Demo Card", "Demo Net Banking"];
const WITHDRAW_METHODS = ["Demo Bank Account", "Demo UPI ID"];
const SESSION_COOKIE = "jpj_session";

type Purpose = "signup" | "login";

const app = new Hono();

// ---------- helpers ----------
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) =>
      err ? reject(err) : resolve(`scrypt$${salt}$${key.toString("hex")}`),
    ),
  );
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return Promise.resolve(false);
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      const expected = Buffer.from(hash, "hex");
      resolve(expected.length === key.length && timingSafeEqual(expected, key));
    }),
  );
}

const isMobile = (v: unknown): v is string => typeof v === "string" && /^[6-9][0-9]{9}$/.test(v);

function parseAmount(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const paise = Math.round(n * 100);
  if (Math.abs(n * 100 - paise) > 1e-6) return null; // more than 2 decimals
  if (paise < 100 || paise > MAX_TXN_PAISE) return null;
  return paise;
}

const reference = () => "DEMO" + Date.now().toString(36).toUpperCase() + randomBytes(3).toString("hex").toUpperCase();

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

const fail = (c: Context, status: 400 | 401 | 404 | 409 | 429, error: string) => c.json({ error }, status);

function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    mobile: u.mobile,
    balance: u.balancePaise / 100,
    memberSince: u.createdAt,
  };
}

function publicTxn(t: typeof transactions.$inferSelect) {
  return {
    id: t.id,
    type: t.type,
    amount: t.amountPaise / 100,
    method: t.method,
    note: t.note,
    reference: t.reference,
    balanceAfter: t.balanceAfterPaise / 100,
    createdAt: t.createdAt,
    demo: true,
  };
}

/** Creates a simulated OTP challenge and returns the code so the UI can display it. */
async function issueOtp(userId: number, purpose: Purpose) {
  const challenge = randomBytes(24).toString("base64url");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // Old challenges for the same purpose are no longer usable.
  await db
    .update(otpCodes)
    .set({ consumed: true })
    .where(and(eq(otpCodes.userId, userId), eq(otpCodes.purpose, purpose), eq(otpCodes.consumed, false)));
  await db.insert(otpCodes).values({
    userId,
    purpose,
    challengeHash: sha256(challenge),
    codeHash: sha256(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  return otpPayload(challenge, code);
}

const otpPayload = (challenge: string, code: string) => ({
  challenge,
  demoOtp: code,
  expiresInSeconds: OTP_TTL_MS / 1000,
  resendInSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
  notice: "Simulated OTP for testing only. No SMS was sent.",
});

async function findChallenge(challenge: unknown) {
  if (typeof challenge !== "string" || challenge.length < 10) return null;
  const [row] = await db.select().from(otpCodes).where(eq(otpCodes.challengeHash, sha256(challenge)));
  return row ?? null;
}

async function startSession(c: Context, userId: number, remember: boolean) {
  const token = randomBytes(32).toString("base64url");
  const days = remember ? REMEMBER_DAYS : SESSION_DAYS;
  await db.insert(sessions).values({
    tokenHash: sha256(token),
    userId,
    expiresAt: new Date(Date.now() + days * 86_400_000),
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    // Without "remember me" the cookie ends with the browser session.
    ...(remember ? { maxAge: days * 86_400 } : {}),
  });
}

async function currentUser(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row?.user ?? null;
}

type Row = Record<string, unknown>;
const rowsOf = (result: unknown): Row[] =>
  Array.isArray(result) ? (result as Row[]) : (((result as { rows?: Row[] })?.rows ?? []) as Row[]);

// ---------- auth ----------
app.post("/api/auth/signup", async (c) => {
  const body = await readJson(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const { mobile, password } = body;
  if (name.length < 2 || name.length > 60) return fail(c, 400, "Please enter your full name (2–60 characters).");
  if (!isMobile(mobile)) return fail(c, 400, "Please enter a valid 10 digit mobile number.");
  if (typeof password !== "string" || password.length < 6 || password.length > 100)
    return fail(c, 400, "Password must be at least 6 characters.");

  const [existing] = await db.select().from(users).where(eq(users.mobile, mobile));
  if (existing?.verified) return fail(c, 409, "An account with this mobile number already exists. Please sign in.");

  const passwordHash = await hashPassword(password);
  let userId: number;
  if (existing) {
    await db.update(users).set({ name, passwordHash }).where(eq(users.id, existing.id));
    userId = existing.id;
  } else {
    const [created] = await db
      .insert(users)
      .values({ name, mobile, passwordHash })
      .onConflictDoNothing({ target: users.mobile })
      .returning({ id: users.id });
    if (!created) return fail(c, 409, "An account with this mobile number already exists. Please sign in.");
    userId = created.id;
  }
  return c.json({ purpose: "signup", mobile, ...(await issueOtp(userId, "signup")) });
});

app.post("/api/auth/login", async (c) => {
  const { mobile, password } = await readJson(c);
  if (!isMobile(mobile)) return fail(c, 400, "Please enter a valid 10 digit mobile number.");
  if (typeof password !== "string" || !password) return fail(c, 400, "Please enter your password.");
  const [user] = await db.select().from(users).where(eq(users.mobile, mobile));
  if (!user || !(await verifyPassword(password, user.passwordHash)))
    return fail(c, 401, "Incorrect mobile number or password.");
  const purpose: Purpose = user.verified ? "login" : "signup";
  return c.json({ purpose, mobile, ...(await issueOtp(user.id, purpose)) });
});

app.post("/api/auth/resend-otp", async (c) => {
  const { challenge } = await readJson(c);
  const row = await findChallenge(challenge);
  if (!row || row.consumed) return fail(c, 400, "This verification session has ended. Please start again.");
  const waitMs = row.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS - Date.now();
  if (waitMs > 0) return fail(c, 429, `Please wait ${Math.ceil(waitMs / 1000)}s before requesting a new OTP.`);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db
    .update(otpCodes)
    .set({ codeHash: sha256(code), attempts: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + OTP_TTL_MS) })
    .where(eq(otpCodes.id, row.id));
  return c.json(otpPayload(challenge as string, code));
});

app.post("/api/auth/verify-otp", async (c) => {
  const { challenge, code, remember } = await readJson(c);
  const row = await findChallenge(challenge);
  if (!row || row.consumed) return fail(c, 400, "This verification session has ended. Please start again.");
  if (row.expiresAt.getTime() < Date.now()) return fail(c, 400, "OTP expired. Tap Resend OTP to get a new one.");
  if (row.attempts >= OTP_MAX_ATTEMPTS) return fail(c, 429, "Too many wrong attempts. Tap Resend OTP to get a new one.");
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) return fail(c, 400, "Enter the 6 digit OTP.");

  if (sha256(code) !== row.codeHash) {
    await db.update(otpCodes).set({ attempts: row.attempts + 1 }).where(eq(otpCodes.id, row.id));
    const left = OTP_MAX_ATTEMPTS - row.attempts - 1;
    return fail(c, 400, left > 0 ? `Incorrect OTP. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many wrong attempts. Tap Resend OTP.");
  }

  // Consume atomically so the same OTP can't be used twice.
  const [consumed] = await db
    .update(otpCodes)
    .set({ consumed: true })
    .where(and(eq(otpCodes.id, row.id), eq(otpCodes.consumed, false)))
    .returning({ id: otpCodes.id });
  if (!consumed) return fail(c, 400, "This OTP was already used.");

  let welcomeBonus = false;
  if (row.purpose === "signup") {
    // First verification: mark verified and credit the demo welcome balance in one statement.
    const result = await db.execute(sql`
      WITH u AS (
        UPDATE users SET verified = true, balance_paise = balance_paise + ${WELCOME_BONUS_PAISE}
        WHERE id = ${row.userId} AND verified = false
        RETURNING id, balance_paise
      )
      INSERT INTO transactions (user_id, type, amount_paise, method, note, reference, balance_after_paise)
      SELECT id, 'bonus', ${WELCOME_BONUS_PAISE}, 'JPJ PAY Demo', 'Demo welcome credit', ${reference()}, balance_paise FROM u
      RETURNING id
    `);
    welcomeBonus = rowsOf(result).length > 0;
  }

  await startSession(c, row.userId, remember === true);
  const [user] = await db.select().from(users).where(eq(users.id, row.userId));
  return c.json({ user: publicUser(user), welcomeBonus });
});

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

// ---------- account ----------
app.get("/api/me", async (c) => {
  const user = await currentUser(c);
  if (!user) return fail(c, 401, "Please sign in.");
  const recent = await db
    .select()
    .from(transactions)
    .where(eq(transactions.userId, user.id))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(5);
  const [totals] = await db
    .select({
      added: sql<string>`coalesce(sum(case when ${transactions.type} in ('add','bonus') then ${transactions.amountPaise} else 0 end), 0)`,
      withdrawn: sql<string>`coalesce(sum(case when ${transactions.type} = 'withdraw' then ${transactions.amountPaise} else 0 end), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(transactions)
    .where(eq(transactions.userId, user.id));
  return c.json({
    user: publicUser(user),
    recent: recent.map(publicTxn),
    totals: {
      added: Number(totals?.added ?? 0) / 100,
      withdrawn: Number(totals?.withdrawn ?? 0) / 100,
      count: Number(totals?.count ?? 0),
    },
  });
});

app.patch("/api/me", async (c) => {
  const user = await currentUser(c);
  if (!user) return fail(c, 401, "Please sign in.");
  const body = await readJson(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 60) return fail(c, 400, "Please enter your full name (2–60 characters).");
  const [updated] = await db.update(users).set({ name }).where(eq(users.id, user.id)).returning();
  return c.json({ user: publicUser(updated) });
});

app.get("/api/transactions", async (c) => {
  const user = await currentUser(c);
  if (!user) return fail(c, 401, "Please sign in.");
  const type = c.req.query("type");
  const filter =
    type === "add"
      ? and(eq(transactions.userId, user.id), sql`${transactions.type} in ('add','bonus')`)
      : type === "withdraw"
        ? and(eq(transactions.userId, user.id), eq(transactions.type, "withdraw"))
        : eq(transactions.userId, user.id);
  const rows = await db
    .select()
    .from(transactions)
    .where(filter)
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(200);
  return c.json({ transactions: rows.map(publicTxn) });
});

// ---------- demo wallet ----------
async function moveDemoMoney(c: Context, kind: "add" | "withdraw") {
  const user = await currentUser(c);
  if (!user) return fail(c, 401, "Please sign in.");
  const body = await readJson(c);
  const paise = parseAmount(body.amount);
  if (paise === null) return fail(c, 400, "Enter an amount between ₹1 and ₹50,000 (up to 2 decimals).");
  const methods = kind === "add" ? ADD_METHODS : WITHDRAW_METHODS;
  const method = typeof body.method === "string" && methods.includes(body.method) ? body.method : methods[0];
  const note = kind === "add" ? "Demo money added" : "Demo withdrawal";
  const ref = reference();

  // Single atomic statement: the balance check, balance change and history entry succeed or fail together.
  const result =
    kind === "add"
      ? await db.execute(sql`
          WITH u AS (
            UPDATE users SET balance_paise = balance_paise + ${paise}
            WHERE id = ${user.id} AND balance_paise + ${paise} <= ${MAX_BALANCE_PAISE}
            RETURNING id, balance_paise
          )
          INSERT INTO transactions (user_id, type, amount_paise, method, note, reference, balance_after_paise)
          SELECT id, 'add', ${paise}, ${method}, ${note}, ${ref}, balance_paise FROM u
          RETURNING id
        `)
      : await db.execute(sql`
          WITH u AS (
            UPDATE users SET balance_paise = balance_paise - ${paise}
            WHERE id = ${user.id} AND balance_paise >= ${paise}
            RETURNING id, balance_paise
          )
          INSERT INTO transactions (user_id, type, amount_paise, method, note, reference, balance_after_paise)
          SELECT id, 'withdraw', ${paise}, ${method}, ${note}, ${ref}, balance_paise FROM u
          RETURNING id
        `);

  const [inserted] = rowsOf(result);
  if (!inserted)
    return fail(
      c,
      400,
      kind === "add" ? "Demo wallet limit is ₹10,00,000. Try a smaller amount." : "Insufficient demo balance.",
    );
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, Number(inserted.id)));
  return c.json({ transaction: publicTxn(txn), balance: txn.balanceAfterPaise / 100 });
}

app.post("/api/wallet/add", (c) => moveDemoMoney(c, "add"));
app.post("/api/wallet/withdraw", (c) => moveDemoMoney(c, "withdraw"));

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

export default app;
