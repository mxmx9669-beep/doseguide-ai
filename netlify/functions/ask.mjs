// netlify/functions/ask.mjs
// Protocol-Locked engine (GLOBAL strict mode):
// - Evidence-first (verbatim quotes) -> then compose answer ONLY from evidence
// - No evidence => NOT_FOUND
// - Supports modes: verbatim | short | hybrid | link
//
// Backward compatible:
// - payload.answerMode (recommended|detailed|bullet) still controls style
// New (optional):
// - payload.mode: "hybrid" (default) | "verbatim" | "short" | "link"

import fs from "node:fs/promises";
import path from "node:path";

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function clampStr(s, max = 280) {
  const t = String(s ?? "");
  return t.length <= max ? t : t.slice(0, max) + "…";
}

function normalizeSpace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function extractOutputText(resp) {
  // Robust extraction across response shapes
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text.trim();

  const out = resp?.output;
  if (!Array.isArray(out)) return "";

  let text = "";
  for (const item of out) {
    if (item?.type === "message" && item?.role === "assistant" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (typeof c?.text === "string") text += c.text;
        if (typeof c?.content === "string") text += c.content;
      }
    }
  }
  return text.trim();
}

// --- Strict schemas (Responses API json_schema) ---
const evidenceSchema = {
  name: "protocol_evidence",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["FOUND", "NOT_FOUND"] },
      evidence: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            quote: { type: "string", minLength: 1, maxLength: 320 },
            section_hint: { type: "string", minLength: 0, maxLength: 120 },
            page_hint: { type: "string", minLength: 0, maxLength: 80 },
          },
          required: ["quote", "section_hint", "page_hint"],
        },
      },
      note: { type: "string", minLength: 0, maxLength: 240 },
    },
    required: ["verdict", "evidence", "note"],
  },
};

const answerSchema = {
  name: "protocol_answer",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["FOUND", "NOT_FOUND"] },
      short_answer: { type: "string", minLength: 0, maxLength: 1200 },
      verbatim: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            quote: { type: "string", minLength: 1, maxLength: 320 },
            section_hint: { type: "string", minLength: 0, maxLength: 120 },
            page_hint: { type: "string", minLength: 0, maxLength: 80 },
          },
          required: ["quote", "section_hint", "page_hint"],
        },
      },
      source_hint: { type: "string", minLength: 0, maxLength: 240 },
      warnings: {
        type: "array",
        maxItems: 6,
        items: { type: "string", minLength: 1, maxLength: 160 },
      },
    },
    required: ["verdict", "short_answer", "verbatim", "source_hint", "warnings"],
  },
};

async function callOpenAI({ url, apiKey, body }) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const resp = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = resp?.error?.message || resp?.message || "OpenAI API error";
    throw new Error(`${msg}`);
  }
  return resp;
}

function minimalNotFound(lang = "ar") {
  const ar = {
    verdict: "NOT_FOUND",
    short_answer: "غير موجود في بروتوكول/ملف PDF هذا الدواء.",
    verbatim: [],
    source_hint: "",
    warnings: ["راجع البروتوكول/النسخة المحدثة أو ارفع نسخة أحدث."],
  };
  const en = {
    verdict: "NOT_FOUND",
    short_answer: "Not found in this drug protocol/PDF.",
    verbatim: [],
    source_hint: "",
    warnings: ["Please review the protocol source or upload a newer version."],
  };
  return lang === "en" ? en : ar;
}

function enforceEvidenceSanity(evidenceObj) {
  // Hard-stop rules:
  // - must be valid schema (already strict), but also:
  // - FOUND requires >=1 evidence quote
  // - quotes must be non-trivial (avoid generic filler)
  const obj = evidenceObj || {};
  const verdict = obj.verdict;

  if (verdict === "FOUND") {
    const ev = Array.isArray(obj.evidence) ? obj.evidence : [];
    const cleaned = ev
      .map((e) => ({
        quote: normalizeSpace(e?.quote),
        section_hint: normalizeSpace(e?.section_hint),
        page_hint: normalizeSpace(e?.page_hint),
      }))
      .filter((e) => e.quote.length >= 8); // avoid tiny fragments

    if (cleaned.length === 0) {
      return { verdict: "NOT_FOUND", evidence: [], note: "No usable evidence extracted." };
    }

    // de-duplicate quotes
    const seen = new Set();
    const dedup = [];
    for (const e of cleaned) {
      const key = e.quote.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        dedup.push(e);
      }
    }
    return { verdict: "FOUND", evidence: dedup.slice(0, 6), note: clampStr(obj.note || "", 240) };
  }

  return { verdict: "NOT_FOUND", evidence: [], note: clampStr(obj.note || "", 240) };
}

function inferLangFromUserSetting(langSetting, question) {
  const l = String(langSetting || "auto").toLowerCase();
  if (l !== "auto") return l;
  // naive: if Arabic letters exist -> ar else en
  return /[\u0600-\u06FF]/.test(question) ? "ar" : "en";
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json({ ok: true }, 200);
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return json({ error: "Missing OPENAI_API_KEY in Netlify environment variables" }, 500);
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const drugKey = String(payload.drugKey || "").trim().toLowerCase();
  const question = String(payload.question || "").trim();
  const langSetting = String(payload.lang || "auto").trim().toLowerCase(); // auto|ar|en|hi|tl|am (we focus ar/en)
  const answerMode = String(payload.answerMode || "recommended").trim().toLowerCase(); // recommended|detailed|bullet (legacy)
  const mode = String(payload.mode || "hybrid").trim().toLowerCase(); // hybrid|verbatim|short|link

  if (!drugKey) return json({ error: "drugKey is required" }, 400);
  if (!question) return json({ error: "question is required" }, 400);

  // Load manifests from functions bundle
  const dataDir = path.join(process.cwd(), "netlify", "functions", "data");
  const refsPath = path.join(dataDir, "refs.manifest.json");

  let refs;
  try {
    refs = JSON.parse(await fs.readFile(refsPath, "utf8"));
  } catch (e) {
    return json({ error: "Cannot read refs.manifest.json", details: String(e?.message || e) }, 500);
  }

  const entry = refs?.[drugKey];
  const vectorStoreId = entry?.vector_store_id;

  if (!vectorStoreId) {
    return json({
      ok: true,
      reply: "هذا الدواء غير موجود ضمن القائمة المتاحة في النظام (لا يوجد PDF/VectorStore مرتبط به).",
      locked: true,
      drugKey,
    });
  }

  const lang = inferLangFromUserSetting(langSetting, question);

  const styleHint =
    answerMode === "detailed"
      ? lang === "en"
        ? "Provide a detailed answer but without filler."
        : "قدّم شرحاً مفصلاً لكن بدون حشو."
      : answerMode === "bullet"
      ? lang === "en"
        ? "Answer in short, clear bullet points."
        : "أجب بنقاط قصيرة وواضحة."
      : lang === "en"
      ? "Provide a concise, practical answer."
      : "أجب بإجابة مختصرة عملية.";

  const url = "https://api.openai.com/v1/responses";
  const model = process.env.OPENAI_MODEL || "gpt-5.2";

  // ========== STEP 1: Evidence extraction (file_search allowed) ==========
  const SYSTEM_EVIDENCE = lang === "en"
    ? `
You are a Protocol-Locked clinical engine.
Task: Extract ONLY verbatim evidence quotes from the provided protocol context (via file_search) that directly answer the user's question.
Rules:
- Do NOT answer the question.
- Do NOT infer, reinterpret, or combine conditions.
- Return verdict NOT_FOUND if you cannot find explicit protocol text supporting an answer.
- Quotes MUST be copied exactly as they appear (verbatim).
- Prefer up to 6 short quotes (<= 320 chars each).
- Add optional section/page hints if visible in text (e.g., "ARGATROBAN", "Page 11").
Return JSON only per the schema.
`
    : `
أنت محرك سريري "Protocol-Locked".
مهمتك: استخراج أدلة نصية حرفية فقط من البروتوكول عبر file_search تُجيب مباشرة على سؤال المستخدم.
قواعد صارمة:
- ممنوع الإجابة عن السؤال.
- ممنوع الاستنتاج أو إعادة تفسير النص أو دمج الشروط.
- إذا لم تجد نصًا صريحًا يدعم الإجابة => verdict = NOT_FOUND.
- الاقتباسات يجب أن تكون حرفية كما هي في البروتوكول.
- بحد أقصى 6 اقتباسات قصيرة (<= 320 حرف).
- أضف تلميح قسم/صفحة إن كان ظاهرًا في النص (مثل "ARGATROBAN" أو "Page 11").
أعد JSON فقط حسب المخطط.
`;

  const USER_EVIDENCE = lang === "en"
    ? `Drug key: ${drugKey}\nUser question:\n${question}\n\nExtract verbatim protocol evidence only.`
    : `Drug key: ${drugKey}\nسؤال المستخدم:\n${question}\n\nاستخرج أدلة حرفية من البروتوكول فقط.`;

  const reqEvidence = {
    model,
    input: [
      { role: "system", content: [{ type: "text", text: SYSTEM_EVIDENCE.trim() }] },
      { role: "user", content: [{ type: "text", text: USER_EVIDENCE.trim() }] },
    ],
    tools: [{ type: "file_search" }],
    tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
    response_format: { type: "json_schema", json_schema: evidenceSchema },
    temperature: 0,
    max_output_tokens: 900,
  };

  let evidenceResult;
  try {
    const resp1 = await callOpenAI({ url, apiKey: OPENAI_API_KEY, body: reqEvidence });
    const txt1 = extractOutputText(resp1);
    const parsed1 = safeJsonParse(txt1);
    evidenceResult = enforceEvidenceSanity(parsed1);
  } catch (e) {
    // If evidence extraction fails, hard stop to NOT_FOUND (safer)
    const nf = minimalNotFound(lang);
    return json({
      ok: true,
      locked: true,
      drugKey,
      vector_store_id: vectorStoreId,
      mode,
      reply: nf.short_answer,
      result: nf,
      error_guardrail: "evidence_extraction_failed",
      details: String(e?.message || e),
    });
  }

  if (evidenceResult.verdict !== "FOUND") {
    const nf = minimalNotFound(lang);
    return json({
      ok: true,
      locked: true,
      drugKey,
      vector_store_id: vectorStoreId,
      mode,
      reply: nf.short_answer,
      result: nf,
      evidence_note: evidenceResult.note,
    });
  }

  // ========== STEP 2: Compose answer ONLY from extracted evidence (no file_search) ==========
  const SYSTEM_ANSWER = lang === "en"
    ? `
You are a Protocol-Locked clinical engine.
Task: Compose the final output using ONLY the provided verbatim evidence quotes.
Rules:
- Do NOT add any dose, timing, condition, or step that is not explicitly contained in the quotes.
- Do NOT infer or reinterpret. If the quotes are insufficient to answer, set verdict NOT_FOUND.
- Keep wording faithful and minimal.
- Provide "source_hint" using section/page hints from evidence when available.
Output JSON only per the schema.
Style: ${styleHint}
`
    : `
أنت محرك سريري "Protocol-Locked".
مهمتك: صياغة المخرجات النهائية باستخدام الاقتباسات الحرفية المقدّمة فقط.
قواعد صارمة:
- ممنوع إضافة أي جرعة/توقيت/شرط/خطوة غير مذكورة صراحة داخل الاقتباسات.
- ممنوع الاستنتاج أو إعادة التفسير. إذا كانت الاقتباسات غير كافية => verdict = NOT_FOUND.
- اجعل الصياغة قصيرة وأمينة للنص.
- ضع source_hint اعتمادًا على تلميحات القسم/الصفحة من الأدلة إن توفرت.
أعد JSON فقط حسب المخطط.
أسلوب الإجابة: ${styleHint}
`;

  const USER_ANSWER = lang === "en"
    ? `User question:\n${question}\n\nVerbatim evidence quotes:\n${JSON.stringify(evidenceResult.evidence, null, 2)}`
    : `سؤال المستخدم:\n${question}\n\nالاقتباسات الحرفية (Evidence):\n${JSON.stringify(evidenceResult.evidence, null, 2)}`;

  const reqAnswer = {
    model,
    input: [
      { role: "system", content: [{ type: "text", text: SYSTEM_ANSWER.trim() }] },
      { role: "user", content: [{ type: "text", text: USER_ANSWER.trim() }] },
    ],
    response_format: { type: "json_schema", json_schema: answerSchema },
    temperature: 0,
    max_output_tokens: 900,
  };

  let finalObj;
  try {
    const resp2 = await callOpenAI({ url, apiKey: OPENAI_API_KEY, body: reqAnswer });
    const txt2 = extractOutputText(resp2);
    const parsed2 = safeJsonParse(txt2);

    // If parsing fails, hard stop to NOT_FOUND (safer)
    if (!parsed2 || typeof parsed2 !== "object") {
      finalObj = minimalNotFound(lang);
    } else {
      // Basic hard rules: FOUND must include verbatim evidence
      const v = parsed2.verdict;
      const verbatim = Array.isArray(parsed2.verbatim) ? parsed2.verbatim : [];
      if (v === "FOUND" && verbatim.length === 0) finalObj = minimalNotFound(lang);
      else finalObj = parsed2;
    }
  } catch (e) {
    finalObj = minimalNotFound(lang);
    finalObj.warnings = [
      ...(finalObj.warnings || []),
      lang === "en" ? "Answer composer failed; returned NOT_FOUND for safety." : "فشل توليد الإجابة؛ تم إرجاع NOT_FOUND للأمان.",
    ];
  }

  // ========== Apply mode (what to show) ==========
  // Always keep evidence in `result.verbatim` for audit; UI can hide it.
  const result = {
    verdict: finalObj.verdict,
    short_answer: finalObj.short_answer || "",
    verbatim: finalObj.verbatim && finalObj.verbatim.length ? finalObj.verbatim : evidenceResult.evidence,
    source_hint: finalObj.source_hint || "",
    warnings: Array.isArray(finalObj.warnings) ? finalObj.warnings : [],
  };

  // If mode is verbatim: hide short answer
  if (mode === "verbatim") {
    result.short_answer = "";
  }

  // If mode is short: hide verbatim (UI still gets it; reply will be short)
  // (We keep verbatim in result for audit/logging; UI can choose to hide.)
  const reply =
    mode === "verbatim"
      ? (result.verbatim.length
          ? result.verbatim
              .map((e, i) => `${i + 1}) ${e.quote}${e.section_hint ? `\n   [${e.section_hint}]` : ""}${e.page_hint ? ` ${e.page_hint}` : ""}`)
              .join("\n\n")
          : minimalNotFound(lang).short_answer)
      : mode === "link"
      ? (result.source_hint
          ? (lang === "en"
              ? `Source: ${result.source_hint}\n\nEvidence:\n${result.verbatim[0]?.quote || ""}`
              : `المصدر: ${result.source_hint}\n\nالدليل:\n${result.verbatim[0]?.quote || ""}`)
          : (lang === "en" ? "Source not found in protocol." : "المصدر غير موجود في البروتوكول."))
      : // short/hybrid default
        (result.verdict === "FOUND" && result.short_answer
          ? result.short_answer
          : minimalNotFound(lang).short_answer);

  return json({
    ok: true,
    locked: true,
    drugKey,
    vector_store_id: vectorStoreId,
    mode,
    answerMode,
    reply,
    result,
  });
}
