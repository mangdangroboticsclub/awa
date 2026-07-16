"use strict";

/**
 * Test fixtures for the script screener.
 */

/** A valid merchant skill script */
const validScript = `
async function execute({ targetUrl, sku, quantity }) {
  await $awa.navigate(targetUrl);
  await $awa.waitForSelector(".product-title", 10000);
  const title = await $awa.extractText(".product-title");
  await $awa.click(".add-to-cart-button");
  return { status: "success", checkoutUrl: "https://example.com/checkout/" + sku };
}
`;

/** Script using forbidden 'process' identifier */
const scriptWithProcess = `
async function execute() {
  const env = process.env;
  return { status: "success" };
}
`;

/** Script using forbidden 'require' identifier */
const scriptWithRequire = `
const fs = require('fs');
async function execute() {
  return { status: "success" };
}
`;

/** Script using forbidden 'eval(' pattern */
const scriptWithEval = `
async function execute() {
  eval("doSomething()");
  return { status: "success" };
}
`;

/** Script using forbidden 'Function(' pattern */
const scriptWithFunction = `
async function execute() {
  const fn = Function("return 1")();
  return { status: "success" };
}
`;

/** Script with no execute function */
const scriptNoExecute = `
async function doSomething() {
  return { status: "success" };
}
`;

/** Max size violation */
const oversizedScript = "x".repeat(11 * 1024 * 1024);

/** Script using const assignment (valid) */
const scriptWithConstExecute = `
const execute = async function({ targetUrl }) {
  await $awa.navigate(targetUrl);
  return { status: "success" };
};
`;

/** Script with global reference */
const scriptWithGlobal = `
async function execute() {
  const g = global;
  return { status: "success" };
}
`;

/** Script with import() */
const scriptWithImport = `
async function execute() {
  const mod = import("./something");
  return { status: "success" };
}
`;

module.exports = {
  validScript,
  scriptWithProcess,
  scriptWithRequire,
  scriptWithEval,
  scriptWithFunction,
  scriptNoExecute,
  oversizedScript,
  scriptWithConstExecute,
  scriptWithGlobal,
  scriptWithImport,
};
