# Implement Local Observability Stack

Set up an ephemeral, per-worktree observability stack so coding agents can query logs, metrics, and traces from a running app instance. The stack is fully isolated per worktree and torn down when the task completes.

With this stack in place, prompts like "ensure service startup completes in under 800ms" or "no span in these four critical user journeys exceeds two seconds" become tractable — the agent can query real telemetry, reason about it, implement a fix, restart the app, and verify the improvement.

## Architecture

```
APP
 │
 ├── Logs (HTTP)
 ├── OTLP Metrics
 └── OTLP Traces
      │
      ▼
   VECTOR  (fan-out, local)
   ├──────────► Victoria Logs    ──► LogQL API
   ├──────────► Victoria Metrics ──► PromQL API
   └──────────► Victoria Traces  ──► TraceQL API
                                        │
                                        ▼
                                  Coding Agent
                                  (query, correlate, reason)
                                        │
                                        ▼
                                  Implement change + restart app
                                        │
                                        ▼
                                  Re-run workload + verify
```

### Components

| Component | Role | Ingest protocol | Query API |
|---|---|---|---|
| **Vector** | Telemetry collector and local fan-out | Receives logs (HTTP), OTLP metrics, OTLP traces from the app | N/A |
| **Victoria Logs** | Log storage and query engine | Receives logs from Vector | LogQL |
| **Victoria Metrics** | Metrics storage and query engine | Receives OTLP metrics from Vector | PromQL |
| **Victoria Traces** | Trace storage and query engine | Receives OTLP traces from Vector | TraceQL |

## Step 1: Understand the repository

Before implementing, explore the repository to determine:

- **What the app already emits**: Does it have structured logging? Does it emit OTLP telemetry? What libraries or frameworks are in use?
- **Worktree setup**: Is there an existing worktree-aware boot flow (e.g., from `execution-env-setup.md`)? The observability stack must integrate with it.
- **Existing Docker/container usage**: Is Docker Compose or similar already in use? The stack services can run as containers or as standalone binaries.

## Step 2: Set up Vector as the telemetry collector

Vector is the single collection point. The app sends all telemetry to Vector, and Vector fans out to the three Victoria services.

### What Vector must do

- Accept **HTTP logs** from the app (e.g., on a local port)
- Accept **OTLP metrics** from the app (OTLP/gRPC or OTLP/HTTP)
- Accept **OTLP traces** from the app (OTLP/gRPC or OTLP/HTTP)
- Forward logs to Victoria Logs
- Forward metrics to Victoria Metrics
- Forward traces to Victoria Traces

### Worktree isolation

- All Vector ports must be derived from the worktree ID to avoid collisions across worktrees.
- Vector's data directory must be worktree-scoped.
- The Vector config file can be a shared template with ports injected at startup.

### Configuration

Create a Vector config template (`scripts/observability/vector.toml` or similar) that defines:

- **Sources**: HTTP log receiver, OTLP receiver
- **Sinks**: Victoria Logs (HTTP), Victoria Metrics (remote write / OTLP), Victoria Traces (OTLP)

All sink endpoints should use worktree-derived ports.

## Step 3: Set up Victoria Logs

Victoria Logs stores and queries logs via a LogQL-compatible API.

### What to configure

- Listen port derived from worktree ID
- Data storage directory scoped to the worktree (e.g., `.worktree/<id>/victoria-logs/`)
- Retention policy: short-lived, no need for long retention — this is ephemeral

### How the agent queries logs

The agent uses the LogQL API to query logs:

```
GET http://localhost:<vlogs-port>/select/logsql/query?query=<LogQL expression>
```

Example queries the agent might run:

- `{app="myservice"} |= "error"` — find error logs
- `{app="myservice"} | json | duration > 800ms` — find slow operations
- `{app="myservice", level="error"} | line_format "{{.msg}}"` — extract error messages

## Step 4: Set up Victoria Metrics

Victoria Metrics stores and queries metrics via a PromQL-compatible API.

### What to configure

- Listen port derived from worktree ID
- Data storage directory scoped to the worktree (e.g., `.worktree/<id>/victoria-metrics/`)
- Accept OTLP metrics ingestion (via `-openTelemetryListenAddr` flag or similar)

### How the agent queries metrics

The agent uses the PromQL API:

```
GET http://localhost:<vmetrics-port>/api/v1/query?query=<PromQL expression>
GET http://localhost:<vmetrics-port>/api/v1/query_range?query=<PromQL>&start=<t>&end=<t>&step=<s>
```

Example queries:

- `http_request_duration_seconds{quantile="0.99"}` — p99 latency
- `rate(http_requests_total[1m])` — request rate
- `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))` — p95 from histogram

## Step 5: Set up Victoria Traces

Victoria Traces stores and queries distributed traces via a TraceQL-compatible API.

### What to configure

- Listen port derived from worktree ID
- Data storage directory scoped to the worktree (e.g., `.worktree/<id>/victoria-traces/`)
- Accept OTLP trace ingestion

### How the agent queries traces

The agent uses the TraceQL API:

```
GET http://localhost:<vtraces-port>/api/v3/search?query=<TraceQL expression>
```

Example queries:

- `{resource.service.name="myservice" && duration > 2s}` — find slow traces
- `{span.http.status_code >= 500}` — find error spans
- `{name="user.checkout" && duration > 800ms}` — find slow checkout journeys

## Step 6: Instrument the app

Ensure the app emits telemetry that Vector can collect:

- **Logs**: The app should send structured logs (JSON) to Vector's HTTP log source. If the app already writes to stdout, Vector can also tail a log file.
- **Metrics**: The app should emit OTLP metrics to Vector's OTLP receiver. Use the appropriate OpenTelemetry SDK for the project's language.
- **Traces**: The app should emit OTLP traces to Vector's OTLP receiver. Use the OpenTelemetry SDK with a trace exporter pointed at Vector.

The app should read telemetry endpoints from environment variables so they can be set per worktree:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — Vector's OTLP receiver address
- `LOG_ENDPOINT` — Vector's HTTP log receiver address (or equivalent)

## Step 7: Create lifecycle commands

All lifecycle tools are subcommands of the `harnesscli` CLI under `harnesscli observability`.

### `harnesscli observability start`

Starts the full observability stack for the current worktree:

1. Derive worktree ID and compute ports for Vector, Victoria Logs, Victoria Metrics, Victoria Traces
2. Create worktree-scoped data directories
3. Start Victoria Logs, Victoria Metrics, Victoria Traces as background processes (via `std::process::Command`)
4. Start Vector with the generated config
5. Wait for all services to be healthy (HTTP readiness checks using `reqwest` or `ureq`, not sleeps)
6. Print a JSON metadata block with all endpoints (use `serde_json`):

```json
{
  "worktree_id": "<id>",
  "vector_log_port": 5140,
  "vector_otlp_port": 4317,
  "vlogs_port": 9428,
  "vlogs_query": "http://localhost:9428/select/logsql/query",
  "vmetrics_port": 8428,
  "vmetrics_query": "http://localhost:8428/api/v1/query",
  "vtraces_port": 9428,
  "vtraces_query": "http://localhost:9428/api/v3/search"
}
```

Port numbers above are examples — use worktree-derived values.

Support env var overrides for all ports via `std::env::var`.

### `harnesscli observability stop`

Stops the observability stack for the current worktree:

1. Derive the same worktree ID
2. Stop Vector, Victoria Logs, Victoria Metrics, Victoria Traces (use PID files or process matching)
3. Optionally clean up data directories (use `--clean` flag)

### `harnesscli observability query`

A convenience wrapper for the agent to query any of the three APIs:

```sh
harnesscli observability query logs '{app="myservice"} |= "error"'
harnesscli observability query metrics 'rate(http_requests_total[1m])'
harnesscli observability query traces '{duration > 2s}'
```

Should auto-detect the correct port for the current worktree and format the output as JSON. Use `reqwest` or `ureq` for HTTP requests and `serde_json` for output formatting.

## Step 8: Integrate with app boot flow

If the worktree-aware app boot flow from `execution-env-setup.md` exists:

- `harnesscli observability start` should be called as part of the app startup sequence
- `harnesscli observability stop` should be called during teardown
- The app's environment variables for telemetry endpoints should be set automatically based on the observability stack's metadata output

If no boot flow exists yet, the observability commands should work standalone.

## Agent feedback loop

Once the stack is running, the coding agent operates in a feedback loop:

1. **Query** — run LogQL/PromQL/TraceQL queries to understand current behavior
2. **Correlate** — cross-reference logs, metrics, and traces to identify root causes
3. **Reason** — determine what change is needed
4. **Implement** — make the code change
5. **Restart** — restart the app (observability stack stays running)
6. **Re-run** — exercise the same workload or UI journey
7. **Verify** — query again to confirm the fix meets the requirement

## Deliverables

1. **Vector config template** — `scripts/observability/vector.toml`
2. **Lifecycle commands** — `harnesscli observability start`, `harnesscli observability stop`, `harnesscli observability query`
3. **App instrumentation** — OpenTelemetry SDK setup for the project's language, emitting logs/metrics/traces to Vector
4. **Integration with worktree boot** — observability stack starts/stops with the app

## Non-goals

- Do not deploy a production observability platform.
- Do not set up dashboards or alerting UIs.
- Do not persist telemetry beyond the worktree lifecycle.
- Focus on the minimum stack needed for the coding agent to query, reason, and verify.

## Quality bar

- Fully ephemeral — no state leaks between worktrees
- Deterministic startup with health checks
- All ports derived from worktree ID — safe for parallel use
- Agent can query all three signal types with a single command
- Teardown is clean and complete
