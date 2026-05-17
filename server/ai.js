import { PDFParse } from "pdf-parse";
import { currentMonthKey, summarizeFinance, transactionLabel, VENMO_ZELLE_PATTERN } from "./finance.js";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
export const OPENAI_MODELS = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2"];

export function openaiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function selectedOpenAIModel() {
  return process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}

export function setOpenAIModel(model) {
  if (!model || typeof model !== "string") throw new Error("Model is required.");
  process.env.OPENAI_MODEL = model.trim();
  return selectedOpenAIModel();
}

export async function analyzeIncomeStatementPdf(buffer, fileName) {
  const parser = new PDFParse({ data: buffer });
  let text = "";
  let firstPageImageUrl = "";
  try {
    const result = await parser.getText();
    text = result.text || "";
    const screenshot = await parser.getScreenshot({ first: 1, desiredWidth: 3200, imageDataUrl: true, imageBuffer: false });
    firstPageImageUrl = screenshot.pages?.[0]?.dataUrl || "";
  } finally {
    await parser.destroy();
  }

  if (!openaiConfigured()) return fallbackIncomeStatement(text, fileName);

  const response = await callOpenAI({
    instructions: [
      "Extract payroll income statement amounts for a personal finance app.",
      "Return only JSON.",
      "Use positive numbers in dollars.",
      "Read the first-page image as the source of truth. Use the extracted text only as a backup hint.",
      "Use the current pay-period amount column, not year-to-date totals, unless the document only has YTD.",
      "Do not calculate totals. Only copy the individual line amounts into the requested fields.",
      "For the statutory fields, copy only these payroll tax/insurance lines when present: Federal Income Tax, Social Security Tax, Medicare Tax, WA Paid Family Leave Ins, WA Paid Medical Leave Ins, and WA LTCare.",
      "For other fields, copy only these lines when present: Comm Addl Inc, Critic Illness, Hsa, Pre-Tax Dental, Pre-Tax Medical, Pre-Tax Vision, and 401K-Roth.",
      "If a field is absent, return 0 rather than guessing.",
      "Use the sign shown in the document if clear, but do not sum anything."
    ].join(" "),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: JSON.stringify({ fileName, extractedText: text.slice(0, 30000) }) },
          ...(firstPageImageUrl ? [{ type: "input_image", image_url: firstPageImageUrl, detail: "high" }] : [])
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "income_statement",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["employer", "payDate", "periodStart", "periodEnd", "grossPay", "takeHome", "statutory", "other", "aiSummary"],
          properties: {
            employer: { type: "string" },
            payDate: { type: ["string", "null"], description: "YYYY-MM-DD if available" },
            periodStart: { type: ["string", "null"], description: "YYYY-MM-DD if available" },
            periodEnd: { type: ["string", "null"], description: "YYYY-MM-DD if available" },
            grossPay: { type: "number" },
            takeHome: { type: "number" },
            statutory: {
              type: "object",
              additionalProperties: false,
              required: ["federalIncomeTax", "socialSecurityTax", "medicareTax", "waPaidFamilyLeaveIns", "waPaidMedicalLeaveIns", "waLTCare"],
              properties: {
                federalIncomeTax: { type: "number" },
                socialSecurityTax: { type: "number" },
                medicareTax: { type: "number" },
                waPaidFamilyLeaveIns: { type: "number" },
                waPaidMedicalLeaveIns: { type: "number" },
                waLTCare: { type: "number" }
              }
            },
            other: {
              type: "object",
              additionalProperties: false,
              required: ["commAddlInc", "criticalIllness", "hsa", "preTaxDental", "preTaxMedical", "preTaxVision", "roth401k"],
              properties: {
                commAddlInc: { type: "number" },
                criticalIllness: { type: "number" },
                hsa: { type: "number" },
                preTaxDental: { type: "number" },
                preTaxMedical: { type: "number" },
                preTaxVision: { type: "number" },
                roth401k: { type: "number" }
              }
            },
            aiSummary: { type: "string" }
          }
        }
      }
    }
  });

  return normalizeIncomeStatementAnalysis(safeJson(outputText(response), {}), fileName);
}

async function callOpenAI(payload) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: selectedOpenAIModel(),
      ...payload
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${body}`);
  }

  return response.json();
}

function outputText(response) {
  if (response.output_text) return response.output_text;
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" || content.type === "text") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]);
    } catch {
      return fallback;
    }
  }
}

export async function categorizeTransactionsWithAI(transactions, categories, rules) {
  const candidates = transactions.slice(0, 40);
  if (!openaiConfigured()) {
    return candidates.map((txn) => fallbackCategorization(txn, categories));
  }

  const response = await callOpenAI({
    instructions: [
      "You categorize personal finance transactions for a private budgeting app.",
      "Return only JSON.",
      "Use a provided category when it fits. Do not use trips, projects, or events as categories; those belong in transaction context.",
      "Venmo, Zelle, PayPal instant transfers, and Cash App should stay in 'Venmo / Zelle' unless the transaction text clearly says what it paid for.",
      "Transfers and credit card payments should not be treated as spending categories unless obvious."
    ].join(" "),
    input: JSON.stringify({
      categories: categories.map((category) => category.name),
      permanentRules: rules.filter((rule) => rule.active).map((rule) => ({
        match: rule.match,
        category: rule.category,
        context: rule.context || ""
      })),
      transactions: candidates.map((txn) => ({
        id: txn.id,
        date: txn.date,
        merchant: txn.merchantName,
        name: txn.name,
        amount: txn.amount,
        plaidCategory: txn.plaidCategory,
        currentCategory: txn.category
      }))
    }),
    text: {
      format: {
        type: "json_schema",
        name: "transaction_categories",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["updates"],
          properties: {
            updates: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "category", "label", "aiSummary", "confidence"],
                properties: {
                  id: { type: "string" },
                  category: { type: ["string", "null"] },
                  label: { type: ["string", "null"] },
                  aiSummary: { type: "string" },
                  confidence: { type: "number" }
                }
              }
            }
          }
        }
      }
    }
  });

  const parsed = safeJson(outputText(response), { updates: [] });
  return parsed.updates || [];
}

export async function interpretCommandWithAI(text, state) {
  if (!openaiConfigured()) return fallbackCommand(text, state);

  const recent = state.transactions
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 80)
    .map((txn) => ({
      id: txn.id,
      date: txn.date,
      merchant: txn.merchantName,
      name: txn.name,
      amount: txn.amount,
      category: txn.category,
      context: txn.context,
      notes: txn.notes
    }));

  const response = await callOpenAI({
    instructions: [
      "Convert the user's finance command into one app action.",
      "Prefer the most recent matching transaction when the user gives a merchant or vague description.",
      "Categories are spend types. Contexts are flexible human groupings like trips, projects, events, or custom text.",
      "If the user asks to label everything between dates, return label_range with startDate and endDate as YYYY-MM-DD; the label should become context.",
      "If they ask to permanently classify future similar charges, set makeRule true and provide a short merchantMatch.",
      "Return JSON only."
    ].join(" "),
    input: JSON.stringify({
      userCommand: text,
      categories: state.categories.map((category) => category.name),
      recentTransactions: recent
    }),
    text: {
      format: {
        type: "json_schema",
        name: "finance_command",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["action", "transactionId", "category", "label", "note", "makeRule", "merchantMatch", "startDate", "endDate", "budgetCategory", "budgetAmount", "explanation"],
          properties: {
            action: { type: "string", enum: ["categorize_transaction", "label_range", "set_budget", "add_rule", "note_only", "none"] },
            transactionId: { type: ["string", "null"] },
            category: { type: ["string", "null"] },
            label: { type: ["string", "null"] },
            note: { type: ["string", "null"] },
            makeRule: { type: "boolean" },
            merchantMatch: { type: ["string", "null"] },
            startDate: { type: ["string", "null"] },
            endDate: { type: ["string", "null"] },
            budgetCategory: { type: ["string", "null"] },
            budgetAmount: { type: ["number", "null"] },
            explanation: { type: "string" }
          }
        }
      }
    }
  });

  return safeJson(outputText(response), { action: "none", explanation: "I could not parse that instruction." });
}

export async function financeChatWithAI(message, state) {
  if (!openaiConfigured()) {
    const summary = summarizeFinance(state);
    return `I can answer with local summaries once you add an OpenAI key. Right now: ${summary.transactionCount} transactions, ${summary.connectedInstitutionCount} connected institutions, and $${summary.totalSpend.toLocaleString()} spent in ${summary.month}.`;
  }

  const tools = [
    {
      type: "function",
      name: "get_finance_summary",
      description: "Get monthly spending, income, flexible labels, category budgets, account totals, top merchants, recurring merchants, and trends.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["month"],
        properties: {
          month: { type: ["string", "null"], description: "YYYY-MM month or null for current month" }
        }
      },
      strict: true
    },
    {
      type: "function",
      name: "search_transactions",
      description: "Search transactions by merchant/name/category and optional limit.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query", "category", "limit"],
        properties: {
          query: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          limit: { type: "number" }
        }
      },
      strict: true
    }
  ];

  let input = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "You are a private finance analyst inside a local app.",
            "Answer from tool data, be direct, and flag uncertainty.",
            "Use categories for spend type and contexts for trips, projects, events, or custom groupings.",
            "Do not give investment, tax, or legal advice. You can explain patterns and budgeting tradeoffs.",
            `User question: ${message}`
          ].join("\n")
        }
      ]
    }
  ];

  for (let step = 0; step < 4; step += 1) {
    const response = await callOpenAI({ input, tools });
    const calls = (response.output || []).filter((item) => item.type === "function_call");
    if (!calls.length) return outputText(response);

    input = [...input, ...response.output];
    for (const call of calls) {
      const args = safeJson(call.arguments || "{}", {});
      const result = runFinanceTool(call.name, args, state);
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result)
      });
    }
  }

  return "I hit my tool-call limit while analyzing that. Try narrowing the question to a merchant, month, or category.";
}

function runFinanceTool(name, args, state) {
  if (name === "get_finance_summary") {
    return summarizeFinance(state, args.month || currentMonthKey());
  }
  if (name === "search_transactions") {
    const query = (args.query || "").toLowerCase();
    const category = args.category || null;
    const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 50);
    return state.transactions
      .filter((txn) => {
        const label = `${txn.merchantName || ""} ${txn.name || ""} ${txn.notes || ""} ${transactionLabel(txn)}`.toLowerCase();
        if (query && !label.includes(query)) return false;
        if (category && transactionLabel(txn) !== category && txn.category !== category) return false;
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
  }
  return { error: `Unknown tool: ${name}` };
}

function fallbackCategorization(txn, categories) {
  const names = new Set(categories.map((category) => category.name));
  let category = txn.category || "Uncategorized";
  const label = `${txn.merchantName || ""} ${txn.name || ""}`;

  if (VENMO_ZELLE_PATTERN.test(label)) category = "Venmo / Zelle";
  else if (/target|whole foods|trader joe|safeway|kroger|costco/i.test(label)) category = "Groceries";
  else if (/uber|lyft|shell|chevron|parking|metro/i.test(label)) category = "Transport";
  else if (/netflix|spotify|apple\.com|hulu|prime/i.test(label)) category = "Subscriptions";
  else if (/restaurant|cafe|coffee|doordash|ubereats|chipotle|starbucks/i.test(label)) category = "Dining";

  if (!names.has(category)) category = "Uncategorized";
  return {
    id: txn.id,
    category,
    label: category,
    aiSummary: "Local fallback categorization",
    confidence: 0.45
  };
}

function fallbackCommand(text, state) {
  const lower = text.toLowerCase();
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
  const labelMatch = text.match(/\b(?:as|label(?:ed)?|called)\s+(.+)$/i);
  if (dates.length >= 2 && labelMatch?.[1]) {
    return {
      action: "label_range",
      transactionId: null,
      category: null,
      label: labelMatch[1].replace(/^as\s+/i, "").trim(),
      note: null,
      makeRule: false,
      merchantMatch: null,
      startDate: dates[0],
      endDate: dates[1],
      budgetCategory: null,
      budgetAmount: null,
      explanation: `I matched this as a date-range label.`
    };
  }
  const category = state.categories.find((candidate) => lower.includes(candidate.name.toLowerCase()))?.name
    || (/food|dinner|lunch|restaurant|coffee/.test(lower) ? "Dining" : null)
    || (/grocery|groceries|target/.test(lower) ? "Groceries" : null);
  const transaction = state.transactions
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .find((txn) => lower.includes((txn.merchantName || txn.name || "").toLowerCase().split(" ")[0]));

  if (category && transaction) {
    return {
      action: "categorize_transaction",
      transactionId: transaction.id,
      category,
      label: category,
      note: text,
      makeRule: /always|future|permanent|recurring/.test(lower),
      merchantMatch: transaction.merchantName || transaction.name,
      startDate: null,
      endDate: null,
      budgetCategory: null,
      budgetAmount: null,
      explanation: `I matched this to ${transaction.merchantName || transaction.name}.`
    };
  }

  return {
    action: "none",
    explanation: "Add an OpenAI key for richer natural-language edits, or use the transaction table controls."
  };
}

function normalizeIncomeStatementAnalysis(parsed, fileName) {
  const statutory = normalizeLineItems(parsed.statutory, {
    federalIncomeTax: 0,
    socialSecurityTax: 0,
    medicareTax: 0,
    waPaidFamilyLeaveIns: 0,
    waPaidMedicalLeaveIns: 0,
    waLTCare: 0
  });
  const other = normalizeLineItems(parsed.other, {
    commAddlInc: 0,
    criticalIllness: 0,
    hsa: 0,
    preTaxDental: 0,
    preTaxMedical: 0,
    preTaxVision: 0,
    roth401k: 0
  });
  const benefits = sumLineItems(other, ["commAddlInc", "criticalIllness", "hsa", "preTaxDental", "preTaxMedical", "preTaxVision"]);
  const retirement401k = money(other.roth401k);
  const taxes = sumLineItems(statutory, Object.keys(statutory));

  return {
    employer: String(parsed.employer || ""),
    payDate: validDate(parsed.payDate) ? parsed.payDate : "",
    periodStart: validDate(parsed.periodStart) ? parsed.periodStart : "",
    periodEnd: validDate(parsed.periodEnd) ? parsed.periodEnd : "",
    grossPay: money(parsed.grossPay),
    taxes,
    retirement401k,
    benefits,
    takeHome: money(parsed.takeHome),
    payrollLines: { statutory, other },
    aiSummary: String(parsed.aiSummary || `Parsed ${fileName}`)
  };
}

function fallbackIncomeStatement(text, fileName) {
  const grossPay = amountAfter(text, /gross\s+(?:pay|earnings|income)/i);
  const takeHome = amountAfter(text, /(?:net\s+pay|take\s*home|direct\s+deposit|amount\s+paid)/i);
  const statutory = {
    federalIncomeTax: lineAmount(text, /federal\s+income\s+tax/i),
    socialSecurityTax: lineAmount(text, /social\s+security\s+tax/i),
    medicareTax: lineAmount(text, /medicare\s+tax/i),
    waPaidFamilyLeaveIns: lineAmount(text, /wa\s+paid\s+family\s+leave\s+ins/i),
    waPaidMedicalLeaveIns: lineAmount(text, /wa\s+paid\s+medical\s+leave\s+ins/i),
    waLTCare: lineAmount(text, /wa\s+ltcare/i)
  };
  const other = {
    commAddlInc: lineAmount(text, /comm\s+addl\s+inc/i),
    criticalIllness: lineAmount(text, /critic(?:al)?\s+illness/i),
    hsa: lineAmount(text, /\bhsa\b/i),
    preTaxDental: lineAmount(text, /pre-tax\s+dental/i),
    preTaxMedical: lineAmount(text, /pre-tax\s+medical/i),
    preTaxVision: lineAmount(text, /pre-tax\s+vision/i),
    roth401k: lineAmount(text, /401k-roth|401\(k\).*roth|roth.*401/i)
  };
  const taxes = sumLineItems(statutory, Object.keys(statutory));
  const retirement401k = money(other.roth401k);
  const benefits = sumLineItems(other, ["commAddlInc", "criticalIllness", "hsa", "preTaxDental", "preTaxMedical", "preTaxVision"]);
  const dates = text.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g) || [];
  const normalizedDates = dates.map(normalizeDate).filter(Boolean);

  return {
    employer: "",
    payDate: normalizedDates[0] || "",
    periodStart: normalizedDates[1] || normalizedDates[0] || "",
    periodEnd: normalizedDates[2] || normalizedDates[0] || "",
    grossPay,
    taxes,
    retirement401k,
    benefits,
    takeHome,
    payrollLines: { statutory, other },
    aiSummary: `Local fallback parsed ${fileName}; add OPENAI_API_KEY for better payroll extraction.`
  };
}

function amountAfter(text, pattern) {
  const line = text.split(/\n/).find((item) => pattern.test(item));
  if (!line) return 0;
  return money((line.match(/-?\$?\d[\d,]*\.\d{2}/g) || []).at(-1));
}

function sumAmountsNear(text, pattern) {
  return text.split(/\n/)
    .filter((line) => pattern.test(line))
    .flatMap((line) => line.match(/-?\$?\d[\d,]*\.\d{2}/g) || [])
    .reduce((sum, value) => sum + money(value), 0);
}

function lineAmount(text, pattern) {
  const line = text.split(/\n/).find((item) => pattern.test(item));
  if (!line) return 0;
  return money((line.match(/-?\$?\d[\d,]*\.\d{2}\*?/g) || []).at(-1));
}

function normalizeLineItems(source = {}, defaults) {
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, money(source?.[key])])
  );
}

function sumLineItems(source, keys) {
  return Math.round(keys.reduce((sum, key) => sum + money(source[key]), 0) * 100) / 100;
}

function money(value) {
  const number = Number(String(value || 0).replace(/[$,*]/g, ""));
  return Number.isFinite(number) ? Math.round(Math.abs(number) * 100) / 100 : 0;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeDate(value) {
  if (validDate(value)) return value;
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return "";
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}
