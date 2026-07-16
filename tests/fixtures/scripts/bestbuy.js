"use strict";

/* global $awa */

/**
 * Sample merchant skill script for bestbuy.com.
 *
 * This is a test fixture that demonstrates the expected script format.
 * The script must export an async function named "execute".
 *
 * Usage:
 *   const result = await execute({ targetUrl, sku, quantity, options });
 *
 * The sandbox injects $awa.* primitives for browser interaction:
 *   $awa.navigate(url)
 *   $awa.click(selector)
 *   $awa.type(selector, text)
 *   $awa.extractText(selector)
 *   etc.
 *
 * See SECURITY.md §3.3 for the full API reference.
 */

async function execute({ targetUrl, sku, quantity }) {
  // Navigate to the product page
  await $awa.navigate(targetUrl);

  // Wait for the product to load
  await $awa.waitForSelector(".product-title", 10000);

  // Get the product title
  const title = await $awa.extractText(".product-title");

  // Check if "Add to Cart" button exists
  const addToCartBtn = await $awa.extractText(".add-to-cart-button");

  // Click add to cart
  await $awa.click(".add-to-cart-button");

  // Wait for the cart to update
  await $awa.waitForSelector(".cart-count", 5000);

  // Navigate to checkout
  await $awa.click(".checkout-button");
  await $awa.waitForNavigation();

  // Return the checkout URL
  return {
    status: "success",
    checkoutUrl: "https://www.bestbuy.com/checkout/" + sku,
  };
}

module.exports = { execute };
