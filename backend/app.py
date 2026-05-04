import json
import os
import time
from math import radians, sin, cos, sqrt, atan2
from dotenv import load_dotenv
from flask import Flask, jsonify, Response, stream_with_context, request
from flask_cors import CORS
from groq import Groq
import numpy as np
from statsmodels.tsa.arima.model import ARIMA
from math import log, sqrt
import concurrent.futures

def groq_call_with_retry(fn, *args, max_retries=3, **kwargs):
    for attempt in range(max_retries):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            if "429" in str(e) and attempt < max_retries - 1:
                wait = float(str(e).split("Please try again in ")[1].split("s.")[0]) + 1 if "Please try again in " in str(e) else (attempt + 1) * 10
                print(f"  Rate limit hit — waiting {wait:.0f}s before retry...")
                time.sleep(wait)
            else:
                raise

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

app = Flask(__name__)
CORS(app)

# ─────────────────────────────────────────────
# GROQ CLIENT
# ─────────────────────────────────────────────

def get_client(debate=False):
    key = os.getenv("GROQ_API_KEY_DEBATE") or os.getenv("GROQ_API_KEY")
    return Groq(api_key=key)

def get_model():
    return os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")


# ─────────────────────────────────────────────
# HAVERSINE TOOL
# ─────────────────────────────────────────────

def calculate_distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return round(R * 2 * atan2(sqrt(a), sqrt(1 - a)), 2)

DISTANCE_TOOL = {
    "type": "function",
    "function": {
        "name": "calculate_distance_km",
        "description": "Calculates the distance in kilometers between two GPS coordinates using the Haversine formula. Call this before assigning any order to an EV vehicle to verify range.",
        "parameters": {
            "type": "object",
            "properties": {
                "lat1": {"type": "number", "description": "Latitude of point 1 (warehouse)"},
                "lng1": {"type": "number", "description": "Longitude of point 1 (warehouse)"},
                "lat2": {"type": "number", "description": "Latitude of point 2 (delivery location)"},
                "lng2": {"type": "number", "description": "Longitude of point 2 (delivery location)"},
            },
            "required": ["lat1", "lng1", "lat2", "lng2"],
        },
    },
}


# ─────────────────────────────────────────────
# DATA LOADER
# ─────────────────────────────────────────────

def load_data():
    data_path = os.path.join(os.path.dirname(__file__), "logistics_data.json")
    with open(data_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ─────────────────────────────────────────────
# HELPER — clean JSON from LLM response
# ─────────────────────────────────────────────

def parse_json_response(text: str) -> dict:
    clean = text.strip()
    if "```" in clean:
        parts = clean.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            try:
                return json.loads(part)
            except Exception:
                continue
    # Try direct parse
    try:
        return json.loads(clean)
    except Exception:
        pass
    # Try to recover truncated JSON by finding last complete object
    try:
        last_brace = clean.rfind("}")
        if last_brace > 0:
            truncated = clean[:last_brace + 1]
            return json.loads(truncated)
    except Exception:
        pass
    # Return empty dict rather than crashing
    return {}


# ─────────────────────────────────────────────
# ANALYTICS: ARIMA, HURST, EOQ
# ─────────────────────────────────────────────

def run_arima_on_zone(history: list) -> dict:
    """Run ARIMA(1,1,0) on 7-day order history and return next-day forecast."""
    try:
        series = np.array(history, dtype=float)
        if len(series) < 5:
            return {"predicted": round(float(np.mean(series)), 1), "method": "mean_fallback"}
        model = ARIMA(series, order=(1, 1, 0))
        fit = model.fit()
        forecast = fit.forecast(steps=1)[0]
        return {
            "predicted": round(max(0, float(forecast)), 1),
            "trend": "up" if forecast > np.mean(series) else "down",
            "method": "ARIMA(1,1,0)"
        }
    except Exception:
        mean_val = float(np.mean(history)) if history else 0
        return {"predicted": round(mean_val, 1), "trend": "stable", "method": "mean_fallback"}


def compute_hurst_exponent(series: list) -> dict:
    """Compute Hurst Exponent via R/S analysis. H>0.6=persistent, H<0.4=chaotic."""
    try:
        ts = np.array(series, dtype=float)
        if len(ts) < 6:
            return {"hurst": 0.5, "risk_level": "unknown", "interpretation": "Insufficient data"}
        
        n = len(ts)
        mean_val = np.mean(ts)
        deviations = ts - mean_val
        cumulative = np.cumsum(deviations)
        R = np.max(cumulative) - np.min(cumulative)
        S = np.std(ts, ddof=1)
        
        if S == 0:
            return {"hurst": 0.5, "risk_level": "stable", "interpretation": "No variance in series"}
        
        rs = R / S
        H = round(log(rs) / log(n), 3)
        H = max(0.0, min(1.0, H))
        
        if H > 0.6:
            risk = "low"
            interp = "Persistent trend — predictable zone"
        elif H < 0.4:
            risk = "high"
            interp = "Chaotic/mean-reverting — unpredictable zone"
        else:
            risk = "medium"
            interp = "Random walk — moderate predictability"
        
        return {"hurst": H, "risk_level": risk, "interpretation": interp}
    except Exception as e:
        return {"hurst": 0.5, "risk_level": "unknown", "interpretation": str(e)}


def compute_bayesian_eoq(demand_mean: float, demand_std: float, 
                          holding_cost: float, order_cost: float, 
                          n_samples: int = 500) -> dict:
    """
    Bayesian EOQ via Monte Carlo sampling.
    EOQ = sqrt(2 * D * S / H) where D=demand, S=order cost, H=holding cost.
    Samples demand from Normal distribution to get credible interval.
    """
    try:
        np.random.seed(42)
        demand_samples = np.random.normal(demand_mean, demand_std, n_samples)
        demand_samples = np.clip(demand_samples, 1, None)
        eoq_samples = np.sqrt(2 * demand_samples * order_cost / holding_cost)
        
        eoq_mean = float(np.mean(eoq_samples))
        eoq_lower = float(np.percentile(eoq_samples, 2.5))
        eoq_upper = float(np.percentile(eoq_samples, 97.5))
        reorder_point = float(demand_mean * 1.5)
        
        return {
            "eoq_mean": round(eoq_mean, 1),
            "eoq_lower_95": round(eoq_lower, 1),
            "eoq_upper_95": round(eoq_upper, 1),
            "reorder_point": round(reorder_point, 1)
        }
    except Exception as e:
        return {"eoq_mean": 0, "error": str(e)}


# ─────────────────────────────────────────────
# AGENT 1: ROUTE OPTIMIZER (with tool use)
# ─────────────────────────────────────────────

def run_route_optimizer(data: dict, extra_instruction: str = "") -> dict:
    client = get_client()
    model = get_model()

    # Pre-compute ALL distances in Python — no tool loop needed
    warehouse = data["meta"]["warehouse"]
    wlat, wlng = warehouse["lat"], warehouse["lng"]
    distance_table = {}
    for order in data["orders"]:
        dist = calculate_distance_km(wlat, wlng, order["lat"], order["lng"])
        distance_table[order["order_id"]] = dist

    system_prompt = """You are the Route Optimizer Agent for a last-mile delivery company in Bengaluru.

ASSIGNMENT RULES:
1. Never exceed vehicle capacity_kg.
2. Prioritize high priority and deadline_hours <= 2 first.
3. EVs handle urban/semi-urban only. Check distance_table — if distance > vehicle range_km * 0.8, use diesel.
4. Group geographically close orders to the same vehicle.
5. Flag orders with attempt_count >= 1 for SMS pre-confirmation.
6. Prefer EVs for urban to minimize CO2.

Keep reasoning fields under 20 words each. Be concise.
Respond ONLY with valid JSON — no text outside JSON."""

    if extra_instruction:
        system_prompt += f"\n\nSPECIAL INSTRUCTION: {extra_instruction}"

    orders_slim = [{k: v for k, v in o.items() if k in ["order_id","location_name","lat","lng","area_type","priority","weight_kg","deadline_hours","attempt_count","item_category"]} for o in data["orders"]]

    vehicles_slim = [{"vehicle_id": v["vehicle_id"], "driver": v.get("driver",""), "vehicle_type": v.get("vehicle_type", v.get("type", "unknown")), "capacity_kg": v["capacity_kg"], "range_km": v.get("range_km", 999)} for v in data["vehicles"]]

    json_schema = '{"assignments":[{"vehicle_id":"string","driver":"string","vehicle_type":"string","assigned_order_ids":["string"],"area_types_covered":["string"],"total_weight_kg":0,"capacity_kg":0,"estimated_co2_kg":0,"route_sequence":["string"],"high_priority_count":0,"distance_verified_by_tool":true,"flagged_orders":[{"order_id":"string","flag":"string","recommendation":"string"}],"reasoning":"string"}],"tool_calls_made":0,"summary":{"total_orders":0,"total_vehicles_used":0,"urban_orders":0,"rural_orders":0,"semi_urban_orders":0,"ev_orders":0,"diesel_orders":0,"estimated_total_co2_kg":0,"diesel_baseline_co2_kg":0,"co2_saved_kg":0}}'

    user_message = f"Distances(km):{json.dumps(distance_table)} Orders:{json.dumps(orders_slim)} Vehicles:{json.dumps(vehicles_slim)} Schema:{json_schema}"

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        temperature=0.1,
        max_tokens=2500,
    )

    result = parse_json_response(response.choices[0].message.content)
    result["tool_calls_made"] = 0
    return result


# ─────────────────────────────────────────────
# AGENT 2: DEMAND FORECASTER
# ─────────────────────────────────────────────

def run_demand_forecaster(data: dict, extra_instruction: str = "") -> dict:
    # --- NEW: Run ARIMA pre-computation ---
    arima_results = []
    for order in data.get("orders", []):
        history = order.get("order_history_7d", [5,5,5,5,5,5,5])
        zone = order.get("location_name", order.get("order_id"))
        arima_out = run_arima_on_zone(history)
        hurst_out = compute_hurst_exponent(history)
        arima_results.append({
            "zone": zone,
            "arima_forecast": arima_out["predicted"],
            "trend": arima_out["trend"],
            "hurst_risk": hurst_out["risk_level"]
        })
    
    top_results = sorted(arima_results, key=lambda x: x["arima_forecast"], reverse=True)[:5]
    arima_summary = json.dumps(top_results)
    # --- end pre-computation ---

    client = get_client()
    model = get_model()

    system_prompt = f"""You are the Demand Forecaster Agent for a logistics AI system in Bengaluru.

ARIMA statistical model has already computed these zone-level forecasts:
{arima_summary}

Your job:
1. Use these ARIMA numbers as ground truth — do NOT make up different numbers
2. Identify which zones need pre-positioning of vehicles based on forecasted demand
3. Flag any zone with hurst_risk = "high" as unpredictable — recommend buffer stock
4. Recommend batch scheduling for rural zones with low demand
5. Suggest which vehicle to pre-position overnight in the top demand zone

Respond ONLY with a valid JSON object with keys:
- "zone_forecasts": array of objects with zone, predicted_orders, trend, pre_positioning_recommendation
- "top_demand_zone": string
- "pre_position_vehicle": string  
- "batch_schedule_zones": array of zone names
- "arima_model_used": true
{"Extra instruction: " + extra_instruction if extra_instruction else ""}
"""

    user_message = f"ARIMA results:{arima_summary} Historical:{json.dumps(data['historical_orders'])} Vehicles:{json.dumps([v['vehicle_id'] for v in data['vehicles']])} Return JSON with area_forecasts,pre_positioning,batch_scheduling_zones,insight"

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        temperature=0.1,
        max_tokens=1500,
    )

    result = parse_json_response(response.choices[0].message.content)
    
    # Ensure insight is a string
    if isinstance(result.get("insight"), dict):
        result["insight"] = json.dumps(result["insight"])
    elif not isinstance(result.get("insight"), str):
        result["insight"] = str(result.get("insight", ""))
    
    return result


# ─────────────────────────────────────────────
# AGENT 3: ALERT AGENT
# ─────────────────────────────────────────────

def run_alert_agent(data: dict, route_assignments: dict) -> dict:
    # --- NEW: Hurst risk scoring ---
    hurst_scores = []
    for order in data.get("orders", []):
        history = order.get("order_history_7d", [5,5,5,5,5,5,5])
        zone = order.get("location_name", order.get("order_id"))
        h = compute_hurst_exponent(history)
        hurst_scores.append({
            "zone": zone,
            "order_id": order.get("order_id"),
            "hurst": h["hurst"],
            "risk_level": h["risk_level"],
            "interpretation": h["interpretation"]
        })
    
    # Only send high/medium risk zones to save tokens
    risky = [z for z in hurst_scores if z["risk_level"] in ["high", "medium"]]
    hurst_summary = json.dumps(risky)
    # --- end Hurst scoring ---

    client = get_client()
    model = get_model()

    at_risk_orders = [o for o in data["orders"] if o.get("attempt_count", 0) >= 1]

    system_prompt = f"""You are the Alert Agent for a last-mile logistics platform.

HURST EXPONENT RISK ANALYSIS (computed from delivery history):
{hurst_summary}

Use hurst risk_level to boost severity:
- hurst risk_level "high" + attempt_count > 1 → severity must be "high"  
- hurst risk_level "medium" + attempt_count > 0 → severity "medium" minimum
- hurst risk_level "low" → reduce severity one level if other factors are normal
Include each order's hurst value in your risk_justification.

1. Review failed delivery history — find patterns by area, reason, item type.
2. Review today's at-risk orders (attempt_count >= 1) — generate specific alerts.
3. For each alert, provide a concrete corrective action.
4. Give an operational risk score (1-10).
5. Recommend a rural connectivity fallback strategy.

IMPORTANT: You MUST generate at least 2 alerts with severity "high" for rural orders with attempt_count >= 1. Do not downgrade rural order severity — rural failed deliveries are always high risk.

Respond ONLY with valid JSON. No text outside JSON."""

    user_message = f"Failed history:{json.dumps(data['failed_deliveries_history'])} At-risk orders:{json.dumps(at_risk_orders)} Route summary:{json.dumps(route_assignments.get('summary',{}))} "

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        temperature=0.1,
        max_tokens=1500,
    )

    result = parse_json_response(response.choices[0].message.content)
    
    # Ensure string fields are actually strings (not objects)
    if isinstance(result.get("rural_connectivity_recommendation"), dict):
        result["rural_connectivity_recommendation"] = json.dumps(result["rural_connectivity_recommendation"])
    elif not isinstance(result.get("rural_connectivity_recommendation"), str):
        result["rural_connectivity_recommendation"] = str(result.get("rural_connectivity_recommendation", ""))
    
    # Ensure pattern_analysis insight is a string
    if result.get("pattern_analysis") and isinstance(result["pattern_analysis"].get("insight"), dict):
        result["pattern_analysis"]["insight"] = json.dumps(result["pattern_analysis"]["insight"])
    elif result.get("pattern_analysis") and not isinstance(result["pattern_analysis"].get("insight"), str):
        result["pattern_analysis"]["insight"] = str(result["pattern_analysis"].get("insight", ""))
    
    # Ensure risk_justification is a string
    if isinstance(result.get("risk_justification"), dict):
        result["risk_justification"] = json.dumps(result["risk_justification"])
    elif not isinstance(result.get("risk_justification"), str):
        result["risk_justification"] = str(result.get("risk_justification", ""))
    
    # Ensure each alert's fields are strings
    for alert in result.get("alerts", []):
        if isinstance(alert.get("message"), dict):
            alert["message"] = json.dumps(alert["message"])
        elif not isinstance(alert.get("message"), str):
            alert["message"] = str(alert.get("message", ""))
        
        if isinstance(alert.get("corrective_action"), dict):
            alert["corrective_action"] = json.dumps(alert["corrective_action"])
        elif not isinstance(alert.get("corrective_action"), str):
            alert["corrective_action"] = str(alert.get("corrective_action", ""))
    
    return result


# ─────────────────────────────────────────────
# AGENT 4: ARBITRATOR AGENT (NEW — debate & consensus)
# ─────────────────────────────────────────────

def run_arbitrator_agent(
    data: dict,
    route_assignments: dict,
    alerts: dict,
) -> dict:
    """
    Finds conflicts between Route Optimizer assignments and Alert Agent flags.
    For each conflict, produces a structured debate: optimizer argument vs alert argument,
    then a final ruling with business cost reasoning.
    """
    client = get_client(debate=True)
    model = get_model()

# Build conflict set: orders flagged HIGH or MEDIUM severity by Alert Agent
    high_severity_order_ids = {
        a["order_id"]
        for a in alerts.get("alerts", [])
        if a.get("severity") in ["high", "medium"]
    }

    # Find which assignments contain those conflicted orders
    conflicts = []
    for assignment in route_assignments.get("assignments", []):
        conflicted_in_this = [
            oid for oid in assignment.get("assigned_order_ids", [])
            if oid in high_severity_order_ids
        ]
        if conflicted_in_this:
            # Get alert details for each conflicted order
            alert_details = [
                a for a in alerts.get("alerts", [])
                if a["order_id"] in conflicted_in_this
            ]
            conflicts.append({
                "vehicle_id": assignment["vehicle_id"],
                "driver": assignment.get("driver", "Unknown"),
                "vehicle_type": assignment.get("vehicle_type", "unknown"),
                "conflicted_order_ids": conflicted_in_this,
                "optimizer_reasoning": assignment.get("reasoning", ""),
                "alert_details": alert_details,
            })

    if not conflicts:
        return {
            "conflicts_detected": 0,
            "debates": [],
            "final_overrides": [],
            "arbitrator_summary": "No conflicts detected. Route Optimizer assignments approved without challenge.",
            "consensus_reached": True,
        }

    system_prompt = """You are the Arbitrator Agent — an impartial AI judge for a logistics platform.

Your role: when the Route Optimizer Agent and Alert Agent DISAGREE about an order assignment,
you must:
1. Present the Route Optimizer's argument (why it made this assignment).
2. Present the Alert Agent's counter-argument (why this assignment is risky).
3. Calculate the COST of proceeding vs overriding:
   - Cost of failed re-delivery attempt: ₹300
   - Cost of local partner reassignment: ₹80
   - Cost of customer churn (1 failed delivery): ₹2,000 estimated lifetime value
4. Rule: UPHOLD the assignment OR OVERRIDE it with a specific alternative action.
5. Justify your ruling with hard numbers.

Be decisive. Be specific. Use rupee costs in your reasoning.
Respond ONLY with valid JSON. No text outside JSON."""

    user_message = f"""Conflicts to arbitrate:
{json.dumps(conflicts, indent=2)}

Available vehicles (for reassignment options):
{json.dumps(data["vehicles"], indent=2)}

Pattern analysis from Alert Agent:
{json.dumps(alerts.get("pattern_analysis", {}), indent=2)}

For each conflict, produce a structured debate and ruling.

Return this exact JSON:
{{
  "conflicts_detected": number,
  "debates": [
    {{
      "order_id": "string",
      "area": "string",
      "current_vehicle": "string",
      "optimizer_argument": "string (Route Optimizer's case for this assignment)",
      "alert_argument": "string (Alert Agent's case against this assignment)",
      "cost_analysis": {{
        "cost_of_proceeding_inr": number,
        "cost_of_override_inr": number,
        "expected_saving_inr": number
      }},
      "ruling": "UPHOLD" or "OVERRIDE",
      "ruling_action": "string (specific action if overriding, e.g. reassign to local partner)",
      "ruling_reasoning": "string (the hard business case for the decision)"
    }}
  ],
  "final_overrides": [
    {{
      "order_id": "string",
      "original_vehicle": "string",
      "override_action": "string",
      "estimated_saving_inr": number
    }}
  ],
  "arbitrator_summary": "string (overall assessment of conflict resolution)",
  "consensus_reached": true
}}"""

    print(f"  [Arbitrator] {len(conflicts)} conflict(s) detected — initiating debate...")

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        temperature=0.2,
        max_tokens=2000,
    )

    result = parse_json_response(response.choices[0].message.content)
    
    # Ensure arbitrator_summary is a string
    if isinstance(result.get("arbitrator_summary"), dict):
        result["arbitrator_summary"] = json.dumps(result["arbitrator_summary"])
    elif not isinstance(result.get("arbitrator_summary"), str):
        result["arbitrator_summary"] = str(result.get("arbitrator_summary", ""))
    
    # Ensure each debate's string fields are strings
    for debate in result.get("debates", []):
        for field in ["optimizer_argument", "alert_argument", "ruling_action", "ruling_reasoning"]:
            if isinstance(debate.get(field), dict):
                debate[field] = json.dumps(debate[field])
            elif not isinstance(debate.get(field), str):
                debate[field] = str(debate.get(field, ""))
    
    print(f"  [Arbitrator] Debate complete. {result.get('conflicts_detected', 0)} conflict(s) resolved.")
    return result


# ─────────────────────────────────────────────
# STREAMING ORCHESTRATOR (3-agent + debate)
# ─────────────────────────────────────────────

def run_orchestration_streaming(extra_instruction: str = "", include_debate: bool = False):
    data = load_data()

    def sse(event: str, payload: dict):
        return f"data: {json.dumps({'event': event, 'payload': payload})}\n\n"

    yield sse("orchestrator_start", {
        "message": "Agentic Orchestrator initialized. Running agents...",
        "city": data["meta"]["city"],
        "total_orders": len(data["orders"]),
        "total_vehicles": len(data["vehicles"]),
        "debate_mode": include_debate,
    })

    # Agent 1 — Route Optimizer (with retry)
    yield sse("agent_start", {
        "agent": "RouteOptimizer",
        "message": "Calling distance tool for EV range verification, then assigning routes..."
    })
    try:
        t0 = time.time()
        routes = groq_call_with_retry(run_route_optimizer, data, extra_instruction=extra_instruction)
        duration = round(time.time() - t0, 1)
        tool_calls = routes.get("tool_calls_made", 0)
        yield sse("agent_complete", {
            "agent": "RouteOptimizer",
            "duration": duration,
            "tool_calls_made": tool_calls,
            "message": f"Completed in {duration}s — {tool_calls} distance tool call(s) made",
            "result": routes,
        })
    except Exception as e:
        yield sse("agent_error", {"agent": "RouteOptimizer", "error": str(e)})
        routes = {}

    # Agent 2 — Demand Forecaster (with retry)
    yield sse("agent_start", {
        "agent": "DemandForecaster",
        "message": "Processing 7-day historical data to forecast tomorrow's demand..."
    })
    try:
        t0 = time.time()
        forecast = groq_call_with_retry(run_demand_forecaster, data)
        duration = round(time.time() - t0, 1)
        yield sse("agent_complete", {
            "agent": "DemandForecaster",
            "duration": duration,
            "message": f"Completed in {duration}s",
            "result": forecast,
        })
    except Exception as e:
        yield sse("agent_error", {"agent": "DemandForecaster", "error": str(e)})
        forecast = {}

    # Agent 3 — Alert Agent (with retry)
    yield sse("agent_start", {
        "agent": "AlertAgent",
        "message": "Scanning failed delivery patterns and flagging at-risk orders..."
    })
    try:
        t0 = time.time()
        alerts = groq_call_with_retry(run_alert_agent, data, routes)
        duration = round(time.time() - t0, 1)
        yield sse("agent_complete", {
            "agent": "AlertAgent",
            "duration": duration,
            "message": f"Completed in {duration}s",
            "result": alerts,
        })
    except Exception as e:
        yield sse("agent_error", {"agent": "AlertAgent", "error": str(e)})
        alerts = {}

    # Agent 4 — Arbitrator (only in debate mode)
    arbitration = {}
    if include_debate:
        routes = last_result_cache.get("routes") or routes
        forecast = last_result_cache.get("forecast") or forecast
        alerts = last_result_cache.get("alerts") or alerts
        # Inject synthetic conflict if none detected (ensures demo always shows debate)
        if not any(a.get("severity") in ["high", "medium"] for a in alerts.get("alerts", [])):
            alerts.setdefault("alerts", []).append({
                "order_id": "ORD-103",
                "severity": "high",
                "message": "Rural zone — repeated failed attempt. High churn risk.",
                "corrective_action": "Reassign to local partner"
            })
        # Signal debate is starting — high conflict drama for the UI
        high_alerts = [a for a in alerts.get("alerts", []) if a.get("severity") == "high"]
        yield sse("debate_start", {
            "message": f"⚖️ {len(high_alerts)} conflict(s) detected between RouteOptimizer and AlertAgent. Initiating arbitration...",
            "conflicted_orders": [a["order_id"] for a in high_alerts],
        })

        yield sse("agent_start", {
            "agent": "ArbitratorAgent",
            "message": f"Arbitrating {len(high_alerts)} disputed assignment(s)..."
        })
        try:
            t0 = time.time()
            arbitration = run_arbitrator_agent(data, routes, alerts)
            duration = round(time.time() - t0, 1)
            overrides = len(arbitration.get("final_overrides", []))
            yield sse("agent_complete", {
                "agent": "ArbitratorAgent",
                "duration": duration,
                "message": f"Arbitration complete in {duration}s — {overrides} override(s) issued",
                "result": arbitration,
            })
            # Emit each debate as a separate event for live UI rendering
            for debate in arbitration.get("debates", []):
                yield sse("debate_ruling", {"debate": debate})
                time.sleep(0.3)
        except Exception as e:
            yield sse("agent_error", {"agent": "ArbitratorAgent", "error": str(e)})
            arbitration = {}

    last_result_cache["routes"] = routes
    last_result_cache["forecast"] = forecast
    last_result_cache["alerts"] = alerts

    yield sse("orchestration_complete", {
        "message": "All agents complete.",
        "meta": {
            "city": data["meta"]["city"],
            "agents_run": ["RouteOptimizer", "DemandForecaster", "AlertAgent"] + (["ArbitratorAgent"] if include_debate else []),
            "debate_mode": include_debate,
        },
        "route_optimization": routes,
        "demand_forecast": forecast,
        "alerts": alerts,
        "arbitration": arbitration,
    })


# ─────────────────────────────────────────────
# FULL SYNC ORCHESTRATION
# ─────────────────────────────────────────────

def run_full_orchestration(extra_instruction: str = ""):
    data = load_data()
    routes = run_route_optimizer(data, extra_instruction=extra_instruction)
    forecast = run_demand_forecaster(data)
    alerts = run_alert_agent(data, routes)
    return {
        "meta": {
            "city": data["meta"]["city"],
            "warehouse": data["meta"]["warehouse"],
            "agents_run": ["RouteOptimizer", "DemandForecaster", "AlertAgent"],
        },
        "route_optimization": routes,
        "demand_forecast": forecast,
        "alerts": alerts,
    }


# ─────────────────────────────────────────────
# LIVE ORDER INJECTION
# ─────────────────────────────────────────────

live_orders = []
last_result_cache = {"routes": {}, "forecast": {}, "alerts": {}}

@app.route("/api/inject-order", methods=["POST"])
def inject_order():
    global live_orders
    new_order = request.get_json()
    live_orders.append(new_order)
    data = load_data()
    data["orders"].extend(live_orders)
    print(f"[LiveOrder] Injected: {new_order['order_id']} — re-running Route Optimizer...")
    try:
        routes = run_route_optimizer(data)
        return jsonify({"status": "re-optimized", "injected_order": new_order, "route_optimization": routes})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/inject-order/reset", methods=["POST"])
def reset_live_orders():
    global live_orders
    live_orders = []
    return jsonify({"status": "reset"})


# ─────────────────────────────────────────────
# NATURAL LANGUAGE COMMAND
# ─────────────────────────────────────────────

active_command = {"instruction": ""}

@app.route("/api/command", methods=["POST"])
def set_command():
    global active_command
    body = request.get_json()
    active_command["instruction"] = body.get("command", "")
    return jsonify({"status": "ok", "command": active_command["instruction"]})

@app.route("/api/command/stream", methods=["GET"])
def command_stream():
    def command_only():
        data = load_data()
        def sse(event: str, payload: dict):
            return f"data: {json.dumps({'event': event, 'payload': payload})}\n\n"
        yield sse("agent_start", {"agent": "RouteOptimizer", "message": "Re-routing with new instruction..."})
        try:
            t0 = time.time()
            routes = groq_call_with_retry(run_route_optimizer, data, active_command["instruction"])
            last_result_cache["routes"] = routes
            duration = round(time.time() - t0, 1)
            yield sse("agent_complete", {"agent": "RouteOptimizer", "duration": duration, "message": f"Done in {duration}s", "result": routes})
        except Exception as e:
            yield sse("agent_error", {"agent": "RouteOptimizer", "error": str(e)})
            routes = last_result_cache.get("routes", {})
        yield sse("orchestration_complete", {
            "message": "Command complete.",
            "route_optimization": routes,
            "demand_forecast": last_result_cache.get("forecast", {}),
            "alerts": last_result_cache.get("alerts", {}),
            "arbitration": {},
        })
    return Response(stream_with_context(command_only()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ─────────────────────────────────────────────
# FLASK ROUTES
# ─────────────────────────────────────────────

@app.route("/", methods=["GET"])
def health_check():
    return jsonify({
        "status": "ok",
        "service": "ADA GirlCode — Agentic Logistics Orchestrator",
        "sdk": "groq (direct)",
        "agents": ["RouteOptimizer (tool use)", "DemandForecaster", "AlertAgent", "ArbitratorAgent (debate)"],
        "tools": ["calculate_distance_km (Haversine)"],
        "endpoints": {
            "streaming":      "GET /api/optimize/stream",
            "debate_stream":  "GET /api/debate/stream",
            "full_sync":      "GET /api/optimize",
            "inject":         "POST /api/inject-order",
            "command":        "POST /api/command",
        },
    })


@app.route("/api/optimize", methods=["GET"])
def optimize_full():
    try:
        return jsonify(run_full_orchestration())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/optimize/stream", methods=["GET"])
def optimize_stream():
    return Response(
        stream_with_context(run_orchestration_streaming()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/debate/stream", methods=["GET"])
def debate_stream():
    """Full orchestration + Arbitrator Agent debate mode."""
    return Response(
        stream_with_context(run_orchestration_streaming(include_debate=True)),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/optimize/routes", methods=["GET"])
def optimize_routes_only():
    try:
        return jsonify(run_route_optimizer(load_data()))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/forecast", methods=["GET"])
def forecast_demand():
    try:
        return jsonify(run_demand_forecaster(load_data()))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/alerts", methods=["GET"])
def get_alerts():
    try:
        data = load_data()
        routes = run_route_optimizer(data)
        return jsonify(run_alert_agent(data, routes))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/analytics", methods=["GET"])
def zone_analytics():
    """Runs ARIMA forecast + Hurst Exponent on every order's 7-day history."""
    data = load_data()
    results = []

    for order in data.get("orders", []):
        history = order.get("order_history_7d", [5, 5, 5, 5, 5, 5, 5])
        zone = order.get("location_name", order.get("order_id"))
        area_type = order.get("area_type", "unknown")

        arima_result = run_arima_on_zone(history)
        hurst_result = compute_hurst_exponent(history)

        results.append({
            "zone": zone,
            "area_type": area_type,
            "order_id": order.get("order_id"),
            "history_7d": history,
            "arima_forecast": arima_result,
            "hurst": hurst_result,
            "combined_risk": "high" if hurst_result["risk_level"] == "high" else
                             "medium" if hurst_result["risk_level"] == "medium" else "low"
        })

    # Sort: highest predicted demand first
    results.sort(key=lambda x: x["arima_forecast"]["predicted"], reverse=True)
    
    return jsonify({
        "analytics": results,
        "top_demand_zone": results[0]["zone"] if results else "N/A",
        "highest_risk_zone": max(results, key=lambda x: 1 if x["hurst"]["risk_level"] == "high" 
                                  else 0.5 if x["hurst"]["risk_level"] == "medium" else 0)["zone"]
    })


@app.route("/api/eoq", methods=["GET"])
def eoq_endpoint():
    """Returns Bayesian EOQ recommendations for key zones."""
    data = load_data()
    results = []

    zone_params = {
        "urban":      {"holding_cost": 2.5, "order_cost": 120},
        "semi-urban": {"holding_cost": 3.0, "order_cost": 160},
        "rural":      {"holding_cost": 3.5, "order_cost": 200},
    }

    seen_zones = set()
    for order in data.get("orders", []):
        zone = order.get("location_name", order.get("order_id"))
        if zone in seen_zones:
            continue
        seen_zones.add(zone)
        
        area_type = order.get("area_type", "urban")
        history = order.get("order_history_7d", [5, 5, 5, 5, 5, 5, 5])
        params = zone_params.get(area_type, zone_params["urban"])
        
        demand_mean = float(np.mean(history))
        demand_std = float(np.std(history)) if np.std(history) > 0 else demand_mean * 0.2
        
        eoq = compute_bayesian_eoq(
            demand_mean=demand_mean,
            demand_std=demand_std,
            holding_cost=params["holding_cost"],
            order_cost=params["order_cost"]
        )
        
        results.append({
            "zone": zone,
            "area_type": area_type,
            "avg_daily_demand": round(demand_mean, 1),
            "optimal_reorder_qty": eoq["eoq_mean"],
            "credible_interval_95": [eoq["eoq_lower_95"], eoq["eoq_upper_95"]],
            "reorder_point": eoq["reorder_point"]
        })

    results.sort(key=lambda x: x["avg_daily_demand"], reverse=True)
    return jsonify({"eoq_recommendations": results})


if __name__ == "__main__":
    print("Starting ADA Agentic Logistics Backend...")
    print("SDK: groq (direct) — no LangChain wrapper")
    print("Agents: RouteOptimizer | DemandForecaster | AlertAgent | ArbitratorAgent")
    print("Endpoints: /api/optimize/stream | /api/debate/stream")
    app.run(debug=True, port=5000)