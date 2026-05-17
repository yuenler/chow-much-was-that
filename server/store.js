import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", ".data");
const dataFile = path.join(dataDir, "finance.json");

const DEFAULT_CATEGORIES = [
  { name: "Income", color: "#1f9d73", monthlyBudget: 0 },
  { name: "Housing", color: "#4f46e5", monthlyBudget: 2400 },
  { name: "Groceries", color: "#0f9f9a", monthlyBudget: 650 },
  { name: "Dining", color: "#f97316", monthlyBudget: 450 },
  { name: "Transport", color: "#2563eb", monthlyBudget: 350 },
  { name: "Shopping", color: "#db2777", monthlyBudget: 400 },
  { name: "Subscriptions", color: "#7c3aed", monthlyBudget: 120 },
  { name: "Entertainment", color: "#eab308", monthlyBudget: 200 },
  { name: "Health", color: "#dc2626", monthlyBudget: 200 },
  { name: "Utilities", color: "#0891b2", monthlyBudget: 260 },
  { name: "Travel", color: "#16a34a", monthlyBudget: 250 },
  { name: "Family Support", color: "#8b5cf6", monthlyBudget: 0 },
  { name: "Debt Payments", color: "#64748b", monthlyBudget: 0 },
  { name: "Transfers", color: "#475569", monthlyBudget: 0 },
  { name: "Venmo / Zelle", color: "#06b6d4", monthlyBudget: 300 },
  { name: "Investments", color: "#059669", monthlyBudget: 0 },
  { name: "Fees", color: "#991b1b", monthlyBudget: 40 },
  { name: "Uncategorized", color: "#94a3b8", monthlyBudget: 0 }
];

function defaultState() {
  const chatThreadId = randomUUID();
  const now = new Date().toISOString();
  return {
    version: 1,
    plaidItems: [],
    accounts: [],
    transactions: [],
    incomeStatements: [],
    categories: DEFAULT_CATEGORIES,
    rules: [],
    chat: [],
    chatThreads: [{ id: chatThreadId, title: "New chat", messages: [], createdAt: now, updatedAt: now }],
    activeChatThreadId: chatThreadId,
    createdAt: now,
    updatedAt: now
  };
}

function chatTitle(messages) {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.content?.trim());
  if (!firstUserMessage) return "New chat";
  const compact = firstUserMessage.content.trim().replace(/\s+/g, " ");
  return compact.length > 48 ? `${compact.slice(0, 45)}...` : compact;
}

function normalizeChatThread(thread, fallbackId) {
  const now = new Date().toISOString();
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  return {
    id: thread?.id || fallbackId || randomUUID(),
    title: thread?.title || chatTitle(messages),
    messages,
    createdAt: thread?.createdAt || messages[0]?.createdAt || now,
    updatedAt: thread?.updatedAt || messages.at(-1)?.createdAt || now
  };
}

function canonicalLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 80);
}

function fixedCategoryName(value) {
  const label = canonicalLabel(value);
  if (label === "grocery") return "Groceries";
  return DEFAULT_CATEGORIES.find((category) => canonicalLabel(category.name) === label)?.name || null;
}

function normalizeTransactionShape(txn) {
  const legacyOverride = canonicalLabel(txn.labelOverride);
  const legacyCategory = txn.category || "Uncategorized";
  const legacySubcategory = txn.subcategory || "";
  const fixedLegacyCategory = fixedCategoryName(legacyCategory);
  const fixedLegacySubcategory = fixedCategoryName(legacySubcategory);
  const context = canonicalLabel(txn.context) || legacyOverride || (!fixedLegacyCategory ? canonicalLabel(legacyCategory) : "");
  const category = fixedLegacySubcategory || fixedLegacyCategory || "Uncategorized";
  const { labelOverride, userCategory, subcategory, ...rest } = txn;
  return {
    ...rest,
    category,
    context
  };
}

function normalizeIncomeStatement(statement) {
  return {
    id: statement.id || randomUUID(),
    fileName: statement.fileName || "Income statement",
    uploadedAt: statement.uploadedAt || new Date().toISOString(),
    source: statement.source || "manual",
    sourceTransactionId: statement.sourceTransactionId || "",
    incomeRuleId: statement.incomeRuleId || "",
    employer: statement.employer || "",
    payDate: statement.payDate || statement.periodEnd || "",
    periodStart: statement.periodStart || statement.payDate || "",
    periodEnd: statement.periodEnd || statement.payDate || "",
    grossPay: Number(statement.grossPay || 0),
    taxes: Number(statement.taxes || 0),
    retirement401k: Number(statement.retirement401k || 0),
    benefits: Number(statement.benefits || 0),
    takeHome: Number(statement.takeHome || 0),
    payrollLines: statement.payrollLines || { statutory: {}, other: {} },
    aiSummary: statement.aiSummary || ""
  };
}

function normalizeState(rawState) {
  const state = rawState || defaultState();
  const legacyChat = Array.isArray(state.chat) ? state.chat : [];
  let chatThreads = Array.isArray(state.chatThreads)
    ? state.chatThreads.map((thread) => normalizeChatThread(thread))
    : [];

  if (!chatThreads.length && legacyChat.length) {
    chatThreads = [normalizeChatThread({
      id: state.activeChatThreadId,
      title: chatTitle(legacyChat),
      messages: legacyChat
    })];
  }

  if (!chatThreads.length) {
    chatThreads = [normalizeChatThread({ id: state.activeChatThreadId, title: "New chat", messages: [] })];
  }

  const activeChatThreadId = chatThreads.some((thread) => thread.id === state.activeChatThreadId)
    ? state.activeChatThreadId
    : chatThreads[0].id;
  const activeThread = chatThreads.find((thread) => thread.id === activeChatThreadId) || chatThreads[0];

  return {
    ...state,
    rules: (state.rules || []).map((rule) => ({
      ...rule,
      category: fixedCategoryName(rule.category || rule.label) || rule.category || null,
      context: canonicalLabel(rule.context) || (fixedCategoryName(rule.category || rule.label) ? "" : canonicalLabel(rule.label)),
      ignore: Boolean(rule.ignore)
    })),
    transactions: (state.transactions || []).map((txn) => normalizeTransactionShape(txn)),
    incomeStatements: (state.incomeStatements || []).map((statement) => normalizeIncomeStatement(statement)),
    chatThreads,
    activeChatThreadId,
    chat: activeThread.messages
  };
}

function ensureDataFile() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(defaultState(), null, 2));
  }
}

export function readState() {
  ensureDataFile();
  return normalizeState(JSON.parse(fs.readFileSync(dataFile, "utf8")));
}

export function writeState(nextState) {
  ensureDataFile();
  const state = normalizeState({ ...nextState, updatedAt: new Date().toISOString() });
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
  return state;
}

export function updateState(updater) {
  const current = readState();
  const next = updater(current);
  return writeState(next);
}

export function publicState() {
  const state = readState();
  return {
    ...state,
    plaidItems: state.plaidItems.map(({ accessToken, ...item }) => item)
  };
}
