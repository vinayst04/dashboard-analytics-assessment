import { createContext, useContext, useEffect, useMemo, useState, type DragEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  ArrowLeft,
  Bot,
  ChartLine as ChartLineIcon,
  ChevronDown,
  Chrome,
  CircleUserRound,
  Columns3,
  Download,
  Filter,
  GripVertical,
  IndianRupee,
  LayoutDashboard,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  PanelTop,
  Package,
  RefreshCw,
  Rows3,
  Send,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Store,
  Table2,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  askGemini,
  createAiDashboard,
  getCurrentAccount,
  getDashboard,
  getExplorerData,
  getFilters,
  getInsights,
  logout,
} from "./lib/api";
import type { AiDashboardConfig, AiDashboardWidget } from "./lib/api";
import type { Account, DashboardData, ExplorerRow } from "./lib/types";

type FilterState = {
  start_date: string;
  end_date: string;
  outlet: string;
  group: string;
  order_type: string;
  settlement: string;
};

const PALETTE = [
  "#0d633f",
  "#e72732",
  "#f4be21",
  "#145a7a",
  "#6b3d17",
  "#d05d1d",
  "#294f35",
];
const hoverGuide = {
  fill: "transparent",
  stroke: "#94a3b8",
  strokeDasharray: "3 3",
  strokeWidth: 1,
};
const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat("en-IN");

function compactRupees(amount: number) {
  const absolute = Math.abs(amount);
  const [divisor, suffix] =
    absolute >= 10_000_000
      ? [10_000_000, "Cr"]
      : absolute >= 100_000
        ? [100_000, "L"]
        : absolute >= 1_000
          ? [1_000, "K"]
          : [1, ""];
  const value = absolute / divisor;
  const digits = value >= 100 || Number.isInteger(value) ? 0 : 1;
  const formatted = value.toLocaleString("en-IN", {
    maximumFractionDigits: digits,
  });

  return `${amount < 0 ? "-" : ""}₹${formatted}${suffix}`;
}

const blankFilters: FilterState = {
  start_date: "",
  end_date: "",
  outlet: "",
  group: "",
  order_type: "",
  settlement: "",
};
const ExpandedChartContext = createContext<string | null>(null);

type ExportPayload = {
  filename: string;
  columns: string[];
  rows: (string | number | null)[][];
};

type ExportRequestDetail = {
  handled: boolean;
  export: (payload: ExportPayload) => void;
};

function csvCell(value: string | number | null) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(payload: ExportPayload) {
  const csv = [payload.columns, ...payload.rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = payload.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function asParams(filters: FilterState) {
  const params = new URLSearchParams();
  for (const [key, current] of Object.entries(filters))
    if (current) params.set(key, current);
  return params;
}

function MetricCard({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: React.ReactNode;
}) {
  return (
    <section className="metric-card">
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{note}</span>
      </div>
      <div className="metric-icon">{icon}</div>
    </section>
  );
}

function ChartPanel({
  title,
  children,
  className = "",
  onExpand,
  onClear,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  onExpand?: (content: React.ReactNode) => void;
  onClear?: () => void;
}) {
  const expandedTitle = useContext(ExpandedChartContext);
  return (
    <section className={`chart-panel ${className}`}>
      <div className="panel-heading">
        <h2>{title}</h2>
        <div className="panel-actions">
          {onClear && (
            <button
              className="clear-panel-filter"
              onClick={onClear}
              title={`Clear ${title} filter`}
            >
              <X size={13} /> Clear
            </button>
          )}
          {onExpand && (
            <button
              className="icon-button expand-button"
              onClick={() => onExpand(children)}
              title={`Expand ${title}`}
              aria-label={`Expand ${title}`}
            >
              <Maximize2 size={16} />
            </button>
          )}
        </div>
      </div>
      {expandedTitle !== title && children}
    </section>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return <div className="empty-panel">{message}</div>;
}

function ExpandedChartDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="expanded-chart-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} expanded`}
      >
        <div className="expanded-chart-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            title="Close expanded view"
            aria-label="Close expanded view"
          >
            <X size={19} />
          </button>
        </div>
        <div className="expanded-chart-content">{children}</div>
      </section>
    </div>
  );
}

function AuthDialog({
  onClose,
  onAuthenticated,
}: {
  onClose: () => void;
  onAuthenticated: (account: Account) => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.detail ?? "Unable to continue.");
      if (mode === "login") {
        const account = await getCurrentAccount();
        onAuthenticated(account);
        onClose();
      } else {
        setMessage("Account created. You can now sign in.");
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to continue.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Account access"
      >
        <button
          className="icon-button close-button"
          onClick={onClose}
          title="Close"
        >
          <X size={18} />
        </button>
        <div className="auth-mark">
          <BarChart3 size={24} />
        </div>
        <h2>{mode === "login" ? "Welcome back" : "Create your account"}</h2>
        <p>
          {mode === "login"
            ? "Use your dashboard credentials."
            : "Create credentials for the analytics dashboard."}
        </p>
        <form onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button className="primary-button" disabled={busy}>
            {busy
              ? "Working..."
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>
        <div className="auth-divider">
          <span>or</span>
        </div>
        <button
          className="google-button"
          type="button"
          onClick={() => window.location.assign("/api/auth/google/login")}
        >
          <Chrome size={17} /> Continue with Google
        </button>
        {message && <div className="form-message">{message}</div>}
        <button
          className="text-button"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setMessage("");
          }}
        >
          {mode === "login"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<FilterState>(blankFilters);
  const [activePage, setActivePage] = useState<"home" | "details" | "ai">(
    "home",
  );
  const [showAuth, setShowAuth] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const [insightsRequested, setInsightsRequested] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [exporting, setExporting] = useState(false);
  const filtersQuery = useQuery({ queryKey: ["filters"], queryFn: getFilters });
  const accountQuery = useQuery({
    queryKey: ["account"],
    queryFn: getCurrentAccount,
    retry: false,
  });
  const account = accountQuery.data;

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("auth") === "google") {
      setAuthNotice("Signed in with Google.");
      void accountQuery.refetch();
      url.searchParams.delete("auth");
    } else if (url.searchParams.get("auth_error") === "google") {
      setAuthNotice("Google sign-in could not be completed. Please try again.");
      url.searchParams.delete("auth_error");
    } else if (url.searchParams.get("auth_error") === "account") {
      setAuthNotice("That email is already linked to a different Google account.");
      url.searchParams.delete("auth_error");
    } else {
      return;
    }
    window.history.replaceState(
      {},
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [accountQuery]);

  useEffect(() => {
    if (filtersQuery.data && !filters.start_date) {
      setFilters((current) => ({
        ...current,
        start_date: filtersQuery.data!.date_range.min,
        end_date: filtersQuery.data!.date_range.max,
      }));
    }
  }, [filtersQuery.data, filters.start_date]);

  const params = useMemo(() => asParams(filters), [filters]);
  const dashboardQuery = useQuery({
    queryKey: ["dashboard", params.toString()],
    queryFn: () => getDashboard(params),
    enabled: Boolean(filtersQuery.data),
    placeholderData: (previousData) => previousData,
  });
  const insightsQuery = useQuery({
    queryKey: ["insights", params.toString()],
    queryFn: () => getInsights(params),
    enabled: insightsRequested,
  });
  const dashboard = dashboardQuery.data as DashboardData | undefined;
  const isInitialLoading =
    filtersQuery.isLoading || (dashboardQuery.isLoading && !dashboard);
  const isRefreshing = Boolean(dashboard) && dashboardQuery.isFetching;
  const update = (key: keyof FilterState, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const reset = () =>
    setFilters({
      ...blankFilters,
      start_date: filtersQuery.data?.date_range.min ?? "",
      end_date: filtersQuery.data?.date_range.max ?? "",
    });
  const exportData = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      let handled = false;
      const event = new CustomEvent<ExportRequestDetail>("analytics-export-request", {
        detail: { handled: false, export: (payload) => { handled = true; downloadCsv(payload); } },
      });
      window.dispatchEvent(event);
      if (handled) return;
      if (activePage !== "home") {
        throw new Error(
          activePage === "details"
            ? "Detailed Insights has no analysis output to export yet."
            : "Create an AI dashboard before exporting its output.",
        );
      }
      if (!dashboard) throw new Error("There is no dashboard output to export yet.");
      downloadCsv({
        filename: "dashboard-current-view.csv",
        columns: ["View", "Label", "Revenue", "Orders", "Items sold"],
        rows: [
          ["KPI", "Total revenue", dashboard.metrics.revenue, "", ""],
          ["KPI", "Orders", "", dashboard.metrics.orders, ""],
          ["KPI", "Items sold", "", "", dashboard.metrics.units],
          ...dashboard.revenue_trend.map((row) => ["Revenue over time", row.date, row.revenue, row.orders, ""]),
          ...dashboard.category_sales.map((row) => ["Category sales", row.label, row.value, "", row.units]),
          ...dashboard.outlet_performance.map((row) => ["Outlet performance", row.outlet, row.revenue, row.orders, ""]),
          ...dashboard.top_items.map((row) => ["Top-selling items", row.item, row.revenue, "", row.units]),
          ...dashboard.order_type_mix.map((row) => ["Order channels", row.label, "", row.value, ""]),
          ...dashboard.payment_mix.map((row) => ["Payment methods", row.label, "", row.value, ""]),
        ],
      });
    } catch (error) {
      setAuthNotice(
        error instanceof Error ? error.message : "Unable to export the current view.",
      );
    } finally {
      setExporting(false);
    }
  };
  const signedIn = (current: Account) => {
    queryClient.setQueryData(["account"], current);
    setAuthNotice(`Signed in as ${current.email}.`);
  };
  const signOut = async () => {
    try {
      await logout();
      queryClient.setQueryData(["account"], undefined);
      window.location.assign(window.location.pathname);
    } catch (error) {
      setAuthNotice(
        error instanceof Error ? error.message : "Unable to sign out.",
      );
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img
            className="brand-logo"
            src="/california-burrito-logo.png"
            alt="California Burrito"
          />
          <strong>California Burrito Analytics</strong>
        </div>
        <nav className="topbar-nav" aria-label="Primary navigation">
          <button
            className={activePage === "home" ? "is-active" : ""}
            onClick={() => setActivePage("home")}
          >
            <LayoutDashboard size={16} /> Home
          </button>
          <button
            className={activePage === "details" ? "is-active" : ""}
            onClick={() => setActivePage("details")}
          >
            <ChartLineIcon size={16} /> Detailed insights
          </button>
          <button
            className={activePage === "ai" ? "is-active" : ""}
            onClick={() => setActivePage("ai")}
          >
            <PanelTop size={16} /> AI dashboard
          </button>
        </nav>
        <div className="topbar-actions">
          <div className="account-area">
            <button
              className="account-button"
              onClick={() =>
                account
                  ? setShowAccountMenu((current) => !current)
                  : setShowAuth(true)
              }
              title={
                account
                  ? `Signed in as ${account.email}`
                  : "Sign in or create an account"
              }
            >
              <CircleUserRound size={18} />
              <span>{account ? account.email : "Sign in"}</span>
            </button>
            {account && showAccountMenu && (
              <div className="account-menu">
                <strong>{account.email}</strong>
                <small>
                  {account.provider === "google"
                    ? "Connected with Google"
                    : "Email account"}
                </small>
                <button onClick={() => void signOut()}>Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="content-wrap">
        {authNotice && (
          <div className="auth-notice" role="status">
            <span>{authNotice}</span>
            <button
              className="icon-button"
              onClick={() => setAuthNotice("")}
              title="Dismiss"
            >
              <X size={15} />
            </button>
          </div>
        )}
        <section className="page-heading">
          <div>
            <p className="eyebrow">BURGER TOWN PERFORMANCE</p>
            <h1>
              {activePage === "home"
                ? "See what is moving the business."
                : activePage === "details"
                  ? "Build the view you need."
                  : "Describe the dashboard you need."}
            </h1>
            <p className="heading-copy">
              {activePage === "home"
                ? "Sales, products, channels, and outlet performance in one focused workspace."
                : activePage === "details"
                  ? "Choose a dimension, measure, and visualization to explore the current data."
                  : "Ask AI for a structured dashboard from the previous month of sales. It will use approved charts, tables, and pivot views only."}
            </p>
          </div>
          <div className="heading-actions">
            <button
              className="secondary-button"
              onClick={exportData}
              disabled={!dashboard || isRefreshing || exporting}
            >
              <Download size={17} /> {exporting ? "Exporting..." : "Export current view"}
            </button>
            <button
              className="primary-button"
              onClick={() => {
                setShowInsights(true);
                setInsightsRequested(true);
              }}
              disabled={!dashboard || isRefreshing}
            >
              <Sparkles size={17} /> Ask Gemini
            </button>
          </div>
        </section>

        <section
          className={`filter-bar ${filtersQuery.isLoading ? "is-loading" : ""}`}
          aria-busy={filtersQuery.isLoading}
        >
          <div className="filter-title">
            <SlidersHorizontal size={18} />
            <span>Filters</span>
          </div>
          <div className="filter-controls">
            <label>
              From
              <input
                type="date"
                disabled={!filtersQuery.data}
                min={filtersQuery.data?.date_range.min}
                max={filters.end_date || filtersQuery.data?.date_range.max}
                value={filters.start_date}
                onChange={(event) => update("start_date", event.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                disabled={!filtersQuery.data}
                min={filters.start_date || filtersQuery.data?.date_range.min}
                max={filtersQuery.data?.date_range.max}
                value={filters.end_date}
                onChange={(event) => update("end_date", event.target.value)}
              />
            </label>
            <Select
              label="Outlet"
              value={filters.outlet}
              values={filtersQuery.data?.outlets ?? []}
              disabled={!filtersQuery.data}
              onChange={(value) => update("outlet", value)}
            />
            <Select
              label="Category"
              value={filters.group}
              values={filtersQuery.data?.groups ?? []}
              disabled={!filtersQuery.data}
              onChange={(value) => update("group", value)}
            />
            <Select
              label="Channel"
              value={filters.order_type}
              values={filtersQuery.data?.order_types ?? []}
              disabled={!filtersQuery.data}
              onChange={(value) => update("order_type", value)}
            />
            <Select
              label="Payment"
              value={filters.settlement}
              values={filtersQuery.data?.settlements ?? []}
              disabled={!filtersQuery.data}
              onChange={(value) => update("settlement", value)}
            />
            <button
              className="secondary-button filter-reset-button"
              onClick={reset}
              disabled={!filtersQuery.data || isRefreshing}
            >
              Reset filters
            </button>
          </div>
          <div className="filter-feedback" aria-live="polite">
            {isRefreshing && (
              <>
                <LoaderCircle size={14} /> Updating
              </>
            )}
          </div>
        </section>

        {isInitialLoading ? <DashboardSkeleton /> : null}
        {filtersQuery.isError || dashboardQuery.isError ? (
          <SetupState
            error={
              (filtersQuery.error ?? dashboardQuery.error)?.message ??
              "Unable to connect to the analytics API."
            }
            onRetry={() => {
              filtersQuery.refetch();
              dashboardQuery.refetch();
            }}
          />
        ) : null}
        {dashboard && !isInitialLoading && (
          <div
            className={
              isRefreshing
                ? "dashboard-content is-refreshing"
                : "dashboard-content"
            }
            aria-busy={isRefreshing}
          >
            {activePage === "home" ? (
              <Dashboard
                dashboard={dashboard}
                filters={filters}
                onFilter={update}
              />
            ) : activePage === "details" ? (
              <DetailedInsights dashboard={dashboard} filters={filters} />
            ) : (
              <AiDashboardBuilder />
            )}
          </div>
        )}
      </div>
      {dashboard && !isInitialLoading && (
        <footer className="app-footer">
          <div className="footer-content">
            <div>
              <strong>California Burrito Analytics</strong>
              <span>Business analytics</span>
            </div>
            <small>Copyright 2026</small>
          </div>
        </footer>
      )}
      {showInsights && (
        <InsightsDialog
          onClose={() => setShowInsights(false)}
          loading={insightsQuery.isLoading}
          error={insightsQuery.error?.message}
          insights={insightsQuery.data?.insights ?? []}
          params={params}
        />
      )}
      {showAuth && (
        <AuthDialog
          onClose={() => setShowAuth(false)}
          onAuthenticated={signedIn}
        />
      )}
    </main>
  );
}

function Select({
  label,
  value,
  values,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">All</option>
        {values.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function LoadingState({
  message = "Loading performance data...",
  detail,
}: {
  message?: string;
  detail?: string;
}) {
  return (
    <div className="loading-state">
      <SectionLoader label={message} />
      <strong>{message}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function SectionLoader({ label = "Updating section" }: { label?: string }) {
  return (
    <div className="section-loader" role="status" aria-label={label}>
      <span />
    </div>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`} />;
}

function DashboardSkeleton() {
  return (
    <div
      className="dashboard-skeleton"
      aria-label="Loading dashboard"
      aria-busy="true"
    >
      <SectionLoader label="Loading metrics" />
      <section className="metrics-grid">
        {["revenue", "orders", "items", "average"].map((key) => (
          <section className="metric-card skeleton-card" key={key}>
            <div>
              <Skeleton className="skeleton-label" />
              <Skeleton className="skeleton-value" />
              <Skeleton className="skeleton-note" />
            </div>
            <Skeleton className="skeleton-icon" />
          </section>
        ))}
      </section>
      <SectionLoader label="Loading primary charts" />
      <section className="chart-grid primary-grid">
        <SkeletonPanel className="skeleton-chart-large" />
        <SkeletonPanel className="skeleton-chart-large" />
      </section>
      <SectionLoader label="Loading supporting charts" />
      <section className="chart-grid secondary-grid">
        <SkeletonPanel />
        <SkeletonPanel />
        <SkeletonPanel />
        <SkeletonPanel />
      </section>
    </div>
  );
}

function SkeletonPanel({ className = "" }: { className?: string }) {
  return (
    <section className={`chart-panel skeleton-panel ${className}`}>
      <Skeleton className="skeleton-title" />
      <div className="skeleton-lines">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    </section>
  );
}

function SetupState({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <section className="setup-state">
      <div className="setup-icon">
        <Store size={27} />
      </div>
      <div>
        <p className="eyebrow">CONNECTION NEEDED</p>
        <h2>The dashboard is ready for its database.</h2>
        <p>{error}</p>
        <p>
          Once PostgreSQL is connected and the supplied workbook is imported,
          live analytics will appear here.
        </p>
      </div>
      <button className="secondary-button" onClick={onRetry}>
        <RefreshCw size={17} /> Retry
      </button>
    </section>
  );
}

function Dashboard({
  dashboard,
  filters,
  onFilter,
}: {
  dashboard: DashboardData;
  filters: FilterState;
  onFilter: (key: keyof FilterState, value: string) => void;
}) {
  const [expandedChart, setExpandedChart] = useState<{
    title: string;
    content: React.ReactNode;
  } | null>(null);
  const [categoryHover, setCategoryHover] = useState<number | null>(null);
  const [channelHover, setChannelHover] = useState<number | null>(null);
  const applyChartFilter = (key: keyof FilterState, value: string) => {
    setExpandedChart(null);
    onFilter(key, value);
  };
  return (
    <ExpandedChartContext.Provider value={expandedChart?.title ?? null}>
      <>
        <section className="metrics-grid">
          <MetricCard
            label="Total revenue"
            value={money.format(dashboard.metrics.revenue)}
            note="Filtered sales value"
            icon={<IndianRupee size={22} />}
          />
          <MetricCard
            label="Orders"
            value={number.format(dashboard.metrics.orders)}
            note="Unique bills completed"
            icon={<ShoppingBag size={22} />}
          />
          <MetricCard
            label="Items sold"
            value={number.format(dashboard.metrics.units)}
            note="Units across all orders"
            icon={<Package size={22} />}
          />
          <MetricCard
            label="Avg. order value"
            value={money.format(dashboard.metrics.average_order_value)}
            note="Revenue per unique bill"
            icon={<BarChart3 size={22} />}
          />
        </section>
        <section className="chart-grid primary-grid">
          <ChartPanel
            title="Revenue over time"
            className="wide"
            onExpand={(content) =>
              setExpandedChart({ title: "Revenue over time", content })
            }
          >
            <ResponsiveContainer width="100%" height={280}>
              <LineChart
                data={dashboard.revenue_trend}
                margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="#dbe5e5"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) =>
                    new Intl.DateTimeFormat("en-IN", {
                      day: "numeric",
                      month: "short",
                    }).format(new Date(`${date}T00:00:00`))
                  }
                  minTickGap={34}
                  tick={{ fontSize: 12 }}
                />
                <YAxis
                  tickFormatter={compactRupees}
                  tick={{ fontSize: 12 }}
                  width={62}
                />
                <Tooltip
                  cursor={hoverGuide}
                  contentStyle={{
                    background: "#fff",
                    border: "1px solid #d8e5e2",
                    borderRadius: 6,
                    boxShadow: "0 10px 24px rgba(24, 66, 60, .12)",
                  }}
                  formatter={(amount: number) => money.format(amount)}
                  labelFormatter={(date) =>
                    new Intl.DateTimeFormat("en-IN", {
                      dateStyle: "medium",
                    }).format(new Date(`${date}T00:00:00`))
                  }
                />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  stroke="#0f766e"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 5 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartPanel>
          <ChartPanel
            title="Sales by category"
            onExpand={(content) =>
              setExpandedChart({ title: "Sales by category", content })
            }
            onClear={
              filters.group ? () => applyChartFilter("group", "") : undefined
            }
          >
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                data={dashboard.category_sales}
                layout="vertical"
                margin={{ top: 4, right: 16, left: 12, bottom: 4 }}
                onMouseMove={(state) =>
                  setCategoryHover(
                    typeof state.activePayload?.[0]?.value === "number"
                      ? state.activePayload[0].value
                      : null,
                  )
                }
                onMouseLeave={() => setCategoryHover(null)}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  horizontal={false}
                  stroke="#dbe5e5"
                />
                <XAxis
                  type="number"
                  tickFormatter={compactRupees}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={76}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip
                  cursor={false}
                  contentStyle={{
                    background: "#fff",
                    border: "1px solid #d8e5e2",
                    borderRadius: 6,
                    boxShadow: "0 10px 24px rgba(24, 66, 60, .12)",
                  }}
                  formatter={(amount: number) => money.format(amount)}
                />
                {categoryHover !== null && (
                  <ReferenceLine
                    x={categoryHover}
                    stroke="#94a3b8"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                  />
                )}
                <Bar
                  className="interactive-bar"
                  dataKey="value"
                  radius={[3, 3, 3, 3]}
                  isAnimationActive={false}
                  onClick={(data) => {
                    const label = data?.payload?.label;
                    if (label) applyChartFilter("group", label);
                  }}
                >
                  {dashboard.category_sales.map((entry) => (
                    <Cell
                      key={entry.label}
                      fill={
                        filters.group === entry.label ? "#b45309" : "#f97316"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>
        </section>
        <section className="chart-grid secondary-grid">
          <ChartPanel
            title="Outlet performance"
            onExpand={(content) =>
              setExpandedChart({ title: "Outlet performance", content })
            }
            onClear={
              filters.outlet ? () => applyChartFilter("outlet", "") : undefined
            }
          >
            <div className="outlet-table">
              <div className="table-row table-heading">
                <span>Outlet</span>
                <span>Revenue</span>
                <span>Orders</span>
              </div>
              {dashboard.outlet_performance.map((row) => (
                <button
                  className={`table-row interactive-row ${filters.outlet === row.outlet ? "is-selected" : ""}`}
                  key={row.outlet}
                  onClick={() => applyChartFilter("outlet", row.outlet)}
                >
                  <span>{row.outlet}</span>
                  <strong>{money.format(row.revenue)}</strong>
                  <span>{number.format(row.orders)}</span>
                </button>
              ))}
            </div>
          </ChartPanel>
          <ChartPanel
            title="Order channels"
            onExpand={(content) =>
              setExpandedChart({ title: "Order channels", content })
            }
            onClear={
              filters.order_type
                ? () => applyChartFilter("order_type", "")
                : undefined
            }
          >
            {dashboard.order_type_mix.length ? (
              <ResponsiveContainer width="100%" height={236}>
                <BarChart
                  data={dashboard.order_type_mix}
                  layout="vertical"
                  margin={{ top: 4, right: 12, left: 12, bottom: 4 }}
                  onMouseMove={(state) =>
                    setChannelHover(
                      typeof state.activePayload?.[0]?.value === "number"
                        ? state.activePayload[0].value
                        : null,
                    )
                  }
                  onMouseLeave={() => setChannelHover(null)}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    horizontal={false}
                    stroke="#dbe5e5"
                  />
                  <XAxis
                    type="number"
                    tickFormatter={(amount) => number.format(amount)}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={66}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip
                    cursor={false}
                    contentStyle={{
                      background: "#fff",
                      border: "1px solid #d8e5e2",
                      borderRadius: 6,
                      boxShadow: "0 10px 24px rgba(24, 66, 60, .12)",
                    }}
                    formatter={(amount: number) => number.format(amount)}
                  />
                  {channelHover !== null && (
                    <ReferenceLine
                      x={channelHover}
                      stroke="#94a3b8"
                      strokeDasharray="3 3"
                      strokeWidth={1}
                    />
                  )}
                  <Bar
                    className="interactive-bar"
                    dataKey="value"
                    radius={[3, 3, 3, 3]}
                    isAnimationActive={false}
                    onClick={(data) => {
                      const label = data?.payload?.label;
                      if (label) applyChartFilter("order_type", label);
                    }}
                  >
                    {dashboard.order_type_mix.map((entry, index) => (
                      <Cell
                        key={entry.label}
                        fill={
                          filters.order_type === entry.label
                            ? "#0c4a6e"
                            : PALETTE[index]
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyPanel message="No channel data for this filter." />
            )}
          </ChartPanel>
          <ChartPanel
            title="Top-selling items"
            onExpand={(content) =>
              setExpandedChart({ title: "Top-selling items", content })
            }
          >
            <div className="items-list">
              {dashboard.top_items.map((row, index) => (
                <div className="item-row" key={row.item}>
                  <span className="rank">{index + 1}</span>
                  <div>
                    <strong>{row.item}</strong>
                    <small>{number.format(row.units)} units</small>
                  </div>
                  <b>{money.format(row.revenue)}</b>
                </div>
              ))}
            </div>
          </ChartPanel>
          <ChartPanel
            title="Payment mix"
            onExpand={(content) =>
              setExpandedChart({ title: "Payment mix", content })
            }
            onClear={
              filters.settlement
                ? () => applyChartFilter("settlement", "")
                : undefined
            }
          >
            <div className="payment-list">
              {dashboard.payment_mix.map((row, index) => (
                <button
                  className={
                    filters.settlement === row.label ? "is-selected" : ""
                  }
                  key={row.label}
                  onClick={() => applyChartFilter("settlement", row.label)}
                >
                  <div>
                    <span>{row.label}</span>
                    <strong>{number.format(row.value)}</strong>
                  </div>
                  <i>
                    <b
                      style={{
                        width: `${(row.value / Math.max(...dashboard.payment_mix.map((item) => item.value), 1)) * 100}%`,
                        background: PALETTE[index],
                      }}
                    />
                  </i>
                </button>
              ))}
            </div>
          </ChartPanel>
        </section>
        {expandedChart && (
          <ExpandedChartDialog
            title={expandedChart.title}
            onClose={() => setExpandedChart(null)}
          >
            {expandedChart.content}
          </ExpandedChartDialog>
        )}
      </>
    </ExpandedChartContext.Provider>
  );
}

type ExplorerField =
  | "year"
  | "month"
  | "week"
  | "day"
  | "outlet"
  | "category"
  | "product"
  | "channel"
  | "payment";
type ExplorerMeasure = "revenue" | "orders" | "units" | "average_order_value";
type ExplorerVisual = "bar" | "horizontalBar" | "line" | "area" | "pie" | "donut" | "table";
type ExplorerWell = "rows" | "columns" | "filters";

const EXPLORER_FIELDS: { key: ExplorerField; label: string; group: string }[] = [
  { key: "outlet", label: "Outlet", group: "Sales structure" },
  { key: "category", label: "Category", group: "Sales structure" },
  { key: "product", label: "Product", group: "Sales structure" },
  { key: "channel", label: "Channel", group: "Sales structure" },
  { key: "payment", label: "Payment", group: "Sales structure" },
  { key: "year", label: "Year", group: "Date hierarchy" },
  { key: "month", label: "Month", group: "Date hierarchy" },
  { key: "week", label: "Week", group: "Date hierarchy" },
  { key: "day", label: "Day", group: "Date hierarchy" },
];
const EXPLORER_MEASURES: { key: ExplorerMeasure; label: string }[] = [
  { key: "revenue", label: "Revenue" },
  { key: "orders", label: "Orders" },
  { key: "units", label: "Items sold" },
  { key: "average_order_value", label: "Avg. order value" },
];
const DRILL_CHAIN: Partial<Record<ExplorerField, ExplorerField>> = {
  outlet: "category",
  category: "product",
  year: "month",
  month: "week",
  week: "day",
};
const TIME_FIELDS: ExplorerField[] = ["year", "month", "week", "day"];

function fieldLabel(field: ExplorerField) {
  return EXPLORER_FIELDS.find((item) => item.key === field)?.label ?? field;
}

function ExplorerFieldChip({ field, onRemove }: { field: ExplorerField; onRemove: () => void }) {
  return (
    <div className="explorer-field-chip">
      <GripVertical size={14} aria-hidden="true" />
      <span>{fieldLabel(field)}</span>
      <button type="button" onClick={onRemove} aria-label={`Remove ${fieldLabel(field)}`}>
        <X size={13} />
      </button>
    </div>
  );
}

function ExplorerWell({
  title,
  icon,
  fields,
  well,
  onDrop,
  onRemove,
}: {
  title: string;
  icon: React.ReactNode;
  fields: ExplorerField[];
  well: ExplorerWell;
  onDrop: (well: ExplorerWell, event: DragEvent<HTMLDivElement>) => void;
  onRemove: (well: ExplorerWell, field: ExplorerField) => void;
}) {
  return (
    <div
      className="explorer-well"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(well, event)}
    >
      <div className="explorer-well-heading">
        <span>{icon}</span>
        <strong>{title}</strong>
        {well === "filters" && <small>optional</small>}
      </div>
      <div className="explorer-well-content">
        {fields.length === 0 ? (
          <span className="explorer-drop-hint">Drop fields here</span>
        ) : (
          fields.map((field) => (
            <ExplorerFieldChip
              key={field}
              field={field}
              onRemove={() => onRemove(well, field)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function DetailedInsights({ dashboard, filters }: { dashboard: DashboardData; filters: FilterState }) {
  const [rows, setRows] = useState<ExplorerField[]>(["outlet"]);
  const [columns, setColumns] = useState<ExplorerField[]>([]);
  const [filterFields, setFilterFields] = useState<ExplorerField[]>([]);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [measure, setMeasure] = useState<ExplorerMeasure>("revenue");
  const [visual, setVisual] = useState<ExplorerVisual>("bar");
  const [drillSelections, setDrillSelections] = useState<{ field: ExplorerField; value: string }[]>([]);

  const fieldValues = useMemo<Record<string, string[]>>(
    () => ({
      outlet: dashboard.outlet_performance.map((row) => row.outlet),
      category: dashboard.category_sales.map((row) => row.label),
      product: dashboard.top_items.map((row) => row.item),
      channel: dashboard.order_type_mix.map((row) => row.label),
      payment: dashboard.payment_mix.map((row) => row.label),
    }),
    [dashboard],
  );
  const queryParams = useMemo(() => {
    const params = asParams(filters);
    const dimensions = [...rows, ...columns].filter((field, index, list) => list.indexOf(field) === index);
    params.set("dimensions", dimensions.join(","));
    params.set("measure", measure);
    const selectedFilters = [
      ...drillSelections,
      ...filterFields
        .map((field) => ({ field, value: filterValues[field] }))
        .filter((item): item is { field: ExplorerField; value: string } => Boolean(item.value)),
    ];
    if (selectedFilters.length) params.set("drill", JSON.stringify(selectedFilters));
    return params;
  }, [columns, drillSelections, filterFields, filterValues, filters, measure, rows]);
  const explorerQuery = useQuery({
    queryKey: ["explorer", queryParams.toString()],
    queryFn: () => getExplorerData(queryParams),
    enabled: rows.length > 0,
  });
  const explorer = explorerQuery.data;
  const chartField: ExplorerField = rows[rows.length - 1] ?? columns[columns.length - 1] ?? "outlet";
  const chartData = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const row of explorer?.rows ?? []) {
      const label = row.dimensions[chartField] ?? "Unknown";
      grouped.set(label, (grouped.get(label) ?? 0) + row.value);
    }
    return [...grouped.entries()].map(([label, value]) => ({ label, value }));
  }, [chartField, explorer?.rows]);
  const isTimeSeries = TIME_FIELDS.includes(chartField);
  const pieAvailable = !isTimeSeries && chartData.length > 0 && chartData.length <= 8;
  const formatValue = (amount: number) =>
    measure === "orders" || measure === "units" ? number.format(amount) : money.format(amount);
  const formatLabel = (value: string) =>
    TIME_FIELDS.includes(chartField)
      ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(`${value}-01`))
      : value;

  useEffect(() => {
    if ((visual === "pie" || visual === "donut") && !pieAvailable) setVisual(isTimeSeries ? "line" : "bar");
  }, [isTimeSeries, pieAvailable, visual]);

  const relocateField = (well: ExplorerWell, field: ExplorerField) => {
    setRows((current) => current.filter((item) => item !== field));
    setColumns((current) => current.filter((item) => item !== field));
    setFilterFields((current) => current.filter((item) => item !== field));
    if (well === "rows") setRows((current) => [...current, field].slice(0, 4));
    if (well === "columns") setColumns((current) => [...current, field].slice(0, 3));
    if (well === "filters") setFilterFields((current) => [...current, field].slice(0, 4));
  };
  const handleDrop = (well: ExplorerWell, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const field = event.dataTransfer.getData("text/plain") as ExplorerField;
    if (EXPLORER_FIELDS.some((item) => item.key === field)) relocateField(well, field);
  };
  const removeField = (well: ExplorerWell, field: ExplorerField) => {
    if (well === "rows") setRows((current) => current.filter((item) => item !== field));
    if (well === "columns") setColumns((current) => current.filter((item) => item !== field));
    if (well === "filters") {
      setFilterFields((current) => current.filter((item) => item !== field));
      setFilterValues((current) => ({ ...current, [field]: "" }));
    }
  };
  const drillInto = (value: string) => {
    const next = DRILL_CHAIN[chartField];
    if (!next || rows.includes(next) || rows.length >= 4) return;
    setDrillSelections((current) => [...current, { field: chartField, value }]);
    setRows((current) => [...current, next]);
  };
  const drillBack = () => {
    if (!drillSelections.length) return;
    setDrillSelections((current) => current.slice(0, -1));
    setRows((current) => current.slice(0, -1));
  };
  const clearAnalysis = () => {
    setRows(["outlet"]);
    setColumns([]);
    setFilterFields([]);
    setFilterValues({});
    setDrillSelections([]);
  };
  const chartTooltip = (
    <Tooltip
      cursor={hoverGuide}
      contentStyle={{ background: "#fff", border: "1px solid #d8e5e2", borderRadius: 6 }}
      formatter={(amount: number) => formatValue(amount)}
      labelFormatter={formatLabel}
    />
  );
  const dimensionsForPivot = [...rows, ...columns].filter((field, index, list) => list.indexOf(field) === index);
  const pivotRows = useMemo(() => {
    const rowFields = rows.length ? rows : [chartField];
    const columnFields = columns.filter((field) => !rowFields.includes(field));
    const map = new Map<string, { labels: Record<string, string>; values: Record<string, number> }>();
    for (const row of explorer?.rows ?? []) {
      const rowKey = rowFields.map((field) => row.dimensions[field] ?? "Unknown").join(" • ");
      const columnKey = columnFields.length
        ? columnFields.map((field) => row.dimensions[field] ?? "Unknown").join(" • ")
        : "Value";
      const current = map.get(rowKey) ?? { labels: {}, values: {} };
      rowFields.forEach((field) => { current.labels[field] = row.dimensions[field] ?? "Unknown"; });
      current.values[columnKey] = (current.values[columnKey] ?? 0) + row.value;
      map.set(rowKey, current);
    }
    return { rows: [...map.values()], columns: [...new Set([...map.values()].flatMap((row) => Object.keys(row.values)))], rowFields };
  }, [chartField, columns, explorer?.rows, rows]);

  useEffect(() => {
    const handleExport = (event: Event) => {
      const request = event as CustomEvent<ExportRequestDetail>;
      if (!request.detail?.export) return;
      request.detail.handled = true;
      request.detail.export({
        filename: "detailed-insights-current-view.csv",
        columns: [
          ...dimensionsForPivot.map(fieldLabel),
          explorer?.measure.label ?? EXPLORER_MEASURES.find((item) => item.key === measure)?.label ?? measure,
        ],
        rows: (explorer?.rows ?? []).map((row) => [
          ...dimensionsForPivot.map((field) => row.dimensions[field] ?? ""),
          row.value,
        ]),
      });
    };
    window.addEventListener("analytics-export-request", handleExport);
    return () => window.removeEventListener("analytics-export-request", handleExport);
  }, [dimensionsForPivot, explorer?.measure.label, explorer?.rows, measure]);

  return (
    <section className="explorer-page">
      <section className="explorer-intro">
        <div>
          <p className="eyebrow">POWER BI STYLE EXPLORER</p>
          <h2>Build an analysis from your sales data.</h2>
          <p>Drag fields into rows, columns, or filters. Select a chart and drill into the next level.</p>
        </div>
        <button type="button" className="secondary-button" onClick={clearAnalysis}>
          <RefreshCw size={15} /> Reset analysis
        </button>
      </section>
      <section className="explorer-builder">
        <aside className="field-library">
          <div className="builder-section-heading"><strong>Fields</strong><small>Drag to a well</small></div>
          {["Sales structure", "Date hierarchy"].map((group) => (
            <div key={group} className="field-group">
              <small>{group}</small>
              {EXPLORER_FIELDS.filter((field) => field.group === group).map((field) => (
                <button
                  key={field.key}
                  type="button"
                  className="field-library-item"
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData("text/plain", field.key)}
                  onClick={() => relocateField("rows", field.key)}
                >
                  <GripVertical size={14} /><span>{field.label}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>
        <div className="explorer-workbench">
          <div className="explorer-wells">
            <ExplorerWell title="Rows" icon={<Rows3 size={15} />} fields={rows} well="rows" onDrop={handleDrop} onRemove={removeField} />
            <ExplorerWell title="Columns" icon={<Columns3 size={15} />} fields={columns} well="columns" onDrop={handleDrop} onRemove={removeField} />
            <ExplorerWell title="Filters" icon={<Filter size={15} />} fields={filterFields} well="filters" onDrop={handleDrop} onRemove={removeField} />
            <label className="measure-well">
              <span><Table2 size={15} /> Values</span>
              <select value={measure} onChange={(event) => setMeasure(event.target.value as ExplorerMeasure)}>
                {EXPLORER_MEASURES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </label>
          </div>
          {filterFields.length > 0 && (
            <div className="analysis-filter-values">
              {filterFields.map((field) => (
                <label key={field}>
                  {fieldLabel(field)}
                  <select value={filterValues[field] ?? ""} onChange={(event) => setFilterValues((current) => ({ ...current, [field]: event.target.value }))}>
                    <option value="">All</option>
                    {(fieldValues[field] ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
              ))}
            </div>
          )}
          <div className="explorer-toolbar">
            <div className="drill-breadcrumbs">
              <button type="button" onClick={drillBack} disabled={!drillSelections.length} title="Drill back up"><ArrowLeft size={15} /> Back</button>
              <span>All data</span>
              {drillSelections.map((item) => <span key={`${item.field}-${item.value}`}>/ {fieldLabel(item.field)}: {item.value}</span>)}
            </div>
            <label>Visual
              <select value={visual} onChange={(event) => setVisual(event.target.value as ExplorerVisual)}>
                <option value="bar">Column chart</option>
                <option value="horizontalBar">Bar chart</option>
                <option value="line">Line chart</option>
                <option value="area">Area chart</option>
                <option value="pie" disabled={!pieAvailable}>Pie chart{!pieAvailable ? " (category only)" : ""}</option>
                <option value="donut" disabled={!pieAvailable}>Donut chart{!pieAvailable ? " (category only)" : ""}</option>
                <option value="table">Pivot table</option>
              </select>
            </label>
          </div>
          <section className="explorer-result-panel">
            <div className="panel-heading">
              <div><p className="eyebrow">LIVE ANALYSIS</p><h2>{dimensionsForPivot.map(fieldLabel).join(" by ") || "Choose fields"}</h2></div>
              <small>{explorer?.rows.length ?? 0} grouped results</small>
            </div>
            {explorerQuery.isLoading ? <LoadingState message="Running analysis..." detail="Grouping the selected fields from PostgreSQL." /> : explorerQuery.isError ? <div className="insight-error">{explorerQuery.error.message}</div> : (
              <>
                {(visual === "bar" || visual === "horizontalBar") && (
                  <ResponsiveContainer width="100%" height={430}>
                    <BarChart data={chartData} layout={visual === "horizontalBar" ? "vertical" : "horizontal"} margin={{ top: 14, right: 24, left: 12, bottom: 25 }} onClick={(entry) => { const label = (entry as { activeLabel?: string })?.activeLabel; if (label) drillInto(label); }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={visual === "horizontalBar"} horizontal={visual !== "horizontalBar"} stroke="#dbe5e5" />
                      {visual === "bar" ? <><XAxis dataKey="label" tick={{ fontSize: 12 }} tickFormatter={formatLabel} /><YAxis tick={{ fontSize: 12 }} tickFormatter={(amount) => compactRupees(amount)} /></> : <><XAxis type="number" tick={{ fontSize: 12 }} tickFormatter={(amount) => compactRupees(amount)} /><YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 12 }} /></>}
                      {chartTooltip}<Bar dataKey="value" fill="#0f766e" radius={visual === "bar" ? [4, 4, 0, 0] : [0, 4, 4, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
                {visual === "line" && <ResponsiveContainer width="100%" height={430}><LineChart data={chartData} margin={{ top: 14, right: 24, left: 12, bottom: 25 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dbe5e5" /><XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={20} tickFormatter={formatLabel} /><YAxis tick={{ fontSize: 12 }} tickFormatter={(amount) => compactRupees(amount)} />{chartTooltip}<Line type="monotone" dataKey="value" stroke="#0f766e" strokeWidth={3} dot={false} activeDot={{ r: 5 }} isAnimationActive={false} /></LineChart></ResponsiveContainer>}
                {visual === "area" && <ResponsiveContainer width="100%" height={430}><AreaChart data={chartData} margin={{ top: 14, right: 24, left: 12, bottom: 25 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dbe5e5" /><XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={20} tickFormatter={formatLabel} /><YAxis tick={{ fontSize: 12 }} tickFormatter={(amount) => compactRupees(amount)} />{chartTooltip}<Area type="monotone" dataKey="value" stroke="#0f766e" strokeWidth={2} fill="#99ded1" fillOpacity={0.55} isAnimationActive={false} /></AreaChart></ResponsiveContainer>}
                {(visual === "pie" || visual === "donut") && <ResponsiveContainer width="100%" height={430}><PieChart><Pie data={chartData} dataKey="value" nameKey="label" innerRadius={visual === "donut" ? 78 : 0} outerRadius={126} paddingAngle={2} isAnimationActive={false} labelLine={{ stroke: "#94a3b8" }} label={({ name, percent }) => name && percent !== undefined ? `${name} ${Math.round(percent * 100)}%` : ""} onClick={(entry) => { const label = (entry as { name?: string })?.name; if (label) drillInto(label); }}>{chartData.map((row, index) => <Cell key={row.label} fill={PALETTE[index % PALETTE.length]} />)}</Pie><Tooltip formatter={(amount: number) => formatValue(amount)} /></PieChart></ResponsiveContainer>}
                {visual === "table" && <div className="explorer-pivot-wrap"><table className="explorer-pivot"><thead><tr>{pivotRows.rowFields.map((field) => <th key={field}>{fieldLabel(field)}</th>)}{pivotRows.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{pivotRows.rows.map((row, index) => <tr key={`${index}-${Object.values(row.labels).join("-")}`}>{pivotRows.rowFields.map((field) => <td key={field}>{row.labels[field]}</td>)}{pivotRows.columns.map((column) => <td key={column}>{formatValue(row.values[column] ?? 0)}</td>)}</tr>)}</tbody></table></div>}
                {chartData.length === 0 && <div className="empty-panel">No rows match this analysis. Remove a filter or choose another field.</div>}
              </>
            )}
          </section>
          <div className="explorer-drill-hint">Select a bar, slice, or table grouping to drill down. Use Back to return to the previous level.</div>
        </div>
      </section>
    </section>
  );
}

function DetailedInsightsLegacy({ dashboard }: { dashboard: DashboardData }) {
  const [source, setSource] = useState<
    "category" | "outlet" | "channel" | "payment" | "trend"
  >("category");
  const [visual, setVisual] = useState<
    | "bar"
    | "horizontalBar"
    | "line"
    | "area"
    | "pie"
    | "donut"
    | "scatter"
    | "table"
  >("bar");
  const sources = {
    category: {
      label: "Category revenue",
      kind: "currency",
      data: dashboard.category_sales.map((row) => ({
        label: row.label,
        value: row.value,
        comparison: row.units,
      })),
    },
    outlet: {
      label: "Outlet revenue",
      kind: "currency",
      data: dashboard.outlet_performance.map((row) => ({
        label: row.outlet,
        value: row.revenue,
        comparison: row.orders,
      })),
    },
    channel: {
      label: "Orders by channel",
      kind: "number",
      data: dashboard.order_type_mix.map((row) => ({
        ...row,
        comparison: row.value,
      })),
    },
    payment: {
      label: "Payments by method",
      kind: "number",
      data: dashboard.payment_mix.map((row) => ({
        ...row,
        comparison: row.value,
      })),
    },
    trend: {
      label: "Revenue over time",
      kind: "currency",
      data: dashboard.revenue_trend.map((row) => ({
        label: row.date,
        value: row.revenue,
        comparison: row.orders,
      })),
    },
  } as const;
  const selected = sources[source];
  const data = selected.data;
  const isTimeSeries = source === "trend";
  const isCurrency = selected.kind === "currency";
  const formatValue = (amount: number) =>
    isCurrency ? money.format(amount) : number.format(amount);
  const formatLabel = (value: string) =>
    source === "trend"
      ? new Intl.DateTimeFormat("en-IN", {
          day: "numeric",
          month: "short",
        }).format(new Date(`${value}T00:00:00`))
      : value;
  const chartTooltip = (
    <Tooltip
      cursor={hoverGuide}
      contentStyle={{
        background: "#fff",
        border: "1px solid #d8e5e2",
        borderRadius: 6,
      }}
      formatter={(amount: number) => formatValue(amount)}
      labelFormatter={formatLabel}
    />
  );
  const axisFormatter = (amount: number) =>
    isCurrency ? compactRupees(amount) : number.format(amount);

  return (
    <section className="details-workspace">
      <section className="builder-controls">
        <label>
          Database view
          <select
            value={source}
            onChange={(event) => {
              const nextSource = event.target.value as keyof typeof sources;
              setSource(nextSource);
              if (
                nextSource === "trend" &&
                (visual === "pie" || visual === "donut")
              ) {
                setVisual("line");
              }
            }}
          >
            {Object.entries(sources).map(([key, item]) => (
              <option key={key} value={key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Chart type
          <select
            value={visual}
            onChange={(event) => setVisual(event.target.value as typeof visual)}
          >
            <option value="bar">Column chart</option>
            <option value="horizontalBar">Horizontal bar chart</option>
            <option value="line">Line chart</option>
            <option value="area">Area chart</option>
            <option value="pie" disabled={isTimeSeries}>
              Pie chart{isTimeSeries ? " (not available for time-series)" : ""}
            </option>
            <option value="donut" disabled={isTimeSeries}>
              Donut chart{isTimeSeries ? " (not available for time-series)" : ""}
            </option>
            <option value="scatter">Scatter plot</option>
            <option value="table">Data table</option>
          </select>
        </label>
        {isTimeSeries ? (
          <p className="chart-compatibility-note" role="status">
            Pie and donut charts are unavailable for daily time-series data. Use
            a line, area, column, scatter, or table view instead.
          </p>
        ) : (
          <small>
            All values are queried from the current filtered PostgreSQL data.
          </small>
        )}
      </section>
      <section className="custom-visual-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">DATABASE VISUAL</p>
            <h2>{selected.label}</h2>
          </div>
        </div>
        {visual === "bar" && (
          <ResponsiveContainer width="100%" height={430}>
            <BarChart
              data={data}
              margin={{ top: 14, right: 24, left: 8, bottom: 12 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="#dbe5e5"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                minTickGap={20}
                tickFormatter={formatLabel}
              />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={axisFormatter} />
              {chartTooltip}
              <Bar
                dataKey="value"
                fill="#0f766e"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
        {visual === "horizontalBar" && (
          <ResponsiveContainer width="100%" height={430}>
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 14, right: 24, left: 28, bottom: 12 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                horizontal={false}
                stroke="#dbe5e5"
              />
              <XAxis
                type="number"
                tick={{ fontSize: 12 }}
                tickFormatter={axisFormatter}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={100}
                tick={{ fontSize: 12 }}
                tickFormatter={formatLabel}
              />
              {chartTooltip}
              <Bar
                dataKey="value"
                fill="#f97316"
                radius={[0, 4, 4, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
        {visual === "line" && (
          <ResponsiveContainer width="100%" height={430}>
            <LineChart
              data={data}
              margin={{ top: 14, right: 24, left: 8, bottom: 12 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="#dbe5e5"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                minTickGap={20}
                tickFormatter={formatLabel}
              />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={axisFormatter} />
              {chartTooltip}
              <Line
                type="monotone"
                dataKey="value"
                stroke="#0f766e"
                strokeWidth={3}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
        {visual === "area" && (
          <ResponsiveContainer width="100%" height={430}>
            <AreaChart
              data={data}
              margin={{ top: 14, right: 24, left: 8, bottom: 12 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="#dbe5e5"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                minTickGap={20}
                tickFormatter={formatLabel}
              />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={axisFormatter} />
              {chartTooltip}
              <Area
                type="monotone"
                dataKey="value"
                stroke="#0f766e"
                strokeWidth={2}
                fill="#99ded1"
                fillOpacity={0.6}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
        {(visual === "pie" || visual === "donut") && (
          <ResponsiveContainer width="100%" height={430}>
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                innerRadius={visual === "donut" ? 72 : 0}
                outerRadius={122}
                paddingAngle={2}
                isAnimationActive={false}
                labelLine={{ stroke: "#94a3b8" }}
                label={({ name, percent }) =>
                  name && percent !== undefined
                    ? `${name} ${Math.round(percent * 100)}%`
                    : ""
                }
              >
                {data.map((row, index) => (
                  <Cell
                    key={row.label}
                    fill={PALETTE[index % PALETTE.length]}
                  />
                ))}
              </Pie>
              <Tooltip formatter={(amount: number) => formatValue(amount)} />
            </PieChart>
          </ResponsiveContainer>
        )}
        {visual === "scatter" && (
          <ResponsiveContainer width="100%" height={430}>
            <ScatterChart margin={{ top: 20, right: 32, bottom: 20, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dbe5e5" />
              <XAxis
                type="number"
                dataKey="value"
                name={isCurrency ? "Revenue" : "Value"}
                tickFormatter={axisFormatter}
              />
              <YAxis
                type="number"
                dataKey="comparison"
                name={
                  source === "category"
                    ? "Units"
                    : source === "outlet" || source === "trend"
                      ? "Orders"
                      : "Value"
                }
                tickFormatter={(amount) => number.format(amount)}
              />
              <ZAxis range={[80, 180]} />
              {chartTooltip}
              <Scatter data={data} fill="#0f766e" />
            </ScatterChart>
          </ResponsiveContainer>
        )}
        {visual === "table" && (
          <div className="custom-table">
            <div>
              <span>Label</span>
              <span>{isCurrency ? "Revenue" : "Value"}</span>
              <span>
                {source === "category"
                  ? "Units"
                  : source === "outlet" || source === "trend"
                    ? "Orders"
                    : "Comparison"}
              </span>
            </div>
            {data.map((row) => (
              <div key={row.label}>
                <strong>{formatLabel(row.label)}</strong>
                <span>{formatValue(row.value)}</span>
                <span>{number.format(row.comparison)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

type AiDataRow = { label: string; value: number; comparison: number };

function aiSourceData(
  data: DashboardData,
  source: AiDashboardWidget["source"],
): { rows: AiDataRow[]; currency: boolean } {
  if (source === "category")
    return {
      rows: data.category_sales.map((row) => ({
        label: row.label,
        value: row.value,
        comparison: row.units,
      })),
      currency: true,
    };
  if (source === "outlet")
    return {
      rows: data.outlet_performance.map((row) => ({
        label: row.outlet,
        value: row.revenue,
        comparison: row.orders,
      })),
      currency: true,
    };
  if (source === "trend")
    return {
      rows: data.revenue_trend.map((row) => ({
        label: row.date,
        value: row.revenue,
        comparison: row.orders,
      })),
      currency: true,
    };
  if (source === "items")
    return {
      rows: data.top_items.map((row) => ({
        label: row.item,
        value: row.revenue,
        comparison: row.units,
      })),
      currency: true,
    };
  if (source === "channel")
    return {
      rows: data.order_type_mix.map((row) => ({
        label: row.label,
        value: row.value,
        comparison: row.value,
      })),
      currency: false,
    };
  return {
    rows: data.payment_mix.map((row) => ({
      label: row.label,
      value: row.value,
      comparison: row.value,
    })),
    currency: false,
  };
}

function AiDashboardWidgetView({
  widget,
  data,
}: {
  widget: AiDashboardWidget;
  data: DashboardData;
}) {
  const { rows, currency } = aiSourceData(data, widget.source);
  const formatValue = (amount: number) =>
    currency ? money.format(amount) : number.format(amount);
  const label = (row: { name?: string; percent?: number }) =>
    row.name && row.percent !== undefined
      ? `${row.name} ${Math.round(row.percent * 100)}%`
      : "";
  const tooltip = (
    <Tooltip
      cursor={hoverGuide}
      contentStyle={{
        background: "#fff",
        border: "1px solid #d8e5e2",
        borderRadius: 6,
      }}
      formatter={(amount: number) => formatValue(amount)}
    />
  );
  return (
    <section className={`ai-widget ai-${widget.visual}`}>
      <div className="ai-widget-heading">
        <div>
          <h2>{widget.title}</h2>
          <p>{widget.description}</p>
        </div>
      </div>
      {widget.visual === "bar" && (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={rows}>
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="#dbe5e5"
            />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={20} />
            <YAxis
              tick={{ fontSize: 11 }}
              tickFormatter={(value) =>
                currency ? compactRupees(value) : number.format(value)
              }
            />
            {tooltip}
            <Bar
              dataKey="value"
              fill="#0f766e"
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
      {widget.visual === "horizontalBar" && (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={rows} layout="vertical" margin={{ left: 18 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              horizontal={false}
              stroke="#dbe5e5"
            />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              tickFormatter={(value) =>
                currency ? compactRupees(value) : number.format(value)
              }
            />
            <YAxis
              type="category"
              dataKey="label"
              width={100}
              tick={{ fontSize: 11 }}
            />
            {tooltip}
            <Bar
              dataKey="value"
              fill="#f97316"
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
      {widget.visual === "line" && (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows}>
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="#dbe5e5"
            />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={22} />
            <YAxis tick={{ fontSize: 11 }} />
            {tooltip}
            <Line
              type="monotone"
              dataKey="value"
              stroke="#0f766e"
              strokeWidth={3}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
      {widget.visual === "area" && (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={rows}>
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="#dbe5e5"
            />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={22} />
            <YAxis tick={{ fontSize: 11 }} />
            {tooltip}
            <Area
              type="monotone"
              dataKey="value"
              stroke="#0f766e"
              fill="#99ded1"
              fillOpacity={0.6}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
      {(widget.visual === "pie" || widget.visual === "donut") && (
        <ResponsiveContainer width="100%" height={280}>
          <PieChart>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="label"
              innerRadius={widget.visual === "donut" ? 56 : 0}
              outerRadius={88}
              paddingAngle={2}
              isAnimationActive={false}
              labelLine={{ stroke: "#94a3b8" }}
              label={label}
            >
              {rows.map((row, index) => (
                <Cell key={row.label} fill={PALETTE[index % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(amount: number) => formatValue(amount)} />
          </PieChart>
        </ResponsiveContainer>
      )}
      {(widget.visual === "table" || widget.visual === "pivot") && (
        <div className="ai-data-table">
          <div>
            <span>{widget.visual === "pivot" ? "Dimension" : "Label"}</span>
            <span>{currency ? "Revenue" : "Value"}</span>
            <span>
              {widget.source === "category" || widget.source === "items"
                ? "Units"
                : "Orders"}
            </span>
          </div>
          {rows.map((row) => (
            <div key={row.label}>
              <strong>{row.label}</strong>
              <span>{formatValue(row.value)}</span>
              <span>{number.format(row.comparison)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AiDashboardBuilder() {
  const [prompt, setPrompt] = useState(
    "Create a dashboard for previous month sales by outlet and category.",
  );
  const [config, setConfig] = useState<AiDashboardConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const handleExport = (event: Event) => {
      const request = event as CustomEvent<ExportRequestDetail>;
      if (!request.detail?.export || !config) return;
      request.detail.handled = true;
      request.detail.export({
        filename: "ai-dashboard-current-view.csv",
        columns: ["Widget", "Source", "Label", "Value", "Comparison"],
        rows: config.widgets.flatMap((widget) => {
          const source = aiSourceData(config.data, widget.source);
          return source.rows.map((row) => [
            widget.title,
            widget.source,
            row.label,
            row.value,
            row.comparison,
          ]);
        }),
      });
    };
    window.addEventListener("analytics-export-request", handleExport);
    return () => window.removeEventListener("analytics-export-request", handleExport);
  }, [config]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      setConfig(await createAiDashboard(prompt.trim()));
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to create the AI dashboard.",
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="ai-dashboard-workspace">
      <form className="ai-dashboard-prompt" onSubmit={create}>
        <label htmlFor="ai-dashboard-request">Dashboard request</label>
        <div>
          <input
            id="ai-dashboard-request"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={500}
            placeholder="Create a dashboard for previous month sales by outlet and category"
          />
          <button
            className="primary-button"
            disabled={loading || !prompt.trim()}
          >
            <Sparkles size={17} />
            {loading ? "Creating..." : "Create dashboard"}
          </button>
        </div>
        <small>
          AI can assemble approved charts, tables, and pivot views from the
          previous month of imported sales data.
        </small>
      </form>
      {error && <div className="insight-error">{error}</div>}
      {loading && (
        <LoadingState
          message="Building your dashboard..."
          detail="Selecting approved charts and tables from previous-month sales."
        />
      )}
      {config && !loading && (
        <section className="ai-generated-dashboard">
          <div className="ai-dashboard-intro">
            <div>
              <p className="eyebrow">AI-CREATED DASHBOARD</p>
              <h2>{config.title}</h2>
              <p>{config.summary}</p>
              {config.generation_notice && <p className="ai-generation-notice">{config.generation_notice}</p>}
            </div>
            <span>{config.period}</span>
          </div>
          <section className="metrics-grid ai-kpis">
            <MetricCard
              label="Revenue"
              value={money.format(config.data.metrics.revenue)}
              note="Previous-month sales"
              icon={<IndianRupee size={22} />}
            />
            <MetricCard
              label="Orders"
              value={number.format(config.data.metrics.orders)}
              note="Unique bills completed"
              icon={<ShoppingBag size={22} />}
            />
            <MetricCard
              label="Items sold"
              value={number.format(config.data.metrics.units)}
              note="Units across all orders"
              icon={<Package size={22} />}
            />
            <MetricCard
              label="Avg. order value"
              value={money.format(config.data.metrics.average_order_value)}
              note="Revenue per bill"
              icon={<BarChart3 size={22} />}
            />
          </section>
          <section className="ai-widget-grid">
            {config.widgets.map((widget, index) => (
              <AiDashboardWidgetView
                key={`${widget.title}-${index}`}
                widget={widget}
                data={config.data}
              />
            ))}
          </section>
        </section>
      )}
    </section>
  );
}

function InsightsDialog({
  onClose,
  loading,
  error,
  insights,
  params,
}: {
  onClose: () => void;
  loading: boolean;
  error?: string;
  insights: { title: string; explanation: string; action: string }[];
  params: URLSearchParams;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const [questionError, setQuestionError] = useState("");
  const ask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setQuestionError("");
    setAnswer("");
    try {
      setAnswer(await askGemini(question.trim(), params));
    } catch (requestError) {
      setQuestionError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to answer this question.",
      );
    } finally {
      setAsking(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="insights-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Gemini data assistant"
      >
        <button
          className="icon-button close-button"
          onClick={onClose}
          title="Close"
        >
          <X size={18} />
        </button>
        <div className="insight-heading">
          <div className="gemini-mark">
            <MessageSquareText size={23} />
          </div>
          <div>
            <p className="eyebrow">GEMINI DATA ASSISTANT</p>
            <h2>Ask about this dashboard</h2>
            <small>
              Gemini 3.6 Flash | Answers use the current filtered data only.
            </small>
          </div>
        </div>
        <form className="gemini-question" onSubmit={ask}>
          <label htmlFor="gemini-question">Your question</label>
          <div>
            <input
              id="gemini-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Which outlet has the strongest revenue?"
              maxLength={500}
              disabled={asking}
            />
            <button
              className="primary-button"
              disabled={asking || !question.trim()}
              title="Ask Gemini"
            >
              <Send size={16} />
              {asking ? "Thinking..." : "Ask"}
            </button>
          </div>
        </form>
        {questionError && <div className="insight-error">{questionError}</div>}
        {answer && (
          <article className="gemini-answer">
            <p className="eyebrow">ANSWER</p>
            <p>{answer}</p>
          </article>
        )}
        <div className="insight-divider">
          <span>Dashboard summary</span>
        </div>
        {loading && <LoadingState message="Preparing dashboard insights..." />}
        {error && <div className="insight-error">{error}</div>}
        {!loading && !error && (
          <div className="insights-list">
            {insights.map((insight) => (
              <article key={insight.title}>
                <h3>{insight.title}</h3>
                <p>{insight.explanation}</p>
                <span>{insight.action}</span>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
