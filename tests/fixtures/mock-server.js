"use strict";

/**
 * Mock Merchant Site — A minimal Express server that simulates a merchant
 * product page for integration/E2E testing of the AWA worker.
 *
 * Serves:
 *   GET  /product/:sku       — Product page with Add to Cart + Checkout buttons
 *   POST /cart/add           — Add item to cart
 *   GET  /cart               — View cart
 *   POST /checkout           — Complete checkout
 *
 * The mock site uses simple HTML pages that the AWA worker's Playwright
 * browser can navigate and interact with using $awa.* primitives.
 */

const express = require("express");
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory "database"
// ---------------------------------------------------------------------------

const products = {
  6534211: {
    name: "Sample Product 6534211",
    price: 49.99,
    inStock: true,
  },
  1234567: {
    name: "Another Product",
    price: 99.99,
    inStock: true,
  },
  OUTOFSTOCK: {
    name: "Unavailable Item",
    price: 29.99,
    inStock: false,
  },
};

let carts = {};

// ---------------------------------------------------------------------------
// Product page — serves a minimal HTML product page
// ---------------------------------------------------------------------------

app.get("/product/:sku", (req, res) => {
  const product = products[req.params.sku];
  if (!product) {
    return res.status(404).send("<html><body><h1>Product Not Found</h1></body></html>");
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>${product.name} — Mock Merchant</title>
</head>
<body>
  <div class="product-container">
    <h1 class="product-title">${product.name}</h1>
    <p class="product-price">$${product.price.toFixed(2)}</p>
    <p class="product-sku">SKU: ${req.params.sku}</p>
    ${
      product.inStock
        ? '<button class="add-to-cart-button" data-sku="' +
          req.params.sku +
          '">Add to Cart</button>'
        : '<p class="out-of-stock">Out of Stock</p>'
    }
    <a class="checkout-link" href="/cart">View Cart</a>
  </div>
</body>
</html>
  `);
});

// ---------------------------------------------------------------------------
// Add to cart
// ---------------------------------------------------------------------------

app.post("/cart/add", (req, res) => {
  const { sku, quantity } = req.body;
  const product = products[sku];
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }
  if (!product.inStock) {
    return res.status(400).json({ error: "Out of stock" });
  }

  const sessionId = req.headers["x-session-id"] || "default";
  if (!carts[sessionId]) {
    carts[sessionId] = [];
  }
  carts[sessionId].push({ sku, quantity: quantity || 1, name: product.name, price: product.price });

  res.json({ status: "added", cartSize: carts[sessionId].length });
});

// ---------------------------------------------------------------------------
// View cart
// ---------------------------------------------------------------------------

app.get("/cart", (req, res) => {
  const sessionId = req.headers["x-session-id"] || "default";
  const cart = carts[sessionId] || [];
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Cart — Mock Merchant</title>
</head>
<body>
  <div class="cart-container">
    <h1>Shopping Cart</h1>
    <p class="cart-count">${cart.length} item(s)</p>
    <ul class="cart-items">
      ${cart.map((item, i) => `<li class="cart-item-${i}">${item.name} x${item.quantity} — $${(item.price * item.quantity).toFixed(2)}</li>`).join("")}
    </ul>
    <p class="cart-total">Total: $${total.toFixed(2)}</p>
    <a class="checkout-button" href="/checkout">Proceed to Checkout</a>
  </div>
</body>
</html>
  `);
});

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

app.get("/checkout", (req, res) => {
  const sessionId = req.headers["x-session-id"] || "default";
  const cart = carts[sessionId] || [];
  if (cart.length === 0) {
    return res.send("<html><body><h1>Cart is empty</h1></body></html>");
  }

  const orderId = "ORD-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  delete carts[sessionId];

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Checkout — Mock Merchant</title>
</head>
<body>
  <div class="checkout-container">
    <h1>Order Complete</h1>
    <p class="order-id">Order: ${orderId}</p>
    <p class="checkout-success">Thank you for your purchase!</p>
  </div>
</body>
</html>
  `);
});

// ---------------------------------------------------------------------------
// Reset (for test cleanup)
// ---------------------------------------------------------------------------

app.post("/reset", (req, res) => {
  carts = {};
  res.json({ status: "reset" });
});

// ---------------------------------------------------------------------------
// Start server (only when run directly)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.MOCK_PORT, 10) || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Mock merchant site running on http://localhost:${PORT}`);
  });
}

module.exports = app;
