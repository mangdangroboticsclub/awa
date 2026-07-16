"use strict";

function _parseCards(gridHtml) {
  var products = [];
  if (!gridHtml) return products;
  var cardBlocks = [];
  var liRegex = /<li[^>]*class="[^"]*grid__item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  var match;
  while ((match = liRegex.exec(gridHtml)) !== null) { cardBlocks.push(match[1]); }
  if (cardBlocks.length === 0) {
    var wrapperRegex = /<div[^>]*class="[^"]*card-wrapper[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    while ((match = wrapperRegex.exec(gridHtml)) !== null) { cardBlocks.push(match[0]); }
  }
  if (cardBlocks.length === 0) {
    var anyLiRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    while ((match = anyLiRegex.exec(gridHtml)) !== null) {
      var inside = match[1];
      if (inside.indexOf("/products/") !== -1) { cardBlocks.push(match[0]); }
    }
  }
  for (var i = 0; i < cardBlocks.length; i++) {
    var block = cardBlocks[i];
    var sku = null;
    var skuMatch = block.match(/data-product-sku="([^"]+)"/);
    if (skuMatch) sku = skuMatch[1];
    var urlMatch = block.match(/href="(\/products\/[^"]+?)(?:\?|\s|")/);
    var productUrl = urlMatch ? urlMatch[1] : null;
    if (!productUrl) continue;
    var handle = productUrl.replace("/products/", "").split("?")[0];
    var name = null;
    var dataNameMatch = block.match(/data-product-name="([^"]+)"/);
    if (dataNameMatch) name = dataNameMatch[1];
    if (!name) {
      var nameMatch = block.match(/<a[^>]*class="[^"]*full-unstyled-link[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/i);
      if (nameMatch) name = nameMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    if (!name) {
      var nameMatch = block.match(/class="[^"]*card__heading[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h[23]>/i);
      if (nameMatch) name = nameMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    if (!name) {
      var nameMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      if (nameMatch) name = nameMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    var price = null;
    var priceMatch = block.match(/class="[^"]*price-item--sale[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span/i);
    if (priceMatch) price = priceMatch[1].replace(/<[^>]+>/g, "").trim();
    if (!price) {
      priceMatch = block.match(/class="[^"]*price-item--regular[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span/i);
      if (priceMatch) price = priceMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    if (!price) {
      priceMatch = block.match(/class="[^"]*price[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span/i);
      if (priceMatch) price = priceMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    var badges = [];
    var badgeContainer = block.match(/class="[^"]*card__badge[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/div>/i);
    if (badgeContainer) {
      var badgeTexts = badgeContainer[1].replace(/<[^>]+>/g, " ").trim();
      if (badgeTexts) { badgeTexts.split(/\s+/).forEach(function(bt) { bt = bt.trim(); if (bt && bt.length < 25 && badges.indexOf(bt) === -1) { badges.push(bt); } }); }
    }
    var badgeSpans = block.match(/<span[^>]*class="[^"]*badge[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span>/gi);
    if (badgeSpans) { for (var bi = 0; bi < badgeSpans.length; bi++) { var badgeText = badgeSpans[bi].replace(/<[^>]+>/g, "").trim(); if (badgeText && badgeText.length < 30 && badges.indexOf(badgeText) === -1) { badges.push(badgeText); } } }
    var imageUrl = null;
    var imgMatch = block.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
    if (imgMatch) imageUrl = imgMatch[1];
    if (imageUrl && imageUrl.indexOf("//") === 0) { imageUrl = "https:" + imageUrl; }
    products.push({ name: name, sku: sku, handle: handle, url: productUrl, fullUrl: "https://mrbeast.store" + productUrl, price: price, imageUrl: imageUrl, badges: badges.length > 0 ? badges : null });
  }
  return products;
}

module.exports = {
  manifest: {
    domain: "mrbeast.store",
    version: "1.2.0",
    capabilities: ["search", "filterResults", "getProduct", "addToCart", "getCheckoutLink"],
    urls: { search: "https://mrbeast.store/search?q={query}", shop: "https://mrbeast.store/collections/all", product: "https://mrbeast.store/products/:handle", cart: "https://mrbeast.store/cart", checkout: "https://mrbeast.store/checkout" },
  },

  handlers: {

    async search({ query, collection, page }) {
      if (query && query !== "") {
        await $awa.navigate("https://mrbeast.store/search?q=" + encodeURIComponent(query) + "&type=product&options[prefix]=last");
        await $awa.waitForSelector("ul#product-grid, h1, .card-wrapper, div#product-grid, .product-grid, .collection", 15000);
      } else if (collection && collection !== "") {
        await $awa.navigate("https://mrbeast.store/collections/" + collection);
        await $awa.waitForSelector("ul#product-grid, .card-wrapper, .product-grid, div#product-grid, h1", 15000);
      } else {
        await $awa.navigate("https://mrbeast.store/collections/all");
        await $awa.waitForSelector("ul#product-grid, .product-card-wrapper, .card-wrapper", 15000);
      }
      await $awa.sleep(2000);
      var pageTitle = null;
      try { pageTitle = await $awa.extractText("h1"); } catch (e) {}
      var gridHtml = null;
      var gridSelectors = ["div#product-grid", "ul#product-grid", ".product-grid", ".collection", "main#MainContent"];
      for (var s = 0; s < gridSelectors.length; s++) { try { var html = await $awa.extractHtml(gridSelectors[s]); if (html && html.length > 50) { gridHtml = html; break; } } catch (e) {} }
      if (!gridHtml) { try { var cards = await $awa.extractHtml(".card-wrapper.product-card-wrapper"); if (cards && cards.length > 20) { gridHtml = "<div>" + cards + "</div>"; } } catch (e) {} }
      var products = _parseCards(gridHtml);
      if (products.length === 0) {
        try { var firstLink = await $awa.extractAttribute(".card-wrapper a.full-unstyled-link, .card__heading a", "href"); if (firstLink && firstLink.indexOf("/products/") !== -1) { var fallbackName = null; try { fallbackName = await $awa.extractText("h3.card__heading a.full-unstyled-link"); } catch (e) {} var fallbackPrice = null; try { fallbackPrice = await $awa.extractText(".price .price-item--sale"); } catch (e) {} if (!fallbackPrice) { try { fallbackPrice = await $awa.extractText(".price .price-item--regular"); } catch (e) {} } var fallbackHandle = firstLink.replace("/products/", "").split("?")[0]; products.push({ name: fallbackName, sku: null, handle: fallbackHandle, url: firstLink, fullUrl: "https://mrbeast.store" + firstLink, price: fallbackPrice, imageUrl: null, badges: null }); } } catch (e) {}
      }
      return { query: query, collection: collection, pageTitle: pageTitle, resultCount: products.length, products: products, firstProduct: products.length > 0 ? products[0] : null };
    },

        async filterResults({ filterType, filterValue, page }) {
      if (filterType === "variantType" && filterValue) {
        var toggleSelector = filterValue === "youth" || filterValue === "Youth" ? "button[aria-label='Youth']" : filterValue === "adult" || filterValue === "Adult" ? "button[aria-label='Adult']" : "";
        if (toggleSelector) { try { await $awa.waitForSelector(toggleSelector, 5000); await $awa.click(toggleSelector); await $awa.sleep(2000); } catch (e) { return { status: "failed", errorDetails: "Could not find variant type filter: " + filterValue }; } }
      }
      if (filterType === "productType" && filterValue) { try { await $awa.waitForSelector("button[aria-label='Product type']", 5000); await $awa.click("button[aria-label='Product type']"); await $awa.sleep(500); try { await $awa.click("label[for*='" + filterValue + "']"); await $awa.sleep(1000); } catch (e) {} } catch (e) {} }
      if (filterType === "color" && filterValue) { try { await $awa.waitForSelector("button[aria-label='Color']", 5000); await $awa.click("button[aria-label='Color']"); await $awa.sleep(500); try { await $awa.click("label[for*='" + filterValue.toLowerCase() + "']"); await $awa.sleep(1000); } catch (e) {} } catch (e) {} }
      if (filterType === "size" && filterValue) { try { await $awa.waitForSelector("button[aria-label='Size']", 5000); await $awa.click("button[aria-label='Size']"); await $awa.sleep(500); try { await $awa.click("label[for*='" + filterValue.toUpperCase() + "']"); await $awa.sleep(1000); } catch (e) {} } catch (e) {} }
      await $awa.sleep(1500);
      var pageTitle = null;
      try { pageTitle = await $awa.extractText("h1"); } catch (e) {}
      var gridHtml = null;
      var gridSelectors = ["div#product-grid", "ul#product-grid", ".product-grid", ".collection"];
      for (var s = 0; s < gridSelectors.length; s++) { try { var html = await $awa.extractHtml(gridSelectors[s]); if (html && html.length > 50) { gridHtml = html; break; } } catch (e) {} }
      return { status: "success", appliedFilter: { filterType: filterType, filterValue: filterValue }, resultCount: _parseCards(gridHtml).length, products: _parseCards(gridHtml), pageTitle: pageTitle };
    },

    async getProduct({ handle, targetUrl, page }) {
      var url = targetUrl || (handle ? "https://mrbeast.store/products/" + handle : null);
      if (!url) return { status: "failed", errorDetails: "No handle or targetUrl provided" };
      await $awa.navigate(url);
      await $awa.sleep(3000);
      var title = null;
      try { title = await $awa.extractText("h1"); } catch (e) {}
      if (!title || title.trim() === "") { try { title = await $awa.extractText(".product__title"); } catch (e) {} }
      var price = null; try { price = await $awa.extractText(".price.price--large"); } catch (e) {}
      if (!price) { try { price = await $awa.extractText(".price"); } catch (e) {} }
      var regularPrice = null; try { regularPrice = await $awa.extractText(".price-item--regular"); } catch (e) {}
      var salePrice = null; try { salePrice = await $awa.extractText(".price-item--sale"); } catch (e) {}
      var rating = null; try { var ra = await $awa.extractAttribute("a.rating-wrapper, .rating-wrapper", "aria-label"); if (ra) rating = ra; } catch (e) {}
      var reviewCount = null; try { var rb = await $awa.extractText("button[aria-label*='stars'], a[aria-label*='star']"); if (rb) reviewCount = rb; } catch (e) {}
      var options = {}; try { if (await $awa.extractHtml("fieldset.product-form__input--swatch")) options.hasColor = true; } catch (e) {}
      try { if (await $awa.extractHtml("fieldset.product-form__input--pill")) options.hasSize = true; } catch (e) {}
      var collectionLink = null; try { collectionLink = await $awa.extractText("nav[aria-label='breadcrumbs'] a, nav.breadcrumb a"); } catch (e) {}
      var description = null; try { var db = await $awa.extractText("button:has-text('PRODUCT DETAILS')"); if (db) { var dc = await $awa.extractText("button:has-text('PRODUCT DETAILS') + div"); if (dc) description = dc.substring(0, 300); } } catch (e) {}
      if (!description) { try { description = await $awa.extractText("[class*='product__description']"); } catch (e) {} }
      return { handle: handle, title: title, price: price, regularPrice: regularPrice, salePrice: salePrice, rating: rating, reviewCount: reviewCount, hasVariants: options, collection: collectionLink, description: description, url: await $awa.currentUrl() };
    },

    // -------------------------------------------------------------------
    // addToCart
    //
    // Uses evaluate() with SYNCHRONOUS XMLHttpRequest to fetch the Shopify
    // product JSON and POST to /cart/add.js.  Async IIFEs don't work
    // reliably with $awa.evaluate() because it may not await the promise.
    // Synchronous XHR avoids that problem entirely.
    // -------------------------------------------------------------------
    async addToCart({ handle, quantity, variantOptions, page }) {
      var currentUrl = await $awa.currentUrl();
      if (handle && currentUrl.indexOf("/products/" + handle) === -1) {
        await $awa.navigate("https://mrbeast.store/products/" + handle);
        await $awa.sleep(4000);
      }

      // Extract handle from current URL if not provided
      var productHandle = handle;
      if (!productHandle) {
        try {
          currentUrl = await $awa.currentUrl();
          var m = currentUrl.match(/\/products\/([^/?]+)/);
          if (m) { productHandle = m[1]; }
        } catch (e) {}
      }

      // ----- Strategy 1: Synchronous XHR via $awa.evaluate() -----
      // Uses synchronous XMLHttpRequest to avoid promise/async issues with
      // $awa.evaluate().  Steps: fetch product JSON, match variant, POST
      // to /cart/add.js, verify with /cart.js.
      var ajaxSucceeded = false;
      if (productHandle && typeof $awa.evaluate === "function") {
        try {
          // Step 1 — Fetch product JSON synchronously
          var fetchJs = "(function(){" +
            "var x=new XMLHttpRequest();" +
            "x.open('GET','/products/" + productHandle + ".json',false);" +
            "x.send();" +
            "return x.responseText;" +
          "})()";
          var raw = await $awa.evaluate(fetchJs);
          var prod = JSON.parse(raw);
          if (prod && prod.product && prod.product.variants && prod.product.variants.length > 0) {
            var variants = prod.product.variants;
            var targetId = null;

            // Match variant using Shopify's option1/option2 fields
            var opts = variantOptions || {};
            if (opts.size || opts.color) {
              var sizeMap = {L:"LG",M:"MD",S:"SM",XXL:"2XL",XXXL:"3XL"};
              var wantSize = sizeMap[opts.size] || "";
              // option1 = Size, option2 = Color on this product
              for (var vi = 0; vi < variants.length; vi++) {
                var v = variants[vi];
                var match = true;
                if (opts.size) {
                  var vSize = (v.option1 || "").toUpperCase();
                  var wantUp = wantSize.toUpperCase();
                  if (vSize !== wantUp) { match = false; }
                }
                if (opts.color && match) {
                  var vColor = (v.option2 || "").toLowerCase();
                  var wantColor = (opts.color || "").toLowerCase();
                  if (vColor !== wantColor) { match = false; }
                }
                if (match) { targetId = String(v.id); break; }
              }
            }
            if (!targetId) {
              // No options requested or no match: use first variant
              targetId = String(variants[0].id);
            }

            // Step 2 — POST to /cart/add.js synchronously
            var qty = (typeof quantity === "number" ? quantity : 1);
            var postJs = "(function(){" +
              "var x=new XMLHttpRequest();" +
              "x.open('POST','/cart/add.js',false);" +
              "var fd=new FormData();" +
              "fd.append('id','" + targetId + "');" +
              "fd.append('quantity','" + qty + "');" +
              "x.send(fd);" +
              "return JSON.stringify({status:x.status,ok:x.status>=200&&x.status<300});" +
            "})()";
            var postRaw = await $awa.evaluate(postJs);
            var postParsed = JSON.parse(postRaw);
            if (postParsed.ok) {
              ajaxSucceeded = true;

              // Step 3 — Verify via /cart.js
              var checkJs = "(function(){" +
                "var x=new XMLHttpRequest();" +
                "x.open('GET','/cart.js',false);" +
                "x.send();" +
                "return x.responseText;" +
              "})()";
              var checkRaw = await $awa.evaluate(checkJs);
              var cartData = JSON.parse(checkRaw);
              if (cartData && cartData.item_count > 0) {
                return {
                  status: "success",
                  handle: handle || productHandle,
                  quantity: qty,
                  variantOptions: variantOptions,
                  cartUrl: "https://mrbeast.store/cart"
                };
              }
              // AJAX POST said ok but cart is empty — rare edge case
            }
          }
        } catch (e) {
          // evaluate failed or parse error — fall through
        }
      }

      // ----- Strategy 2: DOM click approach (fallback) -----
      // Navigate to the product page if we aren't already on it
      if (!ajaxSucceeded && productHandle) {
        currentUrl = await $awa.currentUrl();
        if (currentUrl.indexOf("/products/" + productHandle) === -1) {
          await $awa.navigate("https://mrbeast.store/products/" + productHandle);
          await $awa.sleep(3000);
        }
      }

      // Select variant via DOM
      if (variantOptions) {
        if (variantOptions.size) {
          var sz = variantOptions.size.toUpperCase();
          var nsz = sz;
          if (sz === "L") nsz = "LG"; else if (sz === "M") nsz = "MD"; else if (sz === "S") nsz = "SM";
          else if (sz === "XXL") nsz = "2XL"; else if (sz === "XXXL") nsz = "3XL";
          try {
            await $awa.waitForSelector("label[data-value='" + nsz + "']", 5000);
            await $awa.click("label[data-value='" + nsz + "']");
            await $awa.sleep(500);
          } catch (e) {}
        }
        await $awa.sleep(1000);
      }

      // Click add-to-cart button
      var clickTargets = [
        "button.product-form__submit[name='add']",
        "button[name='add']",
        "button.product-form__submit",
        ".product-form__submit",
        "#ProductSubmitButton-template--17862483116159__main",
        "button[id*='ProductSubmitButton']",
      ];

      var clicked = false;
      for (var i = 0; i < clickTargets.length && !clicked; i++) {
        try { await $awa.waitForSelector(clickTargets[i], 3000); await $awa.click(clickTargets[i]); clicked = true; } catch (e) {}
      }
      if (!clicked) { return { status: "failed", errorDetails: "Could not find add-to-cart button" }; }

      // Wait for AJAX add to complete, then verify via /cart.js
      await $awa.sleep(5000);

      if (typeof $awa.evaluate === "function") {
        try {
          var checkJs = "(function(){" +
            "var x=new XMLHttpRequest();" +
            "x.open('GET','/cart.js',false);" +
            "x.send();" +
            "return x.responseText;" +
          "})()";
          var checkRaw = await $awa.evaluate(checkJs);
          var cartCheck = JSON.parse(checkRaw);
          if (cartCheck && cartCheck.item_count > 0) {
            return {
              status: "success",
              handle: handle || productHandle,
              quantity: quantity || 1,
              variantOptions: variantOptions,
              cartUrl: "https://mrbeast.store/cart"
            };
          }
        } catch (e) {}
      }

      // Final fallback: navigate to cart and check DOM
      await $awa.navigate("https://mrbeast.store/cart");
      await $awa.sleep(3000);
      if (typeof $awa.evaluate === "function") {
        try {
          var checkJs = "(function(){" +
            "var x=new XMLHttpRequest();" +
            "x.open('GET','/cart.js',false);" +
            "x.send();" +
            "return x.responseText;" +
          "})()";
          var checkRaw = await $awa.evaluate(checkJs);
          var cartCheck = JSON.parse(checkRaw);
          if (cartCheck && cartCheck.item_count > 0) {
            return {
              status: "success",
              handle: handle || productHandle,
              quantity: quantity || 1,
              variantOptions: variantOptions,
              cartUrl: "https://mrbeast.store/cart"
            };
          }
        } catch (e) {}
      }
      return { status: "failed", errorDetails: "Cart is empty after add attempt", cartUrl: await $awa.currentUrl() };
    },

    async getCheckoutLink({ page }) {
      // ----- Navigate to /cart if not already there -----
      var currentUrl = await $awa.currentUrl();
      if (currentUrl.indexOf("/checkout") !== -1) {
        // Already on checkout page — just return the URL
        return { status: "success", checkoutUrl: currentUrl };
      }
      if (currentUrl.indexOf("/cart") === -1) {
        await $awa.navigate("https://mrbeast.store/cart");
        await $awa.sleep(3000);
      }

      // ----- Verify cart has items (using /cart.js API) -----
      if (typeof $awa.evaluate === "function") {
        try {
          var checkJs = "(function(){" +
            "var x=new XMLHttpRequest();" +
            "x.open('GET','/cart.js',false);" +
            "x.send();" +
            "return x.responseText;" +
          "})()";
          var checkRaw = await $awa.evaluate(checkJs);
          var cartCheck = JSON.parse(checkRaw);
          if (!cartCheck || cartCheck.item_count === 0) {
            return { status: "failed", errorDetails: "Cart is empty", cartUrl: currentUrl };
          }
        } catch (e) {
          return { status: "failed", errorDetails: "Could not check cart state", cartUrl: currentUrl };
        }
      } else {
        // Fallback DOM empty-check
        try {
          var emptyText = await $awa.extractText("h1:has-text('empty')");
          if (emptyText) { return { status: "failed", errorDetails: "Cart is empty", cartUrl: await $awa.currentUrl() }; }
        } catch (e) {}
      }

      // ----- Click the checkout button -----
      // The visible button has id="checkout". The hidden drawer button
      // (#CartDrawer-Checkout) comes first in DOM with the same name="checkout",
      // so put specific selectors first.
      var checkoutBtns = [
        "button#checkout",
        "#checkout",
        "button:has-text('Go to Checkout')",
        "button[name='checkout']",
        "a[href*='/checkout']",
        "button[class*='checkout']",
        "input[type='submit'][value*='checkout']"
      ];
      var clicked = false;
      for (var i = 0; i < checkoutBtns.length; i++) {
        try { await $awa.waitForSelector(checkoutBtns[i], 3000); await $awa.click(checkoutBtns[i]); clicked = true; await $awa.sleep(1000); break; } catch (e) {}
      }

      // Evaluate fallback: click via JS if DOM selectors fail
      if (!clicked && typeof $awa.evaluate === "function") {
        try {
          var clickJs = "(function(){var b=document.getElementById('checkout');if(!b)return 'no-btn';b.click();return 'ok'})()";
          var evalResult = await $awa.evaluate(clickJs);
          if (evalResult === "ok") { clicked = true; await $awa.sleep(2000); }
        } catch (e) {}
      }

      if (!clicked) { return { status: "failed", errorDetails: "Could not find checkout button", cartUrl: await $awa.currentUrl() }; }

      // ----- Wait for navigation to checkout -----
      try { await $awa.waitForNavigation(); } catch (e) {}
      await $awa.sleep(2000);
      return { status: "success", checkoutUrl: await $awa.currentUrl() };
    },
  },
};
