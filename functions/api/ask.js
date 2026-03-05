// ============================================================
// FILE: /functions/api/ask.js
// THERA GUARD AI — Backend v8 (QUESTION + CASE) — Protocol-Locked RAG with PDF URLs
// Runtime: Cloudflare Pages Functions
//
// Required env:
// - OPENAI_API_KEY
// - VECTOR_STORE_ID
// Optional env:
// - MODEL (default: gpt-4.1-mini)
// - PDF_BASE_URL (default: https://yourdomain.com/pdfs/)
//
// Request body supports:
// {
//   "mode": "QUESTION" | "CASE" (optional; auto-detected if omitted),
//   "question_text": "...",      (optional)
//   "case_text": "..."           (optional)
// }
//
// Response:
// { ok, final_note, sources[], debug{...} }
// ============================================================

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed. Use POST." }, 405, corsHeaders);
  }

  try {
    const body = await request.json().catch(() => ({}));

    const case_text = typeof body.case_text === "string" ? body.case_text.trim() : "";
    const question_text = typeof body.question_text === "string" ? body.question_text.trim() : "";
    const modeRaw = typeof body.mode === "string" ? body.mode.trim().toUpperCase() : "";

    const mode = detectMode(modeRaw, case_text, question_text);

    if (!env.OPENAI_API_KEY) {
      return jsonResponse({ ok: false, error: "Server configuration error: OPENAI_API_KEY missing" }, 500, corsHeaders);
    }
    if (!env.VECTOR_STORE_ID) {
      return jsonResponse({ ok: false, error: "Server configuration error: VECTOR_STORE_ID missing" }, 500, corsHeaders);
    }

    if (!case_text && !question_text) {
      return jsonResponse(
        { ok: false, error: "Provide either case_text (case) or question_text (question)." },
        400,
        corsHeaders
      );
    }

    const model = env.MODEL || "gpt-4.1-mini";
    const pdfBaseUrl = env.PDF_BASE_URL || "https://yourdomain.com/pdfs/";

    // ---- Extraction (best-effort) + CrCl
    const extracted = extractBasics(case_text || question_text);
    const computed = computeCrCl(extracted);

    // ---- Build retrieval query
    const retrievalQuery = buildRetrievalQuery({ mode, case_text, question_text, extracted, computed });

    // ---- RAG search (Protocol-Locked)
    const evidence = await vectorStoreSearch(env, env.VECTOR_STORE_ID, retrievalQuery, pdfBaseUrl);

    // Protocol Locked behavior:
    // - For QUESTION: must have evidence; otherwise return an error (no hallucination)
    // - For CASE: if no evidence, still allow output BUT must label Sources: N/A and avoid guideline claims
    if (mode === "QUESTION" && evidence.snippets.length === 0) {
      return jsonResponse(
        {
          ok: false,
          error: "No evidence found in vector store for this question (Protocol-Locked). Try rephrasing or ensure the relevant PDF is in the vector store.",
          debug: { mode, retrievalQuery, evidence_count: 0 },
        },
        200,
        corsHeaders
      );
    }

    // ---- Build prompts per mode
    const systemPrompt =
      mode === "QUESTION"
        ? buildQuestionPrompt({ hasEvidence: evidence.snippets.length > 0 })
        : buildCasePrompt({ extracted, computed, hasEvidence: evidence.snippets.length > 0 });

    const userMessage = buildUserMessage({ mode, case_text, question_text, extracted, computed, evidence });

    // ---- Generate answer
    const draft = await callOpenAIChat(env, {
      model,
      systemPrompt,
      userMessage,
      maxTokens: mode === "QUESTION" ? 650 : 900,
      temperature: 0.2,
    });

    // ---- Validate formatting
    const validated = mode === "QUESTION" ? validateQuestionFormat(draft) : validateCaseFormat(draft);

    let final_note = draft;

    if (!validated.ok) {
      // 1 retry repair
      const repairSystem = mode === "QUESTION" ? buildQuestionRepairPrompt(validated.reason) : buildCaseRepairPrompt(validated.reason);

      final_note = await callOpenAIChat(env, {
        model,
        systemPrompt: repairSystem,
        userMessage: draft,
        maxTokens: mode === "QUESTION" ? 550 : 750,
        temperature: 0.0,
      });
    }

    // finalize sources proof (with URLs)
    const sources = evidence.sources;

    return jsonResponse(
      {
        ok: true,
        mode,
        final_note,
        sources,
        debug: {
          extracted,
          computed,
          retrievalQuery,
          evidence_count: evidence.snippets.length,
          vector_store_id: env.VECTOR_STORE_ID,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      corsHeaders
    );
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error?.message || "Internal server error",
        details: String(error),
      },
      500,
      corsHeaders
    );
  }
}

// ============================================================
// MODE DETECTION
// ============================================================

function detectMode(modeRaw, case_text, question_text) {
  if (modeRaw === "QUESTION" || modeRaw === "CASE") return modeRaw;

  // Auto:
  // - If question exists and case absent => QUESTION
  // - If case exists => CASE (even if question also exists)
  if (case_text) return "CASE";
  return "QUESTION";
}

// ============================================================
// PROMPTS
// ============================================================

function buildQuestionPrompt({ hasEvidence }) {
  // Strict direct question output with citations
  return `
You are THERA GUARD AI (Clinical Pharmacist), Protocol-Locked.

You MUST answer using ONLY the provided EVIDENCE SNIPPETS.
If evidence is insufficient, say: "Insufficient evidence in provided sources."

OUTPUT FORMAT (EXACT):

Answer:
- <direct answer in 1–3 lines>

Explanation:
- <very brief reasoning tied to the evidence>

Quote:
- "<short supporting excerpt (<=25 words)>" [S#]

Sources:
- [S1] <filename> p.<page or N/A>
- [S2] ...

Rules:
- Do NOT mention general medical knowledge.
- Do NOT invent dosing. Use only evidence.
- Always include at least 1 source line when evidence exists.
- If ${hasEvidence ? "evidence exists" : "no evidence exists"}, follow the rules accordingly.
`.trim();
}

function buildCasePrompt({ extracted, computed, hasEvidence }) {
  const { mrn, age, sex, weightKg, scrUmol } = extracted;

  const hints = [
    `Patient hints (best-effort):`,
    `- MRN: ${mrn || "N/A"}`,
    `- Age: ${age ?? "N/A"}`,
    `- Sex: ${sex || "N/A"}`,
    `- Weight: ${weightKg ?? "N/A"} kg`,
    `- SCr: ${scrUmol ?? "N/A"} umol/L`,
    `- CrCl: ${computed.crclMlMin ?? "N/A"} mL/min`,
    hasEvidence ? `- Evidence: PROVIDED (cite in Sources)` : `- Evidence: NOT PROVIDED`,
  ].join("\n");

  // Strict template + explicit "current vs recommended"
  return `
You are THERA GUARD AI (Clinical Pharmacist).

ABSOLUTE OUTPUT CONTRACT:
- Output MUST follow EXACTLY the template below.
- Do NOT add any additional sections.
- Use N/A for missing data.
- Calculate CrCl only if inputs exist; otherwise write N/A.
- For dosing recommendations: if evidence is provided, use it and cite Sources. If evidence is not provided, do NOT give guideline dosing; instead advise "Need protocol evidence".

TEMPLATE (COPY EXACTLY):

S: Patient (MRN: ), Y, kg admitted to ICU.
Reason for Admission:
PMH:
Home Meds:

O: Vitals:
Labs:
Renal: SCr umol/L, Calculated CrCl —

A: Primary admission problem and pharmacist medication assessment.

P:
Current Medications (with current dose if present):
Dose Check (Current vs Recommended):
Pharmacist Intervention (write the correction clearly):
Follow-up Plan:
Sources:

Rules:
- "Dose Check" MUST include at least 1 line like:
  - Drug: Current = <dose>; Recommended = <dose from protocol>; Action = <change>
  If current dose is missing, write Current = N/A.
  If evidence missing, write Recommended = "Need protocol evidence (vector store)".
- "Pharmacist Intervention" must be explicit: "Change from X to Y", NOT "check".
- "Sources:" if evidence exists, list 1–5 sources in this exact format:
  - [S1] <filename> p.<page or N/A>
If no evidence, write: Sources: N/A

${hints}
`.trim();
}

function buildQuestionRepairPrompt(reason) {
  return `
You are a strict formatter.
Rewrite into the EXACT required QUESTION format.

Failure reason: ${reason}

OUTPUT FORMAT:

Answer:
- ...

Explanation:
- ...

Quote:
- "..." [S#]

Sources:
- [S1] ...
`.trim();
}

function buildCaseRepairPrompt(reason) {
  return `
You are a strict formatter.
Rewrite into the EXACT required CASE template. No extra sections.

Failure reason: ${reason}

TEMPLATE:

S: Patient (MRN: ), Y, kg admitted to ICU.
Reason for Admission:
PMH:
Home Meds:

O: Vitals:
Labs:
Renal: SCr umol/L, Calculated CrCl —

A: Primary admission problem and pharmacist medication assessment.

P:
Current Medications (with current dose if present):
Dose Check (Current vs Recommended):
Pharmacist Intervention (write the correction clearly):
Follow-up Plan:
Sources:
`.trim();
}

// ============================================================
// USER MESSAGE (CASE/QUESTION + EVIDENCE)
// ============================================================

function buildUserMessage({ mode, case_text, question_text, extracted, computed, evidence }) {
  const lines = [];

  if (mode === "QUESTION") {
    lines.push(`QUESTION:\n${question_text || case_text}`);
  } else {
    lines.push(`CASE TEXT:\n${case_text || ""}`);
    if (question_text) lines.push(`\nFOCUS QUESTION (if any):\n${question_text}`);
  }

  if (computed.crclMlMin != null) {
    lines.push(`\nCOMPUTED RENAL (best effort): CrCl ≈ ${computed.crclMlMin} mL/min (Cockcroft-Gault).`);
  }

  if (evidence.snippets.length > 0) {
    lines.push(`\nEVIDENCE SNIPPETS (ONLY allowed knowledge):`);
    evidence.snippets.slice(0, 6).forEach((s, i) => {
      const tag = `S${i + 1}`;
      lines.push(
        `- [${tag}] file=${s.filename || "N/A"} page=${s.page ?? "N/A"} score=${formatScore(s.score)}\n  ${s.text}`
      );
    });
  } else {
    lines.push(`\nEVIDENCE SNIPPETS: NONE`);
  }

  return lines.join("\n");
}

function formatScore(x) {
  if (typeof x !== "number") return "N/A";
  return x.toFixed(3);
}

// ============================================================
// VALIDATION
// ============================================================

function validateQuestionFormat(text) {
  const required = ["Answer:", "Explanation:", "Quote:", "Sources:"];
  for (const r of required) {
    if (!text.includes(r)) return { ok: false, reason: `Missing section: "${r}"` };
  }
  // Must include at least one [S#] reference in Quote or Sources
  if (!/\[S\d+\]/.test(text)) return { ok: false, reason: `Missing citation tag like [S1]` };
  return { ok: true };
}

function validateCaseFormat(text) {
  const required = [
    "S: Patient (MRN:",
    "Reason for Admission:",
    "PMH:",
    "Home Meds:",
    "O: Vitals:",
    "Labs:",
    "Renal: SCr",
    "A:",
    "P:",
    "Current Medications (with current dose if present):",
    "Dose Check (Current vs Recommended):",
    "Pharmacist Intervention (write the correction clearly):",
    "Follow-up Plan:",
    "Sources:",
  ];
  for (const r of required) {
    if (!text.includes(r)) return { ok: false, reason: `Missing required line/heading: "${r}"` };
  }
  // ban classic SOAP
  const banned = ["SUBJECTIVE", "OBJECTIVE", "ASSESSMENT", "PLAN", "MEDICATION REVIEW"];
  for (const b of banned) {
    if (text.toUpperCase().includes(b)) return { ok: false, reason: `Contains banned heading: "${b}"` };
  }
  return { ok: true };
}

// ============================================================
// EXTRACTION + CrCl
// ============================================================

function extractBasics(text) {
  const t = text || "";

  // MRN
  const mrnMatch =
    t.match(/\bMRN\b[:\s]*([0-9]{4,})/i) ||
    t.match(/\bMR\s*No\b[:\s]*([0-9]{4,})/i) ||
    t.match(/\bMR\b[:\s]*([0-9]{4,})/i);
  const mrn = mrnMatch ? mrnMatch[1] : "";

  // Age
  const ageMatch =
    t.match(/\b(age|aged)\b[:\s]*([0-9]{1,3})/i) ||
    t.match(/\b([0-9]{1,3})\s*(y|yr|yrs|years)\b/i);
  const age = ageMatch ? parseInt(ageMatch[2] || ageMatch[1], 10) : null;

  // Sex
  let sex = "";
  if (/\bfemale\b/i.test(t) || /\bأنثى\b/.test(t)) sex = "female";
  if (/\bmale\b/i.test(t) || /\bذكر\b/.test(t)) sex = "male";

  // Weight (kg)
  const wMatch =
    t.match(/\bweight\b[:\s]*([0-9]{2,3}(?:\.[0-9])?)\s*kg/i) ||
    t.match(/\bwt\b[:\s]*([0-9]{2,3}(?:\.[0-9])?)\s*kg/i) ||
    t.match(/\b([0-9]{2,3}(?:\.[0-9])?)\s*kg\b/i);
  const weightKg = wMatch ? parseFloat(wMatch[1]) : null;

  // SCr umol/L
  const scrMatch =
    t.match(/\b(creatinine|s\.?cr|scr)\b[^0-9]{0,12}([0-9]{2,4}(?:\.[0-9])?)\s*(umol\/l|µmol\/l|micromol\/l)?/i) ||
    t.match(/\bالكرياتينين\b[^0-9]{0,12}([0-9]{2,4}(?:\.[0-9])?)/);
  const scrUmol = scrMatch ? parseFloat(scrMatch[2] || scrMatch[1]) : null;

  return { mrn, age, sex, weightKg, scrUmol };
}

function computeCrCl({ age, sex, weightKg, scrUmol }) {
  if (!age || !weightKg || !scrUmol) return { crclMlMin: null, scrMgDl: null };

  const scrMgDl = scrUmol / 88.4;
  if (!scrMgDl || scrMgDl <= 0) return { crclMlMin: null, scrMgDl: null };

  let crcl = ((140 - age) * weightKg) / (72 * scrMgDl);
  if (sex === "female") crcl *= 0.85;

  const crclRounded = Math.round(crcl);
  return {
    crclMlMin: Number.isFinite(crclRounded) ? crclRounded : null,
    scrMgDl: Number(scrMgDl.toFixed(2)),
  };
}

// ============================================================
// RETRIEVAL QUERY
// ============================================================

function buildRetrievalQuery({ mode, case_text, question_text, extracted, computed }) {
  const parts = [];

  // Strong pharmacy anchors
  parts.push("protocol dosing adjustment renal impairment guideline dosing anticoagulation ICU");

  if (mode === "QUESTION") {
    parts.push(question_text || "");
  } else {
    // CASE mode: use meds and labs context
    parts.push((question_text || "").slice(0, 250));
    parts.push((case_text || "").slice(0, 550));
  }

  if (computed.crclMlMin != null) parts.push(`CrCl ${computed.crclMlMin} mL/min`);
  if (extracted.scrUmol) parts.push(`Creatinine ${extracted.scrUmol} umol/L`);
  if (extracted.age) parts.push(`Age ${extracted.age}`);
  if (extracted.weightKg) parts.push(`Weight ${extracted.weightKg} kg`);

  return parts.filter(Boolean).join(" | ");
}

// ============================================================
// VECTOR STORE SEARCH (OpenAI) - UPDATED WITH URL SUPPORT
// ============================================================

async function vectorStoreSearch(env, vectorStoreId, query, pdfBaseUrl) {
  const url = `https://api.openai.com/v1/vector_stores/${encodeURIComponent(vectorStoreId)}/search`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      max_results: 8,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error("Vector store search failed:", resp.status, errText);
    return { snippets: [], sources: [] };
  }

  const data = await resp.json();

  const results = Array.isArray(data.data) ? data.data : [];
  const snippets = results
    .map((r) => {
      const text = (r?.content?.[0]?.text ?? r?.text ?? "").toString().trim();
      const score = typeof r?.score === "number" ? r.score : null;

      // best-effort metadata
      const filename = r?.metadata?.filename || r?.metadata?.file_name || r?.filename || null;
      const page = r?.metadata?.page || r?.metadata?.page_number || null;
      
      // Try to get URL from metadata if available
      let fileUrl = r?.metadata?.url || r?.metadata?.file_url || null;
      
      return { 
        text: text.slice(0, 900), 
        score, 
        filename, 
        page,
        url: fileUrl  // Store URL from metadata
      };
    })
    .filter((s) => s.text);

  // إنشاء المصادر مع URLs
  const sources = snippets.slice(0, 5).map((s, idx) => {
    // استراتيجية متعددة للحصول على URL:
    let fileUrl = s.url; // 1. من metadata
    
    // 2. إذا لم يوجد، بناء URL من اسم الملف
    if (!fileUrl && s.filename && s.filename !== "N/A") {
      // تنظيف اسم الملف وجعله صالحاً للـ URL
      const cleanFilename = s.filename
        .replace(/[^\w\s.-]/g, '') // إزالة الرموز الخاصة
        .replace(/\s+/g, '_');      // استبدال المسافات بـ _
      
      fileUrl = `${pdfBaseUrl}${encodeURIComponent(cleanFilename)}`;
    }
    
    // 3. قد نحتاج mapping خاص لبعض الملفات (يمكن إضافته كـ config)
    // هذا يمكن توسيعه لاحقاً حسب الحاجة
    
    return {
      id: `S${idx + 1}`,
      filename: s.filename || "N/A",
      page: s.page ?? "N/A",
      score: s.score ?? null,
      excerpt: s.text.slice(0, 220),
      url: fileUrl  // ✅ إضافة URL
    };
  });

  return { snippets, sources };
}

// ============================================================
// OPENAI CHAT COMPLETIONS
// ============================================================

async function callOpenAIChat(env, { model, systemPrompt, userMessage, maxTokens, temperature }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let msg = `OpenAI API error: ${response.status}`;
    try {
      const j = JSON.parse(errorText);
      msg = j?.error?.message || msg;
    } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  const out = data?.choices?.[0]?.message?.content;
  if (!out) throw new Error("Invalid response format from OpenAI");
  return out.trim();
}

// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
