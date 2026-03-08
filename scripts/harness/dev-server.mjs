import { resolve } from 'node:path';
import process from 'node:process';
import { createServer } from 'vite';
import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const host = process.env.DISCODE_APP_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.DISCODE_APP_PORT || '4173', 10);
const worktreeId = process.env.DISCODE_WORKTREE_ID || 'unknown-worktree';
const logEndpoint = process.env.LOG_ENDPOINT;
const otlpBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const bootStartedAt = Date.now();

let telemetrySdk;
let tracer = trace.getTracer('discode.harness.noop');
let meter = metrics.getMeter('discode.harness.noop');

function buildJsonResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function postStructuredLog(payload) {
  if (!logEndpoint) return;

  try {
    await fetch(logEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Observability must stay best-effort.
  }
}

async function startTelemetry() {
  if (!otlpBase) return;

  const resource = resourceFromAttributes({
    'service.name': 'discode-site-dev',
    'service.version': process.env.npm_package_version || 'dev',
    'service.instance.id': worktreeId,
    'deployment.environment': 'development',
    'discode.worktree_id': worktreeId,
    'discode.app': 'site',
  });

  telemetrySdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${otlpBase}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${otlpBase}/v1/metrics` }),
      exportIntervalMillis: 1000,
    }),
  });

  await telemetrySdk.start();

  tracer = trace.getTracer('discode.harness.dev-server');
  meter = metrics.getMeter('discode.harness.dev-server');
}

await startTelemetry();

const requestCounter = meter.createCounter('discode_site_requests_total', {
  description: 'HTTP requests served by the worktree Vite harness.',
});
const requestDuration = meter.createHistogram('discode_site_request_duration_ms', {
  description: 'HTTP request duration for the worktree Vite harness.',
  unit: 'ms',
});
const bootDuration = meter.createHistogram('discode_site_boot_duration_ms', {
  description: 'Time spent booting the worktree Vite harness.',
  unit: 'ms',
});

const viteServer = await createServer({
  configFile: false,
  root: resolve(repoRoot, 'site'),
  cacheDir: process.env.DISCODE_VITE_CACHE_DIR || resolve(repoRoot, '.worktree', worktreeId, 'vite-cache'),
  plugins: [
    {
      name: 'discode-harness-health',
      configureServer(server) {
        server.middlewares.use('/__harness/health', (_req, res) => {
          buildJsonResponse(res, 200, {
            ok: true,
            app: 'discode-site-dev',
            worktree_id: worktreeId,
            url: `http://${host}:${port}/`,
            healthcheck_url: `http://${host}:${port}/__harness/health`,
            started_at: new Date(bootStartedAt).toISOString(),
            port,
          });
        });
      },
    },
  ],
  server: {
    host,
    port,
    strictPort: true,
  },
});

viteServer.middlewares.use((req, res, next) => {
  const startedAt = Date.now();
  const span = tracer.startSpan('site.request', {
    attributes: {
      'http.request.method': req.method || 'GET',
      'url.path': req.url || '/',
      'discode.worktree_id': worktreeId,
    },
  });

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const attributes = {
      method: req.method || 'GET',
      route: req.url || '/',
      status_code: res.statusCode,
      worktree_id: worktreeId,
    };

    requestCounter.add(1, attributes);
    requestDuration.record(durationMs, attributes);
    span.setAttribute('http.response.status_code', res.statusCode);
    if (res.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();

    void postStructuredLog({
      app: 'discode-site-dev',
      level: res.statusCode >= 500 ? 'error' : 'info',
      event: 'http_request',
      worktree_id: worktreeId,
      method: req.method || 'GET',
      route: req.url || '/',
      status_code: res.statusCode,
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
    });
  });

  next();
});

const bootSpan = tracer.startSpan('site.boot', {
  attributes: {
    'discode.worktree_id': worktreeId,
    'discode.app': 'site',
    'discode.port': port,
  },
});

await viteServer.listen();

const startupDurationMs = Date.now() - bootStartedAt;
bootDuration.record(startupDurationMs, { worktree_id: worktreeId });
bootSpan.end();

void postStructuredLog({
  app: 'discode-site-dev',
  level: 'info',
  event: 'server_ready',
  worktree_id: worktreeId,
  port,
  url: `http://${host}:${port}/`,
  startup_duration_ms: startupDurationMs,
  timestamp: new Date().toISOString(),
});

const shutdown = async (signal) => {
  void postStructuredLog({
    app: 'discode-site-dev',
    level: 'info',
    event: 'server_stopping',
    worktree_id: worktreeId,
    signal,
    timestamp: new Date().toISOString(),
  });

  await viteServer.close();
  if (telemetrySdk) {
    await telemetrySdk.shutdown().catch(() => {});
  }
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
