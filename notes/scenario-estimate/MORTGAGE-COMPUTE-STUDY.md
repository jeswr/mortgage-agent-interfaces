# How many model calls does a delegated US mortgage need? A synthetic worked example and reproducible calculator

**Status (17 October 2026).** This is a first-pass methods paper. No experiment was run. We observed no real mortgage, user log or provider meter. Every count, token size, latency and duration is an assumption stored in `mortgage_scenarios.json`. The figures come from `mortgage_compute.py` (standard library only, no network, no model calls). The calculator reproduces the arithmetic, not the world.

## Abstract

We ask how many large-language-model (LLM) requests a personal agent would make, and what it would currently cost per token, to help two co-borrowers get a US conventional purchase mortgage. This could be measured with instrumented deployments, but our source review found no measured end-to-end trace of a consumer mortgage handled by an agent. One synthetic case also cannot be a representative average. So we build a transparent, illustrative worked example and count it under explicit lean, central and friction-heavy assumptions. We compare three architectures on identical scope. **A** is a screen-driven agent, run both one action per call and batched. **B** is model orchestration of existing connectors, falling back to the browser. **C** is interoperable domain operations with explicit permission checks, run by ordinary software, with an LLM for goals and exceptions.

Under central assumptions, N_model_requests (including 28 safety-reviewer calls) is about 675 for step-wise A, 304 for batched A, 232 for B and 54 for C. Illustrative bills at Standard list prices are $40.87, $29.07 and $4.08 on GPT-6 Astra for batched A, B and C. On Claude Opus 5.5 they are $15.36, $11.11 and $1.61. Agent processing takes minutes to hours. The transaction takes weeks of underwriting, legal waiting periods and human acts that no architecture removes. Most of the reduction comes from structured access and from moving routine control flow into code, not from any particular standard. We specify the observational study and controlled experiment needed to replace these assumptions.

## 1. Question and scope

"LLM calls per mortgage" mixes three different things:

- what the borrower's agent does;
- what lenders and their verification vendors do;
- what the law makes everyone wait for.

Only the first is in scope. The following are excluded from agent processing and reported separately:

- lender underwriting;
- Loan Estimate delivery (generally within three business days of application);
- the Closing Disclosure waiting period (at least three business days before consummation, restarted by certain changes);
- the physical appraisal;
- lender-contracted asset, income and IRS IVES verification;
- signature and funds transfer.

Nothing here implies that a mortgage, or any part of one, completes in milliseconds.

**Case (all assumptions).** The scope is chosen so that each source type appears more than once without assuming complex finances (Table 1). It has:

- two salaried co-borrowers, each with one employer (two payroll sources);
- two deposit institutions with two statement months each;
- six-item applications to three lenders, following CFPB advice to contact several;
- one chosen lender;
- one underwriting clarification round with two conditions;
- twelve uploaded documents and two appointments;
- seven authenticated service sessions.

This three-lender comparison is a separate case from the article's narrative, in which the family has already chosen a lender. Lender discovery overlaps with the companion [MORTGAGE-DISCOVERY-STUDY.md](MORTGAGE-DISCOVERY-STUDY.md). Anyone combining the two should count discovery once, not add both studies' discovery work.

There are fifteen named checkpoints, each treated as a fresh, object-specific human decision. They follow the consent points in the evidence ledger, but requiring all fifteen to be fresh is our conservative study choice, not a list of statutory requirements. Valid standing authority could cover some of them, and not every consent needs a new interruption. We hold the count fixed across architectures so that only machine cost varies. The study therefore does not estimate the benefit of standing delegation, which the article's narrative relies on.

| Named checkpoint | Count |
|---|---|
| Goal and scope confirmation | 1 |
| Lender-specific application and credit-check permission | 3 |
| Lender choice | 1 |
| Intent to proceed, bound to one Loan Estimate version | 1 |
| Appraisal or application fee authorisation | 1 |
| Asset-verification account selection (one per institution) | 2 |
| IRS Form 4506-C signature (one per borrower) | 2 |
| Employment/income verification authorisation (one per borrower) | 2 |
| Condition-response attestation | 1 |
| Closing Disclosure review acknowledgement | 1 |
| **Total** | **15** |

Four acts stay entirely human in this study: the closing signature, the cash-to-close transfer, fee payment and property access. This is a boundary we chose, not a claim that these acts can never be delegated.

## 2. Method

### 2.1 Counting units

- **N_model_requests**: inference calls, counting both agent and safety-reviewer calls.
- **N_tool_invocations**: executed actions. These are UI actions, connector calls, or domain operations including deterministic permission checks.
- **N_environment_turns**: observations returned to a model, such as a screenshot after a batch or a batch of tool results. Human messages are counted separately.
- **N_external_service_requests**: application-level requests to or from other parties, such as page loads, form submissions, API calls and incoming event deliveries. Subresource fetches are not counted.
- **Tokens**: input is split into three disjoint classes: uncached, cache-read and cache-write. A written token is billed once, at the write rate, never also as base input. Output includes reasoning.
- **Time**:
  - model-busy and tool/service-busy seconds;
  - a *serial upper envelope*, where nothing overlaps;
  - a *conditional parallel schedule estimate*. Stages run in order, and units within a stage run up to W at a time. A mixed B stage runs its connector group and then its browser group. Status monitoring is excluded because it happens in the background during waits. This is a scheduling estimate under those rules, not an optimal dependency-graph critical path;
  - human active minutes;
  - calendar business days.

**Request rule.** One response can choose a tool, write its arguments, batch actions, or emit a routine. The next request reads the result. Choosing the tool, learning its schema, writing arguments and interpreting the reply are therefore not separate requests by default. Per unit:

- browser path: requests = plan + ⌈UI/b⌉;
- connector path: requests = plan + ⌈calls/k⌉;
- C: requests = residual LLM turns only.

Here *plan* means model turns not tied to an action: interpretation, drafting and dialogue. We never infer one request per click. Step-wise A sets b = 1 explicitly as a lower bound on engineering effort, and batched A is the fair comparator. Retries are expected values. Each failed action gets exactly one repair attempt, which is assumed to succeed. A failed UI action or model-orchestrated call costs one extra action, observation and request. C retries in code. We do not model geometric retry-until-success, and we do not cost failed or abandoned tasks.

### 2.2 Architectures

All four variants carry the same 15 checkpoints, 28 consequential writes and 7 outbound human messages, and the script fails if they differ.

- **A_step / A_batch.** Screen-driven. Screenshots are counted as input tokens; no screenshot is inferred for free. Opus 5.5's documented ability to emit several computer actions per response motivates A_batch.
- **B.** Existing connectors orchestrated by the model:
  - a financial-data aggregator, as in the Plaid connection for Meta's Muse;
  - email and calendar;
  - search and fetch;
  - local PDF form fill;
  - a product-native approval UI.

  Lender applications, document upload and condition responses have no assumed consumer API and fall back to the batched browser. Routine polling runs without the model. Coverage is a parameter. A hypothetical *B all-API* sensitivity separates API availability from model orchestration, so the savings are not all credited to new standards.
- **C.** Domain operations carrying explicit permission objects (verb, object, purpose, duration, recipient). The design resembles the CFPB Personal Financial Data Rights model, whose compliance dates are stayed, so it describes a design, not a current entitlement.

  **Residual LLM work is counted in C**:
  - goal dialogue (4 turns);
  - comparison narrative (2);
  - discovery judgement (1 per lender);
  - appointment replies (1 each);
  - condition handling (3);
  - Closing Disclosure explanation (1);
  - borrower questions (1 each);
  - exceptions (2 each);
  - model reading of Loan Estimates and Closing Disclosures when they are not machine-readable.

  C uses no model-based monitor, because status arrives as events. Event handling is not free, though. We assume one status update per B poll (10, 20 and 40 across the scenarios; real frequencies may differ), and each update costs one external delivery plus one deterministic operation, with no LLM call. Permission checks are tool invocations. Human clarification is counted as human minutes.

### 2.3 Safety reviewer

OpenAI says dots' action review runs outside the agent environment, and Meta describes a separate Sentinel layer for Muse. Neither documents a per-action call count. In the central case, every architecture therefore gets **one reviewer call per consequential action (28)**. We also show no reviewer and one reviewer call per agent request.

### 2.4 Parameters (all assumptions)

| Parameter | Lean | Central | Friction |
|---|---|---|---|
| Screen batch b (A_batch and B fallback) | 6 | 4 | 2 |
| Connector calls per request k (B) | 4 | 2 | 1 |
| Parallel width W | 4 | 3 | 2 |
| Retry rate, UI / API | 0.02 / 0.01 | 0.05 / 0.02 | 0.15 / 0.05 |
| Authentication | warm | cold | cold |
| Status checks / borrower questions / exceptions | 10 / 2 / 1 | 20 / 5 / 3 | 40 / 12 / 8 |
| B connector units (auth, bank, payroll, consents, Closing Disclosure) | 4/7, 2/2, 2/2, 4/6, 1/1 | 2/7, 2/2, 0/2, 2/6, 1/1 | 1/7, 1/2, 0/2, 2/6, 0/1 |
| C disclosures machine-readable | yes | yes | no |
| Input / output tokens per request: A_step | 15k / 250 | 25k / 500 | 40k / 1.2k |
| A_batch and B fallback | 15k / 450 | 25k / 900 | 40k / 2k |
| B connector | 10k / 250 | 15k / 500 | 25k / 1.2k |
| C | 6k / 400 | 10k / 800 | 16k / 1.6k |
| Reviewer input (A / B / C); output | 6k / 4k / 3k; 200 | same | same |
| Cache read / write fraction: A; B; C | .85/.05; .80/.05; .50/.15 | .70/.10; .60/.10; .30/.20 | .40/.20; .35/.20; .10/.30 |
| First-token s; decode tokens/s | 1; 80 | 2; 50 | 4; 30 |
| Browser action / API call / local op (s) | 0.8 / 0.2 / 0.02 | 1.5 / 0.5 / 0.02 | 3 / 1.5 / 0.05 |

Per-request input covers the system prompt, tool schemas, history and (for A) screenshots. C's smaller contexts are themselves an assumption that favours C. Its lower cache fractions reflect sparse calls. Every request stays below Astra's 272K long-context tier, and the script checks this.

**Prices.** Standard USD per million tokens, from the provider pages recorded in our price notes (verified 17 October 2026):

| Model | Input | Cache read | Cache write | Output |
|---|---|---|---|---|
| GPT-6 Astra | 10 | 1 | 12.50 | 50 |
| Claude Opus 5.5 | 4 | 0.20 | 5 (5-minute) | 20 |

These are illustrative per-token bills. They are not subscription charges, Batch or Flex rates, or measured compute. Price implies nothing about latency, and both providers share one latency model.

## 3. Itemised inventory

**Table 2. Per-unit assumptions.** In the B column, "API" means a connector and "browser" means the batched-browser fallback. Bracketed values apply to warm authentication or PDF-only disclosures.

| Stage | m (central) | A: UI / pages / plan | B (central): calls / ext / plan | C: ops (external) / LLM | Writes per unit | Doc tokens A / B / C |
|---|---|---|---|---|---|---|
| Goal clarification | 1 | 0 / 0 / 4 | API 0 / 0 / 4 | 1 (0) / 4 | 0 | – |
| Authentication, cold [warm] | 7 | 8 / 3 / 1 [1/1/0] | 2 of 7 API: 2 / 2 / 1 [1/1/0]; rest browser | 3 (3) / 0 [1 (1) / 0] | 0 | – |
| Bank statements | 2 | 10 / 5 / 1 | API 3 / 3 / 1 | 4 (3) / 0 | 0 | – |
| Payroll documents | 2 | 10 / 5 / 1 | browser | 4 (3) / 0 | 0 | – |
| Lender discovery and role check | 3 | 12 / 6 / 2 | API 4 / 4 / 2 | 2 (2) / 1 | 0 | 0 / 6k / 1k |
| Six-item application | 3 | 30 / 6 / 2 | browser | 4 (3) / 0 | 1 | – |
| Loan Estimate gathering | 3 | 6 / 3 / 2 | API 2 / 2 / 2 | 2 (1) / 0 [+1] | 0 | 4.5k / 4.5k / 0 [+4.5k] |
| Comparison | 1 | 0 / 0 / 3 | API 0 / 0 / 3 | 1 (0) / 2 | 0 | – |
| Named checkpoints | 15 | 0 / 0 / 1 | API 1 / 0 / 0 | 2 (0) / 0 | 0 | – |
| Intent to proceed | 1 | 6 / 2 / 1 | API 1 / 1 / 1 | 3 (2) / 0 | 1 | – |
| Verification consents | 6 | 12 / 3 / 1 | 2 of 6 API: 2 / 1 / 1; rest browser | 3 (2) / 0 | 1 | – |
| Document transfer | 12 | 5 / 2 / 0 | browser | 3 (2) / 0 | 1 | – |
| Appointments | 2 | 10 / 4 / 2 | API 3 / 3 / 2 | 3 (3) / 1 | 2 | – |
| Status monitoring (per check or update) | 20 | 4 / 2 / 1 | API, model-free 1 / 1 / 0 | event 1 (1) / 0 | 0 | – |
| Underwriting clarification | 1 | 16 / 6 / 4 | browser | 6 (4) / 3 | 2 | 6k / 6k / 3k |
| Closing Disclosure review | 1 | 6 / 3 / 3 | API 2 / 2 / 3 | 2 (1) / 1 [+1] | 0 | 7.5k / 7.5k / 1.5k [+7.5k] |
| Borrower questions | 5 | 0 / 0 / 1 | API 0 / 0 / 1 | 0 / 1 | 0 | – |
| Exceptions | 3 | 6 / 2 / 3 | API 2 / 2 / 3 | 2 (2) / 2 | 0 | – |

**Table 3. Central agent requests by stage, before retries and reviewers.**

| Stage | A_step | A_batch | B | C |
|---|---|---|---|---|
| Goal | 4 | 4 | 4 | 4 |
| Authentication | 63 | 21 | 19 | 0 |
| Bank / payroll | 22 / 22 | 8 / 8 | 6 / 8 | 0 / 0 |
| Discovery | 42 | 15 | 12 | 3 |
| Applications | 96 | 30 | 30 | 0 |
| Loan Estimates | 24 | 12 | 9 | 0 |
| Comparison | 3 | 3 | 3 | 2 |
| Checkpoints | 15 | 15 | 15 | 0 |
| Intent | 7 | 3 | 2 | 0 |
| Consents | 78 | 24 | 20 | 0 |
| Document transfer | 60 | 24 | 24 | 0 |
| Appointments | 24 | 10 | 8 | 2 |
| Monitoring | 100 | 40 | 0 | 0 |
| Clarification | 20 | 8 | 8 | 3 |
| Closing Disclosure | 9 | 5 | 4 | 1 |
| Questions / exceptions | 5 / 27 | 5 / 15 | 5 / 12 | 5 / 6 |
| **Total** | **621** | **250** | **189** | **26** |

## 4. Results

**Table 4. Central case.**

| Metric | A_step | A_batch | B | C |
|---|---|---|---|---|
| Agent / reviewer requests | 646.9 / 28 | 275.9 / 28 | 203.9 / 28 | 26 / 28 |
| **N_model_requests** | **674.9** | **303.9** | **231.9** | **54** |
| N_tool_invocations | 543.9 | 543.9 | 371.3 | 193.8 |
| N_environment_turns | 543.9 | 172.9 | 135.9 | 15 |
| N_external_service_requests | 202.7 | 202.7 | 155.6 | 128.5 |
| Input Mtok (read / write / uncached) | 16.37 (11.44 / 1.63 / 3.30) | 7.09 (4.95 / 0.71 / 1.44) | 4.36 (2.59 / 0.43 / 1.34) | 0.35 (0.10 / 0.07 / 0.18) |
| Output ktok incl. reasoning | 329.1 | 253.9 | 153.4 | 26.4 |
| **GPT-6 Astra Standard bill** | **$81.27** | **$40.87** | **$29.07** | **$4.08** |
| **Claude Opus 5.5 Standard bill** | **$30.22** | **$15.36** | **$11.11** | **$1.61** |
| Model-busy / tool-busy s | 7,931 / 816 | 5,686 / 816 | 3,533 / 473 | 636 / 66 |
| Serial upper envelope | 2.43 h | 1.81 h | 1.11 h | 11.7 min |
| Conditional parallel schedule estimate (W = 3) | 58.4 min | 47.8 min | 34.0 min | 8.5 min |

**Table 5. Scenarios.** N_model_requests; Astra / Opus bill; serial envelope.

| Arch | Lean | Central | Friction |
|---|---|---|---|
| A_step | 530.3; $25.89 / $9.05; 41.8 min | 674.9; $81.27 / $30.22; 2.43 h | 895.2; $293.09 / $114.45; 11.3 h |
| A_batch | 196.3; $11.00 / $3.94; 25.9 min | 303.9; $40.87 / $15.36; 1.81 h | 587.2; $211.97 / $82.98; 11.7 h |
| B | 159.5; $7.85 / $2.87; 15.8 min | 231.9; $29.07 / $11.11; 1.11 h | 386.0; $122.71 / $48.21; 6.46 h |
| C | 47; $1.90 / $0.74; 3.9 min | 54; $4.08 / $1.61; 11.7 min | 75; $12.56 / $5.01; 54.0 min |
| Human active minutes (all) | 64 | 140.5 | 284.5 |
| Calendar, business days (assumed) | 19 | 32 | 55 |

**Table 6. Central sensitivities.** N_model_requests; Astra / Opus bill.

| Sensitivity | A_step | A_batch | B | C |
|---|---|---|---|---|
| No reviewer | 646.9; $80.32 / $29.87 | 275.9; $39.93 / $15.01 | 203.9; $28.24 / $10.79 | 26; $3.14 / $1.24 |
| Reviewer per agent request | 1,293.8; $102.12 / $38.04 | 551.8; $49.23 / $18.49 | 407.9; $34.24 / $13.09 | 52; $4.01 / $1.58 |
| B with hypothetical APIs for every stage | – | – | 173.5; $15.49 / $5.92 | – |

Eight more sensitivities are computed in `mortgage-compute-summary.md` and the sensitivity CSV:

- warm authentication;
- wider B connector coverage;
- C with PDF-only disclosures;
- no prompt cache;
- b = 8;
- serial-only execution;
- doubled reasoning output;
- 40 status checks.

**Interpretation.** Five points stand out.

1. **Batching matters as much as interface choice.** Batching alone takes A from about 675 to 304 requests. A step-wise screen agent is therefore not a fair baseline.
2. **Existing connectors capture part of the gap.** B cuts requests by 24% against batched A in the central case. Its savings stop at lender portals, which still need the browser.
3. **The decomposition splits roughly into thirds.** On Astra the bill steps down as follows:

   | Step | Bill after step | Saving | Driver |
   |---|---|---|---|
   | Batched A (start) | $40.87 | – | – |
   | → B | $29.07 | $11.81 | existing connectors |
   | → hypothetical B with APIs everywhere | $15.49 | $13.57 | structured access, still model-orchestrated |
   | → C | $4.08 | $11.42 | routine control flow moved into code, events instead of polling, machine-readable disclosures and smaller assumed contexts |

   The second and third savings do not require a *standard* as such. **Counterfactual:** a B with bespoke APIs for every stage, sequenced by ordinary code rather than the model, could match C's model-request count. The benefit of standards is therefore interoperability and lower integration cost, not uniquely lower raw compute. Neither coverage nor developer setup cost is modelled here.
4. **C's residual LLM work is the bulk of its bill.** It is not zero: goals, questions, exceptions and the clarification round dominate C's schedule estimate. Reviewer calls (28) outnumber C's agent calls (26), so reviewer policy is a first-order cost for C and a minor one for A.
5. **Friction erodes batching.** With b = 2 and 2,000-token reasoning outputs, batched A becomes *slower* than step-wise A (11.7 h against 11.3 h serial) while still costing less. Fewer calls do not guarantee less time.

## 5. Time: agent work versus the transaction

Across the variants, borrower-agent processing ranges from minutes to hours. The serial envelope includes monitoring checks spread over weeks, so it is an upper bound, not an expected wall-clock duration. Human active time is the same in every architecture by construction, at 140.5 central minutes:

| Human activity (central) | Minutes |
|---|---|
| 15 checkpoints × 4 min | 60 |
| Goal conversation | 25 |
| Clarification | 20 |
| Cold-authentication interventions | 10.5 |
| Questions | 10 |
| Exceptions | 15 |

Changing the architecture does not remove consent, attestation or signature. Real screen agents may need more hand-offs (CAPTCHAs, re-logins), and only measurement can show this.

The assumed central calendar is 32 business days:

| Component | Business days | Basis |
|---|---|---|
| Shopping | 3 | assumption |
| Loan Estimate delivery | up to 3 | legal bound |
| Decision | 2 | assumption |
| Processing, appraisal and underwriting | 20 | unsourced placeholder |
| Closing Disclosure waiting period | 3 | legal minimum |
| Closing | 1 | assumption |

Agent compute time is far shorter than this calendar and the human waits, which we excluded. It still matters for how quickly the agent responds at each interaction, and for aggregate work across many users.

## 6. Bank retrieval mini-example

The example covers one institution and two statements. In C, the existing mandate is assumed valid. We do not claim that every bank offers this operation or structured records, or that the path is network-only. The mandate path has these steps:

| Step | Network requests |
|---|---|
| Endpoint discovery | 1 (0 if cached) |
| Mandate/credential verification | 1 |
| Permission check and record-generation request | 1 |
| Server-side record generation | 0 (server time) |
| Transfer/download | 1 |
| Local receipt and hash check | 0 |
| Expected retries with backoff | – |

| Path | Model requests | Tool invocations | Network/page requests | Seconds |
|---|---|---|---|---|
| C, **toy network subtotal** (4 × 50 ms) | 0 | 4 | 4 | **0.2** |
| C, parametric lean / central / friction | 0 | 4.04 / 4.08 / 4.2 | 4.04 / 4.08 / 4.2 | 0.62 / 2.90 / 61.2 |
| B connector, warm grant | 3.06 | 3.06 | 3.06 | 38.3 |
| A_batch browser, warm session | 4.5 | 10.5 | 5.25 | 105.8 |
| A_step browser, warm session | 11.5 | 10.5 | 5.25 | 153.8 |

The 200 ms figure is only the round-trip arithmetic for four requests. It leaves out:

- server processing;
- record generation, which may be asynchronous;
- TLS and queueing;
- rate limits;
- retries.

It is not demonstrated latency or observed performance, so it is at most a toy network subtotal. Even our parametric C values are assumptions. Cold authentication adds about 80.6 s plus a human MFA step per A_batch session, 25.5 s plus an OAuth consent for B, and a human mandate grant for C.

## 7. Energy and carbon

We give a formula, not a footprint. The kPTE value (thousands of prefill-token equivalents) is a weighted token proxy under the coefficients we chose. It is not hardware-derived energy and cannot be read as energy without deployment-specific calibration:

> E = (U + W + κ·R + β·O) / 1000

| Symbol | Meaning |
|---|---|
| U | uncached input tokens |
| W | cache writes, which need full prefill |
| R | cache reads, at relative cost κ |
| O | output tokens, at relative cost β |

It converts as Wh = E · e_ref · PUE and gCO₂e = Wh/1000 · I_grid(location, time). Here e_ref is deployment-specific, depending on hardware, model size, provider batching and utilisation. Absolute conversion is disabled by default.

At κ = 0.1 and β = 5, the central totals are 7,718, 3,911, 2,799 and 391 kPTE for A_step, A_batch, B and C. Across κ ∈ {0.05, 0.1, 0.3} and β ∈ {2, 5, 20}, A_batch/C stays between about 9.5 and 12.5.

This ratio covers the inference term only. Three things limit it:

- **Unconverted drivers.** These are left unconverted: browser-host seconds, external requests, server-side record generation and permission services in C, and fixed infrastructure.
- **Shifted work.** Fewer or faster calls do not prove lower total energy, because work may shift to servers or into longer calls.
- **Training.** Training energy is an allocation question and is never added per call.

Google's measured 0.24 Wh for the median Gemini Apps text prompt (May 2025, under Google's full-stack boundary) is non-transferable background from a different workload and model mix. We do not multiply it by our request counts, and we give no provider-specific gCO₂e figure.

## 8. Related evidence and statistics

We do not estimate what share of future agent tasks are routine. No verified source supports such a figure. The best available workload statistics each count a different denominator, and none counts agent executions:

| Source | Denominator | Anchor | What it is not |
|---|---|---|---|
| OpenAI/NBER, *How People Use ChatGPT* (Sep 2025) | ~1.1m sampled consumer conversations, one sampled message per conversation | Practical Guidance, Seeking Information and Writing ≈ 77–78% of messages | Agent executions or external transactions |
| Anthropic Economic Index (Jan 2026 report, Nov 2025 data) | Sampled Claude.ai conversations | 52% augmentation, 45% automation | A routine-workload share; covers Claude users only |
| MyPCBench (Jun 2026) | 184 curated tasks rewritten from 2,749 OpenClaw community requests | 68% multi-application | A population sample; the community is self-selected |
| Pew, *Americans and AI, 2026* | 5,119 US adults, weighted survey | 49% have ever used a chatbot; reasons overlap (non-exclusive) | Task frequency; it measures people's ever-use |

**One real trace, as illustration only.** A public OSWorld 2 image-editing trajectory (`061-5e7d98d7`, Holo4 27B, publisher-reported score 1) records 11 model steps and 15 tool calls: 2 plan updates, 7 shell commands, 5 image views and 1 answer. Three of the 11 steps emit several calls. Its reported end-to-end duration is 263.1 s. We independently counted the steps and calls in the downloaded raw file; we did not re-run it. It is not a mortgage, not representative and not used for calibration. It shows concretely that model calls and actions are different counts.

- **Architecture affects outcomes.** Wharton found that bundled versus split tool calls changed shopping agents' choices. Cost comparisons are therefore meaningful only when outcomes are held equal.
- **B exists today.** Product documentation shows working parts of B: Plaid-powered financial context in Muse, secure sign-in that pauses the model, read-only proactive research and outside-agent review in dots. Lender-side delegation through Fannie Mae, Freddie Mac and IRS IVES already exists, and our borrower-side count excludes it.

## 9. Limitations

- **The counts are invented.** Every count in Table 2 is an assumption. Lean, central and friction scenarios are stated sensitivities, not confidence intervals.
- **One shape, not a population.** A single case cannot represent self-employment, gifts, FHA or VA loans, refinances, brokers or state-specific practice.
- **Some assumptions favour one side.** The token sizes and C's smaller contexts favour C. Exceptions and questions are held equal, though real C deployments may face different failure modes. B's model-free polling favours B.
- **Service latency is flat.** It ignores queueing and server-side generation, except in the bank example.
- **Retries are optimistic.** Each failure gets one successful repair attempt. Repeated failures and abandoned tasks are not costed.
- **The schedule is conditional.** The parallel schedule follows fixed rules rather than an optimised dependency graph, so it can overstate the time for mixed B stages.
- **C's event count is assumed.** C's status updates are assumed to equal B's polls. Real update frequencies may differ.
- **Outcomes are not modelled.** We model no lender choice quality, no duplicate or erroneous submissions and no prompt-injection exposure, although these vary by architecture.
- **Integration costs are excluded.** Developer setup, registry and certification costs are not modelled.

## 10. What would validate this

**Observational study.** The denominator should include both *user goals* (one mortgage) and *routine executable substeps* (each retrieval, entry, transfer and checkpoint). The study should:

- record successful and failed attempts, retries and abandonment;
- sample across users, lenders, institutions, regions and loan types;
- measure human time and recipient burden (messages to loan officers, appraisers and employers);
- collect privacy-respecting, redacted logs that keep counts, types, timings and hashes but not content, under consent.

A task may combine standard substeps with novel reasoning, so the coding scheme should work at the substep level.

**Controlled end-to-end experiment.** The experiment should:

- run A, B and C on identical data, authority and target outcome in instrumented sandboxed lender and bank services;
- inject faults (portal errors, expired sessions, ambiguous conditions, poisoned pages);
- use multiple seeds and locked model and harness versions;
- test both warm and cold cache and authentication;
- meter requests, tokens, latency and energy, including server-side work;
- score full success and safety: right lender, no unauthorised submission, no duplicate messages, correct consent scope;
- report comparative developer setup and maintenance effort.

Only such a design can show whether the call, latency or energy differences here survive equal outcomes.

## 11. Reproduce

```
python3 mortgage_compute.py
```

The command writes the following files:

| File | Contents |
|---|---|
| `mortgage-compute-results.json` / `.csv` | exact values |
| `mortgage-compute-inventory.csv` | per-stage values |
| `mortgage-compute-sensitivity.csv` | sensitivity runs |
| `mortgage-compute-energy.csv` | energy coefficient sweep |
| `mortgage-compute-bank-example.csv` | bank mini-example |
| `mortgage-compute-checks.json` | check results |
| `mortgage-compute-summary.md` | rounded tables |

Before computing anything, the script validates every scenario and merged sensitivity input. It requires:

- finite, non-negative counts, prices, tokens and latencies;
- positive integer batch sizes and parallel width;
- retry fractions between 0 and 1;
- cache read plus write of at most 1, with no reads of tokens never written.

Boundary tests confirm that malformed cache fractions, a zero batch, non-finite values and a bad sensitivity override are all rejected. Invalid inputs stop the run with no results.

The checks then cover:

- scope equality across architectures;
- cache validity;
- the long-context cap;
- schedule-estimate bounds;
- that stage costs sum to totals;
- determinism;
- that C keeps residual LLM work;
- the hand-computed values in this paper.

Sensitivity runs feed the same checks. The script exits 1 on any failure or mismatch.

## References

1. CFPB, Contact multiple lenders. https://www.consumerfinance.gov/owning-a-home/explore/contact-multiple-lenders/
2. CFPB, What do I have to do to apply for a mortgage loan? https://www.consumerfinance.gov/ask-cfpb/what-do-i-have-to-do-to-apply-for-a-mortgage-loan-en-144/
3. CFPB, When will a lender run a credit check? https://www.consumerfinance.gov/ask-cfpb/when-will-a-lender-run-a-credit-check-or-obtain-a-copy-of-my-credit-report-en-322/
4. 12 CFR 1026.19 (Regulation Z). https://www.consumerfinance.gov/rules-policy/regulations/1026/19/
5. CFPB, What does Intent to Proceed mean? https://www.consumerfinance.gov/ask-cfpb/my-loan-officer-said-that-i-need-to-express-my-intent-to-proceed-in-order-for-my-mortgage-loan-application-to-move-forward-what-does-that-mean-en-1989/
6. CFPB, What is a Closing Disclosure? https://www.consumerfinance.gov/ask-cfpb/what-is-a-closing-disclosure-en-1983/
7. CFPB, Questions about the closing process? https://www.consumerfinance.gov/owning-a-home/mortgage-closing/
8. IRS, Income Verification Express Service. https://www.irs.gov/individuals/income-verification-express-service
9. Fannie Mae, Introduction to Asset Validation (2025). https://singlefamily.fanniemae.com/media/document/pdf/introduction-asset-validation
10. Freddie Mac, AIM Capabilities. https://sf.freddiemac.com/tools-learning/technology-tools/our-solutions/aim-eligibility-table
11. CFPB, Personal Financial Data Rights status. https://www.consumerfinance.gov/compliance/compliance-resources/other-applicable-requirements/personal-financial-data-rights/
12. Plaid, Plaid powers Meta's new AI agent, Muse (2026-09-08). https://plaid.com/blog/meta-muse/
13. Meta, Introducing Muse (2026-09-08). https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
14. Meta, Security and safety for AI agents: our approach with Muse. https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
15. OpenAI, How we build safety, security and privacy into dots (2026-09-29). https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/
16. OpenAI, GPT-6 Astra model page (Standard pricing; verified 2026-10-17). https://developers.openai.com/api/docs/models/gpt-6-astra
17. Anthropic, Claude Opus 5.5 overview (pricing; verified 2026-10-17). https://platform.claude.com/docs/en/models/opus-5-5/overview
18. Kumar et al., Agentic Shopping is Complicated and Contingent (2026-08-27). https://gail.wharton.upenn.edu/research-and-insights/technical-report-agentic-shopping/
19. Google, Measuring the environmental impact of delivering AI at Google Scale (Aug 2025; May 2025 median Gemini Apps text prompt, 0.24 Wh). https://arxiv.org/abs/2508.15734
20. OpenAI and NBER, How People Use ChatGPT (Sep 2025). https://cdn.openai.com/pdf/a253471f-8260-40c6-a2cc-aa93fe9f142e/economic-research-chatgpt-usage-paper.pdf ; https://www.nber.org/papers/w34255
21. Anthropic, Anthropic Economic Index: January 2026 report. https://www.anthropic.com/research/anthropic-economic-index-january-2026-report
22. MyPCBench (Jun 2026). https://arxiv.org/abs/2606.16748
23. Pew Research Center, Americans and AI, 2026 (17 Jun 2026). https://www.pewresearch.org/internet/2026/06/17/americans-and-ai-2026-chatbots-smart-devices-and-views-on-impact/
24. H Company, Holo4 trajectory 061-5e7d98d7 (OSWorld 2; retrieved 2026-10-17; audit in PUBLIC-TRACE-AUDIT.json). https://huggingface.co/datasets/Hcompany/trajectories/resolve/main/data/t/061-5e7d98d7.json
25. Companion study: [MORTGAGE-DISCOVERY-STUDY.md](MORTGAGE-DISCOVERY-STUDY.md) (lender discovery; count discovery once when combining).
