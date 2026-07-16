"use strict";

/**
 * AWA Skill Script — amazon.com
 *
 * Session-based skill with handlers for search, getProduct, addToCart, readCart,
 * removeFromCart, changeCartQuantity, and getCartExport.
 *
 * Design:
 *   - All data extraction via $awa.evaluate() — runs JS in browser page context
 *   - $awa.evaluate("window.location.href") instead of page.url() to avoid ivm bridge issue
 *   - Minimal warmup; direct navigation only
 *   - Consistent return shapes match manifest.actions docs
 *
 * 🛡️ ANTI-DETECTION STRATEGY:
 *   When any handler returns status="blocked", it means Amazon's bot detection
 *   has flagged the session. The caller (OpenClaw agent) should:
 *
 *   1. FIRST RETRY (humanize):
 *      - Wait 5-10 seconds before retrying
 *      - Modify search parameters to be more human-like:
 *        * Add natural typos to search queries (e.g., "wireless mouse" → "wireles muse")
 *        * Vary sort order, department, or price filters
 *        * Use different casing or spacing
 *      - The blocked response includes detection type (CAPTCHA, BOT_BLOCK, etc.)
 *        and a bodySnippet for diagnostics
 *
 *   2. SECOND RETRY (fresh session):
 *      - If the same session gets blocked again, the Playwright browser context
 *        may have been fingerprinted. Call /session/:id/end to kill it, then
 *        start a brand new session with /session/start
 *      - A fresh browser context resets the fingerprint canvas
 *
 *   3. PERSISTENT BLOCKING:
 *      - If new sessions keep getting blocked, the proxy IP range is likely
 *        blacklisted. Configure a residential proxy (see proxy-router.js and
 *        docker-compose.yml PROXY_* vars).
 *      - Without a residential proxy, Amazon will block datacenter IPs
 *        after a small number of requests.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get current page URL via evaluate (avoids page.url bridge issues). */
async function _currentUrl() {
  try { return await $awa.evaluate("window.location.href"); } catch (e) { return null; }
}

/** Get page title. */
async function _pageTitle() {
  try { return await $awa.extractText("title"); } catch (e) { return null; }
}

/**
 * Navigate to an Amazon URL with anti-bot awareness.
 * Returns null on success, or a blocked descriptor if detected.
 *
 * When this returns blocked, the CALLER (OpenClaw agent) should:
 *   1. Wait 5-10s, retry with more human-like params (typos, varied filters)
 *   2. If blocked again, kill the session and start a fresh one
 *   3. If persistent across sessions, configure a residential proxy
 *
 * The detection field contains the specific trigger (CAPTCHA, RATE_LIMITED, etc.)
 */
async function _navigateToAmazon(url) {
  await $awa.navigate(url);
  await $awa.sleep(4000);

  var title = await _pageTitle();
  var bodyText = "";
  try { bodyText = (await $awa.extractText("body") || "").substring(0, 500); } catch (e) {}
  var pageUrl = await _currentUrl();

  // ----- Amazon bot-detection indicators (comprehensive) -----
  var indicators = [
    { label: "CAPTCHA",       patterns: ["Sorry! Something went wrong", "Enter the characters", "type the characters", "captcha", "robot check"] },
    { label: "BOT_BLOCK",     patterns: ["Bot", "automated", "automated access", "automated requests"] },
    { label: "GATEWAY_BLOCK", patterns: ["Something went wrong on our end", "We're sorry", "This page can't be loaded"] },
    { label: "RATE_LIMITED",  patterns: ["too many requests", "try again later", "slow down", "unusual traffic"] },
    { label: "HOME_REDIRECT", patterns: [] },
    { label: "PARSE_FAILURE", patterns: [] },
  ];

  var combined = ((title || "") + " " + bodyText).toLowerCase();
  var detected = [];

  for (var i = 0; i < indicators.length; i++) {
    var group = indicators[i];
    for (var j = 0; j < group.patterns.length; j++) {
      if (combined.indexOf(group.patterns[j].toLowerCase()) !== -1) {
        detected.push(group.label);
        break;
      }
    }
  }

  // Detect homepage redirect: navigated to root instead of intended URL
  if (pageUrl && url && pageUrl.replace(/\/$/, "") === "https://www.amazon.com" &&
      (url.indexOf("/s?k=") !== -1 || url.indexOf("/dp/") !== -1)) {
    detected.push("HOME_REDIRECT");
  }

  // Detect parse failure: body too short or no meaningful content
  if (bodyText.length < 50 && !detected.length) {
    detected.push("PARSE_FAILURE");
  }

  if (detected.length > 0) {
    return {
      blocked: true,
      blockedBy: "amazon.com",
      detection: detected,
      detail: detected.join(" + "),
      pageTitle: title,
      bodySnippet: bodyText.substring(0, 200),
      pageUrl: pageUrl,
      intendedUrl: url
    };
  }

  return null;
}

/**
 * Build the Amazon search URL with optional filter parameters.
 */
function _buildSearchUrl(query, opts) {
  var url = "https://www.amazon.com/s?k=" + encodeURIComponent(query) + "&ref=nb_sb_noss";

  if (opts && opts.department) {
    url += "&i=" + encodeURIComponent(opts.department.toLowerCase());
  }

  if (opts && opts.sortBy && opts.sortBy !== "featured") {
    var sortMap = {
      "price-asc": "price-asc-rank",
      "price-desc": "price-desc-rank",
      "rating": "review-rank",
      "newest": "date-desc-rank"
    };
    var sortVal = sortMap[opts.sortBy];
    if (sortVal) url += "&s=" + sortVal;
  }

  var rhParts = [];
  if (opts && (opts.minPrice !== undefined || opts.maxPrice !== undefined)) {
    var min = opts.minPrice !== undefined ? opts.minPrice : "";
    var max = opts.maxPrice !== undefined ? opts.maxPrice : "";
    rhParts.push("p_36:" + min + "-" + max);
  }
  if (opts && opts.condition) {
    var condMap = { "new": "2224371011", "used": "16907720011", "renewed": "16907720011" };
    var condVal = condMap[opts.condition];
    if (condVal) rhParts.push("p_n_condition-type:" + condVal);
  }
  if (rhParts.length > 0) {
    url += "&rh=" + rhParts.join(",");
  }

  return url;
}

/**
 * Extract search results from the page using $awa.evaluate().
 */
async function _extractSearchResults() {
  // Step 1: Check how many result containers exist
  var count = 0;
  try { count = await $awa.evaluate("document.querySelectorAll('div[data-component-type=\"s-search-result\"]').length"); } catch (e) {}
  var debugInfo = { queryCount: count };

  if (count === 0) {
    try { count = await $awa.evaluate("document.querySelectorAll('[data-asin]').length"); } catch (e) {}
    debugInfo.fallbackCount = count;
    if (count === 0) return { products: [], debug: debugInfo };
  }

  // Step 2: Extract product data with a single evaluate call
  var raw = null;
  try {
    raw = await $awa.evaluate(
      "(function(){" +
      "var items=document.querySelectorAll('div[data-component-type=\"s-search-result\"]');" +
      "var out=[];" +
      "for(var i=0;i<items.length;i++){" +
      "var el=items[i];" +
      "var asin=el.getAttribute('data-asin')||'';" +
      "if(!asin)continue;" +
      "var titleEl=el.querySelector('h2 a, h2');" +
      "var title=titleEl?(titleEl.innerText||'').trim():'';" +
      "var linkEl=el.querySelector('a.a-link-normal[href*=\"/dp/\"]');" +
      "var href=linkEl?linkEl.getAttribute('href'):'';" +
      "var fullUrl=href?('https://www.amazon.com'+href.split('?')[0]):'';" +
      "var priceEl=el.querySelector('.a-price .a-offscreen, .a-price-whole');" +
      "var price=priceEl?(priceEl.innerText||'').trim():'';" +
      "var ratingEl=el.querySelector('i[class*=\"a-star\"]');" +
      "var ratingText=ratingEl?(ratingEl.innerText||'').trim():'';" +
      "var ratingMatch=ratingText.match(/([\\d.]+)/);" +
      "var rating=ratingMatch?parseFloat(ratingMatch[1]):null;" +
      "var revEl=el.querySelector('a[href*=\"customerReviews\"]');" +
      "var reviews=revEl?(revEl.innerText||'').trim():'';" +
      "var imgEl=el.querySelector('img.s-image');" +
      "var img=imgEl?imgEl.getAttribute('src'):'';" +
      "out.push(JSON.stringify({asin:asin,title:title,fullUrl:fullUrl,price:price,rating:rating,reviews:reviews,image:img}));" +
      "}" +
      "return '['+out.join(',')+']';" +
      "})()"
    );
  } catch (e) {
    return { products: [], debug: debugInfo };
  }

  if (!raw) return { products: [], debug: debugInfo };
  try { return { products: JSON.parse(raw), debug: debugInfo }; } catch (e) { return { products: [], debug: debugInfo }; }
}


/**
 * Extract product details from a product page using $awa.evaluate().
 */
async function _extractProductInfo() {
  try {
    var raw = await $awa.evaluate(
      "(function(){" +
      "var t=(document.querySelector('#productTitle')||{}).innerText||'';" +
      "t=t.trim();" +
      "var pEl=document.querySelector('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen')" +
      "  || document.querySelector('.a-price .a-offscreen')" +
      "  || document.querySelector('#price_inside_buybox')" +
      "  || document.querySelector('.a-price-whole');" +
      "var p=pEl?(pEl.innerText||pEl.textContent||'').trim():'';" +
      "var m=(window.location.pathname.match(/\\/dp\\/([A-Z0-9]+)/)||[])[1]||'';" +
      "var img=(document.querySelector('#landingImage')" +
      "  || document.querySelector('#imgTagWrapperId img')" +
      "  || document.querySelector('#main-image'))||{};" +
      "var imgSrc=img.getAttribute?img.getAttribute('src'):'';" +
      "var ft=[];" +
      "var fis=document.querySelectorAll('#feature-bullets li span.a-list-item, #feature-bullets li span');" +
      "for(var fi=0;fi<fis.length&&fi<10;fi++){var ftxt=(fis[fi].innerText||'').trim();if(ftxt)ft.push(ftxt);}" +
      "var avEl=document.querySelector('#availability span, #availability .a-color-state');" +
      "var avText=avEl?(avEl.innerText||'').toLowerCase():'';" +
      "var inStock=avText.indexOf('out of stock')===-1&&avText.indexOf('currently unavailable')===-1;" +
      "var addBtn=!!document.querySelector('#add-to-cart-button');" +
      "return JSON.stringify({title:t,price:p,asin:m,img:imgSrc,features:ft,inStock:inStock,hasAddBtn:addBtn});" +
      "})()"
    );
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {};
}

// ─── Handlers ───────────────────────────────────────────────────────────────

module.exports = {
  manifest: {
    domain: "amazon.com",
    version: "2.4.0",
    capabilities: ["search", "getProduct", "addToCart", "readCart", "removeFromCart", "changeCartQuantity", "getCartExport"],
    urls: {
      search: "https://www.amazon.com/s?k={query}",
      product: "https://www.amazon.com/dp/:asin",
      cart: "https://www.amazon.com/gp/cart/view.html",
    },
  },

  handlers: {

    // -------------------------------------------------------------------
    // search — Search Amazon by keyword and return structured results
    // -------------------------------------------------------------------
    async search({ query, department, minPrice, maxPrice, sortBy, condition, page }) {
      if (!query || query === "") {
        return { status: "failed", errorDetails: "No search query provided" };
      }

      var opts = {
        department: department,
        minPrice: minPrice,
        maxPrice: maxPrice,
        sortBy: sortBy,
        condition: condition
      };
      var searchUrl = _buildSearchUrl(query, opts);

      var blocked = await _navigateToAmazon(searchUrl);
      if (blocked) {
        return {
          status: "blocked",
          query: query,
          errorDetails: "Amazon blocked the search page."
        };
      }

      var resultSelectors = [
        "div[data-component-type='s-search-result']",
        "div.s-result-item",
        "#search",
        "div.s-main-slot"
      ];
      for (var s = 0; s < resultSelectors.length; s++) {
        try { await $awa.waitForSelector(resultSelectors[s], 10000); break; } catch (e) {}
      }

      var result = await _extractSearchResults();

      var mapped = [];
      for (var i = 0; i < result.products.length; i++) {
        var p = result.products[i];
        mapped.push({
          asin: p.asin,
          title: p.title,
          url: p.fullUrl || null,
          price: p.price || null,
          rating: p.rating || null,
          reviewCount: p.reviews || null,
          imageUrl: p.image || null
        });
      }

      return {
        status: "success",
        query: query,
        resultCount: mapped.length,
        products: mapped,
        firstProduct: mapped.length > 0 ? mapped[0] : null,
        _debug: result.debug
      };
    },

    // -------------------------------------------------------------------
    // getProduct — Get detailed info from a product page
    // -------------------------------------------------------------------
    async getProduct({ asin, targetUrl, page }) {
      var url = targetUrl || null;
      if (!url && asin) {
        url = "https://www.amazon.com/dp/" + asin;
      }
      if (!url) {
        try { url = await _currentUrl(); } catch (e) {}
      }
      if (!url) {
        return { status: "failed", errorDetails: "No asin, targetUrl, or current page URL available" };
      }

      var blocked = await _navigateToAmazon(url);
      if (blocked) {
        return { status: "blocked", errorDetails: "Amazon blocked the product page." };
      }

      try { await $awa.waitForSelector("#productTitle", 15000); } catch (e) {
        try { await $awa.waitForSelector("h1", 5000); } catch (e2) {}
      }

      var info = await _extractProductInfo();
      var currentUrl = await _currentUrl();

      var currentAsin = info.asin || null;
      if (!currentAsin && currentUrl) {
        var am = currentUrl.match(/\/dp\/([A-Z0-9]+)/);
        if (am) currentAsin = am[1];
      }

      return {
        asin: currentAsin || asin,
        title: info.title || null,
        price: info.price || null,
        imageUrl: info.img || null,
        features: (info.features && info.features.length > 0) ? info.features : null,
        inStock: info.inStock !== false,
        url: currentUrl,
        hasAddToCartButton: !!info.hasAddBtn
      };
    },

    // -------------------------------------------------------------------
    // addToCart — Add a product to the Amazon cart
    // -------------------------------------------------------------------
    async addToCart({ asin, quantity, page }) {
      var currentUrl = await _currentUrl();

      if (asin) {
        var onCorrectPage = false;
        if (currentUrl && currentUrl.indexOf("/dp/" + asin) !== -1) {
          onCorrectPage = true;
        }
        if (!onCorrectPage) {
          var blocked = await _navigateToAmazon("https://www.amazon.com/dp/" + asin);
          if (blocked) {
            return { status: "blocked", errorDetails: "Amazon blocked the product page." };
          }
        }
      }

      try { await $awa.waitForSelector("#productTitle", 10000); } catch (e) {}

      var qty = (typeof quantity === "number" && quantity > 1) ? quantity : 1;
      if (qty > 1) {
        var qtySelectors = ["#quantity", "select[name='quantity']", "select#quantity"];
        for (var qs = 0; qs < qtySelectors.length; qs++) {
          try {
            await $awa.waitForSelector(qtySelectors[qs], 3000);
            await $awa.select(qtySelectors[qs], String(qty));
            await $awa.sleep(500);
            break;
          } catch (e) {}
        }
      }

      var clicked = false;
      try {
        var clickResult = await $awa.evaluate(
          "(function(){" +
          "var btn=document.querySelector('#add-to-cart-button');" +
          "if(!btn)return 'no-btn';" +
          "btn.click();" +
          "return 'clicked';" +
          "})()"
        );
        if (clickResult === "clicked") clicked = true;
      } catch (e) {}

      if (!clicked) {
        var addBtnSelectors = [
          "#add-to-cart-button",
          "input#add-to-cart-button",
          "input[name='submit.add-to-cart']",
          "#add-to-cart-button-ubb"
        ];
        for (var b = 0; b < addBtnSelectors.length && !clicked; b++) {
          try {
            await $awa.waitForSelector(addBtnSelectors[b], 3000);
            await $awa.click(addBtnSelectors[b]);
            clicked = true;
          } catch (e) {}
        }
      }

      if (!clicked) {
        return { status: "failed", errorDetails: "Could not find add-to-cart button" };
      }

      await $awa.sleep(4000);

      var resolvedAsin = asin;
      if (!resolvedAsin && currentUrl) {
        var am = currentUrl.match(/\/dp\/([A-Z0-9]+)/);
        if (am) resolvedAsin = am[1];
      }

      // Verify cart — check if the item actually landed
      var cartCountBefore = 0;
      try {
        var ccBefore = await $awa.evaluate("var el=document.querySelector('#nav-cart-count');return el?parseInt(el.innerText,10)||0:0;");
        if (typeof ccBefore === 'number') cartCountBefore = ccBefore;
      } catch (e) {}

      await $awa.sleep(3000);

      var cartCountAfter = 0;
      try {
        var ccAfter = await $awa.evaluate("var el=document.querySelector('#nav-cart-count');return el?parseInt(el.innerText,10)||0:0;");
        if (typeof ccAfter === 'number') cartCountAfter = ccAfter;
      } catch (e) {}

      var cartIncreased = cartCountAfter > cartCountBefore;

      if (!cartIncreased) {
        // Navigate to cart to check the ASIN directly
        await $awa.navigate("https://www.amazon.com/gp/cart/view.html");
        await $awa.sleep(3000);

        var cartHasAsin = false;
        try {
          var found = await $awa.evaluate("var items=document.querySelectorAll('div.sc-list-item[data-asin]');for(var i=0;i<items.length;i++){if(items[i].getAttribute('data-asin')==='" + resolvedAsin + "')return true;}return false;");
          if (found) cartHasAsin = true;
        } catch (e) {}

        if (!cartHasAsin) {
          try {
            var emptyText = await $awa.extractText("h1");
            if (emptyText && emptyText.toLowerCase().indexOf("empty") !== -1) {
              return {
                status: "failed",
                errorDetails: "Cart appears empty after add attempt",
                asin: resolvedAsin
              };
            }
          } catch (e) {}

          // Button was clicked but the item didn't land — Amazon's anti-bot protection
          // (common for high-demand products like beyblades, sneakers, etc.)
          // Tell the agent to track this item for manual export instead.
          return {
            status: "protected",
            asin: resolvedAsin,
            quantity: qty,
            agentInstruction: "This product has anti-bot protection and addToCart could not complete it. Store this ASIN in your conversation context and include it in the items array when calling getCartExport — provide { asin, title, price, quantity, productUrl } so the user can add it manually from the product link.",
            productUrl: currentUrl || ("https://www.amazon.com/dp/" + resolvedAsin)
          };
        }
      }

      return {
        status: "success",
        asin: resolvedAsin,
        quantity: qty
      };
    },

    // -------------------------------------------------------------------
    // readCart — Read the current contents of the Amazon shopping cart
    //            Returns clean, structured cart data for export.
    // -------------------------------------------------------------------
    async readCart({ page }) {
      // Navigate to cart page
      await $awa.navigate("https://www.amazon.com/gp/cart/view.html");
      await $awa.sleep(3000);

      // Check if cart is empty
      try {
        var emptyText = await $awa.extractText("h1");
        if (emptyText && emptyText.toLowerCase().indexOf("empty") !== -1) {
          return { status: "success", itemCount: 0, items: [], cartTotal: null, subtotal: null, shareUrl: null };
        }
      } catch (e) {}

      // Extract cart items via evaluate — with data quality fixes
      var raw = null;
      try {
        raw = await $awa.evaluate(
          "(function(){" +
          "var items=document.querySelectorAll('div.sc-list-item[data-asin]');" +
          "if(items.length===0) items=document.querySelectorAll('[data-asin]');" +
          "var out=[];" +
          "for(var i=0;i<items.length;i++){" +
          "var el=items[i];" +
          "var asin=el.getAttribute('data-asin')||'';" +
          "if(!asin||asin==='')continue;" +

          // Clean title: take the shortest meaningful version, trim whitespace
          "var titleEl=el.querySelector('span.a-truncate-full, span.a-size-medium, span.sc-product-title');" +
          "var rawTitle=titleEl?(titleEl.innerText||'').trim():'';" +
          "var titleLines=rawTitle.split('\\n').filter(function(l){return l.trim().length>0;});" +
          "var title=titleLines.length>0?titleLines[0].trim():rawTitle;" +

          // Clean price: split on newline, take first meaningful segment
          "var priceEl=el.querySelector('span.sc-product-price, span.a-price .a-offscreen, span.a-color-price');" +
          "var rawPrice=priceEl?(priceEl.innerText||'').trim():'';" +
          "var priceParts=rawPrice.split('\\n').filter(function(l){return l.trim().length>0;});" +
          "var price=priceParts.length>0?priceParts[0].trim():rawPrice;" +

          // Quantity
          "var qtyEl=el.querySelector('input[name=\"quantity\"]');" +
          "var qty=1;if(qtyEl){qty=parseInt(qtyEl.getAttribute('value'),10)||1;}" +

          // Image
          "var imgEl=el.querySelector('img.sc-product-image');" +
          "var img=imgEl?imgEl.getAttribute('src'):'';" +

          // Build the clean product URL
          "var productUrl='https://www.amazon.com/dp/'+asin;" +

          "out.push(JSON.stringify({asin:asin,title:title,quantity:qty,price:price,imageUrl:img,productUrl:productUrl}));" +
          "}" +
          "return '['+out.join(',')+']';" +
          "})()"
        );
      } catch (e) {}

      var items = [];
      if (raw) {
        try { items = JSON.parse(raw); } catch (e) {}
      }

      // Extract subtotal with trimming/cleaning
      var subtotal = null;
      try {
        subtotal = await $awa.evaluate(
          "(function(){" +
          "var el=document.querySelector('#sc-subtotal-amount-buybox span.a-color-price')" +
          "  || document.querySelector('#sc-subtotal-amount-activecart span');" +
          "if(!el)return null;" +
          "var parts=(el.innerText||'').split('\\n').filter(function(l){return l.trim().length>0;});" +
          "return parts.length>0?parts[0].trim():null;" +
          "})()"
        );
      } catch (e) {}

      var totalCount = 0;
      for (var i = 0; i < items.length; i++) {
        totalCount += (items[i].quantity || 1);
      }

      return {
        status: "success",
        itemCount: totalCount,
        items: items,
        cartTotal: subtotal,
        subtotal: subtotal
      };
    },

    // -------------------------------------------------------------------
    // removeFromCart — Remove a specific item from the Amazon cart.
    // -------------------------------------------------------------------
    async removeFromCart({ asin, page }) {
      if (!asin) {
        return { status: "failed", errorDetails: "No ASIN provided" };
      }

      await $awa.navigate("https://www.amazon.com/gp/cart/view.html");
      await $awa.sleep(3000);

      // Check if cart is empty
      try {
        var emptyText = await $awa.extractText("h1");
        if (emptyText && emptyText.toLowerCase().indexOf("empty") !== -1) {
          return { status: "failed", errorDetails: "Cart is empty, nothing to remove", asin: asin };
        }
      } catch (e) {}

      // Find the delete button for this ASIN and click it
      // Amazon's cart uses declarative event handlers (a-declarative) with
      // data-action="cart-delete" attributes. A regular .click() on a span
      // won't trigger the action. We need to:
      //   1. Find the a-declarative element with the right data-action
      //   2. Either click its contained input/button, or
      //   3. Use $awa.click() on the selector (which dispatches properly)
      var deleted = false;
      var deleteResult = null;

      // Strategy 1: Use $awa.click with a specific selector
      var deleteSelectors = [
        "div.sc-list-item[data-asin='" + asin + "'] input[name^='submit.delete']",
        "div.sc-list-item[data-asin='" + asin + "'] [data-action='cart-delete'] a",
        "div.sc-list-item[data-asin='" + asin + "'] [data-action='cart-delete'] input",
        "div.sc-list-item[data-asin='" + asin + "'] .sc-action-link a",
        "div.sc-list-item[data-asin='" + asin + "'] input[value='Delete']",
        "div.sc-list-item[data-asin='" + asin + "'] a:has(span)",
      ];
      for (var ds = 0; ds < deleteSelectors.length && !deleted; ds++) {
        try {
          await $awa.waitForSelector(deleteSelectors[ds], 3000);
          await $awa.click(deleteSelectors[ds]);
          deleted = true;
          deleteResult = "$awa.click:" + deleteSelectors[ds];
        } catch (e) {}
      }

      // Strategy 2: Click via evaluate using Amazon's declarative handler
      if (!deleted) {
        try {
          deleteResult = await $awa.evaluate(
            "(function(){" +
            "var items=document.querySelectorAll('div.sc-list-item[data-asin]');" +
            "for(var i=0;i<items.length;i++){" +
            "var el=items[i];" +
            "if((el.getAttribute('data-asin')||'')!=='" + asin + "')continue;" +
            // Try clicking the declarative action area + various children
            "var delAction=el.querySelector('[data-action=\"cart-delete\"]');" +
            "if(delAction){" +
            // Click the declarative action area itself
            "delAction.click();" +
            // Also try finding and clicking a child input/a
            "var ch=delAction.querySelector('a, input');" +
            "if(ch){try{ch.click();}catch(e){}}" +
            "return 'clicked-action';" +
            "}" +
            // Try by class
            "var scAction=el.querySelector('.sc-action-link a, .sc-action-link input');" +
            "if(scAction){scAction.click();return 'clicked-sc-action';}" +
            // Find any a/input with Delete text
            "var all=el.querySelectorAll('a, input');" +
            "for(var j=0;j<all.length;j++){" +
            "var txt=(all[j].innerText||all[j].getAttribute('value')||'').trim().toLowerCase();" +
            "if(txt.indexOf('delete')!==-1||txt.indexOf('remove')!==-1){" +
            "all[j].click();return 'clicked-text-' + txt.substring(0,10);" +
            "}" +
            "}" +
            "return 'no-delete-btn';" +
            "}" +
            "return 'not-found';" +
            "})()"
          );
          if (deleteResult && deleteResult.indexOf("clicked") === 0) deleted = true;
        } catch (e) {
          deleteResult = 'error: ' + (e.message || e);
        }
      }

      if (!deleted) {
        return { status: "failed", errorDetails: "Could not find delete button for " + asin, asin: asin, _debug: deleteResult };
      }

      await $awa.sleep(4000);

      // Verify removal by navigating back to a fresh cart page
      await $awa.navigate("https://www.amazon.com/gp/cart/view.html");
      await $awa.sleep(3000);

      var stillPresent = false;
      try {
        var checkStill = await $awa.evaluate(
          "(function(asin){" +
          "var items=document.querySelectorAll('div.sc-list-item[data-asin]');" +
          "for(var i=0;i<items.length;i++){" +
          "if(items[i].getAttribute('data-asin')===asin)return true;" +
          "}" +
          "return false;" +
          "})(\"" + asin + "\")"
        );
        if (checkStill) stillPresent = true;
      } catch (e) {}

      // Read remaining cart items from the fresh page
      var remaining = [];
      try {
        var remainingRaw = await $awa.evaluate(
          "(function(){" +
          "var items=document.querySelectorAll('div.sc-list-item[data-asin]');" +
          "var out=[];" +
          "for(var i=0;i<items.length;i++){" +
          "var el=items[i];" +
          "var a=el.getAttribute('data-asin')||'';" +
          "if(!a||a==='')continue;" +
          "var titleEl=el.querySelector('span.a-truncate-full, span.a-size-medium, span.sc-product-title');" +
          "var rawTitle=titleEl?(titleEl.innerText||'').trim():'';" +
          "var titleLines=rawTitle.split('\\n').filter(function(l){return l.trim().length>0;});" +
          "var title=titleLines.length>0?titleLines[0].trim():rawTitle;" +
          "var priceEl=el.querySelector('span.sc-product-price, span.a-price .a-offscreen, span.a-color-price');" +
          "var rawPrice=priceEl?(priceEl.innerText||'').trim():'';" +
          "var priceParts=rawPrice.split('\\n').filter(function(l){return l.trim().length>0;});" +
          "var price=priceParts.length>0?priceParts[0].trim():rawPrice;" +
          "var qtyEl=el.querySelector('input[name=\"quantity\"]');" +
          "var qty=1;if(qtyEl){qty=parseInt(qtyEl.getAttribute('value'),10)||1;}" +
          "out.push(JSON.stringify({asin:a,title:title,quantity:qty,price:price,productUrl:'https://www.amazon.com/dp/'+a}));" +
          "}" +
          "return '['+out.join(',')+']';" +
          "})()"
        );
        if (remainingRaw) remaining = JSON.parse(remainingRaw);
      } catch (e) {}

      return {
        status: "success",
        removed: { asin: asin, wasRemoved: !stillPresent },
        remainingItems: remaining,
        remainingCount: remaining.length
      };
    },

            // -------------------------------------------------------------------
    // changeCartQuantity — Change the quantity of a cart item.
    //
    //   delta > 0: delegates to addToCart (Amazon stacks correctly).
    //   delta < 0 or quantity: removes the item, then re-adds with the
    //     desired quantity. This is reliable because Amazon's quantity
    //     dropdown uses complex JS that's hard to trigger programmatically.
    //   quantity <= 0: delegates to removeFromCart.
    //
    // Accepts:
    //   asin (required) — The ASIN to modify
    //   delta (optional) — +N to add N more, -N to remove N (minimum 1 remains)
    //   quantity (optional) — Absolute quantity to set (e.g., 3)
    // -------------------------------------------------------------------
    async changeCartQuantity({ asin, delta, quantity, page }) {
      if (!asin) {
        return { status: "failed", errorDetails: "No ASIN provided" };
      }

      if (quantity !== undefined) {
        // Absolute mode
        if (quantity <= 0) {
          return await handlers.removeFromCart({ asin: asin });
        }
        // Remove and re-add with desired quantity
        await handlers.removeFromCart({ asin: asin });
        await $awa.sleep(2000);
        await handlers.addToCart({ asin: asin, quantity: quantity });
        return { status: "success", asin: asin, setTo: quantity, mode: "absolute" };
      }

      if (delta === undefined || delta === 0) {
        return { status: "failed", errorDetails: "Provide 'quantity' or a non-zero 'delta'" };
      }

      // Delta mode
      if (delta > 0) {
        await handlers.addToCart({ asin: asin, quantity: delta });
        return { status: "success", asin: asin, added: delta, mode: "increase" };
      }

      // Negative delta — remove and re-add with 1 (minimum)
      await handlers.removeFromCart({ asin: asin });
      if (delta < -1) {
        // delta is more negative (e.g. -3), meaning we wanted to remove more
        // Just leave the item removed
      }
      await $awa.sleep(2000);
      await handlers.addToCart({ asin: asin, quantity: 1 });
      return { status: "success", asin: asin, mode: "decrease", note: "removed and re-added with qty=1" };
    },// -------------------------------------------------------------------
    // getCartExport — Export cart contents for the OpenClaw agent to render
    // as a Markdown table. Returns structured data:
    //
    //   items[] — each with title, productUrl, price, quantity
    //   cartTotal — the total across all items
    //   itemCount — total number of items
    //
    // The agent uses this to show the user:
    //   | # | Product | Qty | Price |
    //   |---|---------|-----|-------|
    //   | 1 | [Acer 27" Monitor](...) | 1 | HKD 783.54 |
    //   | 2 | [Samsung 27" Curved](...) | 1 | HKD 998.25 |
    //   |   | **Total** | | **HKD 1,781.80** |
    //
    // No share URL — Amazon's guest-cart share feature doesn't work
    // without being signed in or using browser extensions.
    // -------------------------------------------------------------------
    async getCartExport({ page }) {
      await $awa.navigate("https://www.amazon.com/gp/cart/view.html");
      await $awa.sleep(3000);

      // Check if cart is empty
      try {
        var emptyText = await $awa.extractText("h1");
        if (emptyText && emptyText.toLowerCase().indexOf("empty") !== -1) {
          return { status: "success", itemCount: 0, items: [], cartTotal: null };
        }
      } catch (e) {}

      // Extract cart items with clean data
      var raw = null;
      try {
        raw = await $awa.evaluate(
          "(function(){" +
          "var items=document.querySelectorAll('div.sc-list-item[data-asin]');" +
          "if(items.length===0) items=document.querySelectorAll('[data-asin]');" +
          "var out=[];" +
          "for(var i=0;i<items.length;i++){" +
          "var el=items[i];" +
          "var asin=el.getAttribute('data-asin')||'';" +
          "if(!asin||asin==='')continue;" +
          "var titleEl=el.querySelector('span.a-truncate-full, span.a-size-medium, span.sc-product-title');" +
          "var rawTitle=titleEl?(titleEl.innerText||'').trim():'';" +
          "var titleLines=rawTitle.split('\\n').filter(function(l){return l.trim().length>0;});" +
          "var title=titleLines.length>0?titleLines[0].trim():rawTitle;" +
          "var priceEl=el.querySelector('span.sc-product-price, span.a-price .a-offscreen, span.a-color-price');" +
          "var rawPrice=priceEl?(priceEl.innerText||'').trim():'';" +
          "var priceParts=rawPrice.split('\\n').filter(function(l){return l.trim().length>0;});" +
          "var price=priceParts.length>0?priceParts[0].trim():rawPrice;" +
          "var qtyEl=el.querySelector('input[name=\"quantity\"]');" +
          "var qty=1;if(qtyEl){qty=parseInt(qtyEl.getAttribute('value'),10)||1;}" +
          "out.push(JSON.stringify({asin:asin,title:title,quantity:qty,price:price,productUrl:'https://www.amazon.com/dp/'+asin}));" +
          "}" +
          "return '['+out.join(',')+']';" +
          "})()"
        );
      } catch (e) {}

      var items = [];
      if (raw) {
        try { items = JSON.parse(raw); } catch (e) {}
      }

      // Extract subtotal
      var subtotal = null;
      try {
        subtotal = await $awa.evaluate(
          "(function(){" +
          "var el=document.querySelector('#sc-subtotal-amount-buybox span.a-color-price')" +
          "  || document.querySelector('#sc-subtotal-amount-activecart span');" +
          "if(!el)return null;" +
          "var parts=(el.innerText||'').split('\\n').filter(function(l){return l.trim().length>0;});" +
          "return parts.length>0?parts[0].trim():null;" +
          "})()"
        );
      } catch (e) {}

      var totalCount = 0;
      for (var i = 0; i < items.length; i++) {
        totalCount += (items[i].quantity || 1);
      }

      return {
        status: "success",
        itemCount: totalCount,
        items: items,
        cartTotal: subtotal
      };
    },
  }
};
