"use strict";

/**
 * Benchmark — Load testing script for the AWA Worker.
 *
 * Sends a configurable number of concurrent requests to the worker's
 * /v1/awa/execute endpoint and reports latency percentiles.
 *
 * Usage:
 *   node scripts/benchmark.js [options]
 *
 * Options:
 *   --url       Worker URL (default: http://localhost:8080)
 *   --concurrency  Number of concurrent requests (default: 10)
 *   --total     Total number of requests (default: 100)
 *   --domain    Merchant domain to test (default: bestbuy.com)
 */

const http = require("http");

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = {};
process.argv.slice(2).forEach((arg) => {
  const [key, val] = arg.split("=");
  if (key.startsWith("--")) {
    args[key.slice(2)] = val || true;
  }
});

const WORKER_URL = args.url || "http://localhost:8080";
const CONCURRENCY = parseInt(args.concurrency, 10) || 10;
const TOTAL = parseInt(args.total, 10) || 100;
const DOMAIN = args.domain || "bestbuy.com";

const { hostname, port } = new URL(WORKER_URL);
const requestBody = JSON.stringify({
  domain: DOMAIN,
  sku: "6534211",
  targetUrl: `https://www.${DOMAIN}/site/product/6534211`,
  quantity: 1,
});

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

let completed = 0;
let errors = 0;
const latencies = [];

function sendRequest() {
  return new Promise((resolve) => {
    const start = Date.now();

    const options = {
      hostname,
      port,
      path: "/v1/awa/execute",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestBody),
      },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const duration = Date.now() - start;
        latencies.push(duration);

        if (res.statusCode !== 200) {
          errors++;
        }

        completed++;
        resolve();
      });
    });

    req.on("error", (err) => {
      const duration = Date.now() - start;
      latencies.push(duration);
      errors++;
      completed++;
      resolve();
    });

    req.on("timeout", () => {
      req.destroy();
    });

    req.write(requestBody);
    req.end();
  });
}

async function worker() {
  while (completed < TOTAL) {
    await sendRequest();
  }
}

async function run() {
  console.log("=== AWA Worker Benchmark ===");
  console.log(`  Worker URL:   ${WORKER_URL}`);
  console.log(`  Concurrency:  ${CONCURRENCY}`);
  console.log(`  Total:        ${TOTAL}`);
  console.log(`  Domain:       ${DOMAIN}`);
  console.log("");

  const startTime = Date.now();

  // Launch concurrent workers
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const totalTime = Date.now() - startTime;
  const sorted = [...latencies].sort((a, b) => a - b);

  // Calculate percentiles
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;

  console.log("=== Results ===");
  console.log(`  Total time:   ${totalTime}ms`);
  console.log(`  Requests:     ${TOTAL}`);
  console.log(`  Errors:       ${errors}`);
  console.log(`  Throughput:   ${((TOTAL / totalTime) * 1000).toFixed(1)} req/s`);
  console.log("");
  console.log("  Latencies:");
  console.log(`    Avg:    ${avg.toFixed(0)}ms`);
  console.log(`    P50:    ${p50}ms`);
  console.log(`    P90:    ${p90}ms`);
  console.log(`    P95:    ${p95}ms`);
  console.log(`    P99:    ${p99}ms`);
  console.log(`    Min:    ${sorted[0]}ms`);
  console.log(`    Max:    ${sorted[sorted.length - 1]}ms`);
}

run().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
