import { pgTable, serial, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

// Demo accounts. Balances are fake demo money stored in paise (1 rupee = 100 paise).
export const users = pgTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  mobile: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  verified: boolean().notNull().default(false),
  balancePaise: integer("balance_paise").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Simulated OTPs. Codes are shown on screen for testing; no SMS is ever sent.
export const otpCodes = pgTable(
  "otp_codes",
  {
    id: serial().primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    purpose: text().notNull(), // "signup" | "login"
    challengeHash: text("challenge_hash").notNull().unique(),
    codeHash: text("code_hash").notNull(),
    attempts: integer().notNull().default(0),
    consumed: boolean().notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("otp_codes_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// Demo transactions only. Nothing here touches a real payment system.
export const transactions = pgTable(
  "transactions",
  {
    id: serial().primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(), // "add" | "withdraw" | "bonus"
    amountPaise: integer("amount_paise").notNull(),
    method: text().notNull(),
    note: text().notNull().default(""),
    reference: text().notNull(),
    balanceAfterPaise: integer("balance_after_paise").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("transactions_user_idx").on(t.userId, t.createdAt)],
);
