#!/usr/bin/env python3
"""Synthetic US purchase-mortgage compute calculator.

Standard library only. Reads mortgage_scenarios.json from this directory and
writes mortgage-compute-*.json/csv/md next to it. It makes no network calls
and no model calls. Every count it multiplies is an assumption declared in the
scenario file; nothing here is measured or calibrated.

Run:   python3 mortgage_compute.py
Exit:  0 if every consistency and hand-count check passes, 1 otherwise.
       Outputs are written either way so a discrepancy can be inspected.

Counting rules (see MORTGAGE-COMPUTE-STUDY.md, section 3):
  * A model request is one inference call. One response may choose a tool,
    write its arguments and emit a batch of actions; the result is read by the
    next request. Requests are never inferred one-per-click.
  * Browser unit:  requests = plan + ceil(ui / b);   observations = ceil(ui / b)
  * Connector unit: requests = plan + ceil(calls / k); model-free polls make none
  * C unit:        requests = residual LLM requests only; routine ops are code
  * Retries (expected values): each failed action gets exactly one repair
    attempt, assumed to succeed. A failed UI action or model-orchestrated call
    costs one extra action and one extra request; a C op retries in code.
    This is not geometric retry-until-success; abandoned tasks are not costed.
  * parallel_critical_path_s is a conditional scheduling estimate, not an
    optimal DAG critical path: stages run in order, a mixed B stage runs its
    connector group then its browser group, and units inside a group run up
    to parallel_width at a time. Background monitoring is excluded.

All scenario and sensitivity inputs are validated before anything is computed;
invalid inputs stop the run with exit status 1 and no result files.
"""

import copy
import csv
import json
import math
import os
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
SCENARIO_FILE = os.path.join(HERE, "mortgage_scenarios.json")
ARCHES = ("A_step", "A_batch", "B", "C")
FAMILY = {"A_step": "A", "A_batch": "A", "B": "B", "C": "C"}
MAIN_SCENARIOS = ("lean", "central", "friction")
PROVIDERS = ("gpt_6_astra_standard", "claude_opus_5_5_standard")
EPS = 1e-6

STAGE_KEYS = (
    "agent_requests", "reviewer_requests", "env_turns", "tool_invocations",
    "browser_actions", "api_calls", "c_external_ops", "c_local_ops",
    "external_requests", "agent_input_tokens", "agent_output_tokens",
    "reviewer_input_tokens", "reviewer_output_tokens", "document_tokens",
    "model_busy_s", "tool_busy_s", "serial_s", "critical_path_s",
    "consequential_actions", "named_checkpoints", "human_interventions",
    "outbound_human_messages",
)


class Checks:
    def __init__(self):
        self.items = []

    def add(self, name, ok, detail=""):
        self.items.append(OrderedDict([("check", name), ("ok", bool(ok)), ("detail", detail)]))

    def failed(self):
        return [c for c in self.items if not c["ok"]]


# ---------------------------------------------------------------- config ---

def load_config():
    with open(SCENARIO_FILE, "r", encoding="utf-8") as fh:
        return json.load(fh)


def merged(base, override):
    out = copy.deepcopy(base)
    for key, val in override.items():
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = merged(out[key], val)
        else:
            out[key] = copy.deepcopy(val)
    return out


def multiplicity(stage, scen):
    m = stage["multiplicity"]
    return scen["counts"][m] if isinstance(m, str) else m


def variant(stage, scen):
    """Stage spec with the warm/cold authentication variant resolved."""
    if "variants" not in stage:
        return stage
    spec = {k: v for k, v in stage.items() if k != "variants"}
    spec.update(stage["variants"][scen["auth_mode"]])
    return spec


def b_api_units(stage_id, bspec, scen, m):
    """Units an existing connector handles in B; the rest use the batched browser."""
    table = scen.get("b_api_units", {})
    if "*" in table:
        val = table["*"]
    elif stage_id in table:
        val = table[stage_id]
    else:
        val = bspec.get("api_units", "all")
    n = m if val == "all" else int(val)
    if not 0 <= n <= m:
        raise ValueError("B api_units for %s must be within 0..%d, got %d" % (stage_id, m, n))
    return n


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def is_count(x):
    return isinstance(x, int) and not isinstance(x, bool) and x >= 0


def validate_config(cfg, checks):
    problems = []
    ids = [s["id"] for s in cfg["stages"]]
    if len(ids) != len(set(ids)):
        problems.append("duplicate stage ids")
    for stage in cfg["stages"]:
        sid = stage["id"]
        m = stage["multiplicity"]
        if not (isinstance(m, str) or is_count(m)):
            problems.append("%s: multiplicity must be a non-negative integer or a count name" % sid)
        for key in ("consequential_per_unit", "human_checkpoints_per_unit", "outbound_human_messages_per_unit"):
            if key in stage and not is_count(stage[key]):
                problems.append("%s.%s must be a non-negative integer" % (sid, key))
        for fam, v in stage.get("doc_tokens", {}).items():
            if not is_num(v) or v < 0:
                problems.append("%s.doc_tokens.%s must be finite and non-negative" % (sid, fam))
        specs = list(stage["variants"].values()) if "variants" in stage else [stage]
        for spec in specs:
            for part, keys in (("A", ("ui", "pages", "plan")),
                               ("B", ("calls", "ext", "plan")),
                               ("C", ("ops", "ext", "llm", "env"))):
                for k in keys:
                    v = spec.get(part, {}).get(k)
                    if not is_num(v) or v < 0:
                        problems.append("%s.%s.%s must be finite and non-negative, got %r" % (sid, part, k, v))
            if is_num(spec["C"].get("ext")) and is_num(spec["C"].get("ops")) and spec["C"]["ext"] > spec["C"]["ops"]:
                problems.append("%s: C external ops exceed total ops" % sid)
    for name, price in cfg["prices_usd_per_million_tokens"].items():
        for k in ("input", "cache_read", "cache_write", "output"):
            if not is_num(price.get(k)) or price[k] < 0:
                problems.append("price %s.%s must be finite and non-negative" % (name, k))
    checks.add("config: stages, counts and prices well formed for A, B and C", not problems,
               "; ".join(problems) or "%d stages" % len(ids))


VALID_REVIEWER_MODES = ("none", "per_consequential_action", "per_model_request")


def validate_scenario(cfg, scen):
    """Return input problems for one (possibly merged) scenario; empty means computable."""
    p = []

    def nonneg(path, x):
        if not is_num(x) or x < 0:
            p.append("%s must be a finite non-negative number, got %r" % (path, x))

    for key in ("batch_actions_per_request", "b_tool_calls_per_request", "parallel_width"):
        x = scen.get(key)
        if not is_count(x) or x < 1:
            p.append("%s must be a positive integer, got %r" % (key, x))
    for key in ("retry_rate_ui", "retry_rate_api"):
        x = scen.get(key)
        if not is_num(x) or not 0 <= x <= 1:
            p.append("%s must be a fraction in [0, 1], got %r" % (key, x))
    nonneg("output_multiplier", scen.get("output_multiplier", 1.0))
    if scen.get("reviewer_mode") not in VALID_REVIEWER_MODES:
        p.append("reviewer_mode must be one of %s" % (VALID_REVIEWER_MODES,))
    for stage in cfg["stages"]:
        if "variants" in stage and scen.get("auth_mode") not in stage["variants"]:
            p.append("auth_mode must be one of %s" % sorted(stage["variants"]))
        if isinstance(stage["multiplicity"], str) and stage["multiplicity"] not in scen.get("counts", {}):
            p.append("counts.%s missing" % stage["multiplicity"])
    if not isinstance(scen.get("c_structured_disclosures"), bool):
        p.append("c_structured_disclosures must be true or false")
    for k, v in scen.get("counts", {}).items():
        if not is_count(v):
            p.append("counts.%s must be a non-negative integer, got %r" % (k, v))
    for k, v in scen.get("b_api_units", {}).items():
        if v != "all" and not is_count(v):
            p.append("b_api_units.%s must be 'all' or a non-negative integer, got %r" % (k, v))
    tok = scen.get("tokens", {})
    for route in ARCHES:
        for k in ("input", "output"):
            nonneg("tokens.%s.%s" % (route, k), tok.get(route, {}).get(k))
    for fam in ("A", "B", "C"):
        for k in ("input", "output"):
            nonneg("tokens.reviewer.%s.%s" % (fam, k), tok.get("reviewer", {}).get(fam, {}).get(k))
        c = scen.get("cache", {}).get(fam, {})
        r, w = c.get("read"), c.get("write")
        nonneg("cache.%s.read" % fam, r)
        nonneg("cache.%s.write" % fam, w)
        if is_num(r) and is_num(w):
            if r + w > 1 + EPS:
                p.append("cache.%s read + write = %r exceeds 1" % (fam, r + w))
            if r > 0 and w <= 0:
                p.append("cache.%s reads tokens that are never written" % fam)
    lat = scen.get("latency", {})
    for k in ("ttft_s", "decode_tokens_per_s", "browser_action_s", "api_call_s", "local_op_s"):
        nonneg("latency.%s" % k, lat.get(k))
    if is_num(lat.get("decode_tokens_per_s")) and lat["decode_tokens_per_s"] <= 0:
        p.append("latency.decode_tokens_per_s must be positive")
    for k in ("minutes_per_checkpoint", "goal_conversation_min", "clarification_round_min",
              "auth_intervention_min", "minutes_per_question", "minutes_per_exception"):
        nonneg("human.%s" % k, scen.get("human", {}).get(k))
    for i, c in enumerate(scen.get("calendar_business_days", [])):
        nonneg("calendar_business_days[%d]" % i, c.get("business_days"))
    return p


def boundary_tests(cfg, checks):
    """Malformed inputs must be rejected and the unmodified central scenario accepted."""
    central = cfg["scenarios"]["central"]
    problems = validate_scenario(cfg, central)
    checks.add("boundary: unmodified central inputs accepted", not problems, "; ".join(problems) or "ok")
    cases = (
        ("cache read + write above 1", {"cache": {"A": {"read": 0.8, "write": 0.3}}}),
        ("cache reads never written", {"cache": {"C": {"read": 0.3, "write": 0.0}}}),
        ("zero screen batch", {"batch_actions_per_request": 0}),
        ("non-finite latency", {"latency": {"ttft_s": float("inf")}}),
        ("NaN token size", {"tokens": {"B": {"input": float("nan")}}}),
        ("retry fraction above 1", {"retry_rate_ui": 1.5}),
    )
    for name, override in cases:
        problems = validate_scenario(cfg, merged(central, override))
        checks.add("boundary: rejects %s" % name, bool(problems), "; ".join(problems) or "NOT rejected")
    # A malformed sensitivity goes through the same merge-then-validate path as main().
    bad = {"name": "bad_width", "base": "central", "overrides": {"parallel_width": 0}}
    problems = validate_scenario(cfg, merged(cfg["scenarios"][bad["base"]], bad["overrides"]))
    checks.add("boundary: rejects malformed sensitivity override (parallel_width 0)", bool(problems),
               "; ".join(problems) or "NOT rejected")


# ----------------------------------------------------------------- units ---

def browser_unit(a, batch, r_ui):
    turns = math.ceil(a["ui"] / batch) if a["ui"] else 0
    extra = r_ui * a["ui"]
    return {"req": a["plan"] + turns + extra, "env": turns + extra,
            "ui": a["ui"] * (1 + r_ui), "api": 0.0, "c_ext": 0.0, "c_local": 0.0,
            "ext": a["pages"] * (1 + r_ui)}


def api_unit(b, calls_per_request, r_api):
    calls = b["calls"]
    if b.get("model_free"):
        if b["plan"]:
            raise ValueError("a model-free connector stage cannot have planning requests")
        turns, extra_req = 0, 0.0
    else:
        turns = math.ceil(calls / calls_per_request) if calls else 0
        extra_req = r_api * calls
    return {"req": b["plan"] + turns + extra_req, "env": turns + extra_req,
            "ui": 0.0, "api": calls * (1 + r_api), "c_ext": 0.0, "c_local": 0.0,
            "ext": b["ext"] * (1 + r_api)}


def c_unit(c, extra, r_api):
    llm = c["llm"] + (extra["llm"] if extra else 0)
    env = c["env"] + (extra["env"] if extra else 0)
    local = c["ops"] - c["ext"]
    return {"req": float(llm), "env": float(env), "ui": 0.0, "api": 0.0,
            "c_ext": c["ext"] * (1 + r_api), "c_local": local * (1 + r_api),
            "ext": c["ext"] * (1 + r_api)}


def groups_for(arch, stage, spec, scen, m):
    """(token route, units, per-unit counts, document tokens per unit)."""
    r_ui, r_api = scen["retry_rate_ui"], scen["retry_rate_api"]
    batch = scen["batch_actions_per_request"]
    doc = spec.get("doc_tokens", {}).get(FAMILY[arch], 0)
    if arch == "A_step":
        return [("A_step", m, browser_unit(spec["A"], 1, r_ui), doc)]
    if arch == "A_batch":
        return [("A_batch", m, browser_unit(spec["A"], batch, r_ui), doc)]
    if arch == "B":
        n_api = b_api_units(stage["id"], spec["B"], scen, m)
        return [("B", n_api, api_unit(spec["B"], scen["b_tool_calls_per_request"], r_api), doc),
                ("A_batch", m - n_api, browser_unit(spec["A"], batch, r_ui), doc)]
    extra = None if scen["c_structured_disclosures"] else spec.get("C_unstructured")
    return [("C", m, c_unit(spec["C"], extra, r_api), doc + (extra["doc"] if extra else 0))]


def reviewers_per_unit(mode, consequential, requests):
    if mode == "none":
        return 0.0
    if mode == "per_consequential_action":
        return float(consequential)
    if mode == "per_model_request":
        return requests
    raise ValueError("unknown reviewer_mode %r" % mode)


# --------------------------------------------------------------- compute ---

def partition(scen, fam, row):
    """Split input into disjoint uncached / cache-read / cache-write classes."""
    cache = scen["cache"][fam]
    base = row["agent_input_tokens"] + row["reviewer_input_tokens"]
    read = cache["read"] * base
    write = cache["write"] * base
    return OrderedDict([
        ("input_total", base + row["document_tokens"]),
        ("uncached_input", base - read - write + row["document_tokens"]),
        ("cache_read", read),
        ("cache_write", write),
        ("output_incl_reasoning", row["agent_output_tokens"] + row["reviewer_output_tokens"]),
        ("document_tokens", row["document_tokens"]),
    ])


def bill(price, t):
    return (t["uncached_input"] * price["input"] + t["cache_read"] * price["cache_read"]
            + t["cache_write"] * price["cache_write"]
            + t["output_incl_reasoning"] * price["output"]) / 1e6


def run_scenario(cfg, scen, label, checks):
    lat, tok = scen["latency"], scen["tokens"]
    mult = scen.get("output_multiplier", 1.0)
    width = scen["parallel_width"]
    prices = cfg["prices_usd_per_million_tokens"]

    def request_latency(route):
        return lat["ttft_s"] + tok[route]["output"] * mult / lat["decode_tokens_per_s"]

    results, inventory, issues = OrderedDict(), [], []
    for arch in ARCHES:
        fam = FAMILY[arch]
        rev = tok["reviewer"][fam]
        rev_lat = lat["ttft_s"] + rev["output"] / lat["decode_tokens_per_s"]
        totals = OrderedDict((k, 0.0) for k in STAGE_KEYS)
        stage_rows = []
        max_input, longest_unit = 0.0, 0.0
        for stage in cfg["stages"]:
            spec = variant(stage, scen)
            m = multiplicity(stage, scen)
            row = OrderedDict((k, 0.0) for k in STAGE_KEYS)
            for route, n, u, doc in groups_for(arch, stage, spec, scen, m):
                if n == 0:
                    continue
                if u["req"] + EPS < u["env"]:
                    issues.append("%s/%s: observations exceed requests that could read them" % (arch, stage["id"]))
                if doc > 0 and u["req"] <= 0:
                    issues.append("%s/%s: document tokens with no model request" % (arch, stage["id"]))
                n_rev = reviewers_per_unit(scen["reviewer_mode"], stage["consequential_per_unit"], u["req"])
                tool_s = (u["ui"] * lat["browser_action_s"]
                          + (u["api"] + u["c_ext"]) * lat["api_call_s"]
                          + u["c_local"] * lat["local_op_s"])
                model_s = u["req"] * request_latency(route) + n_rev * rev_lat
                unit_s = model_s + tool_s
                row["agent_requests"] += n * u["req"]
                row["reviewer_requests"] += n * n_rev
                row["env_turns"] += n * u["env"]
                row["tool_invocations"] += n * (u["ui"] + u["api"] + u["c_ext"] + u["c_local"])
                row["browser_actions"] += n * u["ui"]
                row["api_calls"] += n * u["api"]
                row["c_external_ops"] += n * u["c_ext"]
                row["c_local_ops"] += n * u["c_local"]
                row["external_requests"] += n * u["ext"]
                row["agent_input_tokens"] += n * u["req"] * tok[route]["input"]
                row["agent_output_tokens"] += n * u["req"] * tok[route]["output"] * mult
                row["reviewer_input_tokens"] += n * n_rev * rev["input"]
                row["reviewer_output_tokens"] += n * n_rev * rev["output"]
                row["document_tokens"] += n * doc
                row["model_busy_s"] += n * model_s
                row["tool_busy_s"] += n * tool_s
                row["serial_s"] += n * unit_s
                if stage["on_critical_path"]:
                    on_path = math.ceil(n / width) if stage["parallel"] else n
                    row["critical_path_s"] += on_path * unit_s
                    longest_unit = max(longest_unit, unit_s)
                if u["req"] > 0:
                    max_input = max(max_input, tok[route]["input"] + doc)
                if n_rev > 0:
                    max_input = max(max_input, rev["input"])
            row["consequential_actions"] = float(m * stage["consequential_per_unit"])
            row["named_checkpoints"] = float(m * stage.get("human_checkpoints_per_unit", 0))
            row["human_interventions"] = float(m * spec.get("human_interventions_per_unit", 0))
            row["outbound_human_messages"] = float(m * stage.get("outbound_human_messages_per_unit", 0))
            for k in STAGE_KEYS:
                totals[k] += row[k]
            stage_rows.append((stage["id"], m, row))
            t_stage = partition(scen, fam, row)
            inventory.append(OrderedDict(
                [("scenario", label), ("architecture", arch), ("stage", stage["id"]), ("multiplicity", m)]
                + [(k, row[k]) for k in STAGE_KEYS]
                + [("usd_" + p, bill(prices[p], t_stage)) for p in PROVIDERS]))

        tokens = partition(scen, fam, totals)
        bills = OrderedDict((p, bill(prices[p], tokens)) for p in PROVIDERS)
        no_cache = OrderedDict((p, (tokens["input_total"] * prices[p]["input"]
                                    + tokens["output_incl_reasoning"] * prices[p]["output"]) / 1e6)
                               for p in PROVIDERS)

        # Stage-level bills must add up to the aggregate bill.
        for p in PROVIDERS:
            by_stage = sum(bill(prices[p], partition(scen, fam, r)) for _, _, r in stage_rows)
            checks.add("stage bills sum to total (%s %s %s)" % (label, arch, p),
                       abs(by_stage - bills[p]) <= 1e-9 * max(1.0, bills[p]),
                       "stages=%.9f total=%.9f" % (by_stage, bills[p]))
        checks.add("cache classes leave uncached input >= uncacheable documents (%s %s)" % (label, arch),
                   tokens["uncached_input"] + EPS >= tokens["document_tokens"],
                   "uncached=%.3f documents=%.3f" % (tokens["uncached_input"], tokens["document_tokens"]))
        checks.add("no request reaches the 272K long-context price tier (%s %s)" % (label, arch),
                   max_input < cfg["request_input_cap_tokens"], "largest request %.0f tokens" % max_input)
        checks.add("critical path within [longest unit, serial envelope] (%s %s)" % (label, arch),
                   longest_unit - EPS <= totals["critical_path_s"] <= totals["serial_s"] + EPS,
                   "longest=%.3f path=%.3f serial=%.3f" % (longest_unit, totals["critical_path_s"], totals["serial_s"]))

        h = scen["human"]
        human_min = (totals["named_checkpoints"] * h["minutes_per_checkpoint"]
                     + h["goal_conversation_min"]
                     + cfg["scope"]["underwriting_clarification_rounds"] * h["clarification_round_min"]
                     + totals["human_interventions"] * h["auth_intervention_min"]
                     + scen["counts"]["borrower_questions"] * h["minutes_per_question"]
                     + scen["counts"]["exceptions"] * h["minutes_per_exception"])
        calendar = sum(c["business_days"] for c in scen["calendar_business_days"])

        results[arch] = OrderedDict([
            ("agent_model_requests", totals["agent_requests"]),
            ("reviewer_model_requests", totals["reviewer_requests"]),
            ("N_model_requests", totals["agent_requests"] + totals["reviewer_requests"]),
            ("N_tool_invocations", totals["tool_invocations"]),
            ("browser_actions", totals["browser_actions"]),
            ("api_calls", totals["api_calls"]),
            ("c_external_ops", totals["c_external_ops"]),
            ("c_local_ops", totals["c_local_ops"]),
            ("N_environment_turns", totals["env_turns"]),
            ("N_external_service_requests", totals["external_requests"]),
            ("tokens", tokens),
            ("bills_usd_standard", bills),
            ("bills_usd_standard_if_no_cache", no_cache),
            ("model_busy_s", totals["model_busy_s"]),
            ("tool_service_busy_s", totals["tool_busy_s"]),
            ("browser_action_seconds", totals["browser_actions"] * lat["browser_action_s"]),
            ("serial_upper_envelope_s", totals["serial_s"]),
            ("parallel_critical_path_s", totals["critical_path_s"]),
            ("consequential_actions", totals["consequential_actions"]),
            ("named_checkpoints", totals["named_checkpoints"]),
            ("human_interventions", totals["human_interventions"]),
            ("outbound_human_messages", totals["outbound_human_messages"]),
            ("human_active_minutes", human_min),
            ("calendar_business_days_assumed", calendar),
            ("largest_request_input_tokens", max_input),
        ])

    checks.add("every observation is read by a request; documents need a request (%s)" % label,
               not issues, "; ".join(issues) or "ok")
    a_step, a_batch = results["A_step"]["agent_model_requests"], results["A_batch"]["agent_model_requests"]
    checks.add("batching cannot add requests: A_batch <= A_step (%s)" % label,
               a_batch <= a_step + EPS, "A_batch=%.3f A_step=%.3f" % (a_batch, a_step))
    for key in ("consequential_actions", "named_checkpoints", "outbound_human_messages"):
        vals = {a: results[a][key] for a in ARCHES}
        checks.add("same scope across architectures: %s (%s)" % (key, label),
                   len(set(vals.values())) == 1, json.dumps(vals))
    checks.add("C keeps visible residual LLM work (%s)" % label,
               results["C"]["agent_model_requests"] > 0,
               "C agent requests=%.3f" % results["C"]["agent_model_requests"])
    return results, inventory


# ---------------------------------------------------------- bank example ---

def bank_example(cfg, central, checks):
    ex = cfg["bank_mini_example"]
    n = sum(s["network_requests"] for s in ex["mandate_path_steps"])
    toy = n * ex["toy_rtt_s"]
    rows = [OrderedDict([
        ("path", "C mandate: toy network subtotal"), ("model_requests", 0.0),
        ("tool_invocations", float(n)), ("network_requests", float(n)), ("seconds", toy),
        ("basis", "arithmetic only: %d requests x %.0f ms round trip; excludes server work, "
                  "record generation, TLS, queueing and retries; not observed" % (n, ex["toy_rtt_s"] * 1000))])]
    settled = {}
    for name in MAIN_SCENARIOS:
        s = ex["settings"][name]
        per = s["rtt_s"] + s["server_processing_s"]
        secs = n * per + s["record_generation_s"] + s["retry_rate"] * n * (per + s["backoff_s"])
        settled[name] = secs
        rows.append(OrderedDict([
            ("path", "C mandate: parametric (%s)" % name), ("model_requests", 0.0),
            ("tool_invocations", n * (1 + s["retry_rate"])),
            ("network_requests", n * (1 + s["retry_rate"])), ("seconds", secs),
            ("basis", "assumed rtt %.2fs + server %.2fs per request, record generation %.1fs, "
                      "retry rate %.2f with %.1fs backoff; not observed"
                      % (s["rtt_s"], s["server_processing_s"], s["record_generation_s"], s["retry_rate"], s["backoff_s"]))]))
        checks.add("bank example: parametric (%s) is never below the toy subtotal" % name,
                   secs >= toy - EPS and (secs > toy or (s["server_processing_s"] == 0 and s["record_generation_s"] == 0)),
                   "toy=%.3f parametric=%.3f" % (toy, secs))

    stage = next(s for s in cfg["stages"] if s["id"] == "retrieve_bank")
    lat, tok = central["latency"], central["tokens"]
    alternatives = (
        ("A_step browser, warm session (central)", "A_step", browser_unit(stage["A"], 1, central["retry_rate_ui"])),
        ("A_batch browser, warm session (central)", "A_batch",
         browser_unit(stage["A"], central["batch_actions_per_request"], central["retry_rate_ui"])),
        ("B connector, warm grant (central)", "B",
         api_unit(stage["B"], central["b_tool_calls_per_request"], central["retry_rate_api"])),
        ("C stage model, flat api_call_s per external op (central)", "C",
         c_unit(stage["C"], None, central["retry_rate_api"])),
    )
    for label, route, u in alternatives:
        req_lat = lat["ttft_s"] + tok[route]["output"] / lat["decode_tokens_per_s"]
        secs = (u["req"] * req_lat + u["ui"] * lat["browser_action_s"]
                + (u["api"] + u["c_ext"]) * lat["api_call_s"] + u["c_local"] * lat["local_op_s"])
        rows.append(OrderedDict([
            ("path", label), ("model_requests", u["req"]),
            ("tool_invocations", u["ui"] + u["api"] + u["c_ext"] + u["c_local"]),
            ("network_requests", u["ext"]), ("seconds", secs),
            ("basis", "stage inventory with central latency assumptions; excludes authentication")]))
    return rows, toy, settled


# ---------------------------------------------------------------- energy ---

def energy_rows(cfg, label, metrics, checks):
    e = cfg["energy"]
    conv = e["absolute_conversion"]
    rows, bad = [], []
    for kappa in e["cache_read_weight_kappa"]:
        if not 0 <= kappa <= 1:
            raise ValueError("cache-read weight must lie in [0, 1]")
        for beta in e["output_weight_beta"]:
            rel = {}
            for arch in ARCHES:
                t = metrics[arch]["tokens"]
                rel[arch] = (t["uncached_input"] + e["cache_write_weight"] * t["cache_write"]
                             + kappa * t["cache_read"] + beta * t["output_incl_reasoning"]) / 1000.0
                full = (t["uncached_input"] + e["cache_write_weight"] * t["cache_write"]
                        + t["cache_read"] + beta * t["output_incl_reasoning"]) / 1000.0
                if rel[arch] > full + EPS:
                    bad.append("%s k=%s b=%s" % (arch, kappa, beta))
            for arch in ARCHES:
                m = metrics[arch]
                row = OrderedDict([
                    ("scenario", label), ("architecture", arch), ("kappa_cache_read", kappa),
                    ("beta_output", beta), ("inference_kpte", rel[arch]),
                    ("ratio_to_C", rel[arch] / rel["C"] if rel["C"] else None),
                    ("browser_action_seconds_unconverted", m["browser_action_seconds"]),
                    ("external_requests_unconverted", m["N_external_service_requests"]),
                    ("c_local_ops_unconverted", m["c_local_ops"]),
                ])
                if conv["enabled"]:
                    wh = rel[arch] * conv["wh_per_1k_prefill_token_equivalent"] * conv["pue"]
                    row["wh_user_supplied_coefficients"] = wh
                    row["gco2e_user_supplied_grid"] = wh / 1000.0 * conv["grid_gco2e_per_kwh"]
                rows.append(row)
    checks.add("energy: discounted cache reads never exceed full prefill (%s)" % label, not bad,
               "; ".join(bad) or "ok")
    return rows


# ----------------------------------------------------------- hand checks ---

def hand_checks(cfg, res, sens, bank_toy, bank_settled, energy, checks):
    hc = cfg["hand_checks"]

    def cmp(name, got, want, tol):
        checks.add("hand: " + name, abs(got - want) <= tol, "hand=%r computed=%r" % (want, got))

    c = res["central"]
    cmp("named checkpoints", c["C"]["named_checkpoints"], hc["named_checkpoints"], 0)
    cmp("named checkpoints equal scope declaration", c["C"]["named_checkpoints"],
        cfg["scope"]["named_agent_mediated_checkpoints"], 0)
    cmp("consequential actions", c["C"]["consequential_actions"], hc["consequential_actions"], 0)
    for arch, want in hc["pre_retry_agent_requests_central"].items():
        cmp("central pre-retry agent requests " + arch, sens["retries_zero"][arch]["agent_model_requests"], want, EPS)
    for arch, want in hc["pre_retry_tool_invocations_central"].items():
        cmp("central pre-retry tool invocations " + arch, sens["retries_zero"][arch]["N_tool_invocations"], want, EPS)
    for scen, by_arch in hc["n_model_requests"].items():
        for arch, want in by_arch.items():
            cmp("N_model_requests %s %s" % (scen, arch), res[scen][arch]["N_model_requests"], want, 1e-6)
    for scen, by_arch in hc["cost_usd_astra_opus"].items():
        for arch, (astra, opus) in by_arch.items():
            b = res[scen][arch]["bills_usd_standard"]
            cmp("Astra bill %s %s" % (scen, arch), b[PROVIDERS[0]], astra, 0.01)
            cmp("Opus bill %s %s" % (scen, arch), b[PROVIDERS[1]], opus, 0.01)
    for scen, by_arch in hc["serial_upper_envelope_s"].items():
        for arch, want in by_arch.items():
            cmp("serial envelope %s %s" % (scen, arch), res[scen][arch]["serial_upper_envelope_s"], want, 0.01)
    for scen, by_arch in hc["parallel_critical_path_s"].items():
        for arch, want in by_arch.items():
            cmp("critical path %s %s" % (scen, arch), res[scen][arch]["parallel_critical_path_s"], want, 0.01)
    for name, by_arch in hc["sensitivity_cost_usd_astra_opus"].items():
        for arch, (astra, opus) in by_arch.items():
            b = sens[name][arch]["bills_usd_standard"]
            cmp("sensitivity %s Astra %s" % (name, arch), b[PROVIDERS[0]], astra, 0.01)
            cmp("sensitivity %s Opus %s" % (name, arch), b[PROVIDERS[1]], opus, 0.01)
    for scen, want in hc["human_active_minutes"].items():
        vals = {res[scen][a]["human_active_minutes"] for a in ARCHES}
        cmp("human minutes " + scen, res[scen]["C"]["human_active_minutes"], want, 1e-6)
        checks.add("human minutes identical across architectures by construction (%s)" % scen,
                   len(vals) == 1, str(sorted(vals)))
    for scen, want in hc["calendar_business_days"].items():
        cmp("calendar business days " + scen, res[scen]["C"]["calendar_business_days_assumed"], want, 0)
    cmp("bank toy subtotal", bank_toy, hc["bank_example_s"]["toy"], 1e-9)
    for scen in MAIN_SCENARIOS:
        cmp("bank parametric " + scen, bank_settled[scen], hc["bank_example_s"][scen], 1e-6)
    point = cfg["energy"]["central_point"]
    for arch, want in hc["energy_kpte_central_kappa0.1_beta5"].items():
        got = next(r["inference_kpte"] for r in energy if r["scenario"] == "central" and r["architecture"] == arch
                   and r["kappa_cache_read"] == point["kappa"] and r["beta_output"] == point["beta"])
        cmp("energy kPTE central %s" % arch, got, want, 0.01)


# ---------------------------------------------------------------- output ---

def flat(metrics):
    out = OrderedDict()
    for k, v in metrics.items():
        if isinstance(v, dict):
            for k2, v2 in v.items():
                out["%s.%s" % (k, k2)] = v2
        else:
            out[k] = v
    return out


def write_csv(path, rows):
    if not rows:
        return
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def n0(x):
    return "{:,.0f}".format(x)


def n1(x):
    return "{:,.1f}".format(x)


def usd(x):
    return "${:,.2f}".format(x)


def summary_md(cfg, res, sens, bank, energy, checks):
    lines = ["# Mortgage compute calculator: generated summary", "",
             "> " + cfg["meta"]["status"], "",
             "Checks: **%s** (%d of %d passed). Exact values are in mortgage-compute-results.json and CSV files; "
             "the tables below are rounded." % ("ALL PASSED" if not checks.failed() else "FAILURES PRESENT",
                                                len(checks.items) - len(checks.failed()), len(checks.items)), "",
             "Conditional schedule: " + cfg["meta"]["schedule_semantics"], "",
             "Retries: " + cfg["meta"]["retry_semantics"], ""]
    lines += ["## Scenario totals", "",
              "| Scenario | Arch | N_model_requests (reviewer) | Tool inv. | Env. turns | Ext. requests | Input Mtok (read/write/uncached) | Output ktok | Astra $ | Opus $ | Serial min | Conditional schedule min | Human min | Calendar bd |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for scen in MAIN_SCENARIOS:
        for arch in ARCHES:
            m = res[scen][arch]
            t = m["tokens"]
            lines.append("| %s | %s | %s (%s) | %s | %s | %s | %.2f (%.2f/%.2f/%.2f) | %s | %s | %s | %s | %s | %s | %s |" % (
                scen, arch, n1(m["N_model_requests"]), n0(m["reviewer_model_requests"]), n1(m["N_tool_invocations"]),
                n1(m["N_environment_turns"]), n1(m["N_external_service_requests"]), t["input_total"] / 1e6,
                t["cache_read"] / 1e6, t["cache_write"] / 1e6, t["uncached_input"] / 1e6,
                n1(t["output_incl_reasoning"] / 1e3), usd(m["bills_usd_standard"][PROVIDERS[0]]),
                usd(m["bills_usd_standard"][PROVIDERS[1]]), n1(m["serial_upper_envelope_s"] / 60),
                n1(m["parallel_critical_path_s"] / 60), n1(m["human_active_minutes"]),
                n0(m["calendar_business_days_assumed"])))
    lines += ["", "## Sensitivities (base: central)", "",
              "| Sensitivity | Arch | N_model_requests | Astra $ | Opus $ | Serial min | Conditional schedule min |",
              "|---|---|---|---|---|---|---|"]
    for s in cfg["sensitivities"]:
        for arch in ARCHES:
            m = sens[s["name"]][arch]
            lines.append("| %s | %s | %s | %s | %s | %s | %s |" % (
                s["name"], arch, n1(m["N_model_requests"]), usd(m["bills_usd_standard"][PROVIDERS[0]]),
                usd(m["bills_usd_standard"][PROVIDERS[1]]), n1(m["serial_upper_envelope_s"] / 60),
                n1(m["parallel_critical_path_s"] / 60)))
    lines += ["", "## Bank retrieval mini-example (one institution, two statements)", "",
              "| Path | Model requests | Tool inv. | Network requests | Seconds | Basis |", "|---|---|---|---|---|---|"]
    for r in bank:
        lines.append("| %s | %.2f | %.2f | %.2f | %.3f | %s |" % (
            r["path"], r["model_requests"], r["tool_invocations"], r["network_requests"], r["seconds"], r["basis"]))
    lines += ["", "## Inference energy coefficient sweep (central, kPTE; not a footprint)", "",
              "| kappa | beta | A_step | A_batch | B | C | A_batch/C | B/C |", "|---|---|---|---|---|---|---|---|"]
    central_rows = [r for r in energy if r["scenario"] == "central"]
    for kappa in cfg["energy"]["cache_read_weight_kappa"]:
        for beta in cfg["energy"]["output_weight_beta"]:
            sel = {r["architecture"]: r for r in central_rows if r["kappa_cache_read"] == kappa and r["beta_output"] == beta}
            lines.append("| %s | %s | %s | %s | %s | %s | %.2f | %.2f |" % (
                kappa, beta, n0(sel["A_step"]["inference_kpte"]), n0(sel["A_batch"]["inference_kpte"]),
                n0(sel["B"]["inference_kpte"]), n1(sel["C"]["inference_kpte"]),
                sel["A_batch"]["ratio_to_C"], sel["B"]["ratio_to_C"]))
    if checks.failed():
        lines += ["", "## Failed checks", ""] + ["- %s: %s" % (c["check"], c["detail"]) for c in checks.failed()]
    return "\n".join(lines) + "\n"


def main():
    cfg = load_config()
    checks = Checks()
    validate_config(cfg, checks)
    boundary_tests(cfg, checks)

    sens_inputs = OrderedDict((s["name"], merged(cfg["scenarios"][s["base"]], s["overrides"]))
                              for s in cfg["sensitivities"])
    to_validate = [(n, cfg["scenarios"][n]) for n in MAIN_SCENARIOS]
    to_validate += [("sensitivity:" + n, scen) for n, scen in sens_inputs.items()]
    for label, scen in to_validate:
        problems = validate_scenario(cfg, scen)
        checks.add("inputs valid (%s)" % label, not problems, "; ".join(problems) or "ok")
    if checks.failed():
        with open(os.path.join(HERE, "mortgage-compute-checks.json"), "w", encoding="utf-8") as fh:
            json.dump(OrderedDict([("passed", False), ("stage", "input validation"), ("checks", checks.items)]),
                      fh, indent=2)
            fh.write("\n")
        for c in checks.failed():
            print("FAIL: %s -- %s" % (c["check"], c["detail"]))
        print("Invalid inputs: no results computed. Any older mortgage-compute-* result files are stale.")
        return 1

    res = OrderedDict()
    inventory = []
    for name in MAIN_SCENARIOS:
        res[name], inv = run_scenario(cfg, cfg["scenarios"][name], name, checks)
        inventory += inv

    sens = OrderedDict()
    for name, scen in sens_inputs.items():
        sens[name], _ = run_scenario(cfg, scen, "sensitivity:" + name, checks)

    again, _ = run_scenario(cfg, cfg["scenarios"]["central"], "central", Checks())
    checks.add("deterministic: central recomputation is byte-identical",
               json.dumps(again, sort_keys=True) == json.dumps(res["central"], sort_keys=True), "")

    bank, bank_toy, bank_settled = bank_example(cfg, cfg["scenarios"]["central"], checks)
    energy = []
    for name in MAIN_SCENARIOS:
        energy += energy_rows(cfg, name, res[name], checks)
    hand_checks(cfg, res, sens, bank_toy, bank_settled, energy, checks)

    payload = OrderedDict([
        ("meta", cfg["meta"]),
        ("scope", cfg["scope"]),
        ("prices_usd_per_million_tokens", cfg["prices_usd_per_million_tokens"]),
        ("definitions", OrderedDict([
            ("parallel_critical_path_s", cfg["meta"]["schedule_semantics"]),
            ("retries", cfg["meta"]["retry_semantics"]),
            ("N_external_service_requests", cfg["meta"]["external_request_semantics"]),
        ])),
        ("scenarios", res),
        ("sensitivities", OrderedDict((s["name"], OrderedDict([("description", s["description"]),
                                                               ("overrides", s["overrides"]),
                                                               ("results", sens[s["name"]])]))
                                      for s in cfg["sensitivities"])),
        ("bank_mini_example", bank),
        ("energy_status", cfg["energy"]["status"]),
        ("checks_passed", not checks.failed()),
    ])
    with open(os.path.join(HERE, "mortgage-compute-results.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")
    with open(os.path.join(HERE, "mortgage-compute-checks.json"), "w", encoding="utf-8") as fh:
        json.dump(OrderedDict([("passed", not checks.failed()), ("checks", checks.items)]), fh, indent=2)
        fh.write("\n")

    write_csv(os.path.join(HERE, "mortgage-compute-results.csv"),
              [OrderedDict([("scenario", s), ("architecture", a)] + list(flat(res[s][a]).items()))
               for s in MAIN_SCENARIOS for a in ARCHES])
    write_csv(os.path.join(HERE, "mortgage-compute-sensitivity.csv"),
              [OrderedDict([("sensitivity", s["name"]), ("architecture", a)] + list(flat(sens[s["name"]][a]).items()))
               for s in cfg["sensitivities"] for a in ARCHES])
    write_csv(os.path.join(HERE, "mortgage-compute-inventory.csv"), inventory)
    write_csv(os.path.join(HERE, "mortgage-compute-energy.csv"), energy)
    write_csv(os.path.join(HERE, "mortgage-compute-bank-example.csv"), bank)
    with open(os.path.join(HERE, "mortgage-compute-summary.md"), "w", encoding="utf-8") as fh:
        fh.write(summary_md(cfg, res, sens, bank, energy, checks))

    failed = checks.failed()
    print("%d checks, %d failed" % (len(checks.items), len(failed)))
    for c in failed:
        print("FAIL: %s -- %s" % (c["check"], c["detail"]))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
