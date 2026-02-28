export default {
  async fetch(request, env) {
    // =========================
    // Basic config
    // =========================
    const OPENAI_API_KEY = env.OPENAI_API_KEY;
    const VECTOR_STORE_ID = env.VECTOR_STORE_ID;
    const MODEL = env.MODEL || "gpt-4.1-mini";

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // =========================
    // Helpers
    // =========================
    const json = (obj, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...corsHeaders,
          ...extraHeaders,
        },
      });

    const text = (str, status = 200, extraHeaders = {}) =>
      new Response(str, {
        status,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...corsHeaders,
          ...extraHeaders,
        },
      });

    const must = (cond, msg, status = 400) => {
      if (!cond) throw Object.assign(new Error(msg), { status });
    };

    async function openaiFetch(endpoint, bodyObj) {
      must(OPENAI_API_KEY, "Missing OPENAI_API_KEY in Worker env", 500);

      const res = await fetch(`https://api.openai.com/v1${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyObj),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: res.status, data };
      }
      return { ok: true, status: res.status, data };
    }

    async function openaiGet(endpoint) {
      must(OPENAI_API_KEY, "Missing OPENAI_API_KEY in Worker env", 500);

      const res = await fetch(`https://api.openai.com/v1${endpoint}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: res.status, data };
      }
      return { ok: true, status: res.status, data };
    }

    function normalizeAnswerStyle(v) {
      const s = String(v || "").toLowerCase();
      if (s.includes("bullet")) return "BULLET";
      if (s.includes("detail")) return "DETAILED";
      return "RECOMMENDED";
    }

    function normalizeOutputMode(v) {
      const s = String(v || "").toLowerCase();
      if (s.includes("short")) return "SHORT";
      if (s.includes("verbatim")) return "VERBATIM";
      if (s.includes("source")) return "SOURCE";
      return "HYBRID";
    }

    function safeTrim(s, n = 2400) {
      s = String(s || "");
      return s.length > n ? s.slice(0, n) + "…" : s;
    }

    function buildStrictSystem(language) {
      // STRICT: no external knowledge
      const lang = (language || "Auto").toLowerCase();
      const arabic = lang.includes("ar") || lang.includes("auto");

      return arabic
        ? [
            "أنت محرك إجابة طبي PROTOCOL-LOCKED.",
            "ممنوع منعاً باتاً استخدام أي معرفة خارج (EVIDENCE) المرفق.",
            "إذا لم تجد معلومة صريحة داخل EVIDENCE: قل NOT_FOUND فقط مع سبب مختصر.",
            "ممنوع التخمين. ممنوع الإحالة لمصادر خارجية. ممنوع ذكر إرشادات عامة غير موجودة في النص.",
            "أي رقم/جرعة/مدة يجب أن تكون موجودة حرفياً في EVIDENCE.",
            "أخرج دائماً citations: اسم الملف + مقتطف داعم.",
          ].join("\n")
        : [
            "You are a PROTOCOL-LOCKED medical QA engine.",
            "Absolutely DO NOT use any knowledge outside the provided EVIDENCE.",
            "If the answer is not explicitly supported by EVIDENCE: return NOT_FOUND with a brief reason.",
            "No guessing. No external references. No generic medical advice not present in EVIDENCE.",
            "Any numeric dosing/duration MUST appear verbatim in EVIDENCE.",
            "Always output citations: file name + supporting excerpt.",
          ].join("\n");
    }

    function buildStyleInstruction(answerStyle, outputMode, language) {
      const arabic = String(language || "").toLowerCase().includes("ar");

      // Base: keep it concise unless detailed requested
      let style = "";
      if (answerStyle === "BULLET") {
        style += arabic
          ? "اكتب الإجابة بنقاط واضحة (•)، بدون حشو.\n"
          : "Write in clear bullet points, no fluff.\n";
      } else if (answerStyle === "DETAILED") {
        style += arabic
          ? "اكتب الإجابة مفصّلة ومنظمة بعناوين قصيرة.\n"
          : "Write a detailed, well-structured answer with short headings.\n";
      } else {
        style += arabic
          ? "اكتب الإجابة بشكل عملي ومباشر (Recommended).\n"
          : "Write a practical, direct recommended answer.\n";
      }

      if (outputMode === "SHORT") {
        style += arabic
          ? "التزم بإجابة قصيرة جداً (3-6 أسطر) مع citations.\n"
          : "Keep it very short (3-6 lines) with citations.\n";
      } else if (outputMode === "VERBATIM") {
        style += arabic
          ? "اعرض الاقتباسات حرفياً قدر الإمكان، مع أقل شرح.\n"
          : "Show verbatim excerpts as much as possible with minimal commentary.\n";
      } else if (outputMode === "SOURCE") {
        style += arabic
          ? "أخرج فقط: قائمة المراجع/الاقتباسات (بدون شرح).\n"
          : "Output only: the list of citations/excerpts (no explanation).\n";
      } else {
        style += arabic
          ? "ادمج: جواب مختصر + ثم citations واضحة.\n"
          : "Hybrid: concise answer + clear citations.\n";
      }

      return style;
    }

    async function vectorSearch(query, maxResults = 8) {
      must(VECTOR_STORE_ID, "Missing VECTOR_STORE_ID in Worker env", 500);

      // Official: POST /v1/vector_stores/{id}/search :contentReference[oaicite:3]{index=3}
      const r = await openaiFetch(`/vector_stores/${encodeURIComponent(VECTOR_STORE_ID)}/search`, {
        query,
        max_num_results: maxResults,
      });

      if (!r.ok) return { ok: false, error: r.data };
      // Response typically has .data array
      const items = Array.isArray(r.data?.data) ? r.data.data : [];
      return { ok: true, items };
    }

    function extractEvidence(searchItems) {
      // We keep small evidence pack to reduce hallucinations.
      const evidence = [];

      for (const it of searchItems) {
        // Attempt to extract file name / id / text chunk
        // Different SDKs return different shapes; we safely probe:
        const fileId =
          it?.file_id ||
          it?.file?.id ||
          it?.document?.file_id ||
          it?.attributes?.file_id ||
          null;

        const fileName =
          it?.filename ||
          it?.file?.filename ||
          it?.document?.filename ||
          it?.attributes?.filename ||
          null;

        const text =
          it?.content ||
          it?.text ||
          it?.chunk ||
          it?.document?.content ||
          (Array.isArray(it?.content) ? it.content.map((c) => c?.text || "").join("\n") : "") ||
          "";

        // Some results may include metadata like page numbers; keep if found.
        const page =
          it?.page ||
          it?.metadata?.page ||
          it?.attributes?.page ||
          it?.document?.metadata?.page ||
          null;

        const score = typeof it?.score === "number" ? it.score : null;

        if (safeTrim(text).trim()) {
          evidence.push({
            id: `E${evidence.length + 1}`,
            file_id: fileId,
            filename: fileName || (fileId ? `file:${fileId}` : "unknown_file"),
            page: page,
            score: score,
            excerpt: safeTrim(text, 900),
          });
        }

        if (evidence.length >= 8) break;
      }

      return evidence;
    }

    async function generateAnswer({ question, drug, language, answerStyle, outputMode, evidence }) {
      const system = buildStrictSystem(language);
      const style = buildStyleInstruction(answerStyle, outputMode, language);

      const userPrompt = [
        `QUESTION: ${question}`,
        drug ? `SELECTED_TOPIC/DRUG: ${drug}` : "",
        "",
        "EVIDENCE (ONLY source of truth):",
        ...evidence.map((e) => {
          const pageStr = e.page !== null && e.page !== undefined ? ` | page:${e.page}` : "";
          return `- [${e.id}] ${e.filename}${pageStr}\n  EXCERPT: ${e.excerpt}`;
        }),
        "",
        "TASK:",
        "1) Answer strictly using ONLY EVIDENCE above.",
        "2) If not answerable from EVIDENCE: verdict=NOT_FOUND and explain briefly why.",
        "3) Provide citations array: each item references evidence ids and includes filename + supporting excerpt.",
      ]
        .filter(Boolean)
        .join("\n");

      // Official: POST /v1/responses :contentReference[oaicite:4]{index=4}
      const schema = {
        type: "json_schema",
        json_schema: {
          name: "doseguide_answer",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              verdict: { type: "string", enum: ["OK", "NOT_FOUND"] },
              answer: { type: "string" },
              citations: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    evidence_ids: {
                      type: "array",
                      items: { type: "string" },
                    },
                    filename: { type: "string" },
                    page: { type: ["integer", "null"] },
                    excerpt: { type: "string" },
                  },
                  required: ["evidence_ids", "filename", "page", "excerpt"],
                },
              },
            },
            required: ["verdict", "answer", "citations"],
          },
        },
      };

      const r = await openaiFetch("/responses", {
        model: MODEL,
        input: [
          { role: "system", content: system },
          { role: "system", content: style },
          { role: "user", content: userPrompt },
        ],
        response_format: schema,
      });

      if (!r.ok) return { ok: false, error: r.data };

      // Responses output: parse the JSON text
      const outText =
        r.data?.output_text ||
        (Array.isArray(r.data?.output)
          ? r.data.output
              .map((o) => (Array.isArray(o?.content) ? o.content.map((c) => c?.text || "").join("") : ""))
              .join("\n")
          : "");

      let parsed = null;
      try {
        parsed = JSON.parse(outText);
      } catch {
        // Fallback
        parsed = { verdict: "NOT_FOUND", answer: "Parser error: model output was not valid JSON.", citations: [] };
      }

      return { ok: true, result: parsed };
    }

    // =========================
    // Routes
    // =========================
    try {
      if (path === "/" || path === "/health") {
        return text("DoseGuide Worker OK");
      }

      // List files attached to this vector store (for UI auto-population)
      // Official: GET /v1/vector_stores/{id}/files :contentReference[oaicite:5]{index=5}
      if (path === "/catalog" && request.method === "GET") {
        must(VECTOR_STORE_ID, "Missing VECTOR_STORE_ID", 500);

        const list = await openaiGet(`/vector_stores/${encodeURIComponent(VECTOR_STORE_ID)}/files?limit=100`);
        if (!list.ok) return json({ ok: false, error: list.data }, 500);

        // Return minimal set
        const files = Array.isArray(list.data?.data) ? list.data.data : [];
        const simplified = files.map((f) => ({
          id: f?.id || f?.file_id || null,
          // Some responses use file_id; keep both
          file_id: f?.file_id || null,
          status: f?.status || null,
          // filename may not be present in vector store file object; UI can show id
          // (If you need real filename, you can fetch /files/{file_id} separately)
        }));

        return json({ ok: true, vector_store_id: VECTOR_STORE_ID, count: simplified.length, files: simplified });
      }

      // Main ask endpoint
      if (path === "/ask" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));

        const question = String(body.question || body.q || "").trim();
        const drug = String(body.drug || body.topic || "").trim();
        const language = String(body.language || body.lang || "Auto");
        const answerStyle = normalizeAnswerStyle(body.answer_style || body.style);
        const outputMode = normalizeOutputMode(body.output_mode || body.received_mode || body.mode);

        must(question.length >= 2, "Missing question", 400);

        // Retrieval query: include drug/topic if provided
        const retrievalQuery = drug ? `${drug}\n${question}` : question;

        const s = await vectorSearch(retrievalQuery, 10);
        if (!s.ok) {
          return json({ ok: false, error: "VECTOR_SEARCH_FAILED", details: s.error }, 502);
        }

        const evidence = extractEvidence(s.items);

        // Hard gate: no evidence => NOT_FOUND
        if (!evidence.length) {
          return json({
            ok: true,
            verdict: "NOT_FOUND",
            answer: "NOT_FOUND: لا يوجد أي نص داعم داخل الملفات المرتبطة بهذا السؤال.",
            citations: [],
          });
        }

        const ans = await generateAnswer({
          question,
          drug,
          language,
          answerStyle,
          outputMode,
          evidence,
        });

        if (!ans.ok) {
          return json({ ok: false, error: "ANSWER_FAILED", details: ans.error }, 502);
        }

        // Enforce STRICT again: if model returned citations empty, downgrade to NOT_FOUND
        const result = ans.result || {};
        const citations = Array.isArray(result.citations) ? result.citations : [];

        if (!citations.length) {
          return json({
            ok: true,
            verdict: "NOT_FOUND",
            answer: "NOT_FOUND: لم أستطع استخراج مرجع داعم من الملفات، لذلك لن أقدّم إجابة.",
            citations: [],
          });
        }

        return json({ ok: true, ...result });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      const status = err?.status || 500;
      return json({ ok: false, error: err?.message || "Server error" }, status);
    }
  },
};
