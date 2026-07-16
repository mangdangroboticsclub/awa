"use strict";

/**
 * AWA Skill Script — {{DOMAIN}}
 *
 * This is a scaffold for an AWA (Agentic Web Actions) skill script.
 * Each skill defines action handlers for interacting with a website. The
 * script runs inside a secure V8 isolate with a controlled $awa.* API
 * surface and a persistent Playwright browser page.
 *
 * The skill exports a manifest (domain, capabilities, URLs, action docs)
 * and a set of handler functions. Each handler receives a `page` object
 * (the Playwright Page — set automatically) plus any params from the
 * action dispatch.
 *
 * The browser context persists across all handler invocations within a
 * session. Handlers can navigate, interact, and extract data from the
 * current page state.
 *
 * ── Agent Action Docs ─────────────────────────────────────────────────────
 * The manifest's "actions" field tells the agent exactly what params each
 * action expects and what it returns. Keep these docs in sync with your
 * handler implementations — the agent relies on them to dispatch correctly.
 *
 * View with:  mpx-awa readme {{DOMAIN}}
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── Customizing ───────────────────────────────────────────────────────────
 * The handlers below are EXAMPLES. Rename them, change params, and
 * implement whatever actions your site needs. Just keep manifest.actions
 * and the handlers object in sync.
 * ──────────────────────────────────────────────────────────────────────────
 */

module.exports = {
  manifest: {
    domain: "{{DOMAIN}}",
    version: "1.0.0",
    readme: "Agentic web actions for {{DOMAIN}}.",
    actions: {
      getPage: {
        description: "Navigate to a specific page on the site and extract its content.",
        params: {
          targetUrl: { type: "string", required: false, description: "Full URL to navigate to." },
          section: { type: "string", required: false, description: "Section to visit (handler-specific)." }
        },
        examples: [
          {
            title: "Direct URL",
            params: { targetUrl: "https://www.{{DOMAIN}}/page/example" },
            result: {}
          }
        ]
      },
      searchContent: {
        description: "Search or filter content on the site.",
        params: {
          query: { type: "string", required: true, description: "Search term or filter query" }
        },
        example: {
          params: { query: "example search" },
          result: {}
        }
      },
      extractData: {
        description: "Extract specific data from the currently loaded page.",
        params: {
          selector: { type: "string", required: false, description: "CSS selector for element(s) to extract." },
          type: { type: "string", required: false, description: "'text', 'html', 'attribute', or handler default." },
          attribute: { type: "string", required: false, description: "Attribute name when type is 'attribute'." }
        },
        example: {
          params: { selector: ".main-content", type: "text" },
          result: {}
        }
      },
      fillForm: {
        description: "Fill and optionally submit a form on the current page.",
        params: {
          fields: { type: "object", required: true, description: "Key-value pairs: { '#email': 'user@example.com' }" },
          submitOnComplete: { type: "boolean", required: false, description: "Submit after filling (default: false)" },
          submitSelector: { type: "string", required: false, description: "Submit button selector." }
        },
        returns: {
          submitted: "Boolean: whether the form was submitted",
          fieldsFilled: "Number of fields filled"
        },
        example: {
          params: { fields: { "#email": "user@example.com", "#message": "Hello!" }, submitOnComplete: true },
          result: { submitted: true, fieldsFilled: 2 }
        }
      }
    },
    capabilities: ["getPage", "searchContent", "extractData", "fillForm"],
    urls: {
      home: "https://www.{{DOMAIN}}/",
      search: "https://www.{{DOMAIN}}/search?q={query}"
    }
  },

  handlers: {
    // ── EXAMPLE HANDLERS ─────────────────────────────────────────────
    // These are placeholders. Rename, re-param, and re-implement to
    // match your site's actual actions. Delete the ones you don't need.
    // ──────────────────────────────────────────────────────────────────

    // -------------------------------------------------------------------
    // getPage — Navigate to a page and extract basic content
    // See manifest.actions.getPage in manifest.json for params/returns
    // -------------------------------------------------------------------
    async getPage({ targetUrl, section, page }) {
      const url = targetUrl || `https://www.{{DOMAIN}}/${section || ""}`;
      await $awa.navigate(url);
      await $awa.waitForSelector("body", 10000);

      const title = await $awa.extractText("title");
      return { url, pageTitle: title };
    },

    // -------------------------------------------------------------------
    // searchContent — Search the site
    // -------------------------------------------------------------------
    async searchContent({ query, page }) {
      const searchUrl = `https://www.{{DOMAIN}}/search?q=${encodeURIComponent(query)}`;
      await $awa.navigate(searchUrl);
      await $awa.waitForSelector("body", 10000);

      const pageTitle = await $awa.extractText("title");
      return { query, pageTitle };
    },

    // -------------------------------------------------------------------
    // extractData — Extract content from the current page
    // -------------------------------------------------------------------
    async extractData({ selector, type, attribute, page }) {
      if (type === "html") {
        return { data: await $awa.extractHtml(selector) };
      }
      if (type === "attribute" && attribute) {
        return { data: await $awa.extractAttribute(selector, attribute) };
      }
      // Default: extract text
      return { data: await $awa.extractText(selector || "body") };
    },

    // -------------------------------------------------------------------
    // fillForm — Fill and optionally submit a form
    // -------------------------------------------------------------------
    async fillForm({ fields, submitOnComplete, submitSelector, page }) {
      let filled = 0;
      for (const [sel, val] of Object.entries(fields)) {
        await $awa.type(sel, String(val));
        filled++;
      }

      if (submitOnComplete) {
        const btn = submitSelector || "button[type=submit]";
        await $awa.click(btn);
        await $awa.waitForNavigation();
        return { submitted: true, fieldsFilled: filled };
      }

      return { submitted: false, fieldsFilled: filled };
    },
  },
};
