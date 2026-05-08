"use client";

import dynamic from "next/dynamic";
import { useState, useEffect, useRef, useMemo } from "react";

const DeliveryMap = dynamic(() => import("./components/DeliveryMap"), {
  ssr: false,
  loading: () => (
    <div style={{
      height: 380, background: "#060f1e", borderRadius: 10,
      border: "1px solid #1a2e45", display: "flex",
      alignItems: "center", justifyContent: "center",
      fontFamily: "monospace", color: "#1e3050", fontSize: 12,
      letterSpacing: 2,
    }}>
      LOADING MAP...
    </div>
  ),
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentStatus {
  state: "idle" | "running" | "done" | "error";
  startedAt?: number;
  duration?: number;
}

interface Assignment {
  vehicle_id: string;
  driver: string;
  vehicle_type: string;
  assigned_order_ids: string[];
  area_types_covered: string[];
  total_weight_kg: number;
  capacity_kg: number;
  estimated_co2_kg: number;
  route_sequence: string[];
  high_priority_count: number;
  flagged_orders: { order_id: string; flag: string; recommendation: string }[];
  reasoning: string;
}

interface RouteSummary {
  total_orders: number;
  total_vehicles_used: number;
  urban_orders: number;
  rural_orders: number;
  semi_urban_orders: number;
  ev_orders: number;
  diesel_orders: number;
  estimated_total_co2_kg: number;
  diesel_baseline_co2_kg: number;
  co2_saved_kg: number;
}

interface AreaForecast {
  area: string;
  area_type: string;
  avg_daily_orders: number;
  trend: string;
  predicted_tomorrow: number;
  demand_surge: boolean;
  recommendation: string;
}

interface Alert {
  order_id: string;
  alert_type: string;
  severity: "high" | "medium" | "low";
  area: string;
  area_type: string;
  message: string;
  corrective_action: string;
}

interface Debate {
  order_id: string;
  area: string;
  current_vehicle: string;
  optimizer_argument: string;
  alert_argument: string;
  cost_analysis: {
    cost_of_proceeding_inr: number;
    cost_of_override_inr: number;
    expected_saving_inr: number;
  };
  ruling: "UPHOLD" | "OVERRIDE";
  ruling_action: string;
  ruling_reasoning: string;
}

interface Arbitration {
  conflicts_detected: number;
  debates: Debate[];
  final_overrides: {
    order_id: string;
    original_vehicle: string;
    override_action: string;
    estimated_saving_inr: number;
  }[];
  arbitrator_summary: string;
  consensus_reached: boolean;
}

interface OrchestrationResult {
  meta: { city: string; agents_run: string[]; debate_mode?: boolean };
  route_optimization: { assignments: Assignment[]; summary: RouteSummary };
  demand_forecast: {
    area_forecasts: AreaForecast[];
    pre_positioning: { vehicle_id: string; recommended_staging_area: string; reason: string }[];
    insight: string;
  };
  alerts: {
    alerts: Alert[];
    pattern_analysis: {
      most_problematic_area: string;
      most_common_failure_reason: string;
      rural_failure_rate_pct: number;
      insight: string;
    };
    rural_connectivity_recommendation: string;
    operational_risk_score: number;
    risk_justification: string;
  };
  arbitration?: Arbitration;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BACKEND = "https://girlcodehackathon.onrender.com/";

const WAREHOUSE = { lat: 12.9716, lng: 77.5946, name: "ADA Central Warehouse" };

const AGENT_META = {
  RouteOptimizer: {
    label: "Route Optimizer",
    icon: "⬡",
    desc: "Assigns orders to vehicles by capacity, area & CO₂",
    color: "#38bdf8",
  },
  DemandForecaster: {
    label: "Demand Forecaster",
    icon: "◈",
    desc: "ARIMA-based next-day demand prediction",
    color: "#f472b6",
  },
  AlertAgent: {
    label: "Alert Agent",
    icon: "◉",
    desc: "Scans failed patterns & flags at-risk orders",
    color: "#fbbf24",
  },
  ArbitratorAgent: {
    label: "Arbitrator",
    icon: "⚖",
    desc: "Resolves conflicts with cost reasoning",
    color: "#a78bfa",
  },
};

const SUGGESTED_COMMANDS = [
  "Prioritize all medicine orders",
  "Avoid Koramangala due to flooding",
  "Maximize EV usage, minimize diesel",
  "Flag all rural orders for SMS confirmation",
  "Emergency: reassign EV-01 orders to TRUCK-01",
];

const MAP_ORDERS = [
  { order_id: "ORD-101", location_name: "Indiranagar", lat: 12.9784, lng: 77.6408, area_type: "urban", priority: "high", weight_kg: 10, deadline_hours: 2, attempt_count: 0, item_category: "electronics" },
  { order_id: "ORD-102", location_name: "Whitefield", lat: 12.9698, lng: 77.7500, area_type: "urban", priority: "medium", weight_kg: 15, deadline_hours: 4, attempt_count: 0, item_category: "groceries" },
  { order_id: "ORD-103", location_name: "Devanahalli", lat: 13.2431, lng: 77.7160, area_type: "rural", priority: "low", weight_kg: 5, deadline_hours: 8, attempt_count: 1, item_category: "medicines" },
  { order_id: "ORD-104", location_name: "Koramangala", lat: 12.9352, lng: 77.6245, area_type: "urban", priority: "high", weight_kg: 20, deadline_hours: 1, attempt_count: 0, item_category: "perishables" },
  { order_id: "ORD-105", location_name: "Doddaballapura", lat: 13.2963, lng: 77.5373, area_type: "rural", priority: "medium", weight_kg: 8, deadline_hours: 6, attempt_count: 0, item_category: "clothing" },
  { order_id: "ORD-106", location_name: "HSR Layout", lat: 12.9116, lng: 77.6474, area_type: "urban", priority: "low", weight_kg: 12, deadline_hours: 5, attempt_count: 0, item_category: "furniture" },
  { order_id: "ORD-107", location_name: "Yelahanka", lat: 13.1005, lng: 77.5963, area_type: "semi-urban", priority: "high", weight_kg: 18, deadline_hours: 2, attempt_count: 0, item_category: "electronics" },
  { order_id: "ORD-108", location_name: "Nelamangala", lat: 13.0989, lng: 77.3938, area_type: "rural", priority: "medium", weight_kg: 10, deadline_hours: 7, attempt_count: 2, item_category: "medicines" },
  { order_id: "ORD-109", location_name: "Bannerghatta", lat: 12.8000, lng: 77.5757, area_type: "semi-urban", priority: "low", weight_kg: 7, deadline_hours: 6, attempt_count: 0, item_category: "groceries" },
  { order_id: "ORD-110", location_name: "Electronic City", lat: 12.8458, lng: 77.6603, area_type: "urban", priority: "high", weight_kg: 25, deadline_hours: 1, attempt_count: 0, item_category: "perishables" },
  { order_id: "ORD-111", location_name: "Hoskote", lat: 13.0709, lng: 77.7980, area_type: "rural", priority: "medium", weight_kg: 9, deadline_hours: 8, attempt_count: 1, item_category: "clothing" },
  { order_id: "ORD-112", location_name: "Malleshwaram", lat: 13.0035, lng: 77.5703, area_type: "urban", priority: "high", weight_kg: 3, deadline_hours: 2, attempt_count: 0, item_category: "medicines" },
  { order_id: "ORD-113", location_name: "Kanakapura", lat: 12.5462, lng: 77.4175, area_type: "rural", priority: "low", weight_kg: 14, deadline_hours: 10, attempt_count: 0, item_category: "groceries" },
  { order_id: "ORD-114", location_name: "Rajajinagar", lat: 12.9906, lng: 77.5530, area_type: "urban", priority: "medium", weight_kg: 11, deadline_hours: 3, attempt_count: 0, item_category: "electronics" },
  { order_id: "ORD-115", location_name: "Tumkur Road", lat: 13.0550, lng: 77.4700, area_type: "semi-urban", priority: "high", weight_kg: 22, deadline_hours: 3, attempt_count: 0, item_category: "perishables" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function severityColor(s: string) {
  if (s === "high") return "#f87171";
  if (s === "medium") return "#fbbf24";
  return "#34d399";
}

function areaColor(t: string) {
  if (t === "urban") return "#38bdf8";
  if (t === "rural") return "#fbbf24";
  return "#f472b6";
}

function vehicleIcon(type: string) {
  if (type === "electric") return "⚡";
  if (type === "electric_bike") return "🛵";
  return "🚛";
}

function trendIcon(t: string) {
  if (t === "growing") return "↑";
  if (t === "declining") return "↓";
  return "→";
}

// ─── Agent Status Row ─────────────────────────────────────────────────────────

function AgentRow({ name, status, log }: { name: keyof typeof AGENT_META; status: AgentStatus; log: string[] }) {
  const meta = AGENT_META[name];
  const isRunning = status.state === "running";
  const isDone = status.state === "done";
  const isError = status.state === "error";

  const dotColor = isRunning ? meta.color : isDone ? "#34d399" : isError ? "#f87171" : "#1e3a5a";
  const statusLabel = isRunning ? "running" : isDone ? `${status.duration?.toFixed(1)}s` : isError ? "error" : "idle";
  const statusColor = isRunning ? meta.color : isDone ? "#34d399" : isError ? "#f87171" : "#2a3a4a";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px",
      background: isRunning ? `${meta.color}0d` : "#060f1e",
      borderRadius: 8,
      border: `1px solid ${isRunning ? `${meta.color}44` : isDone ? "#34d39922" : "#0e2040"}`,
      transition: "all 0.3s ease",
      position: "relative", overflow: "hidden",
    }}>
      {isRunning && (
        <div style={{
          position: "absolute", top: 0, left: 0, height: 2, width: "100%",
          background: `linear-gradient(90deg, transparent, ${meta.color}, transparent)`,
          animation: "scanline 1.5s linear infinite",
        }} />
      )}
      <div style={{
        width: 7, height: 7, borderRadius: "50%",
        background: dotColor, flexShrink: 0,
        boxShadow: isRunning ? `0 0 6px ${meta.color}` : "none",
        animation: isRunning ? "pulse 1.2s ease-in-out infinite" : "none",
      }} />
      <span style={{ fontSize: 14, color: meta.color, flexShrink: 0 }}>{meta.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "#d4e4f4", fontWeight: 600, fontFamily: "monospace" }}>{meta.label}</div>
        {log.length > 0 && (
          <div style={{ fontSize: 10, color: "#4a6080", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {log[log.length - 1]}
          </div>
        )}
      </div>
      <span style={{ fontSize: 10, fontFamily: "monospace", color: statusColor, fontWeight: 600, flexShrink: 0 }}>
        {isRunning ? <span style={{ animation: "blink 1s step-end infinite" }}>●</span> : null} {statusLabel}
      </span>
    </div>
  );
}

// ─── KPI Tile ─────────────────────────────────────────────────────────────────

function KpiTile({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color: string }) {
  return (
    <div style={{
      background: "#060f1e",
      border: `1px solid ${color}22`,
      borderRadius: 8, padding: "12px 14px",
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ fontSize: 9, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4, fontWeight: 600 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: 20, fontFamily: "monospace", color, fontWeight: 700, lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 9, color: "#3a5070", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── Debate Card ──────────────────────────────────────────────────────────────

function DebateCard({ debate, index }: { debate: Debate; index: number }) {
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<"optimizer" | "alert" | "ruling">("optimizer");

  useEffect(() => {
    const t1 = setTimeout(() => setVisible(true), index * 800);
    const t2 = setTimeout(() => setPhase("alert"), index * 800 + 1200);
    const t3 = setTimeout(() => setPhase("ruling"), index * 800 + 2400);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [index]);

  if (!visible) return (
    <div style={{ background: "#060f1e", border: "1px solid #1e2a3a", borderRadius: 10, padding: "18px 20px", opacity: 0.3, fontFamily: "monospace", fontSize: 11, color: "#2a4060" }}>
      ⚖ Preparing case for {debate.order_id}...
    </div>
  );

  const isOverride = debate.ruling === "OVERRIDE";
  const accentColor = isOverride ? "#a78bfa" : "#34d399";

  return (
    <div style={{
      background: "#060f1e", border: `1px solid ${accentColor}33`,
      borderRadius: 10, padding: "20px 22px", animation: "fadeIn 0.5s ease forwards",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div style={{ width: 30, height: 30, borderRadius: 7, background: `${accentColor}18`, border: `1px solid ${accentColor}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⚖</div>
        <div>
          <div style={{ fontSize: 13, fontFamily: "monospace", color: "#e8f4ff", fontWeight: 700 }}>{debate.order_id} — {debate.area}</div>
          <div style={{ fontSize: 10, color: "#4a6080" }}>Assigned: {debate.current_vehicle}</div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700, padding: "4px 12px", borderRadius: 20, background: `${accentColor}18`, border: `1px solid ${accentColor}`, color: accentColor }}>
            {isOverride ? "⚠ OVERRIDE" : "✓ UPHOLD"}
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div style={{ background: "#030b18", border: "1px solid #38bdf822", borderRadius: 7, padding: "10px 12px" }}>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#38bdf8", letterSpacing: 1, marginBottom: 6 }}>⬡ ROUTE OPTIMIZER</div>
          <p style={{ fontSize: 11, color: "#6a9abf", lineHeight: 1.6 }}>
            {typeof debate.optimizer_argument === "string"
              ? debate.optimizer_argument
              : typeof debate.optimizer_argument === "object"
                ? JSON.stringify(debate.optimizer_argument)
                : String(debate.optimizer_argument)}
          </p>
        </div>
        <div style={{ background: "#030b18", border: "1px solid #f8717122", borderRadius: 7, padding: "10px 12px", opacity: phase === "alert" || phase === "ruling" ? 1 : 0.2, transition: "opacity 0.5s ease" }}>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#f87171", letterSpacing: 1, marginBottom: 6 }}>◉ ALERT AGENT</div>
          <p style={{ fontSize: 11, color: "#6a9abf", lineHeight: 1.6 }}>
            {typeof debate.alert_argument === "string"
              ? debate.alert_argument
              : typeof debate.alert_argument === "object"
                ? JSON.stringify(debate.alert_argument)
                : String(debate.alert_argument)}
          </p>
        </div>
      </div>

      {debate.cost_analysis && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 12, opacity: phase === "ruling" ? 1 : 0.2, transition: "opacity 0.5s ease" }}>
          {[
            { label: "Proceed cost", value: `₹${debate.cost_analysis.cost_of_proceeding_inr?.toLocaleString("en-IN") || 0}`, color: "#f87171" },
            { label: "Override cost", value: `₹${debate.cost_analysis.cost_of_override_inr?.toLocaleString("en-IN") || 0}`, color: "#fbbf24" },
            { label: "Saving", value: `₹${debate.cost_analysis.expected_saving_inr?.toLocaleString("en-IN") || 0}`, color: "#34d399" },
          ].map(item => (
            <div key={item.label} style={{ background: "#030b18", borderRadius: 7, padding: "8px 10px", border: `1px solid ${item.color}22`, textAlign: "center" }}>
              <div style={{ fontSize: 9, fontFamily: "monospace", color: "#3a5070", marginBottom: 3 }}>{item.label.toUpperCase()}</div>
              <div style={{ fontSize: 14, fontFamily: "monospace", color: item.color, fontWeight: 700 }}>{item.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ background: `${accentColor}0d`, border: `1px solid ${accentColor}33`, borderRadius: 7, padding: "10px 14px", opacity: phase === "ruling" ? 1 : 0, transition: "opacity 0.5s ease", borderLeft: `3px solid ${accentColor}` }}>
        <div style={{ fontSize: 9, fontFamily: "monospace", color: accentColor, letterSpacing: 1, marginBottom: 4 }}>⚖ RULING · {debate.ruling}</div>
        {isOverride && (
          <div style={{ fontSize: 11, color: accentColor, fontFamily: "monospace", marginBottom: 4 }}>
            {typeof debate.ruling_action === "string"
              ? debate.ruling_action
              : typeof debate.ruling_action === "object"
                ? JSON.stringify(debate.ruling_action)
                : String(debate.ruling_action)}
          </div>
        )}
        <p style={{ fontSize: 11, color: "#8ab0d0", lineHeight: 1.6 }}>
          {typeof debate.ruling_reasoning === "string"
            ? debate.ruling_reasoning
            : typeof debate.ruling_reasoning === "object"
              ? JSON.stringify(debate.ruling_reasoning)
              : String(debate.ruling_reasoning)}
        </p>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Page() {
  const [agentStatus, setAgentStatus] = useState<Record<string, AgentStatus>>({
    RouteOptimizer: { state: "idle" }, DemandForecaster: { state: "idle" },
    AlertAgent: { state: "idle" }, ArbitratorAgent: { state: "idle" },
  });
  const [agentLogs, setAgentLogs] = useState<Record<string, string[]>>({
    RouteOptimizer: [], DemandForecaster: [], AlertAgent: [], ArbitratorAgent: [],
  });
  const [result, setResult] = useState<OrchestrationResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [debateMode, setDebateMode] = useState(false);
  const [activeTab, setActiveTab] = useState<"routes" | "forecast" | "alerts" | "analytics" | "debate">("routes");
  const [orchestratorLog, setOrchestratorLog] = useState<string[]>([]);
  const [injecting, setInjecting] = useState(false);
  const [injectedOrderId, setInjectedOrderId] = useState<string | null>(null);
  const [liveDebates, setLiveDebates] = useState<Debate[]>([]);
  const [conflictAlert, setConflictAlert] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<any>(null);
  const [eoqData, setEoqData] = useState<any>(null);
  const [command, setCommand] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const startTimes = useRef<Record<string, number>>({});

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [orchestratorLog]);

  const addLog = (msg: string) => setOrchestratorLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  const addAgentLog = (agent: string, msg: string) => setAgentLogs(prev => ({ ...prev, [agent]: [...(prev[agent] || []), msg] }));

  const resetState = () => {
    setResult(null); setLiveDebates([]); setConflictAlert(null);
    setOrchestratorLog([]);
    setAgentLogs({ RouteOptimizer: [], DemandForecaster: [], AlertAgent: [], ArbitratorAgent: [] });
    setAgentStatus({ RouteOptimizer: { state: "idle" }, DemandForecaster: { state: "idle" }, AlertAgent: { state: "idle" }, ArbitratorAgent: { state: "idle" } });
  };

  const handleStream = (es: EventSource) => {
    es.onmessage = (e) => {
      const { event, payload } = JSON.parse(e.data);
      if (event === "orchestrator_start") addLog(`Initialized — ${payload.total_orders} orders, ${payload.total_vehicles} vehicles, ${payload.city}`);
      if (event === "agent_start") {
        startTimes.current[payload.agent] = Date.now();
        setAgentStatus(prev => ({ ...prev, [payload.agent]: { state: "running", startedAt: Date.now() } }));
        addLog(`▶ ${payload.agent}: ${payload.message}`);
        addAgentLog(payload.agent, payload.message);
      }
      if (event === "agent_complete") {
        const duration = payload.duration || ((Date.now() - (startTimes.current[payload.agent] || Date.now())) / 1000);
        setAgentStatus(prev => ({ ...prev, [payload.agent]: { state: "done", duration } }));
        addLog(`✓ ${payload.agent} in ${typeof duration === "number" ? duration.toFixed(1) : duration}s`);
        addAgentLog(payload.agent, `Done in ${typeof duration === "number" ? duration.toFixed(1) : duration}s`);
      }
      if (event === "agent_error") {
        setAgentStatus(prev => ({ ...prev, [payload.agent]: { state: "error" } }));
        addLog(`✗ ${payload.agent}: ${payload.error}`);
      }
      if (event === "debate_start") { setConflictAlert(payload.message); addLog(`⚖ ${payload.message}`); setActiveTab("debate"); }
      if (event === "debate_ruling") {
        setLiveDebates(prev => [...prev, payload.debate]);
        addLog(`⚖ ${payload.debate.order_id}: ${payload.debate.ruling}`);
      }
      if (event === "orchestration_complete") {
        addLog("All agents complete.");
        setResult(payload as OrchestrationResult);
        if (payload.arbitration?.debates?.length > 0) setLiveDebates(payload.arbitration.debates);
        setIsRunning(false);
        es.close();
        fetch(`${BACKEND}/api/analytics`).then(r => r.json()).then(setAnalytics).catch(console.error);
        fetch(`${BACKEND}/api/eoq`).then(r => r.json()).then(setEoqData).catch(console.error);
      }
    };
    es.onerror = () => { addLog("Stream error. Is backend running on port 5000?"); setIsRunning(false); es.close(); };
  };

  const runOrchestration = () => {
    if (isRunning) return;
    setIsRunning(true); resetState(); setDebateMode(false);
    addLog("Connecting to Agentic Orchestrator...");
    handleStream(new EventSource(`${BACKEND}/api/optimize/stream`));
  };

  const runDebate = () => {
    if (isRunning) return;
    setIsRunning(true); resetState(); setDebateMode(true); setActiveTab("debate");
    addLog("⚖ DEBATE MODE — Connecting to Arbitration Orchestrator...");
    handleStream(new EventSource(`${BACKEND}/api/debate/stream`));
  };

  const runCommand = async () => {
    const cmd = command.trim();
    if (!cmd || isRunning) return;
    setIsRunning(true); resetState();
    setCommandHistory(prev => [cmd, ...prev.slice(0, 4)]); setCommand("");
    addLog(`⌘ "${cmd}"`);
    try {
      await fetch(`${BACKEND}/api/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) });
    } catch { addLog("✗ Could not reach backend."); setIsRunning(false); return; }
    handleStream(new EventSource(`${BACKEND}/api/command/stream`));
  };

  const injectLiveOrder = async () => {
    setInjecting(true);
    const urgentOrder = { order_id: `LIVE-${Date.now().toString().slice(-4)}`, customer_name: "Urgent Customer", location_name: "MG Road", area_type: "urban", lat: 12.9756, lng: 77.6099, priority: "high", weight_kg: 8, deadline_hours: 1, item_category: "medicines", status: "pending", attempt_count: 0, delivery_window: "ASAP" };
    try {
      addLog(`⚡ LIVE ORDER: ${urgentOrder.order_id} — MG Road — medicines — 1hr`);
      const res = await fetch(`${BACKEND}/api/inject-order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(urgentOrder) });
      const data = await res.json();
      setInjectedOrderId(urgentOrder.order_id);
      addLog(`✓ ${urgentOrder.order_id} assigned`);
      setResult(prev => prev ? { ...prev, route_optimization: data.route_optimization } : prev);
    } catch { addLog("✗ Live order injection failed."); } finally { setInjecting(false); }
  };

  const summary = result?.route_optimization?.summary;
  const riskScore = result?.alerts?.operational_risk_score;
  const arbitration = result?.arbitration;
  const overriddenOrderIds = useMemo(() => (arbitration?.final_overrides || liveDebates.filter(d => d.ruling === "OVERRIDE")).map((d: any) => d.order_id), [arbitration, liveDebates]);
  const visibleAgents = debateMode ? (Object.keys(AGENT_META) as (keyof typeof AGENT_META)[]) : (["RouteOptimizer", "DemandForecaster", "AlertAgent"] as (keyof typeof AGENT_META)[]);

  const tabs = ["routes", "forecast", "alerts", "analytics", ...(debateMode || liveDebates.length > 0 ? ["debate"] : [])] as const;
  const tabLabels: Record<string, string> = {
    routes: "⬡ Routes",
    forecast: "◈ Forecast",
    alerts: `◉ Alerts${result?.alerts?.alerts?.length ? ` (${result.alerts.alerts.length})` : ""}`,
    analytics: "📊 Analytics",
    debate: `⚖ Arbitration${liveDebates.length > 0 ? ` (${liveDebates.length})` : ""}`,
  };
  const tabColors: Record<string, string> = { routes: "#38bdf8", forecast: "#f472b6", alerts: "#fbbf24", analytics: "#34d399", debate: "#a78bfa" };

  return (
    <>
      {/* Background grid */}
      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", backgroundImage: "linear-gradient(#0a1e35 1px, transparent 1px), linear-gradient(90deg, #0a1e35 1px, transparent 1px)", backgroundSize: "40px 40px", animation: "gridMove 10s linear infinite", opacity: 0.3 }} />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 1400, margin: "0 auto", padding: "20px 20px 40px" }}>

        {/* ── HEADER ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg, #38bdf8, #f472b6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>⬡</div>
            <div>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#f472b6", letterSpacing: 3, marginBottom: 2 }}>ADA × GIRLCODE 2026</div>
              <h1 style={{ fontSize: 22, fontFamily: "'Inter', sans-serif", fontWeight: 600, color: "#f0f8ff", lineHeight: 1 }}>Agentic Logistics Orchestrator</h1>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="action-btn" onClick={runOrchestration} disabled={isRunning} style={{ background: isRunning && !debateMode ? "#060f1e" : "linear-gradient(135deg, #0ea5e9, #0369a1)", color: isRunning && !debateMode ? "#38bdf8" : "#fff", border: isRunning && !debateMode ? "1px solid #38bdf8" : "none" }}>
              {isRunning && !debateMode ? "⬡ RUNNING..." : "▶ RUN ORCHESTRATOR"}
            </button>
            <button className="action-btn" onClick={runDebate} disabled={isRunning} style={{ background: isRunning && debateMode ? "#060f1e" : "linear-gradient(135deg, #7c3aed, #5b21b6)", color: isRunning && debateMode ? "#a78bfa" : "#fff", border: isRunning && debateMode ? "1px solid #a78bfa" : "none" }}>
              {isRunning && debateMode ? "⚖ ARBITRATING..." : "⚖ DEBATE MODE"}
            </button>
            {result && (
              <button className="action-btn" onClick={injectLiveOrder} disabled={injecting || isRunning} style={{ background: injecting ? "#060f1e" : "linear-gradient(135deg, #dc2626, #991b1b)", color: injecting ? "#f87171" : "#fff", border: injecting ? "1px solid #f87171" : "none" }}>
                {injecting ? "⚡ INJECTING..." : "⚡ INJECT ORDER"}
              </button>
            )}
          </div>
        </div>

        {/* ── CONFLICT BANNER ── */}
        {conflictAlert && (
          <div className="fadeIn" style={{ background: "#1a0a2e", border: "1px solid #a78bfa55", borderRadius: 8, padding: "10px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>⚖</span>
            <div>
              <div style={{ fontSize: 9, fontFamily: "monospace", color: "#a78bfa", letterSpacing: 2, marginBottom: 1 }}>CONFLICT DETECTED — ARBITRATOR ENGAGED</div>
              <div style={{ fontSize: 12, color: "#8ab0d0" }}>{conflictAlert}</div>
            </div>
            <div style={{ marginLeft: "auto", fontSize: 9, fontFamily: "monospace", color: "#a78bfa", background: "#a78bfa11", border: "1px solid #a78bfa33", borderRadius: 16, padding: "3px 10px" }}>● ARBITRATING</div>
          </div>
        )}

        {/* ── COMMAND BAR ── */}
        <div className="card" style={{ padding: "14px 16px", marginBottom: 18 }}>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#38bdf8", letterSpacing: 2, marginBottom: 10 }}>⌘ NATURAL LANGUAGE CONTROL</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={command} onChange={e => setCommand(e.target.value)} onKeyDown={e => e.key === "Enter" && runCommand()} placeholder='e.g. "Prioritize all medicine orders"' disabled={isRunning}
              style={{ flex: 1, background: "#030b18", border: "1px solid #1e3a5a", borderRadius: 7, padding: "9px 13px", color: "#e8f4ff", fontFamily: "monospace", fontSize: 12, outline: "none" }} />
            <button onClick={runCommand} disabled={isRunning || !command.trim()}
              style={{ background: command.trim() && !isRunning ? "linear-gradient(135deg, #0ea5e9, #0369a1)" : "#030b18", border: `1px solid ${command.trim() && !isRunning ? "transparent" : "#1e3a5a"}`, borderRadius: 7, padding: "9px 20px", color: command.trim() && !isRunning ? "#fff" : "#2a4060", fontFamily: "monospace", fontSize: 12, fontWeight: 700, cursor: command.trim() && !isRunning ? "pointer" : "not-allowed", transition: "all 0.2s" }}>
              RUN
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 10, fontFamily: "monospace", color: "#2a4060" }}>TRY:</span>
            {SUGGESTED_COMMANDS.map(s => (
              <span key={s} className="chip" onClick={() => { if (!isRunning) setCommand(s); }} style={{ fontSize: 10, fontFamily: "monospace", color: "#3a5070", background: "#030b18", border: "1px solid #0e2040", borderRadius: 5, padding: "3px 9px", cursor: isRunning ? "not-allowed" : "pointer", transition: "all 0.15s" }}>{s}</span>
            ))}
          </div>
          {commandHistory.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
              <span style={{ fontSize: 10, fontFamily: "monospace", color: "#2a4060" }}>HISTORY:</span>
              {commandHistory.map((h, i) => (
                <span key={i} onClick={() => { if (!isRunning) setCommand(h); }} style={{ fontSize: 10, fontFamily: "monospace", color: i === 0 ? "#38bdf8" : "#2a4060", background: "#030b18", border: `1px solid ${i === 0 ? "#38bdf822" : "#0e2040"}`, borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>{h}</span>
              ))}
            </div>
          )}
        </div>

        {/* ── MAIN BODY: SIDEBAR + CONTENT ── */}
        <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>

          {/* ── LEFT SIDEBAR ── */}
          <div style={{ width: 272, flexShrink: 0, display: "flex", flexDirection: "column", gap: 14 }}>

            {/* Agent Status */}
            <div className="card" style={{ padding: "14px 14px" }}>
              <div style={{ fontSize: 9, fontFamily: "monospace", color: "#4a6080", letterSpacing: 2, marginBottom: 12, fontWeight: 600 }}>AGENT STATUS</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {visibleAgents.map(name => (
                  <AgentRow key={name} name={name} status={agentStatus[name]} log={agentLogs[name]} />
                ))}
              </div>
            </div>

            {/* KPI Grid */}
            {summary && (() => {
              const evCostSaved = summary.ev_orders * 15 * (8 - 2.5);
              const totalSavings = (arbitration?.final_overrides || []).reduce((s: number, o: any) => s + (o.estimated_saving_inr || 0), 0);
              return (
                <div className="card" style={{ padding: "14px 14px" }}>
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#4a6080", letterSpacing: 2, marginBottom: 12, fontWeight: 600 }}>KEY METRICS</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <KpiTile label="Orders" value={summary.total_orders} sub="dispatched" color="#38bdf8" />
                    <KpiTile label="Vehicles" value={summary.total_vehicles_used} sub="active" color="#f472b6" />
                    <KpiTile label="Rural" value={summary.rural_orders} sub="zones covered" color="#fbbf24" />
                    <KpiTile label="CO₂ Saved" value={`${summary.co2_saved_kg?.toFixed(1)}kg`} sub="vs diesel" color="#34d399" />
                    <KpiTile label="EV Orders" value={summary.ev_orders} sub="zero emission" color="#38bdf8" />
                    <KpiTile label="Cost Saved" value={`₹${evCostSaved.toLocaleString("en-IN", { notation: "compact" })}`} sub="EV routing" color="#34d399" />
                    {riskScore !== undefined && <KpiTile label="Risk Score" value={`${riskScore}/10`} sub="operational" color={riskScore >= 7 ? "#f87171" : riskScore >= 4 ? "#fbbf24" : "#34d399"} />}
                    {arbitration && arbitration.conflicts_detected > 0 && <KpiTile label="Conflicts" value={arbitration.conflicts_detected} sub={`₹${totalSavings.toLocaleString("en-IN", { notation: "compact" })} saved`} color="#a78bfa" />}
                    {analytics && <KpiTile label="Top Demand" value={analytics.top_demand_zone} sub="ARIMA #1" color="#38bdf8" />}
                    {analytics && <KpiTile label="High Risk" value={analytics.highest_risk_zone} sub="Hurst: chaotic" color="#f87171" />}
                  </div>
                </div>
              );
            })()}

            {/* Orchestrator Log */}
            <div className="card" style={{ padding: "12px 14px" }}>
              <div style={{ fontSize: 9, fontFamily: "monospace", color: "#4a6080", letterSpacing: 2, marginBottom: 8, fontWeight: 600 }}>ORCHESTRATOR LOG</div>
              <div ref={logRef} style={{ maxHeight: 130, overflowY: "auto", fontFamily: "monospace", fontSize: 10, lineHeight: 1.5 }}>
                {orchestratorLog.length === 0 ? (
                  <div style={{ color: "#1e3050", fontStyle: "italic" }}>Waiting for run...</div>
                ) : (
                  orchestratorLog.map((l, i) => (
                    <div key={i} style={{ color: i === orchestratorLog.length - 1 ? "#6a9abf" : "#2a4060", marginBottom: 2, wordBreak: "break-word" }}>
                      {l.substring(l.indexOf("]") + 2)}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* ── MAIN CONTENT PANEL ── */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Map */}
            <div className="card fadeIn" style={{ padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 9, fontFamily: "monospace", color: "#38bdf8", letterSpacing: 2, fontWeight: 600 }}>⬡ LIVE DELIVERY MAP — BENGALURU</div>
                {overriddenOrderIds.length > 0 && (
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#a78bfa", background: "#a78bfa11", border: "1px solid #a78bfa33", borderRadius: 14, padding: "2px 8px" }}>
                    {overriddenOrderIds.length} overridden
                  </div>
                )}
              </div>
<DeliveryMap
                orders={MAP_ORDERS}
                assignments={result?.route_optimization?.assignments || []}
                warehouse={WAREHOUSE}
                alerts={result?.alerts?.alerts || []}
                injectedOrderId={injectedOrderId}
                overriddenOrderIds={overriddenOrderIds}
                activeTab={activeTab}
              />
            </div>

            {/* Empty state */}
            {!result && !isRunning && (
              <div style={{ textAlign: "center", padding: "60px 0" }}>
                <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.15 }}>⬡</div>
                <div style={{ fontFamily: "monospace", fontSize: 12, letterSpacing: 2, color: "#1e3050", marginBottom: 8 }}>PRESS RUN ORCHESTRATOR TO BEGIN</div>
                <div style={{ fontFamily: "monospace", fontSize: 10, color: "#141e2a" }}>OR PRESS ⚖ DEBATE MODE TO SEE AGENTS ARGUE</div>
              </div>
            )}

            {/* Tabs + Tab content */}
            {result && (
              <div className="fadeIn">
                {/* Tab bar */}
                <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                  {tabs.map(tab => (
                    <button key={tab} className="tab-pill" onClick={() => setActiveTab(tab as any)} style={{
                      color: activeTab === tab ? tabColors[tab] : "#4a6080",
                      background: activeTab === tab ? `${tabColors[tab]}12` : "transparent",
                      border: `1px solid ${activeTab === tab ? tabColors[tab] : "#1e3a5a"}`,
                      fontWeight: activeTab === tab ? 700 : 400,
                    }}>
                      {tabLabels[tab]}
                    </button>
                  ))}
                </div>

                {/* ── ROUTES TAB ── */}
                {activeTab === "routes" && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
                    {result.route_optimization?.assignments?.map((a, i) => (
                      <div key={`${a.vehicle_id}-${i}`} className="card row-hover" style={{ padding: "16px 18px", transition: "background 0.2s" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                          <span style={{ fontSize: 18 }}>{vehicleIcon(a.vehicle_type)}</span>
                          <div>
                            <div style={{ fontFamily: "monospace", fontSize: 13, color: "#e8f4ff", fontWeight: 700 }}>{a.vehicle_id}</div>
                            <div style={{ fontSize: 11, color: "#4a6080" }}>Driver: {a.driver || "—"}</div>
                          </div>
                          <div style={{ marginLeft: "auto", textAlign: "right" }}>
                            <div style={{ fontSize: 12, color: "#4a6080" }}>{a.total_weight_kg}kg / {a.capacity_kg}kg</div>
                            <div style={{ fontSize: 10, color: "#2a4060" }}>{Math.round((a.total_weight_kg / a.capacity_kg) * 100)}% load</div>
                          </div>
                        </div>
                        <div style={{ height: 3, background: "#0e2040", borderRadius: 2, marginBottom: 12, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${Math.min(100, Math.round((a.total_weight_kg / a.capacity_kg) * 100))}%`, background: a.vehicle_type === "diesel" ? "#fbbf24" : "#38bdf8", borderRadius: 2, transition: "width 1s ease" }} />
                        </div>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
                          {a.area_types_covered?.map(t => <span key={t} style={{ fontSize: 9, fontFamily: "monospace", padding: "2px 7px", borderRadius: 16, border: `1px solid ${areaColor(t)}44`, color: areaColor(t), background: `${areaColor(t)}0f` }}>{t.toUpperCase()}</span>)}
                          {a.estimated_co2_kg === 0 && <span style={{ fontSize: 9, fontFamily: "monospace", padding: "2px 7px", borderRadius: 16, border: "1px solid #34d39944", color: "#34d399", background: "#34d3990f" }}>ZERO EMISSION</span>}
                          {a.high_priority_count > 0 && <span style={{ fontSize: 9, fontFamily: "monospace", padding: "2px 7px", borderRadius: 16, border: "1px solid #f8717144", color: "#f87171", background: "#f871710f" }}>{a.high_priority_count} HIGH PRI</span>}
                        </div>
                        {a.route_sequence?.length > 0 && (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 9, fontFamily: "monospace", color: "#2a4060", letterSpacing: 1, marginBottom: 5 }}>ROUTE</div>
                            <div style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 9, color: "#34d399", fontFamily: "monospace" }}>WH</span>
                              {a.route_sequence.map((loc, i) => (
                                <span key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                  <span style={{ color: "#1e3050", fontSize: 9 }}>→</span>
                                  <span style={{ fontSize: 9, fontFamily: "monospace", color: "#5a8ab0" }}>{loc}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 10 }}>
                          {a.assigned_order_ids?.map(id => (
                            <span key={id} style={{ fontSize: 9, fontFamily: "monospace", padding: "2px 5px", background: overriddenOrderIds.includes(id) ? "#a78bfa1a" : "#0e2040", border: overriddenOrderIds.includes(id) ? "1px solid #a78bfa44" : "none", borderRadius: 4, color: overriddenOrderIds.includes(id) ? "#a78bfa" : "#4a6080" }}>
                              {id}{overriddenOrderIds.includes(id) ? " ⚖" : ""}
                            </span>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, color: "#3a5070", lineHeight: 1.6, borderTop: "1px solid #0e2040", paddingTop: 10 }}>
                          {typeof a.reasoning === "string"
                            ? a.reasoning
                            : typeof a.reasoning === "object"
                              ? JSON.stringify(a.reasoning)
                              : String(a.reasoning)}
                        </div>
                        {a.flagged_orders?.length > 0 && a.flagged_orders.map((f, i) => (
                          <div key={i} style={{ fontSize: 10, color: "#fbbf24", background: "#fbbf2411", border: "1px solid #fbbf2433", borderRadius: 5, padding: "5px 8px", marginTop: 6 }}>⚠ {f.order_id}: {f.recommendation}</div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {/* ── FORECAST TAB ── */}
                {activeTab === "forecast" && (
                  <div>
                    {result.demand_forecast?.insight && (
                      <div className="card" style={{ padding: "14px 16px", marginBottom: 16, borderColor: "#f472b622" }}>
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#f472b6", letterSpacing: 1, marginBottom: 6 }}>◈ FORECAST INSIGHT</div>
                        <p style={{ fontSize: 13, color: "#8ab0d0", lineHeight: 1.7 }}>
                          {typeof result.demand_forecast.insight === "string"
                            ? result.demand_forecast.insight
                            : typeof result.demand_forecast.insight === "object"
                              ? JSON.stringify(result.demand_forecast.insight)
                              : String(result.demand_forecast.insight)}
                        </p>
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 16 }}>
                      {result.demand_forecast?.area_forecasts?.map(f => (
                        <div key={f.area} className="card row-hover" style={{ padding: "14px 16px", borderColor: f.demand_surge ? "#f8717133" : "#0e2040", transition: "background 0.2s" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                            <div>
                              <div style={{ fontSize: 13, color: "#e8f4ff", fontWeight: 600, marginBottom: 3 }}>{f.area}</div>
                              <span style={{ fontSize: 9, fontFamily: "monospace", padding: "2px 6px", borderRadius: 16, border: `1px solid ${areaColor(f.area_type)}44`, color: areaColor(f.area_type) }}>{f.area_type?.toUpperCase()}</span>
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: 22, fontFamily: "monospace", color: f.demand_surge ? "#f87171" : "#f472b6", fontWeight: 700 }}>{f.predicted_tomorrow}</div>
                              <div style={{ fontSize: 9, color: "#2a4060" }}>tomorrow</div>
                            </div>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#3a5070", marginBottom: 6 }}>
                            <span>avg {f.avg_daily_orders}/day</span>
                            <span style={{ color: f.trend === "growing" ? "#34d399" : f.trend === "declining" ? "#f87171" : "#fbbf24" }}>{trendIcon(f.trend)} {f.trend}</span>
                          </div>
                          {f.demand_surge && <div style={{ fontSize: 9, color: "#f87171", background: "#f871710f", borderRadius: 4, padding: "3px 7px", marginBottom: 5 }}>⚡ SURGE</div>}
                          <div style={{ fontSize: 10, color: "#3a5070", lineHeight: 1.5 }}>{f.recommendation}</div>
                        </div>
                      ))}
                    </div>
                    {result.demand_forecast?.pre_positioning?.length > 0 && (
                      <div className="card" style={{ padding: "14px 16px" }}>
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#38bdf8", letterSpacing: 1, marginBottom: 12 }}>PRE-POSITIONING RECOMMENDATIONS</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8 }}>
                          {result.demand_forecast.pre_positioning.map((p, i) => (
                            <div key={i} style={{ display: "flex", gap: 10, padding: "10px 12px", background: "#030b18", borderRadius: 7 }}>
                              <span style={{ fontSize: 14 }}>📍</span>
                              <div>
                                <div style={{ fontSize: 12, color: "#38bdf8", fontFamily: "monospace", marginBottom: 3 }}>{p.vehicle_id} → {p.recommended_staging_area}</div>
                                <div style={{ fontSize: 11, color: "#3a5070" }}>{p.reason}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── ALERTS TAB ── */}
                {activeTab === "alerts" && (
                  <div>
                    {result.alerts?.pattern_analysis && (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 16 }}>
                        <div className="card" style={{ padding: "14px 16px", borderColor: "#fbbf2422" }}>
                          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#fbbf24", letterSpacing: 1, marginBottom: 8 }}>PATTERN ANALYSIS</div>
                          <div style={{ fontSize: 12, color: "#8ab0d0", lineHeight: 1.8 }}>
                            <div>Most problematic: <span style={{ color: "#fbbf24" }}>{result.alerts.pattern_analysis.most_problematic_area}</span></div>
                            <div>Common failure: <span style={{ color: "#fbbf24" }}>{result.alerts.pattern_analysis.most_common_failure_reason}</span></div>
                            <div>Rural failure rate: <span style={{ color: "#f87171" }}>{result.alerts.pattern_analysis.rural_failure_rate_pct}%</span></div>
                          </div>
                          <div style={{ fontSize: 11, color: "#3a5070", marginTop: 8, lineHeight: 1.6 }}>
                            {typeof result.alerts.pattern_analysis.insight === "string"
                              ? result.alerts.pattern_analysis.insight
                              : typeof result.alerts.pattern_analysis.insight === "object"
                                ? JSON.stringify(result.alerts.pattern_analysis.insight)
                                : String(result.alerts.pattern_analysis.insight)}
                          </div>
                        </div>
                        <div className="card" style={{ padding: "14px 16px", borderColor: "#34d39922" }}>
                          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#34d399", letterSpacing: 1, marginBottom: 8 }}>RURAL CONNECTIVITY FIX</div>
                          <p style={{ fontSize: 12, color: "#8ab0d0", lineHeight: 1.7 }}>
                            {typeof result.alerts.rural_connectivity_recommendation === "string" 
                              ? result.alerts.rural_connectivity_recommendation 
                              : typeof result.alerts.rural_connectivity_recommendation === "object" && result.alerts.rural_connectivity_recommendation !== null
                                ? Object.entries(result.alerts.rural_connectivity_recommendation).map(([k, v]) => `${k}: ${v}`).join(" • ")
                                : "Rural connectivity strategy pending..."}
                          </p>
                        </div>
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 10, marginBottom: 16 }}>
                      {result.alerts?.alerts?.map((a, i) => (
                        <div key={i} className="card row-hover" style={{ padding: "14px 16px", borderColor: `${severityColor(a.severity)}33`, transition: "background 0.2s" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                            <div>
                              <span style={{ fontSize: 9, fontFamily: "monospace", padding: "2px 7px", borderRadius: 16, border: `1px solid ${severityColor(a.severity)}55`, color: severityColor(a.severity), background: `${severityColor(a.severity)}0f` }}>{a.severity.toUpperCase()}</span>
                              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#2a4060", marginLeft: 6 }}>{a.alert_type}</span>
                            </div>
                            <span style={{ fontSize: 11, fontFamily: "monospace", color: "#4a6080" }}>{a.order_id}</span>
                          </div>
                          <div style={{ fontSize: 12, color: "#8ab0d0", marginBottom: 5 }}>{a.area} <span style={{ color: areaColor(a.area_type), fontSize: 10 }}>({a.area_type})</span></div>
                          <div style={{ fontSize: 12, color: "#c8d8e8", marginBottom: 8, lineHeight: 1.6 }}>
                            {typeof a.message === "string"
                              ? a.message
                              : typeof a.message === "object"
                                ? JSON.stringify(a.message)
                                : String(a.message)}
                          </div>
                          <div style={{ fontSize: 11, color: "#34d399", background: "#34d3990f", border: "1px solid #34d39922", borderRadius: 5, padding: "6px 10px" }}>
                            ✓ {typeof a.corrective_action === "string"
                              ? a.corrective_action
                              : typeof a.corrective_action === "object"
                                ? JSON.stringify(a.corrective_action)
                                : String(a.corrective_action)}
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Rural Fallback Protocol */}
                    <div className="card" style={{ padding: "18px 20px", borderColor: "#fbbf2433" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                        <span style={{ fontSize: 18 }}>📡</span>
                        <div>
                          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#fbbf24", letterSpacing: 2 }}>RURAL FALLBACK PROTOCOL — ACTIVE</div>
                          <div style={{ fontSize: 11, color: "#4a6080", marginTop: 2 }}>Nelamangala · Kanakapura · Devanahalli · Hoskote</div>
                        </div>
                        <div style={{ marginLeft: "auto", fontSize: 9, fontFamily: "monospace", color: "#34d399", background: "#34d3990f", border: "1px solid #34d39922", borderRadius: 14, padding: "3px 10px" }}>● ARMED</div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                        {[
                          { step: "01", icon: "💬", title: "SMS Pre-Confirmation", desc: "Automated SMS 2hrs before dispatch. Reduces failed attempts by ~60%.", color: "#38bdf8" },
                          { step: "02", icon: "🤝", title: "Local Partner Network", desc: "Rural orders to verified local partners with ground knowledge.", color: "#f472b6" },
                          { step: "03", icon: "📦", title: "Community Locker", desc: "Package dropped at nearest kirana store or community locker.", color: "#fbbf24" },
                          { step: "04", icon: "🗺️", title: "Offline Driver App", desc: "Routes cached locally. Works without internet in rural zones.", color: "#34d399" },
                        ].map(item => (
                          <div key={item.step} style={{ background: "#030b18", border: `1px solid ${item.color}18`, borderRadius: 8, padding: "12px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                              <span style={{ fontSize: 15 }}>{item.icon}</span>
                              <div>
                                <div style={{ fontSize: 8, fontFamily: "monospace", color: item.color, letterSpacing: 1 }}>STEP {item.step}</div>
                                <div style={{ fontSize: 12, color: "#e8f4ff", fontWeight: 600 }}>{item.title}</div>
                              </div>
                            </div>
                            <div style={{ fontSize: 11, color: "#3a5070", lineHeight: 1.5 }}>{item.desc}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* ── ANALYTICS TAB ── */}
                {activeTab === "analytics" && analytics && (
                  <div>
                    {/* ARIMA + Hurst */}
                    <div style={{ marginBottom: 24 }}>
                      <div style={{ fontSize: 9, fontFamily: "monospace", color: "#38bdf8", letterSpacing: 2, marginBottom: 12, fontWeight: 600 }}>⬡ ARIMA DEMAND FORECAST + HURST ZONE STABILITY</div>
                      {/* Header row */}
                      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1.6fr", gap: 14, padding: "8px 16px", marginBottom: 6 }}>
                        {["ZONE", "FORECAST", "HURST (H)", "INTERPRETATION"].map(h => (
                          <div key={h} style={{ fontSize: 9, color: "#3a5070", fontFamily: "monospace", fontWeight: 600, letterSpacing: 1 }}>{h}</div>
                        ))}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {analytics.analytics?.map((z: any) => (
                          <div key={z.order_id} className="card row-hover" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1.6fr", gap: 14, padding: "12px 16px", alignItems: "center", transition: "background 0.15s" }}>
                            <div>
                              <div style={{ fontSize: 13, color: "#e8f4ff", fontWeight: 600 }}>{z.zone}</div>
                              <div style={{ fontSize: 9, color: "#4a6080", marginTop: 2 }}>{z.area_type}</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 14, color: "#38bdf8", fontFamily: "monospace", fontWeight: 700 }}>{z.arima_forecast.predicted}</div>
                              <div style={{ fontSize: 9, color: z.arima_forecast.trend === "up" ? "#34d399" : "#f87171", marginTop: 2 }}>{z.arima_forecast.trend === "up" ? "▲ Growing" : "▼ Declining"}</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 14, color: "#fbbf24", fontFamily: "monospace", fontWeight: 700 }}>{z.hurst.hurst}</div>
                              <div style={{ fontSize: 9, fontWeight: 600, marginTop: 2, color: z.hurst.risk_level === "high" ? "#f87171" : z.hurst.risk_level === "medium" ? "#fbbf24" : "#34d399" }}>{z.hurst.risk_level.toUpperCase()} RISK</div>
                            </div>
                            <div style={{ fontSize: 11, color: "#6a9abf", lineHeight: 1.5 }}>{z.hurst.interpretation}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* EOQ */}
                    {eoqData && (
                      <div>
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#f472b6", letterSpacing: 2, marginBottom: 12, fontWeight: 600 }}>⬡ BAYESIAN EOQ — OPTIMAL REORDER QUANTITIES (95% CI)</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.2fr 1fr", gap: 14, padding: "8px 16px", marginBottom: 6 }}>
                          {["ZONE", "AVG DEMAND", "REORDER QTY", "REORDER PT"].map(h => (
                            <div key={h} style={{ fontSize: 9, color: "#3a5070", fontFamily: "monospace", fontWeight: 600, letterSpacing: 1 }}>{h}</div>
                          ))}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                          {eoqData.eoq_recommendations?.slice(0, 15).map((z: any) => (
                            <div key={z.zone} className="card row-hover" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.2fr 1fr", gap: 14, padding: "12px 16px", alignItems: "center", transition: "background 0.15s" }}>
                              <div>
                                <div style={{ fontSize: 13, color: "#e8f4ff", fontWeight: 600 }}>{z.zone}</div>
                                <div style={{ fontSize: 9, color: "#4a6080", marginTop: 2 }}>{z.area_type}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 14, color: "#38bdf8", fontFamily: "monospace", fontWeight: 700 }}>{z.avg_daily_demand}</div>
                                <div style={{ fontSize: 9, color: "#4a6080", marginTop: 2 }}>units/day</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 14, color: "#34d399", fontFamily: "monospace", fontWeight: 700 }}>{z.optimal_reorder_qty}</div>
                                <div style={{ fontSize: 9, color: "#3a5070", marginTop: 2 }}>[{z.credible_interval_95[0]}–{z.credible_interval_95[1]}]</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 14, color: "#fbbf24", fontFamily: "monospace", fontWeight: 700 }}>{z.reorder_point}</div>
                                <div style={{ fontSize: 9, color: "#4a6080", marginTop: 2 }}>units</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── ARBITRATION TAB ── */}
                {activeTab === "debate" && (
                  <div>
                    {arbitration?.arbitrator_summary && (
                      <div className="card" style={{ padding: "14px 18px", marginBottom: 20, borderColor: "#a78bfa33", background: "#130a2a" }}>
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#a78bfa", letterSpacing: 1, marginBottom: 6 }}>⚖ ARBITRATOR SUMMARY</div>
                        <p style={{ fontSize: 13, color: "#8ab0d0", lineHeight: 1.7 }}>
                          {typeof arbitration.arbitrator_summary === "string"
                            ? arbitration.arbitrator_summary
                            : typeof arbitration.arbitrator_summary === "object"
                              ? JSON.stringify(arbitration.arbitrator_summary)
                              : String(arbitration.arbitrator_summary)}
                        </p>
                        <div style={{ display: "flex", gap: 20, marginTop: 12 }}>
                          <div style={{ fontSize: 12, color: "#4a6080" }}>Conflicts: <span style={{ color: "#a78bfa", fontFamily: "monospace" }}>{arbitration.conflicts_detected}</span></div>
                          <div style={{ fontSize: 12, color: "#4a6080" }}>Overrides: <span style={{ color: "#f87171", fontFamily: "monospace" }}>{arbitration.final_overrides?.length || 0}</span></div>
                          <div style={{ fontSize: 12, color: "#4a6080" }}>Upheld: <span style={{ color: "#34d399", fontFamily: "monospace" }}>{arbitration.conflicts_detected - (arbitration.final_overrides?.length || 0)}</span></div>
                        </div>
                      </div>
                    )}
                    {liveDebates.length === 0 && !isRunning && (
                      <div style={{ textAlign: "center", padding: "40px 0", color: "#2a4060", fontFamily: "monospace", fontSize: 12 }}>
                        {debateMode ? "⚖ No conflicts detected." : "Run ⚖ DEBATE MODE to see Arbitrator resolve conflicts."}
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                      {liveDebates.map((debate, i) => <DebateCard key={debate.order_id} debate={debate} index={i} />)}
                    </div>
                    {arbitration?.final_overrides && arbitration.final_overrides.length > 0 && (
                      <div className="card" style={{ marginTop: 20, padding: "16px 20px", borderColor: "#a78bfa22" }}>
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#a78bfa", letterSpacing: 2, marginBottom: 12 }}>⚖ FINAL OVERRIDE SUMMARY</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {arbitration.final_overrides.map((o: any, i: number) => (
                            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "#030b18", borderRadius: 7, border: "1px solid #a78bfa18" }}>
                              <span style={{ fontSize: 14 }}>⚖</span>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 12, fontFamily: "monospace", color: "#e8f4ff", marginBottom: 2 }}>{o.order_id} · {o.original_vehicle} → overridden</div>
                                <div style={{ fontSize: 11, color: "#4a6080" }}>{o.override_action}</div>
                              </div>
                              <div style={{ textAlign: "right" }}>
                                <div style={{ fontSize: 14, fontFamily: "monospace", color: "#34d399", fontWeight: 700 }}>₹{(o.estimated_saving_inr || 0).toLocaleString("en-IN")}</div>
                                <div style={{ fontSize: 10, color: "#3a5070" }}>saved</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid #0e2040", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#1e3050", letterSpacing: 1 }}>ADA × GIRLCODE 2026 — BIGGEST WOMEN AI HACKATHON</div>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#1e3050" }}>RouteOptimizer · DemandForecaster · AlertAgent · ArbitratorAgent · Groq SDK</div>
        </div>
      </div>
    </>
  );
}
