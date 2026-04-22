var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8"
};
function corsHeaders(origin, env) {
  return {
    "Access-Control-Allow-Origin": env.CORS_ORIGIN ?? origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
__name(corsHeaders, "corsHeaders");
function jsonResponse(data, init = {}, origin = null, env) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...env ? corsHeaders(origin, env) : {},
      ...init.headers ?? {}
    }
  });
}
__name(jsonResponse, "jsonResponse");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(origin, env)
      });
    }
    if (request.method !== "POST" || url.pathname !== "/" && url.pathname !== "/ocr") {
      return jsonResponse({ error: "Not Found" }, { status: 404 }, origin, env);
    }
    try {
      const body = await request.json();
      if (!body.imageBase64) {
        return jsonResponse({ error: "Missing imageBase64" }, { status: 400 }, origin, env);
      }
      const maxRetries = 2;
      let lastGeminiResponse = null;
      for (let i = 0; i < maxRetries; i++) {
        lastGeminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text: '\u0E2D\u0E48\u0E32\u0E19\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E08\u0E32\u0E01\u0E43\u0E1A\u0E40\u0E2A\u0E23\u0E47\u0E08\u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22/\u0E2D\u0E31\u0E07\u0E01\u0E24\u0E29 \u0E41\u0E25\u0E49\u0E27\u0E15\u0E2D\u0E1A\u0E01\u0E25\u0E31\u0E1A\u0E40\u0E1B\u0E47\u0E19 JSON \u0E25\u0E49\u0E27\u0E19\u0E40\u0E17\u0E48\u0E32\u0E19\u0E31\u0E49\u0E19 \u0E2B\u0E49\u0E32\u0E21\u0E21\u0E35 markdown \u0E2B\u0E23\u0E37\u0E2D\u0E04\u0E33\u0E2D\u0E18\u0E34\u0E1A\u0E32\u0E22\u0E40\u0E2A\u0E23\u0E34\u0E21 \u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E15\u0E49\u0E2D\u0E07\u0E40\u0E1B\u0E47\u0E19: {"rawText":string,"lines":[string],"summary":{"total":number|null,"subtotal":number|null,"vat":number|null,"serviceCharge":number|null,"discount":number|null,"billDiscount":number|null,"vatIncluded":boolean},"items":[{"name":string,"amount":number}]} \u0E01\u0E0E\u0E2A\u0E33\u0E04\u0E31\u0E0D: 1) \u0E14\u0E36\u0E07\u0E0A\u0E37\u0E48\u0E2D\u0E2A\u0E34\u0E19\u0E04\u0E49\u0E32\u0E41\u0E25\u0E30\u0E23\u0E32\u0E04\u0E32\u0E15\u0E48\u0E2D\u0E1A\u0E23\u0E23\u0E17\u0E31\u0E14\u0E43\u0E2B\u0E49\u0E04\u0E23\u0E1A\u0E17\u0E35\u0E48\u0E2A\u0E38\u0E14 2) \u0E16\u0E49\u0E32\u0E1E\u0E1A VAT/\u0E04\u0E48\u0E32\u0E1A\u0E23\u0E34\u0E01\u0E32\u0E23/\u0E2A\u0E48\u0E27\u0E19\u0E25\u0E14 \u0E43\u0E2B\u0E49\u0E43\u0E2A\u0E48\u0E43\u0E19 summary 3) \u0E16\u0E49\u0E32\u0E40\u0E2B\u0E47\u0E19\u0E04\u0E33\u0E27\u0E48\u0E32 VAT \u0E23\u0E27\u0E21\u0E43\u0E19\u0E23\u0E32\u0E04\u0E32 \u0E43\u0E2B\u0E49\u0E15\u0E31\u0E49\u0E07 vatIncluded=true 4) \u0E43\u0E0A\u0E49 number \u0E08\u0E23\u0E34\u0E07\u0E40\u0E17\u0E48\u0E32\u0E19\u0E31\u0E49\u0E19 \u0E44\u0E21\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E2A\u0E48\u0E2A\u0E31\u0E0D\u0E25\u0E31\u0E01\u0E29\u0E13\u0E4C\u0E40\u0E07\u0E34\u0E19 5) rawText \u0E41\u0E25\u0E30 lines \u0E04\u0E27\u0E23\u0E04\u0E07\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E08\u0E32\u0E01\u0E2A\u0E25\u0E34\u0E1B\u0E15\u0E32\u0E21\u0E17\u0E35\u0E48\u0E2D\u0E48\u0E32\u0E19\u0E44\u0E14\u0E49'
                    },
                    {
                      inline_data: {
                        mime_type: body.mimeType ?? "image/jpeg",
                        data: body.imageBase64
                      }
                    }
                  ]
                }
              ],
              generationConfig: {
                temperature: 0.05
              }
            })
          }
        );
        if (lastGeminiResponse.status !== 429) break;
        if (i < maxRetries - 1) await new Promise((r) => setTimeout(r, 1e3));
      }
      const geminiResponse = lastGeminiResponse;
      if (!geminiResponse.ok) {
        const text2 = await geminiResponse.text();
        return jsonResponse({ error: `Gemini error ${geminiResponse.status}`, detail: text2 }, { status: geminiResponse.status }, origin, env);
      }
      const data = await geminiResponse.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const cleaned = text.replace(/```json|```/g, "").trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return jsonResponse({ error: "Gemini did not return valid JSON", raw: text }, { status: 502 }, origin, env);
      }
      return jsonResponse(parsed, { status: 200 }, origin, env);
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : "Worker error" }, { status: 500 }, origin, env);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-q9815I/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-q9815I/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
