import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import {
  analyzeIncomeStatementPdf,
  categorizeTransactionsWithAI,
  financeChatWithAI,
  interpretCommandWithAI,
  OPENAI_MODELS,
  openaiConfigured,
  selectedOpenAIModel,
  setOpenAIModel
} from "./ai.js";
import {
  normalizeAccount,
  normalizeTransaction,
  queryTransactions,
  summarizeFinance,
  transactionLabel,
  upsertById
} from "./finance.js";
import { publicState, readState, updateState } from "./store.js";

const app = express();
const port = Number(process.env.PORT || 5174);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing-key" });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const plaidEnv = process.env.PLAID_ENV || "sandbox";
const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[plaidEnv],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
        "PLAID-SECRET": process.env.PLAID_SECRET || ""
      }
    }
  })
);

function plaidConfigured() {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && PlaidEnvironments[plaidEnv]);
}

app.get("/api/config", (_req, res) => {
  res.json({
    plaidConfigured: plaidConfigured(),
    plaidEnv,
    openaiConfigured: openaiConfigured(),
    openaiModel: selectedOpenAIModel(),
    openaiModels: Array.from(new Set([selectedOpenAIModel(), ...OPENAI_MODELS]))
  });
});

app.patch("/api/config/model", (req, res) => {
  try {
    const openaiModel = setOpenAIModel(req.body?.model);
    res.json({
      ok: true,
      openaiModel,
      openaiModels: Array.from(new Set([openaiModel, ...OPENAI_MODELS]))
    });
  } catch (error) {
    res.status(400).json({ error: cleanError(error) });
  }
});

app.get("/api/state", (req, res) => {
  const state = publicState();
  const range = {
    mode: req.query.mode,
    year: req.query.year,
    month: req.query.month,
    day: req.query.day,
    start: req.query.start,
    end: req.query.end
  };
  res.json({
    ...state,
    summary: summarizeFinance(state, range)
  });
});


app.post("/api/plaid/link-token", async (req, res) => {
  if (!plaidConfigured()) {
    return res.status(400).json({ error: "Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env." });
  }

  try {
    const products = (process.env.PLAID_PRODUCTS || "transactions").split(",").map((item) => item.trim());
    const countryCodes = (process.env.PLAID_COUNTRY_CODES || "US").split(",").map((item) => item.trim());
    const redirectUri = process.env.PLAID_REDIRECT_URI;
    const linkTokenRequest = {
      user: { client_user_id: "local-owner" },
      client_name: "Chow Much Was That",
      products,
      country_codes: countryCodes,
      language: "en",
      transactions: {
        days_requested: 730
      }
    };
    if (redirectUri) linkTokenRequest.redirect_uri = redirectUri;
    const response = await plaidClient.linkTokenCreate(linkTokenRequest);
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    res.status(500).json({ error: cleanError(error) });
  }
});

app.post("/api/plaid/exchange-public-token", async (req, res) => {
  if (!plaidConfigured()) {
    return res.status(400).json({ error: "Plaid is not configured." });
  }

  try {
    const { public_token: publicToken, metadata } = req.body;
    const exchange = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    const itemId = exchange.data.item_id;
    const accessToken = exchange.data.access_token;

    updateState((state) => {
      const existing = state.plaidItems.find((item) => item.itemId === itemId);
      const item = {
        id: existing?.id || crypto.randomUUID(),
        itemId,
        accessToken,
        cursor: existing?.cursor || null,
        institutionName: metadata?.institution?.name || existing?.institutionName || "Connected institution",
        createdAt: existing?.createdAt || new Date().toISOString()
      };
      return {
        ...state,
        plaidItems: upsertById(state.plaidItems, item)
      };
    });

    const synced = await syncPlaidItem(itemId);
    res.json({ ok: true, state: publicState(), sync: synced });
  } catch (error) {
    res.status(500).json({ error: cleanError(error) });
  }
});

app.post("/api/plaid/sync", async (_req, res) => {
  if (!plaidConfigured()) {
    return res.status(400).json({ error: "Plaid is not configured." });
  }

  try {
    const state = readState();
    const results = [];
    for (const item of state.plaidItems) {
      results.push(await syncPlaidItem(item.itemId));
    }
    res.json({ ok: true, results, state: publicState(), summary: summarizeFinance(publicState()) });
  } catch (error) {
    res.status(500).json({ error: cleanError(error) });
  }
});

app.patch("/api/transactions/:id", (req, res) => {
  const { id } = req.params;
  const patch = req.body || {};
  const state = updateState((current) => ({
    ...current,
    transactions: current.transactions.map((txn) => {
      if (txn.id !== id) return txn;
      return applyTransactionPatch(current, txn, patch);
    })
  }));
  res.json({ ok: true, transaction: state.transactions.find((txn) => txn.id === id), summary: summarizeFinance(state) });
});

app.post("/api/transactions/search", (req, res) => {
  res.json({ ok: true, ...queryTransactions(publicState(), req.body || {}) });
});

app.post("/api/chat/new", (_req, res) => {
  const state = updateState((current) => createNewChatThread(current));
  const safeState = publicState();
  res.json({
    ok: true,
    state: safeState,
    chat: state.chat,
    chatThreads: state.chatThreads,
    activeChatThreadId: state.activeChatThreadId,
    summary: summarizeFinance(safeState)
  });
});

app.post("/api/rules", (req, res) => {
  const match = cleanText(req.body.match);
  if (!match) return res.status(400).json({ error: "match is required." });
  const currentState = readState();
  const requestedCategory = categoryByName(currentState.categories, req.body.category);
  const requestedContext = cleanLabel(req.body.context ?? (requestedCategory ? "" : req.body.label));
  const ignore = Boolean(req.body.ignore);
  if (!requestedCategory && !requestedContext && !ignore) {
    return res.status(400).json({ error: "Choose a category, context, or ignore for this rule." });
  }

  const state = updateState((current) => {
    const fixedCategory = categoryByName(current.categories, requestedCategory);
    const context = requestedContext;
    const rule = {
      id: crypto.randomUUID(),
      match,
      category: fixedCategory,
      context,
      ignore,
      active: true,
      createdAt: new Date().toISOString()
    };
    return {
      ...current,
      rules: [rule, ...current.rules],
      transactions: current.transactions.map((txn) => {
        const txnLabel = `${txn.displayName || ""} ${txn.merchantName || ""} ${txn.name || ""}`.toLowerCase();
        if (!txnLabel.includes(match.toLowerCase())) return txn;
        let next = txn;
        if (fixedCategory) next = applyCategoryValue(current, next, fixedCategory);
        if (context) next = applyContextValue(next, context);
        if (ignore) next = { ...next, hidden: true, reviewed: true };
        return next;
      })
    };
  });

  res.json({ ok: true, state: publicState(), summary: summarizeFinance(state) });
});

app.post("/api/labels/range", (req, res) => {
  const label = cleanLabel(req.body?.label);
  const start = req.body?.start;
  const end = req.body?.end;
  if (!label || !validDate(start) || !validDate(end)) {
    return res.status(400).json({ error: "label, start, and end are required. Dates must be YYYY-MM-DD." });
  }

  const [rangeStart, rangeEnd] = start <= end ? [start, end] : [end, start];
  let changed = 0;
  const state = updateState((current) => ({
    ...current,
    transactions: current.transactions.map((txn) => {
      if (txn.hidden || txn.date < rangeStart || txn.date > rangeEnd) return txn;
      changed += 1;
      return applyContextValue(txn, label);
    })
  }));

  res.json({ ok: true, changed, label, displayLabel: formatLabel(label), start: rangeStart, end: rangeEnd, state: publicState(), summary: summarizeFinance(state) });
});

app.patch("/api/rules/:id", (req, res) => {
  const state = updateState((current) => ({
    ...current,
    rules: current.rules.map((rule) => (rule.id === req.params.id ? { ...rule, ...req.body } : rule))
  }));
  res.json({ ok: true, rules: state.rules });
});

app.delete("/api/rules/:id", (req, res) => {
  const state = updateState((current) => ({
    ...current,
    rules: current.rules.filter((rule) => rule.id !== req.params.id)
  }));
  res.json({ ok: true, rules: state.rules });
});

app.post("/api/income-statements", upload.single("statement"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload a PDF income statement." });
  if (!/pdf/i.test(req.file.mimetype) && !req.file.originalname.toLowerCase().endsWith(".pdf")) {
    return res.status(400).json({ error: "Income statements must be PDFs." });
  }

  try {
    const parsed = await analyzeIncomeStatementPdf(req.file.buffer, req.file.originalname);
    const statement = {
      id: crypto.randomUUID(),
      fileName: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      ...parsed
    };
    const state = updateState((current) => ({
      ...current,
      incomeStatements: [statement, ...(current.incomeStatements || [])]
    }));
    const safeState = publicState();
    res.json({ ok: true, statement, state: safeState, summary: summarizeFinance(safeState) });
  } catch (error) {
    res.status(500).json({ error: cleanError(error) });
  }
});

app.post("/api/income-statements/manual", (req, res) => {
  const payDate = validDate(req.body.payDate) ? req.body.payDate : "";
  if (!payDate) return res.status(400).json({ error: "Pay date is required." });

  const grossPay = roundMoney(req.body.grossPay);
  const taxes = roundMoney(req.body.taxes);
  const retirement401k = roundMoney(req.body.retirement401k);
  const benefits = roundMoney(req.body.benefits);
  const providedTakeHome = req.body.takeHome === "" || req.body.takeHome === null || req.body.takeHome === undefined
    ? null
    : roundMoney(req.body.takeHome);
  const takeHome = providedTakeHome ?? roundMoney(Math.max(grossPay - taxes - retirement401k - benefits, 0));

  const statement = {
    id: crypto.randomUUID(),
    fileName: "Manual income entry",
    uploadedAt: new Date().toISOString(),
    source: "manual-entry",
    employer: cleanText(req.body.employer) || "Manual income",
    payDate,
    periodStart: validDate(req.body.periodStart) ? req.body.periodStart : payDate,
    periodEnd: validDate(req.body.periodEnd) ? req.body.periodEnd : payDate,
    grossPay,
    taxes,
    retirement401k,
    benefits,
    takeHome,
    payrollLines: { statutory: {}, other: {} },
    aiSummary: ""
  };

  const state = updateState((current) => ({
    ...current,
    incomeStatements: [statement, ...(current.incomeStatements || [])]
  }));
  const safeState = publicState();
  res.json({ ok: true, statement, state: safeState, summary: summarizeFinance(safeState) });
});

app.patch("/api/income-statements/:id", (req, res) => {
  const allowed = new Set(["employer", "payDate", "periodStart", "periodEnd", "grossPay", "taxes", "retirement401k", "benefits", "takeHome"]);
  const patch = Object.fromEntries(
    Object.entries(req.body || {}).filter(([key]) => allowed.has(key))
  );
  for (const field of ["grossPay", "taxes", "retirement401k", "benefits", "takeHome"]) {
    if (patch[field] !== undefined) patch[field] = Math.round(Number(patch[field] || 0) * 100) / 100;
  }
  const state = updateState((current) => ({
    ...current,
    incomeStatements: (current.incomeStatements || []).map((statement) =>
      statement.id === req.params.id ? { ...statement, ...patch } : statement
    )
  }));
  const safeState = publicState();
  res.json({ ok: true, state: safeState, summary: summarizeFinance(safeState) });
});

app.delete("/api/income-statements/:id", (req, res) => {
  const state = updateState((current) => ({
    ...current,
    incomeStatements: (current.incomeStatements || []).filter((statement) => statement.id !== req.params.id)
  }));
  const safeState = publicState();
  res.json({ ok: true, state: safeState, summary: summarizeFinance(safeState) });
});

app.post("/api/income-rules/generate", (req, res) => {
  const match = cleanText(req.body.match || "HARVARD UNIVERSI PAYROLL");
  const employer = cleanText(req.body.employer || "Harvard University");
  const grossPay = roundMoney(req.body.grossPay ?? 449.96);
  const minimumDeposit = roundMoney(req.body.minimumDeposit ?? 250);
  const startDate = validDate(req.body.startDate) ? req.body.startDate : "2025-01-01";
  const endDate = validDate(req.body.endDate) ? req.body.endDate : "9999-12-31";
  const incomeRuleId = `income_rule_${hashText(`${match}|${grossPay}`)}`;

  const state = updateState((current) => {
    const existingSourceIds = new Set((current.incomeStatements || []).map((statement) => statement.sourceTransactionId).filter(Boolean));
    const generated = current.transactions
      .filter((txn) => {
        const text = `${txn.displayName || ""} ${txn.merchantName || ""} ${txn.name || ""}`.toLowerCase();
        const deposit = Math.abs(Number(txn.amount || 0));
        return txn.amount < 0
          && txn.date >= startDate
          && txn.date <= endDate
          && deposit >= minimumDeposit
          && text.includes(match.toLowerCase())
          && !existingSourceIds.has(txn.id);
      })
      .map((txn) => {
        const takeHome = roundMoney(Math.abs(txn.amount));
        const taxes = roundMoney(Math.max(grossPay - takeHome, 0));
        return {
          id: `income_${hashText(`${incomeRuleId}|${txn.id}`)}`,
          fileName: "Generated from payroll deposit",
          uploadedAt: new Date().toISOString(),
          source: "income-rule",
          sourceTransactionId: txn.id,
          incomeRuleId,
          employer,
          payDate: txn.date,
          periodStart: txn.date,
          periodEnd: txn.date,
          grossPay,
          taxes,
          retirement401k: 0,
          benefits: 0,
          takeHome,
          payrollLines: {
            statutory: { inferredTaxes: taxes },
            other: {}
          },
          aiSummary: `Generated from matching payroll deposit. Taxes inferred as gross pay minus take-home.`
        };
      });

    return {
      ...current,
      incomeStatements: [...generated, ...(current.incomeStatements || [])].sort((a, b) => String(b.payDate || "").localeCompare(String(a.payDate || "")))
    };
  });

  const safeState = publicState();
  res.json({ ok: true, state: safeState, summary: summarizeFinance(safeState) });
});

app.patch("/api/categories/:name", (req, res) => {
  const state = updateState((current) => ({
    ...current,
    categories: current.categories.map((category) =>
      category.name === req.params.name ? { ...category, ...req.body } : category
    )
  }));
  res.json({ ok: true, categories: state.categories, summary: summarizeFinance(state) });
});

app.post("/api/ai/categorize", async (_req, res) => {
  try {
    const state = readState();
    const candidates = state.transactions
      .filter((txn) => txn.category === "Uncategorized" || txn.category === "Venmo / Zelle")
      .sort((a, b) => b.date.localeCompare(a.date));
    const updates = await categorizeTransactionsWithAI(candidates, state.categories, state.rules);
    const next = updateState((current) => ({
      ...current,
      transactions: current.transactions.map((txn) => {
        const update = updates.find((candidate) => candidate.id === txn.id);
        if (!update) return txn;
        const label = cleanLabel(update.label || update.category);
        if (!label) return txn;
        const fixedCategory = categoryByName(state.categories, update.category);
        return {
          ...applyCategoryValue(current, txn, fixedCategory || label),
          aiSummary: update.aiSummary,
          reviewed: update.confidence >= 0.72
        };
      })
    }));

    res.json({ ok: true, updates, state: publicState(), summary: summarizeFinance(next) });
  } catch (error) {
    res.status(500).json({ error: cleanError(error) });
  }
});

app.post("/api/ai/command", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text is required." });

    const interpretation = await interpretCommandWithAI(text, readState());
    const applied = applyCommand(interpretation, text);
    res.json({ ok: true, interpretation, applied, state: publicState(), summary: summarizeFinance(publicState()) });
  } catch (error) {
    res.status(500).json({ error: cleanError(error) });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message is required." });
    const interpretation = await interpretCommandWithAI(message, readState());
    const applied = applyCommand(interpretation, message);
    const answer = applied.changed
      ? applied.message
      : await financeChatWithAI(message, readState());
    const state = updateState((current) => appendMessagesToActiveChat(current, [
      { id: crypto.randomUUID(), role: "user", content: message, createdAt: new Date().toISOString() },
      { id: crypto.randomUUID(), role: "assistant", content: answer, createdAt: new Date().toISOString() }
    ]));
    res.json({ ok: true, answer, changed: applied.changed, chat: state.chat, state: publicState(), summary: summarizeFinance(publicState()) });
  } catch (error) {
    res.status(500).json({ error: cleanError(error) });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  const { message } = req.body || {};
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  if (!message || typeof message !== "string") {
    writeStreamEvent(res, "error", { message: "message is required." });
    return res.end();
  }

  try {
    const history = readState().chat || [];
    const eventsForChat = [
      { id: crypto.randomUUID(), role: "user", content: message, createdAt: new Date().toISOString() }
    ];
    let answer = "";
    let changed = false;

    if (!openaiConfigured()) {
      const text = "Add an OpenAI key to use the tool-calling assistant. The deterministic table controls still work.";
      writeStreamEvent(res, "text_delta", { delta: text });
      answer = text;
    } else {
      const result = await runFinanceAgent(message, {
        history,
        onEvent: (event) => {
          writeStreamEvent(res, event.type, event);
          if (event.type === "text_delta") answer += event.delta;
          if (event.type === "tool_call") {
            eventsForChat.push({
              id: crypto.randomUUID(),
              role: "tool",
              content: `Calling ${event.name} ${JSON.stringify(event.arguments || {})}`,
              createdAt: new Date().toISOString()
            });
          }
          if (event.type === "tool_result") {
            if (event.changed) changed = true;
            eventsForChat.push({
              id: crypto.randomUUID(),
              role: "tool",
              content: event.summary,
              createdAt: new Date().toISOString()
            });
          }
        }
      });
      if (!answer.trim()) answer = result.answer || "Done.";
      changed = changed || result.changed;
    }

    const state = updateState((current) => appendMessagesToActiveChat(current, [
      ...eventsForChat,
      { id: crypto.randomUUID(), role: "assistant", content: answer, createdAt: new Date().toISOString() }
    ]));

    writeStreamEvent(res, "done", {
      answer,
      changed,
      chat: state.chat,
      chatThreads: state.chatThreads,
      activeChatThreadId: state.activeChatThreadId,
      summary: summarizeFinance(publicState())
    });
  } catch (error) {
    writeStreamEvent(res, "error", { message: cleanError(error) });
  } finally {
    res.end();
  }
});

async function syncPlaidItem(itemId) {
  let added = [];
  let modified = [];
  let removed = [];
  let accounts = [];
  let cursor = null;
  let hasMore = true;

  const state = readState();
  const item = state.plaidItems.find((candidate) => candidate.itemId === itemId);
  if (!item) throw new Error(`Unknown Plaid item ${itemId}`);
  cursor = item.cursor || null;

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: item.accessToken,
      cursor,
      count: 100
    });
    added = added.concat(response.data.added || []);
    modified = modified.concat(response.data.modified || []);
    removed = removed.concat(response.data.removed || []);
    accounts = response.data.accounts || accounts;
    cursor = response.data.next_cursor;
    hasMore = response.data.has_more;
  }

  const normalized = updateState((current) => {
    const byId = new Map(current.transactions.map((txn) => [txn.id, txn]));
    const nextAccounts = accounts.reduce((list, account) => upsertById(list, normalizeAccount(account)), current.accounts);
    let nextTransactions = current.transactions.filter(
      (txn) => !removed.some((removedTxn) => removedTxn.transaction_id === txn.id)
    );

    for (const txn of [...added, ...modified]) {
      const existing = byId.get(txn.transaction_id);
      nextTransactions = upsertById(nextTransactions, normalizeTransaction(txn, existing, current));
    }

    return {
      ...current,
      accounts: nextAccounts,
      transactions: nextTransactions.sort((a, b) => b.date.localeCompare(a.date)),
      plaidItems: current.plaidItems.map((candidate) =>
        candidate.itemId === itemId ? { ...candidate, cursor } : candidate
      )
    };
  });

  return {
    itemId,
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    accounts: accounts.length,
    transactionCount: normalized.transactions.length
  };
}

function applyCommand(interpretation, originalText) {
  let result = { changed: false, message: interpretation.explanation || "No changes made." };

  updateState((current) => {
    if (interpretation.action === "set_budget" && interpretation.budgetCategory && interpretation.budgetAmount !== null) {
      result = { changed: true, message: `Set ${interpretation.budgetCategory} budget to $${interpretation.budgetAmount}.` };
      return {
        ...current,
        categories: current.categories.map((category) =>
          category.name === interpretation.budgetCategory
            ? { ...category, monthlyBudget: Number(interpretation.budgetAmount) }
            : category
        )
      };
    }

    if (interpretation.action === "label_range" && interpretation.label && interpretation.startDate && interpretation.endDate) {
      const [rangeStart, rangeEnd] = interpretation.startDate <= interpretation.endDate
        ? [interpretation.startDate, interpretation.endDate]
        : [interpretation.endDate, interpretation.startDate];
      let count = 0;
      result = { changed: true, message: `Labeled ${rangeStart} through ${rangeEnd} as ${formatLabel(interpretation.label)}.` };
      return {
        ...current,
        transactions: current.transactions.map((txn) => {
          if (txn.hidden || txn.date < rangeStart || txn.date > rangeEnd) return txn;
          count += 1;
          return applyContextValue(txn, cleanLabel(interpretation.label));
        })
      };
    }

    if (interpretation.action === "categorize_transaction" && interpretation.transactionId && (interpretation.category || interpretation.label)) {
      const matchText = interpretation.merchantMatch || "";
      const label = cleanLabel(interpretation.label || interpretation.category);
      const fixedCategory = categoryByName(current.categories, interpretation.category) || categoryByName(current.categories, label);
      const context = fixedCategory ? "" : label;
      const nextRules = interpretation.makeRule && matchText
        ? [
            {
              id: crypto.randomUUID(),
              match: matchText,
              category: fixedCategory,
              context,
              active: true,
              createdAt: new Date().toISOString()
            },
            ...current.rules
          ]
        : current.rules;

      result = { changed: true, message: interpretation.explanation || `Updated transaction to ${formatLabel(label)}.` };
      return {
        ...current,
        rules: nextRules,
        transactions: current.transactions.map((txn) => {
          if (txn.id !== interpretation.transactionId) return txn;
          return {
            ...(fixedCategory ? applyCategoryValue(current, txn, fixedCategory) : applyContextValue(txn, label)),
            notes: [txn.notes, interpretation.note || originalText].filter(Boolean).join(" | "),
            reviewed: true
          };
        })
      };
    }

    if (interpretation.action === "add_rule" && (interpretation.category || interpretation.label) && interpretation.merchantMatch) {
      const label = cleanLabel(interpretation.label || interpretation.category);
      const fixedCategory = categoryByName(current.categories, interpretation.category) || categoryByName(current.categories, label);
      result = { changed: true, message: `Added a permanent rule for ${interpretation.merchantMatch}.` };
      return {
        ...current,
        rules: [
          {
              id: crypto.randomUUID(),
              match: interpretation.merchantMatch,
              category: fixedCategory,
              context: fixedCategory ? "" : label,
              active: true,
              createdAt: new Date().toISOString()
            },
          ...current.rules
        ]
      };
    }

    return current;
  });

  return result;
}

function createNewChatThread(current) {
  const now = new Date().toISOString();
  const thread = {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now
  };
  return {
    ...current,
    activeChatThreadId: thread.id,
    chatThreads: [thread, ...(current.chatThreads || [])],
    chat: []
  };
}

function appendMessagesToActiveChat(current, messages) {
  const now = new Date().toISOString();
  const chatThreads = current.chatThreads?.length
    ? current.chatThreads
    : [{
        id: current.activeChatThreadId || crypto.randomUUID(),
        title: "New chat",
        messages: current.chat || [],
        createdAt: now,
        updatedAt: now
      }];
  const activeChatThreadId = chatThreads.some((thread) => thread.id === current.activeChatThreadId)
    ? current.activeChatThreadId
    : chatThreads[0].id;
  let activeMessages = [];
  const nextThreads = chatThreads.map((thread) => {
    if (thread.id !== activeChatThreadId) return thread;
    activeMessages = [...(thread.messages || []), ...messages].slice(-120);
    return {
      ...thread,
      title: thread.title && thread.title !== "New chat" ? thread.title : chatTitle(activeMessages),
      messages: activeMessages,
      updatedAt: now
    };
  });

  return {
    ...current,
    activeChatThreadId,
    chatThreads: nextThreads,
    chat: activeMessages
  };
}

function chatTitle(messages) {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.content?.trim());
  if (!firstUserMessage) return "New chat";
  const compact = firstUserMessage.content.trim().replace(/\s+/g, " ");
  return compact.length > 48 ? `${compact.slice(0, 45)}...` : compact;
}

async function runFinanceAgent(message, { onEvent, history = [] }) {
  const tools = financeAgentTools();
  let input = [
    ...chatHistoryForAgent(history),
    {
      role: "user",
      content: message
    }
  ];
  let answer = "";
  let changed = false;

  for (let step = 0; step < 8; step += 1) {
    const stream = await openai.responses.create({
      model: selectedOpenAIModel(),
      instructions: financeAgentInstructions(),
      input,
      tools,
      stream: true,
      parallel_tool_calls: false,
      store: false
    });
    let response = null;
    const outputItems = [];

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        answer += event.delta;
        onEvent({ type: "text_delta", delta: event.delta });
      }
      if (event.type === "response.reasoning_summary_text.delta") {
        onEvent({ type: "reasoning_delta", delta: event.delta });
      }
      if (event.type === "response.output_item.done") {
        outputItems.push(event.item);
      }
      if (event.type === "response.completed") {
        response = event.response;
      }
    }

    const calls = outputItems.filter((item) => item.type === "function_call");
    if (!calls.length) return { answer, changed };

    input = [...input, ...(response?.output || outputItems)];
    for (const call of calls) {
      const args = safeJson(call.arguments || "{}", {});
      onEvent({ type: "tool_call", name: call.name, arguments: args });
      const result = runFinanceAgentTool(call.name, args);
      if (result.changed) changed = true;
      onEvent({
        type: "tool_result",
        name: call.name,
        changed: Boolean(result.changed),
        summary: result.summary || summarizeToolResult(call.name, result),
        result: compactToolResult(result)
      });
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result)
      });
    }
  }

  return { answer: answer || "I hit my tool-call limit. Try narrowing the request.", changed };
}

function chatHistoryForAgent(history) {
  return history
    .filter((message) => ["user", "assistant"].includes(message.role) && message.content?.trim())
    .slice(-16)
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}

function financeAgentInstructions() {
  const state = publicState();
  const fixedCategories = state.categories.map((category) => category.name).join(", ");
  return [
    "You are an agentic personal finance assistant inside a local budgeting app.",
    `Existing fixed categories: ${fixedCategories}. Use category for ordinary spend type and prefer one of these values when it fits.`,
    "Use tools to inspect and edit data. Do not guess transaction IDs.",
    "For any request to change one or more transactions, first call search_transactions unless the user already supplied exact transaction IDs.",
    "Use edit_transaction_field to change one transaction by id. Use label_transactions_by_date_range only when the user explicitly asks for all/everything/between/from-through/during a date range.",
    "Use the previous chat turns for short follow-ups like yes, do it, that one, or undo that; resolve what the user means before asking for clarification.",
    "Transactions use category for spend type and context for trips/projects/events/life buckets. For trips/projects/events, set context and preserve category.",
    "Custom contexts are stored lowercase by tools, but when you mention one to the user, capitalize it like a normal title.",
    "Transactions have stable IDs. Mention the merchant/name/date/amount when confirming edits.",
    "Expose your work through concise visible summaries. Do not reveal hidden chain-of-thought."
  ].join(" ");
}

function financeAgentTools() {
  return [
    {
      type: "function",
      name: "search_transactions",
      description: "Search and filter transactions. Substring query checks id, date, display name, merchant, name, notes, category, context, payment channel, account name, account mask, and amount. Strict filters can narrow by dates, category, context, account/card, amount, direction, reviewed, pending, and ids.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query", "startDate", "endDate", "labels", "categories", "contexts", "accountIds", "accountNames", "accountMasks", "accountTypes", "direction", "minAmount", "maxAmount", "reviewed", "pending", "ids", "limit"],
        properties: {
          query: { type: ["string", "null"] },
          startDate: { type: ["string", "null"], description: "YYYY-MM-DD inclusive" },
          endDate: { type: ["string", "null"], description: "YYYY-MM-DD inclusive" },
          labels: { type: ["array", "null"], items: { type: "string" } },
          categories: { type: ["array", "null"], items: { type: "string" } },
          contexts: { type: ["array", "null"], items: { type: "string" } },
          accountIds: { type: ["array", "null"], items: { type: "string" } },
          accountNames: { type: ["array", "null"], items: { type: "string" } },
          accountMasks: { type: ["array", "null"], items: { type: "string" } },
          accountTypes: { type: ["array", "null"], items: { type: "string" } },
          direction: { type: ["string", "null"], enum: ["spending", "income", null] },
          minAmount: { type: ["number", "null"], description: "Absolute amount minimum" },
          maxAmount: { type: ["number", "null"], description: "Absolute amount maximum" },
          reviewed: { type: ["boolean", "null"] },
          pending: { type: ["boolean", "null"] },
          ids: { type: ["array", "null"], items: { type: "string" } },
          limit: { type: "number" }
        }
      }
    },
    {
      type: "function",
      name: "get_budgets",
      description: "Return budget categories, contexts in use, and current period category/context spending.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["month"],
        properties: {
          month: { type: ["string", "null"], description: "YYYY-MM or null for current month" }
        }
      }
    },
    {
      type: "function",
      name: "edit_transaction_field",
      description: "Edit one field on one transaction by stable transaction id. Use category for spend type and context for trips/projects/events.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id", "field", "value"],
        properties: {
          id: { type: "string" },
          field: { type: "string", enum: ["category", "context", "displayName", "notes", "reviewed", "hidden"] },
          value: { type: ["string", "boolean", "null"] }
        }
      }
    },
    {
      type: "function",
      name: "label_transactions_by_date_range",
      description: "Apply a context to every non-hidden transaction in an explicit inclusive date range while preserving each transaction's category.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["startDate", "endDate", "label"],
        properties: {
          startDate: { type: "string", description: "YYYY-MM-DD inclusive" },
          endDate: { type: "string", description: "YYYY-MM-DD inclusive" },
          label: { type: "string" }
        }
      }
    },
    {
      type: "function",
      name: "get_finance_summary",
      description: "Return spending, income, cashflow, labels/categories, top merchants, recurring transactions, and trends for a month/year/day range.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "year", "month", "day"],
        properties: {
          mode: { type: ["string", "null"], enum: ["day", "month", "year", null] },
          year: { type: ["string", "null"] },
          month: { type: ["string", "null"], description: "YYYY-MM" },
          day: { type: ["string", "null"], description: "YYYY-MM-DD" }
        }
      }
    }
  ];
}

function runFinanceAgentTool(name, args) {
  if (name === "search_transactions") {
    const result = queryTransactions(publicState(), args);
    return {
      ...result,
      summary: `Found ${result.count} transaction${result.count === 1 ? "" : "s"}.`
    };
  }

  if (name === "get_budgets") {
    const state = publicState();
    const summary = summarizeFinance(state, args.month || undefined);
    const contexts = Array.from(new Set(state.transactions.map((txn) => txn.context).filter(Boolean))).sort();
    return {
      categories: state.categories,
      contexts,
      periodSummary: summary,
      summary: `Loaded ${state.categories.length} budgets and ${contexts.length} contexts.`
    };
  }

  if (name === "get_finance_summary") {
    const summary = summarizeFinance(publicState(), {
      mode: args.mode,
      year: args.year,
      month: args.month,
      day: args.day
    });
    return {
      summary,
      summaryText: `Loaded summary for ${summary.period?.label || summary.month}.`
    };
  }

  if (name === "edit_transaction_field") {
    return editTransactionField(args.id, args.field, args.value);
  }

  if (name === "label_transactions_by_date_range") {
    return labelTransactionsByDateRange(args.startDate, args.endDate, args.label);
  }

  return { error: `Unknown tool: ${name}` };
}

function applyTransactionPatch(state, txn, patch) {
  let next = { ...txn, reviewed: true };
  if (patch.category !== undefined) next = applyCategoryValue(state, next, patch.category);
  if (patch.labelOverride !== undefined) next = applyContextValue(next, patch.labelOverride);
  if (patch.context !== undefined) next = applyContextValue(next, patch.context);
  if (patch.displayName !== undefined) next.displayName = cleanText(patch.displayName);
  if (patch.notes !== undefined) next.notes = String(patch.notes || "");
  if (patch.reviewed !== undefined) next.reviewed = Boolean(patch.reviewed);
  if (patch.hidden !== undefined) next.hidden = Boolean(patch.hidden);
  return next;
}

function applyCategoryValue(state, txn, value) {
  const fixedCategory = categoryByName(state.categories, value);
  if (!fixedCategory) return { ...txn, reviewed: true };
  return {
    ...txn,
    category: fixedCategory,
    reviewed: true
  };
}

function applyContextValue(txn, value) {
  return {
    ...txn,
    context: cleanLabel(value),
    reviewed: true
  };
}

function editTransactionField(id, field, value) {
  const allowed = new Set(["category", "context", "displayName", "notes", "reviewed", "hidden"]);
  if (!id || !allowed.has(field)) return { error: "Invalid transaction id or field." };
  if (field === "category" && !categoryByName(readState().categories, value)) {
    return { error: "Category must be one of the existing fixed categories. Use context for custom trips, projects, or labels." };
  }
  let updated = null;
  const state = updateState((current) => ({
    ...current,
    transactions: current.transactions.map((txn) => {
      if (txn.id !== id) return txn;
      if (field === "category") updated = applyCategoryValue(current, txn, value);
      else if (field === "context") updated = applyContextValue(txn, value);
      else {
        const patch = {};
        if (field === "displayName") patch.displayName = cleanText(value);
        else if (field === "notes") patch.notes = String(value || "");
        else if (field === "reviewed") patch.reviewed = Boolean(value);
        else if (field === "hidden") patch.hidden = Boolean(value);
        updated = { ...txn, ...patch, reviewed: true };
      }
      return updated;
    })
  }));
  if (!updated) return { error: `No transaction found for id ${id}.` };
  return {
    changed: true,
    transaction: queryTransactions(state, { ids: [id], includeHidden: true, limit: 1 }).transactions[0],
    summary: `Updated ${updated.name || updated.merchantName || id}: ${field} = ${field === "category" || field === "context" ? formatLabel(value) : String(value)}.`
  };
}

function labelTransactionsByDateRange(startDate, endDate, labelValue) {
  const label = cleanLabel(labelValue);
  if (!validDate(startDate) || !validDate(endDate) || !label) return { error: "startDate, endDate, and label are required." };
  const [rangeStart, rangeEnd] = startDate <= endDate ? [startDate, endDate] : [endDate, startDate];
  let changed = 0;
  const changedIds = [];
  updateState((current) => ({
    ...current,
    transactions: current.transactions.map((txn) => {
      if (txn.hidden || txn.date < rangeStart || txn.date > rangeEnd) return txn;
      changed += 1;
      changedIds.push(txn.id);
      return applyContextValue(txn, label);
    })
  }));
  return {
    changed: changed > 0,
    count: changed,
    ids: changedIds,
    label,
    startDate: rangeStart,
    endDate: rangeEnd,
    summary: `Set context on ${changed} transaction${changed === 1 ? "" : "s"} from ${rangeStart} through ${rangeEnd} to ${formatLabel(label)}.`
  };
}

function compactToolResult(result) {
  if (!result || result.error) return result;
  if (Array.isArray(result.transactions)) {
    return { ...result, transactions: result.transactions.slice(0, 8) };
  }
  if (result.summary?.byCategory) {
    return {
      ...result,
      summary: {
        ...result.summary,
        byCategory: result.summary.byCategory.filter((item) => item.spent > 0).slice(0, 12)
      }
    };
  }
  return result;
}

function summarizeToolResult(name, result) {
  if (result?.summary && typeof result.summary === "string") return result.summary;
  if (result?.summaryText) return result.summaryText;
  if (result?.error) return `${name} failed: ${result.error}`;
  return `${name} completed.`;
}

function writeStreamEvent(res, type, payload = {}) {
  res.write(`${JSON.stringify({ type, ...payload })}\n`);
}

function safeJson(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function cleanError(error) {
  return error?.response?.data || error?.message || "Something went wrong";
}

function cleanLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 80);
}

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function categoryByName(categories, value) {
  const label = cleanLabel(value);
  if (label === "grocery") return "Groceries";
  return categories.find((category) => cleanLabel(category.name) === label)?.name || null;
}

function formatLabel(value) {
  const aliases = new Map([
    ["ai", "AI"],
    ["atm", "ATM"],
    ["gpt", "GPT"],
    ["hsa", "HSA"],
    ["ira", "IRA"],
    ["us", "US"],
    ["usa", "USA"]
  ]);
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => {
      if (word === "/" || word === "&") return word;
      const lower = word.toLowerCase();
      if (aliases.has(lower)) return aliases.get(lower);
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function roundMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function hashText(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 18);
}

const distDir = path.resolve(__dirname, "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.listen(port, () => {
  console.log(`Chow Much Was That API running on http://127.0.0.1:${port}`);
});
