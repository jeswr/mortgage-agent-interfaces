# Mortgage agent interfaces

Testbed, run logs and paper for a controlled comparison of how many model requests, tokens and seconds a personal AI agent needs to complete the same synthetic mortgage application through:

- websites built for people,
- a different API at each organization, or
- one common agent API with server-side permission checks,

with the model orchestrating the steps or with ordinary code running the routine steps.

Paper: [`paper/main.pdf`](paper/main.pdf) ("How Many Model Calls Does a Delegated Mortgage Application Take?").

## Main result

Claude Sonnet 5.5, five runs per set-up, 29 October 2026 (medians):

| Set-up | Model requests | Total tokens | Wall time |
|---|---|---|---|
| Websites only | 83 | 4.13M | 345 s |
| Per-organization APIs, lender by website | 46 | 2.32M | 230 s |
| Per-organization APIs everywhere | 16 | 0.50M | 108 s |
| Common agent API | 12 | 0.35M | 66 s |
| Per-organization APIs, routine steps in code | 2 | 0.02M | 23 s |
| Common agent API, routine steps in code | 2 | 0.02M | 22 s |

126 runs in total, across five conditions (baseline, friction, a lender asking for more than authorized, an out-of-limits offer, and a realistic condition with lender choice and human sign-in steps), seven set-ups (including an RDF/JSON-LD variant of the common API with a SPARQL index) and two models. `paper/realism-survey.md` compares each part of the sandbox with services that exist today. Full results, method and threats to validity: [`results/README.md`](results/README.md).

## Layout

- `testbed/`: mock organizations (`server.js`), agent runner, MCP tool servers, the two orchestrator programs, logging proxy, checker and summarizer.
- `results/runs.jsonl`: one line per run. `results/summary.csv`: medians and IQRs per condition, set-up and model.
- `results/raw/<run>/`: per-run agent transcript, proxy usage log (no request bodies), server request log, final state and checker output.
- `paper/`: LaTeX source and PDF.
- `notes/scenario-estimate/`: the earlier assumption-based calculator that this experiment replaces.

All people, organizations, accounts and credentials are synthetic. Everything runs on 127.0.0.1; the only external traffic is the agent runtime's calls to the model API.

## Reproduce

Requires Node 20+, the Claude Code CLI (`claude`) signed in, and Playwright's Chromium.

```bash
./testbed/run.sh <A|B|B-full|C1|C2|B-full-code> <model> <n> [slot]
node testbed/summarize.js
```

Conditions are selected as described in `results/README.md`.

## Licence

Code: MIT (see `LICENSE`). Data, run logs and paper: CC BY 4.0.

## Versions and citation

Releases are versioned with semantic-release from Conventional Commit messages (`feat:` gives a minor release, `fix:` a patch, a `BREAKING CHANGE:` footer a major one). Each GitHub release is archived by Zenodo, which assigns it a DOI; cite the version you used. See `CITATION.cff` and `CHANGELOG.md`.
