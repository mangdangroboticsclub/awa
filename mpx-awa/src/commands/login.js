"use strict";

/**
 * mpx-awa login — Authenticate with the MPX gateway and store a JWT token.
 *
 * Usage:
 *   mpx-awa login <username> <password>
 *   MPX_GATEWAY_URL=http://<gateway-host>:8080 mpx-awa login haris_dev password123
 *
 * The token is stored at ~/.mpx-awa-token for use by `mpx-awa publish`.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TOKEN_FILE = path.join(os.homedir(), ".mpx-awa-token");

function getGatewayUrl(hostOpt) {
  return hostOpt || process.env.MPX_GATEWAY_URL || "http://localhost:8080";
}

function apiPost(url, jsonBody) {
  const urlObj = new URL(url);
  const body = JSON.stringify(jsonBody);
  const mod = urlObj.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 15000,
    };

    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: { raw: data } });
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.write(body);
    req.end();
  });
}

module.exports = function login(username, password, hostOpt) {
  const gatewayUrl = getGatewayUrl(hostOpt);
  const loginUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/auth/login`;

  console.log(`Authenticating with ${gatewayUrl}...`);

  apiPost(loginUrl, { username, password })
    .then((res) => {
      if (res.status === 200 && res.body.token) {
        const token = res.body.token;
        fs.writeFileSync(TOKEN_FILE, token, "utf-8");
        fs.chmodSync(TOKEN_FILE, 0o600);
        console.log(`  ✅ Login successful. Token stored at ${TOKEN_FILE}`);
        console.log(`  ⏰ Expires in ${res.body.expires_in || 86400}s`);
      } else {
        const msg = res.body.error || `HTTP ${res.status}`;
        console.error(`  ✗ Login failed: ${msg}`);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`  ✗ Connection failed: ${err.message}`);
      process.exit(1);
    });
};
