import { useCallback, useEffect, useMemo, useState } from "react";
import { ResponsiveSankey } from "@nivo/sankey";
import { usePlaidLink } from "react-plaid-link";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  Bot,
  Brain,
  CalendarDays,
  ChevronDown,
  CreditCard,
  X,
  FileText,
  Landmark,
  Link as LinkIcon,
  MessageSquareText,
  Plus,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Tags,
  Trash2,
  UploadCloud,
  WalletCards
} from "lucide-react";
import { api, currency, percent } from "./lib/api.js";

const tabs = ["Overview", "Transactions", "Income", "Budgets", "Rules"];
const today = new Date().toISOString().slice(0, 10);
const defaultRange = { mode: "month", year: today.slice(0, 4), month: today.slice(0, 7), day: today };

function PlaidButton({ disabled, onConnected, onError }) {
  const [token, setToken] = useState(null);
  const [creating, setCreating] = useState(false);
  const isOAuthRedirect = typeof window !== "undefined" && window.location.href.includes("oauth_state_id");
  const receivedRedirectUri = isOAuthRedirect ? window.location.href : null;

  const { open, ready } = usePlaidLink({
    token,
    receivedRedirectUri,
    onSuccess: async (public_token, metadata) => {
      try {
        localStorage.removeItem("plaid_link_token");
        await api("/api/plaid/exchange-public-token", {
          method: "POST",
          body: { public_token, metadata }
        });
        if (isOAuthRedirect) window.history.replaceState({}, document.title, window.location.pathname);
        onConnected();
      } catch (error) {
        onError(error.message);
      }
    },
    onExit: (error, metadata) => {
      if (!error) return;
      const institution = metadata?.institution?.name ? " for " + metadata.institution.name : "";
      const code = error.error_code || error.error_type || "PLAID_LINK_ERROR";
      const message = error.display_message || error.error_message || "Plaid Link exited before finishing.";
      onError(code + institution + ": " + message);
    }
  });

  useEffect(() => {
    if (!isOAuthRedirect) return;
    const storedToken = localStorage.getItem("plaid_link_token");
    if (storedToken) setToken(storedToken);
    else onError("Plaid OAuth returned without a saved Link token. Start the Capital One connection again.");
  }, [isOAuthRedirect, onError]);

  useEffect(() => {
    if (token && ready) open();
  }, [token, ready, open]);

  async function connect() {
    setCreating(true);
    try {
      const result = await api("/api/plaid/link-token", { method: "POST" });
      localStorage.setItem("plaid_link_token", result.link_token);
      setToken(result.link_token);
    } catch (error) {
      onError(error.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <button className="primary-btn" onClick={connect} disabled={disabled || creating}>
      <LinkIcon size={18} />
      {creating ? "Preparing Link" : "Connect Bank"}
    </button>
  );
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [state, setState] = useState(null);
  const [activeTab, setActiveTab] = useState("Overview");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [dateRange, setDateRange] = useState(defaultRange);
  const [chatInput, setChatInput] = useState("");
  const [streamEvents, setStreamEvents] = useState([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const [configResult, stateResult] = await Promise.all([api("/api/config"), api(`/api/state?${rangeQuery(dateRange)}`)]);
    setConfig(configResult);
    setState(stateResult);
  }, [dateRange]);

  useEffect(() => {
    load().catch((error) => setToast(error.message));
  }, [load]);

  const summary = state?.summary;
  const categories = state?.categories || [];
  const categoryOptions = useMemo(() => makeCategoryOptions(categories), [categories]);
  const contextOptions = useMemo(() => makeContextOptions(state?.transactions || []), [state]);
  const dateOptions = useMemo(() => makeDateOptions(state?.transactions || [], dateRange), [state, dateRange]);
  const filteredTransactions = useMemo(() => {
    const query = search.toLowerCase();
    return (state?.transactions || [])
      .filter((txn) => {
        const label = `${txn.displayName || ""} ${txn.merchantName || ""} ${txn.name || ""} ${txn.notes || ""} ${txn.category || ""} ${txn.context || ""}`.toLowerCase();
        if (txn.hidden) return false;
        if (!inDateRange(txn.date, dateRange)) return false;
        if (query && !label.includes(query)) return false;
        if (categoryFilter !== "All" && canonicalLabel(txn.category) !== canonicalLabel(categoryFilter)) return false;
        return true;
      })
      .slice(0, 120);
  }, [state, search, categoryFilter, dateRange]);

  async function runAction(label, fn) {
    setBusy(label);
    setToast("");
    try {
      await fn();
      await load();
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy("");
    }
  }

  async function patchTransaction(id, patch) {
    await api(`/api/transactions/${id}`, { method: "PATCH", body: patch });
    await load();
  }

  async function uploadIncomeStatement(file) {
    setBusy("income-upload");
    setToast("");
    try {
      const formData = new FormData();
      formData.append("statement", file);
      const response = await fetch("/api/income-statements", { method: "POST", body: formData });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Income statement upload failed.");
      setToast("Income statement parsed.");
      await load();
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy("");
    }
  }

  async function changeModel(model) {
    setBusy("model");
    setToast("");
    try {
      const result = await api("/api/config/model", { method: "PATCH", body: { model } });
      setConfig((current) => ({ ...current, openaiModel: result.openaiModel, openaiModels: result.openaiModels }));
      setToast(`Using ${result.openaiModel} for AI actions.`);
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy("");
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message) return;
    setBusy("chat");
    setChatInput("");
    setStreamEvents([
      { id: `local-user-${Date.now()}`, role: "user", content: message },
      { id: `local-assistant-${Date.now()}`, role: "assistant", content: "" }
    ]);
    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      if (!response.ok || !response.body) throw new Error("Assistant stream failed.");
      let finalEvent = null;
      for await (const event of readNdjson(response.body)) {
        if (event.type === "text_delta") {
          setStreamEvents((current) => appendAssistantDelta(current, event.delta));
        } else if (event.type === "reasoning_delta") {
          setStreamEvents((current) => appendToolEvent(current, { kind: "thinking", label: "Thinking", content: event.delta }));
        } else if (event.type === "tool_call") {
          setStreamEvents((current) => appendToolEvent(current, formatToolCall(event)));
        } else if (event.type === "tool_result") {
          setStreamEvents((current) => appendToolEvent(current, {
            kind: event.changed ? "edit" : "tool",
            label: event.changed ? "Edit" : "Tool",
            content: event.summary || `${friendlyToolName(event.name)} finished.`
          }));
        } else if (event.type === "error") {
          throw new Error(event.message || "Assistant stream failed.");
        } else if (event.type === "done") {
          finalEvent = event;
        }
      }
      if (finalEvent?.chat) {
        setState((current) => ({
          ...current,
          chat: finalEvent.chat,
          chatThreads: finalEvent.chatThreads || current.chatThreads,
          activeChatThreadId: finalEvent.activeChatThreadId || current.activeChatThreadId
        }));
        setStreamEvents([]);
        if (finalEvent.changed) {
          setToast(finalEvent.answer || "Updated.");
          await load();
        }
      }
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy("");
    }
  }

  async function startNewChat() {
    if (busy) return;
    setBusy("new-chat");
    setToast("");
    setStreamEvents([]);
    setChatInput("");
    try {
      const result = await api("/api/chat/new", { method: "POST" });
      setState(result.state);
      setToast("Started a new chat.");
    } catch (error) {
      setToast(error.message);
    } finally {
      setBusy("");
    }
  }

  if (!state || !config) {
    return (
      <main className="loading-screen">
        <Sparkles size={28} />
        <span>Loading your finance cockpit</span>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><WalletCards size={22} /></div>
          <div>
            <strong>Chow Much Was That</strong>
            <span>Personal finance</span>
          </div>
        </div>

        <nav className="nav-list">
          {tabs.map((tab) => (
            <button key={tab} className={tab === activeTab ? "active" : ""} onClick={() => setActiveTab(tab)}>
              {tabIcon(tab)}
              {tab}
            </button>
          ))}
          <button className={chatOpen ? "active assistant-nav" : "assistant-nav"} onClick={() => setChatOpen(true)}>
            <Bot size={18} />
            Assistant
          </button>
        </nav>

        <div className="connection-panel">
          <div className="eyebrow">Connections</div>
          <strong>{summary.connectedInstitutionCount || 0} institutions</strong>
          <p>{config.plaidConfigured ? `Plaid ${config.plaidEnv}` : "Add Plaid keys in .env"}</p>
          <PlaidButton disabled={!config.plaidConfigured} onConnected={load} onError={setToast} />
          <button
            className="secondary-btn"
            onClick={() => runAction("sync", () => api("/api/plaid/sync", { method: "POST" }))}
            disabled={!config.plaidConfigured || busy === "sync"}
          >
            <RefreshCw size={17} />
            Sync
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">Local, private, read-only money dashboard</div>
            <h1>{activeTab}</h1>
          </div>
          <div className="topbar-actions">
            <DateRangeSelector range={dateRange} setRange={setDateRange} options={dateOptions} />
          </div>
        </header>

        {toast && <div className="toast">{toast}</div>}

        {activeTab === "Overview" && <Overview state={state} />}
        {activeTab === "Transactions" && (
          <Transactions
            categoryOptions={categoryOptions}
            contextOptions={contextOptions}
            transactions={filteredTransactions}
            search={search}
            setSearch={setSearch}
            categoryFilter={categoryFilter}
            setCategoryFilter={setCategoryFilter}
            onPatch={patchTransaction}
            onAICategorize={() => runAction("categorize", () => api("/api/ai/categorize", { method: "POST" }))}
            busy={busy}
          />
        )}
        {activeTab === "Income" && (
          <Income
            statements={state.incomeStatements || []}
            summary={summary}
            busy={busy === "income-upload"}
            onUpload={uploadIncomeStatement}
            onDelete={(id) => runAction("income", () => api(`/api/income-statements/${id}`, { method: "DELETE" }))}
          />
        )}
        {activeTab === "Budgets" && (
          <Budgets
            categories={categories}
            summary={summary}
            onBudget={(name, monthlyBudget) =>
              runAction("budget", () => api(`/api/categories/${encodeURIComponent(name)}`, { method: "PATCH", body: { monthlyBudget } }))
            }
          />
        )}
        {activeTab === "Rules" && (
          <Rules
            rules={state.rules}
            categoryOptions={categoryOptions}
            contextOptions={contextOptions}
            merchantOptions={makeMerchantOptions(state.transactions || [])}
            onCreate={(body) => runAction("rule", () => api("/api/rules", { method: "POST", body }))}
            onToggle={(id, active) => runAction("rule", () => api(`/api/rules/${id}`, { method: "PATCH", body: { active } }))}
            onDelete={(id) => runAction("rule", () => api(`/api/rules/${id}`, { method: "DELETE" }))}
          />
        )}
      </section>
      <ChatDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        onNewChat={startNewChat}
        chat={streamEvents.length ? [...(state.chat || []), ...streamEvents] : state.chat || []}
        input={chatInput}
        setInput={setChatInput}
        onSend={sendChat}
        busy={busy === "chat"}
        newChatDisabled={Boolean(busy)}
        config={config}
        modelBusy={busy === "model"}
        onModelChange={changeModel}
      />
    </main>
  );
}

function Overview({ state }) {
  const { summary } = state;
  const [flowMode, setFlowMode] = useState("context");
  const [pieMode, setPieMode] = useState("category");
  const sankeyData = useMemo(
    () => makeSankeyData(state.transactions || [], summary, flowMode),
    [state.transactions, summary, flowMode]
  );
  const pieData = useMemo(
    () => makePieData(state.transactions || [], summary, pieMode),
    [state.transactions, summary, pieMode]
  );
  const periodLabel = summary.period?.label || summary.month;
  const payroll = summary.incomeBreakdown || {};
  const cashflowBase = payroll.takeHome > 0 ? payroll.takeHome : summary.totalIncome;
  const netAfterSpend = cashflowBase - summary.totalSpend;

  return (
    <div className="page-grid">
      <section className="metric-row">
        <Metric title="Spend" value={currency(summary.totalSpend)} detail={`${summary.transactionCount} transactions in ${periodLabel}`} />
        <Metric title={payroll.grossPay > 0 ? "Payroll gross" : "Income tracked"} value={currency(payroll.grossPay || summary.totalIncome)} detail={payroll.grossPay > 0 ? `${currency(payroll.takeHome)} take-home` : `${periodLabel} cashflow`} />
        <Metric title="Net cashflow" value={currency(netAfterSpend)} detail={netAfterSpend >= 0 ? "Money left over" : "Overspending period"} tone={netAfterSpend >= 0 ? "good" : "bad"} />
        <Metric title="Card utilization" value={percent(summary.accountTotals.utilization)} detail={`${currency(summary.accountTotals.creditDebt)} of ${currency(summary.accountTotals.creditLimit)}`} />
      </section>

      <section className="wide-panel">
        <PanelTitle icon={<Landmark size={18} />} title={summary.period?.mode === "year" ? "Year flow" : "Six-month flow"} detail="Income versus spending" />
        <div className="chart-frame">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={summary.monthlyTrend}>
              <defs>
                <linearGradient id="spend" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.38} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="income" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.36} />
                  <stop offset="95%" stopColor="#14b8a6" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#e5e7eb" vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} tickFormatter={(value) => currency(value, true)} />
              <Tooltip formatter={(value, name) => [currency(value), displayLabel(name)]} />
              <Area dataKey="income" stroke="#0f9f9a" fill="url(#income)" strokeWidth={3} />
              <Area dataKey="spend" stroke="#ef4444" fill="url(#spend)" strokeWidth={3} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title with-actions">
          <div><Tags size={18} /><strong>{pieMode === "context" ? "Context mix" : "Category mix"}</strong></div>
          <div className="segmented-control compact">
            <button type="button" className={pieMode === "context" ? "active" : ""} onClick={() => setPieMode("context")}>Context</button>
            <button type="button" className={pieMode === "category" ? "active" : ""} onClick={() => setPieMode("category")}>Category</button>
          </div>
        </div>
        <div className="donut-layout">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={pieData} dataKey="spent" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={2}>
                {pieData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <Tooltip formatter={(value, name) => [currency(value), displayLabel(name)]} />
            </PieChart>
          </ResponsiveContainer>
          <div className="legend-list">
            {pieData.slice(0, 6).map((item) => (
              <span key={item.name}><i style={{ background: item.color }} />{displayLabel(item.name)}<b>{currency(item.spent)}</b></span>
            ))}
            {!pieData.length && <Empty text={`No ${pieMode} spending in this range.`} />}
          </div>
        </div>
      </section>

      <section className="wide-panel">
        <div className="panel-title with-actions">
          <div><Tags size={18} /><strong>Money flow</strong></div>
          <div className="segmented-control compact">
            <button type="button" className={flowMode === "context" ? "active" : ""} onClick={() => setFlowMode("context")}>Context</button>
            <button type="button" className={flowMode === "category" ? "active" : ""} onClick={() => setFlowMode("category")}>Category</button>
          </div>
        </div>
        <div className="chart-frame sankey-frame">
          {sankeyData.links.length ? (
            <ResponsiveSankey
                data={sankeyData}
                margin={{ top: 10, right: 126, bottom: 10, left: 18 }}
                align="justify"
                colors={{ scheme: "paired" }}
                nodeOpacity={1}
                nodeThickness={14}
                nodeSpacing={18}
                nodeBorderWidth={0}
                nodeBorderRadius={4}
                linkOpacity={0.34}
                linkHoverOpacity={0.62}
                linkContract={3}
                enableLinkGradient
                labelPosition="outside"
                labelOrientation="horizontal"
                labelPadding={10}
                labelTextColor="#334155"
                valueFormat={(value) => currency(value)}
                nodeTooltip={({ node }) => (
                  <div className="chart-tooltip">
                    {node.id}: {currency(node.value)}
                  </div>
                )}
                linkTooltip={({ link }) => (
                  <div className="chart-tooltip">
                    {link.source.id} → {link.target.id}: {currency(link.value)}
                  </div>
                )}
              />
          ) : <Empty text="No spending flow in this range." />}
        </div>
      </section>

      <section className="panel">
        <PanelTitle icon={<CreditCard size={18} />} title="Top merchants" detail={`Biggest spend in ${periodLabel}`} />
        <div className="stack-list">
          {summary.topMerchants.map((item) => (
            <div className="list-row" key={item.merchant}>
              <div><strong>{item.merchant}</strong><span>{periodLabel}</span></div>
              <b>{currency(item.amount)}</b>
            </div>
          ))}
          {!summary.topMerchants.length && <Empty text="No merchant spending in this range." />}
        </div>
      </section>
    </div>
  );
}

function Transactions({ categoryOptions, contextOptions, transactions, search, setSearch, categoryFilter, setCategoryFilter, onPatch, onAICategorize, busy }) {
  return (
    <section className="wide-panel">
      <div className="toolbar">
        <div className="search-box">
          <Search size={18} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search merchant, note, context, or name" />
        </div>
        <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
          <option>All</option>
          {categoryOptions.map((label) => <option key={label}>{displayLabel(label)}</option>)}
        </select>
        <button className="secondary-btn" onClick={onAICategorize} disabled={busy === "categorize"}>
          <Sparkles size={17} />
          AI categorize
        </button>
      </div>

      <div className="transaction-table">
        <div className="table-head">
          <span>Date</span><span>Transaction</span><span>Category</span><span>Context</span><span>Note</span><span>Amount</span>
        </div>
        {transactions.map((txn) => (
          <TransactionRow
            key={txn.id}
            txn={txn}
            categoryOptions={categoryOptions}
            contextOptions={contextOptions}
            onPatch={onPatch}
          />
        ))}
      </div>
      <datalist id="transaction-label-options">
        {categoryOptions.map((label) => <option key={label} value={displayLabel(label)} />)}
      </datalist>
    </section>
  );
}

function TransactionRow({ txn, categoryOptions, contextOptions, onPatch }) {
  const [editingName, setEditingName] = useState(false);
  const currentCategory = txn.category || "Uncategorized";
  const currentCategoryKey = canonicalLabel(currentCategory);
  const currentContext = txn.context || "";
  const currentContextKey = canonicalLabel(currentContext);
  const options = categoryOptions.some((label) => canonicalLabel(label) === currentCategoryKey)
    ? categoryOptions
    : [...categoryOptions, currentCategory];
  const contextSelectOptions = currentContext && !contextOptions.some((label) => canonicalLabel(label) === currentContextKey)
    ? [...contextOptions, currentContext]
    : contextOptions;

  function commitDisplayName(value) {
    const next = value.trim();
    if (next !== (txn.displayName || "") && (txn.displayName || next !== transactionDisplayName(txn))) {
      onPatch(txn.id, { displayName: next });
    }
    setEditingName(false);
  }

  function commitNote(value) {
    if (value !== (txn.notes || "")) onPatch(txn.id, { notes: value });
  }

  return (
    <div className="table-row">
      <span>{txn.date}</span>
      <div className="merchant-cell">
        <div className="txn-title-line">
          {editingName ? (
            <input
              className="txn-title-input"
              autoFocus
              defaultValue={txn.displayName || transactionDisplayName(txn)}
              placeholder="Display name"
              onBlur={(event) => commitDisplayName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditingName(false);
              }}
            />
          ) : (
            <>
              <strong>{transactionDisplayName(txn)}</strong>
              <button type="button" className="icon-mini-btn" onClick={() => setEditingName(true)} aria-label="Edit display name" title="Edit display name">
                <Pencil size={14} />
              </button>
            </>
          )}
        </div>
        {txn.name && <span className="txn-merchant-text">{txn.name}</span>}
      </div>
      <select
        className="txn-select"
        value={options.find((label) => canonicalLabel(label) === currentCategoryKey) || "Uncategorized"}
        onChange={(event) => onPatch(txn.id, { category: event.target.value })}
        aria-label="Category"
      >
        {options.map((label) => <option key={label} value={label}>{displayLabel(label)}</option>)}
      </select>
      <LabelCombobox
        value={currentContext}
        options={contextSelectOptions}
        placeholder="None"
        ariaLabel="Context"
        onCommit={(nextLabel) => {
          const value = canonicalLabel(nextLabel);
          if (value !== currentContextKey) onPatch(txn.id, { context: nextLabel });
        }}
      />
      <input
        className="txn-note-input"
        defaultValue={txn.notes || ""}
        placeholder="Note"
        onBlur={(event) => commitNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") event.currentTarget.value = txn.notes || "";
        }}
        aria-label="Note"
      />
      <b className={txn.amount < 0 ? "income" : ""}>{currency(Math.abs(txn.amount))}</b>
    </div>
  );
}

function LabelCombobox({ value, options, onCommit, onTextChange, formatter = displayLabel, ariaLabel = "Transaction label", placeholder = "" }) {
  const [text, setText] = useState(formatter(value));
  const [open, setOpen] = useState(false);
  const normalizedText = canonicalLabel(text);
  const visibleOptions = options
    .map((option, index) => {
      const optionKey = canonicalLabel(option);
      const display = formatter(option);
      const matches = normalizedText && (optionKey.includes(normalizedText) || display.toLowerCase().includes(normalizedText));
      const exact = normalizedText && optionKey === normalizedText;
      return { option, index, display, rank: exact ? 0 : matches ? 1 : 2 };
    })
    .sort((a, b) => a.rank - b.rank || a.display.localeCompare(b.display) || a.index - b.index)
    .map((item) => item.option);
  const exactMatch = options.some((option) => canonicalLabel(option) === normalizedText);

  useEffect(() => {
    setText(formatter(value));
  }, [value, formatter]);

  function commit(nextValue = text) {
    const cleaned = nextValue.trim();
    if (cleaned && canonicalLabel(cleaned) !== canonicalLabel(value)) onCommit(cleaned);
    setText(formatter(cleaned || value));
    setOpen(false);
  }

  return (
    <div className="label-combobox">
      <input
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onTextChange?.(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => commit(text)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(text);
          }
          if (event.key === "Escape") {
            setText(formatter(value));
            setOpen(false);
          }
        }}
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        placeholder={placeholder}
      />
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
        aria-label="Show labels"
      >
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="label-combobox-menu">
          {visibleOptions.map((option) => (
            <button
              type="button"
              key={canonicalLabel(option)}
              onMouseDown={(event) => {
                event.preventDefault();
                commit(formatter(option));
              }}
            >
              {formatter(option)}
            </button>
          ))}
          {normalizedText && !exactMatch && (
            <button
              type="button"
              className="custom"
              onMouseDown={(event) => {
                event.preventDefault();
                commit(text);
              }}
            >
              Use “{formatter(text)}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DateRangeSelector({ range, setRange, options }) {
  const monthOptions = options.months.filter((month) => month.startsWith(range.year));
  const dayOptions = options.days.filter((day) => day.startsWith(range.month));

  function setMode(mode) {
    setRange((current) => {
      if (mode === "year") return { ...current, mode, preset: "", start: "", end: "", year: current.year || options.years[0] };
      if (mode === "day") return { ...current, mode, preset: "", start: "", end: "", day: current.day || dayOptions[0] || today };
      return { ...current, mode, preset: "", start: "", end: "", month: current.month || monthOptions[0] || today.slice(0, 7) };
    });
  }

  function setYear(year) {
    const nextMonth = options.months.find((month) => month.startsWith(year)) || `${year}-01`;
    const nextDay = options.days.find((day) => day.startsWith(nextMonth)) || `${nextMonth}-01`;
    setRange((current) => ({ ...current, mode: "year", preset: "", start: "", end: "", year, month: nextMonth, day: nextDay }));
  }

  function setMonth(month) {
    const nextDay = options.days.find((day) => day.startsWith(month)) || `${month}-01`;
    setRange((current) => ({ ...current, mode: "month", preset: "", start: "", end: "", year: month.slice(0, 4), month, day: nextDay }));
  }

  function setPreset(preset) {
    if (preset === "this-month") {
      setRange((current) => ({ ...current, mode: "month", preset: "", start: "", end: "", year: today.slice(0, 4), month: today.slice(0, 7), day: today }));
      return;
    }
    const months = preset === "past-year" ? 12 : 3;
    const start = firstDayMonthsAgo(months - 1);
    setRange((current) => ({
      ...current,
      mode: "custom",
      preset,
      start,
      end: today,
      year: today.slice(0, 4),
      month: today.slice(0, 7),
      day: today
    }));
  }

  return (
    <div className="range-selector">
      <div className="selector-label"><CalendarDays size={16} /> Time range</div>
      <div className="range-main">
        <div className="segmented-control range-mode">
          {["day", "month", "year"].map((mode) => (
            <button key={mode} type="button" className={range.mode === mode ? "active" : ""} onClick={() => setMode(mode)}>
              {mode}
            </button>
          ))}
        </div>
        <div className="range-fields">
          {range.mode === "year" && (
            <select value={range.year} onChange={(event) => setYear(event.target.value)}>
              {options.years.map((year) => <option key={year}>{year}</option>)}
            </select>
          )}
          {range.mode === "month" && (
          <select value={range.month} onChange={(event) => setMonth(event.target.value)}>
            {monthOptions.map((month) => <option key={month} value={month}>{formatMonth(month)}</option>)}
          </select>
          )}
          {range.mode === "custom" && <span className="range-summary">{formatDay(range.start)} - {formatDay(range.end)}</span>}
          {range.mode === "day" && (
          <select value={range.day} onChange={(event) => setRange((current) => ({ ...current, mode: "day", preset: "", start: "", end: "", day: event.target.value }))}>
            {dayOptions.map((day) => <option key={day} value={day}>{formatDay(day)}</option>)}
          </select>
          )}
        </div>
        <div className="range-presets">
          <button type="button" className={range.mode === "month" && range.month === today.slice(0, 7) ? "active" : ""} onClick={() => setPreset("this-month")}>This month</button>
          <button type="button" className={range.preset === "past-3-months" ? "active" : ""} onClick={() => setPreset("past-3-months")}>Past 3 months</button>
          <button type="button" className={range.preset === "past-year" ? "active" : ""} onClick={() => setPreset("past-year")}>Past year</button>
        </div>
      </div>
    </div>
  );
}

function ModelSelector({ config, busy, onChange }) {
  return (
    <label className={config.openaiConfigured ? "model-picker ok" : "model-picker warn"}>
      <span><Brain size={16} /> {config.openaiConfigured ? "AI model" : "OpenAI key missing"}</span>
      <select value={config.openaiModel} onChange={(event) => onChange(event.target.value)} disabled={busy}>
        {(config.openaiModels || [config.openaiModel]).map((model) => <option key={model}>{model}</option>)}
      </select>
    </label>
  );
}

function Budgets({ categories, summary, onBudget }) {
  const rows = summary.byCategory.filter((item) => item.name !== "Income" && !item.custom);
  return (
    <section className="wide-panel">
      <PanelTitle icon={<WalletCards size={18} />} title="Monthly budgets" detail="Edit targets and watch burn rate" />
      <div className="budget-grid">
        {rows.map((item) => {
          const pct = item.budget ? Math.min((item.spent / item.budget) * 100, 140) : 0;
          return (
            <div className="budget-row" key={item.name}>
              <div>
                <strong>{item.name}</strong>
                <span>{currency(item.spent)} spent · {currency(item.remaining)} left</span>
              </div>
              <div className="budget-track"><i style={{ width: `${pct}%`, background: item.color }} /></div>
              <input
                type="number"
                min="0"
                defaultValue={item.budget}
                onBlur={(event) => onBudget(item.name, Number(event.target.value))}
              />
            </div>
          );
        })}
      </div>
      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={rows.filter((item) => item.spent > 0).slice(0, 12)}>
            <CartesianGrid stroke="#e5e7eb" vertical={false} />
            <XAxis dataKey="name" tickLine={false} axisLine={false} interval={0} angle={-20} textAnchor="end" height={80} tickFormatter={displayLabel} />
            <YAxis tickLine={false} axisLine={false} tickFormatter={(value) => currency(value, true)} />
            <Tooltip formatter={(value) => currency(value)} />
            <Bar dataKey="spent" radius={[6, 6, 0, 0]}>
              {rows.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function Income({ statements, summary, busy, onUpload, onDelete }) {
  const breakdown = summary.incomeBreakdown || {};

  function handleUpload(event) {
    const file = event.target.files?.[0];
    if (file) onUpload(file);
    event.target.value = "";
  }

  return (
    <section className="wide-panel">
      <div className="income-header">
        <PanelTitle icon={<FileText size={18} />} title="Income statements" detail="Upload payroll PDFs to split gross pay into taxes, 401k, benefits, and take-home" />
        <label className="primary-btn upload-btn">
          <UploadCloud size={17} />
          {busy ? "Parsing..." : "Upload PDF"}
          <input type="file" accept="application/pdf,.pdf" onChange={handleUpload} disabled={busy} />
        </label>
      </div>

      <div className="income-metrics">
        <Metric title="Gross pay" value={currency(breakdown.grossPay)} detail={`${breakdown.count || 0} statements in range`} />
        <Metric title="Taxes" value={currency(breakdown.taxes)} detail="Withholding total" />
        <Metric title="401k" value={currency(breakdown.retirement401k)} detail="Retirement contributions" />
        <Metric title="Take-home" value={currency(breakdown.takeHome)} detail="Net pay received" tone="good" />
      </div>

      <div className="rules-list income-list">
        {statements.map((statement) => (
          <div className="rule-row income-row" key={statement.id}>
            <div>
              <strong>{statement.employer || statement.fileName}</strong>
              <span>{statement.payDate || statement.periodEnd || "No pay date"} · Gross {currency(statement.grossPay)} · Net {currency(statement.takeHome)}</span>
            </div>
            <div className="rule-actions">
              <span className="income-chip">Taxes {currency(statement.taxes)}</span>
              <span className="income-chip">401k {currency(statement.retirement401k)}</span>
              <button type="button" className="icon-danger-btn" onClick={() => onDelete(statement.id)} aria-label={`Delete ${statement.fileName}`} title="Delete statement">
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
        {!statements.length && <Empty text="Upload a PDF pay statement to start tracking gross income, taxes, benefits, 401k, and take-home pay." />}
      </div>
    </section>
  );
}

function Rules({ rules, categoryOptions, contextOptions, merchantOptions, onCreate, onToggle, onDelete }) {
  const [match, setMatch] = useState("");
  const [category, setCategory] = useState("");
  const [context, setContext] = useState("");
  const [ignore, setIgnore] = useState(false);

  function submit(event) {
    event.preventDefault();
    if (!match.trim() || (!category && !context.trim() && !ignore)) return;
    onCreate({ match: match.trim(), category, context: context.trim(), ignore });
    setMatch("");
    setContext("");
    setIgnore(false);
  }

  return (
    <section className="wide-panel">
      <PanelTitle icon={<Tags size={18} />} title="Merchant rules" detail="Substring matches apply a fixed category or context" />
      <form className="rule-form" onSubmit={submit}>
        <div className="rule-field merchant-rule-field">
          <span>Merchant contains</span>
          <LabelCombobox
            value={match}
            options={merchantOptions}
            onTextChange={setMatch}
            onCommit={setMatch}
            formatter={plainText}
            ariaLabel="Merchant substring"
            placeholder="Netflix, H Mart, Zelle..."
          />
        </div>
        <div className="rule-field">
          <span>Category</span>
          <select
            className="rule-select"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="Rule category"
          >
            <option value="">No category change</option>
            {categoryOptions.map((option) => <option key={option} value={option}>{displayLabel(option)}</option>)}
          </select>
        </div>
        <div className="rule-field">
          <span>Context</span>
          <LabelCombobox
            value={context}
            options={contextOptions}
            onTextChange={setContext}
            onCommit={setContext}
            ariaLabel="Rule context"
            placeholder="Optional"
          />
        </div>
        <label className="ignore-rule-toggle">
          <input type="checkbox" checked={ignore} onChange={(event) => setIgnore(event.target.checked)} />
          <span>Ignore</span>
        </label>
        <button className="primary-btn">Add rule</button>
      </form>
      <div className="rules-list">
        {rules.map((rule) => (
          <div className="rule-row" key={rule.id}>
            <div>
              <strong>{rule.match}</strong>
              <span>{ruleDescription(rule)}</span>
            </div>
            <div className="rule-actions">
              <label className="switch" title={rule.active ? "Rule active" : "Rule paused"}>
                <input type="checkbox" checked={rule.active} onChange={(event) => onToggle(rule.id, event.target.checked)} />
                <span />
              </label>
              <button type="button" className="icon-danger-btn" onClick={() => onDelete(rule.id)} aria-label={`Delete rule for ${rule.match}`} title="Delete rule">
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
        {!rules.length && <Empty text="No merchant rules yet." />}
      </div>
    </section>
  );
}

function ChatDrawer({ open, onClose, onNewChat, chat, input, setInput, onSend, busy, newChatDisabled, config, modelBusy, onModelChange }) {
  return (
    <section className={open ? "chat-panel open" : "chat-panel"} aria-hidden={!open}>
      <div className="chat-header">
        <div>
          <strong>Assistant</strong>
          <span>Ask questions or make changes</span>
        </div>
        <div className="chat-header-actions">
          <button type="button" onClick={onNewChat} disabled={newChatDisabled} aria-label="Start new chat" title="Start new chat"><Plus size={18} /></button>
          <button type="button" onClick={onClose} aria-label="Close assistant" title="Close assistant"><X size={18} /></button>
        </div>
      </div>
      <div className="chat-model-row">
        <ModelSelector config={config} busy={modelBusy} onChange={onModelChange} />
      </div>
      <div className="chat-log">
        {!chat.length && (
          <div className="empty-chat">
            <MessageSquareText size={36} />
            <h2>Ask about your money</h2>
            <p>Try “Where did I overspend?” or “Label 2025-03-01 through 2025-03-12 as Colombia trip.”</p>
          </div>
        )}
        {chat.map((message) => (
          <div className={`chat-bubble ${message.role}${message.kind ? ` ${message.kind}` : ""}`} key={message.id}>
            {message.role === "tool" && <span className="tool-label">{message.label || "Tool"}</span>}
            <span className="bubble-content">{message.content}</span>
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={onSend}>
        <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask or tell the assistant what to change" />
        <button disabled={busy}><Send size={18} /></button>
      </form>
    </section>
  );
}

async function* readNdjson(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer);
}

function appendAssistantDelta(messages, delta) {
  const next = [...messages];
  const index = next.findLastIndex((message) => message.role === "assistant");
  if (index === -1) return [...next, { id: `assistant-${Date.now()}`, role: "assistant", content: delta }];
  next[index] = { ...next[index], content: `${next[index].content || ""}${delta}` };
  return next;
}

function appendToolEvent(messages, event) {
  return [
    ...messages,
    {
      id: `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "tool",
      ...event
    }
  ];
}

function formatToolCall(event) {
  const name = friendlyToolName(event.name);
  const args = event.arguments || {};
  if (event.name === "search_transactions") {
    const chips = [
      args.query ? `"${args.query}"` : null,
      args.startDate && args.endDate ? `${args.startDate} to ${args.endDate}` : null,
      args.categories?.length ? `category: ${args.categories.map(displayLabel).join(", ")}` : null,
      args.contexts?.length ? `context: ${args.contexts.map(displayLabel).join(", ")}` : null,
      args.accountNames?.length ? `account: ${args.accountNames.join(", ")}` : null,
      args.accountMasks?.length ? `card: ${args.accountMasks.join(", ")}` : null,
      args.direction || null
    ].filter(Boolean);
    return { kind: "tool", label: "Search", content: chips.length ? chips.join(" · ") : "Searching transactions" };
  }
  if (event.name === "edit_transaction_field") {
    return { kind: "tool", label: "Edit", content: `${args.field || "field"} on ${shortId(args.id)} -> ${args.field === "category" || args.field === "context" ? displayLabel(args.value) : String(args.value ?? "")}` };
  }
  if (event.name === "label_transactions_by_date_range") {
    return { kind: "tool", label: "Context", content: `${args.startDate} to ${args.endDate} as ${displayLabel(args.label)}` };
  }
  return { kind: "tool", label: "Tool", content: name };
}

function friendlyToolName(name = "") {
  return name.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function shortId(id = "") {
  if (!id) return "transaction";
  return id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
}

function Metric({ title, value, detail, tone }) {
  return (
    <article className={`metric-card ${tone || ""}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function PanelTitle({ icon, title, detail }) {
  return (
    <div className="panel-title">
      <div>{icon}<strong>{title}</strong></div>
      <span>{detail}</span>
    </div>
  );
}

function Empty({ text }) {
  return <div className="empty-state">{text}</div>;
}

function tabIcon(tab) {
  const props = { size: 18 };
  if (tab === "Overview") return <Landmark {...props} />;
  if (tab === "Transactions") return <CreditCard {...props} />;
  if (tab === "Income") return <FileText {...props} />;
  if (tab === "Budgets") return <WalletCards {...props} />;
  if (tab === "Rules") return <Tags {...props} />;
  return <Bot {...props} />;
}

function rangeQuery(range) {
  const params = new URLSearchParams({ mode: range.mode, year: range.year });
  if (range.month) params.set("month", range.month);
  if (range.day) params.set("day", range.day);
  if (range.start) params.set("start", range.start);
  if (range.end) params.set("end", range.end);
  return params.toString();
}

function makeDateOptions(transactions, range) {
  const transactionDays = transactions.map((txn) => txn.date).filter(Boolean).sort((a, b) => b.localeCompare(a));
  const years = unique([range.year, today.slice(0, 4), ...transactionDays.map((day) => day.slice(0, 4))]);
  const months = unique([range.month, today.slice(0, 7), ...transactionDays.map((day) => day.slice(0, 7))]);
  const days = unique([range.day, today, ...transactionDays]);
  return { years, months, days };
}

const pieColors = ["#0f9f9a", "#f97316", "#4f46e5", "#db2777", "#2563eb", "#16a34a", "#eab308", "#7c3aed", "#dc2626", "#64748b"];

function makePieData(transactions, summary, mode) {
  if (mode === "category") {
    return summary.byCategory.filter((item) => item.spent > 0).slice(0, 9);
  }

  const rows = spendingBreakdown(transactions, summary, "context")
    .slice(0, 9)
    .map((item, index) => ({ ...item, spent: item.value, color: pieColors[index % pieColors.length] }));
  return rows;
}

function makeSankeyData(transactions, summary, mode) {
  const breakdown = spendingBreakdown(transactions, summary, mode);
  const visible = breakdown.slice(0, 10);
  const other = breakdown.slice(10).reduce((sum, row) => sum + row.value, 0);
  if (other > 0) visible.push({ name: "Other", value: Math.round(other * 100) / 100 });

  const income = summary.incomeBreakdown || {};
  if (income.grossPay > 0) {
    const nodes = [
      { id: "Gross pay" },
      { id: "Taxes" },
      { id: "401k" },
      { id: "Benefits" },
      { id: "Take-home" },
      ...visible.map((row) => ({ id: row.name }))
    ];
    const links = [
      { source: "Gross pay", target: "Taxes", value: income.taxes || 0 },
      { source: "Gross pay", target: "401k", value: income.retirement401k || 0 },
      { source: "Gross pay", target: "Benefits", value: income.benefits || 0 },
      { source: "Gross pay", target: "Take-home", value: income.takeHome || Math.max(income.grossPay - (income.taxes || 0) - (income.retirement401k || 0) - (income.benefits || 0) - (income.otherDeductions || 0), 0) }
    ].filter((link) => link.value > 0);
    for (const row of visible) links.push({ source: "Take-home", target: row.name, value: row.value });
    const leftover = Math.round(Math.max((income.takeHome || 0) - (summary.totalSpend || 0), 0) * 100) / 100;
    if (leftover > 0) {
      nodes.push({ id: "Left over" });
      links.push({ source: "Take-home", target: "Left over", value: leftover });
    }
    return { nodes, links };
  }

  const nodes = [{ id: summary.totalIncome > 0 ? "Money in" : "Money out" }, ...visible.map((row) => ({ id: row.name }))];
  const links = visible.map((row, index) => ({ source: nodes[0].id, target: nodes[index + 1].id, value: row.value }));
  const leftover = Math.round(Math.max((summary.totalIncome || 0) - (summary.totalSpend || 0), 0) * 100) / 100;
  if (leftover > 0) {
    nodes.push({ id: "Left over" });
    links.push({ source: nodes[0].id, target: "Left over", value: leftover });
  }

  return { nodes, links };
}

function spendingBreakdown(transactions, summary, mode) {
  const period = summary?.period || {};
  const start = period.start || "0000-01-01";
  const end = period.end || "9999-12-31";
  const totals = new Map();

  for (const txn of transactions) {
    if (txn.hidden || txn.amount <= 0 || txn.date < start || txn.date > end) continue;
    const rawLabel = mode === "context"
      ? (canonicalLabel(txn.context) ? txn.context : txn.category)
      : txn.category;
    const label = rawLabel || "Uncategorized";
    totals.set(label, (totals.get(label) || 0) + txn.amount);
  }

  return Array.from(totals.entries())
    .map(([name, value]) => ({ name: displayLabel(name), value: Math.round(value * 100) / 100 }))
    .sort((a, b) => b.value - a.value);
}

function makeCategoryOptions(categories) {
  return categories
    .map((category) => category.name)
    .filter(Boolean)
    .sort((a, b) => displayLabel(a).localeCompare(displayLabel(b)));
}

function makeContextOptions(transactions) {
  return unique(transactions.map((txn) => txn.context).filter(Boolean))
    .sort((a, b) => displayLabel(a).localeCompare(displayLabel(b)));
}

function makeMerchantOptions(transactions) {
  return unique(
    transactions.flatMap((txn) => [
      txn.merchantName,
      txn.name,
      txn.displayName
    ])
  ).sort((a, b) => a.localeCompare(b));
}

function transactionLabel(txn) {
  return txn.category || "Uncategorized";
}

function transactionDisplayName(txn) {
  return txn.displayName || txn.merchantName || txn.name || "Unknown";
}

function ruleDescription(rule) {
  const parts = [];
  if (rule.ignore) parts.push("Ignore");
  if (rule.category) parts.push(`Category: ${displayLabel(rule.category)}`);
  if (rule.context) parts.push(`Context: ${displayLabel(rule.context)}`);
  return parts.length ? parts.join(" · ") : "No category or context";
}

function canonicalLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function displayLabel(value) {
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

function plainText(value) {
  return String(value || "");
}

function inDateRange(date, range) {
  if (!date) return false;
  if (range.mode === "custom") return date >= range.start && date <= range.end;
  if (range.mode === "day") return date === range.day;
  if (range.mode === "year") return date.startsWith(range.year);
  return date.startsWith(range.month);
}

function rangeBounds(range) {
  if (range.mode === "custom") return { start: range.start, end: range.end };
  if (range.mode === "day") return { start: range.day, end: range.day };
  if (range.mode === "year") return { start: `${range.year}-01-01`, end: `${range.year}-12-31` };
  const start = `${range.month}-01`;
  const end = new Date(Number(range.month.slice(0, 4)), Number(range.month.slice(5, 7)), 0).toISOString().slice(0, 10);
  return { start, end };
}

function firstDayMonthsAgo(monthsAgo) {
  const current = new Date(`${today}T12:00:00`);
  return new Date(current.getFullYear(), current.getMonth() - monthsAgo, 1).toISOString().slice(0, 10);
}

function formatMonth(value) {
  return new Date(`${value}-01T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function formatDay(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => b.localeCompare(a));
}

function updateById(list, id, item) {
  return list.map((entry) => (entry.id === id ? item : entry));
}
