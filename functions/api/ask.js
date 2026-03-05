// ============================================================
// FILE: /functions/api/ask.js
// THERA GUARD AI — Backend v6 (STRICT TEMPLATE + OPTIONAL RAG)
// Runtime: Cloudflare Pages Functions
// ============================================================

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // POST only
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed. Use POST." }, 405, corsHeaders);
  }

  try {
    const body = await request.json().catch(() => ({}));

    const case_text = typeof body.case_text === "string" ? body.case_text.trim() : "";
    const output_mode = typeof body.output_mode === "string" ? body.output_mode : "STRICT_TEMPLATE";
    // output_mode currently not used extensively, but kept for future expansion

    if (!case_text) {
      return jsonResponse({ ok: false, error: "Missing or invalid case_text in request body" }, 400, corsHeaders);
    }

    if (!env.OPENAI_API_KEY) {
      return jsonResponse({ ok: false, error: "Server configuration error: OPENAI_API_KEY missing" }, 500, corsHeaders);
    }

    const model = env.MODEL || "gpt-4o-mini";

    // 1) Light extraction to help prompt (best-effort)
    const extracted = extractBasics(case_text);
    const computed = computeCrCl(extracted);

    // 2) Optional Evidence retrieval (RAG)
    // If VECTOR_STORE_ID is set, we will search it and pass evidence to the model.
    let evidence = { snippets: [], sources: [] };
    if (env.VECTOR_STORE_ID) {
      evidence = await vectorStoreSearch(env, env.VECTOR_STORE_ID, buildQuery(case_text, extracted));
      // evidence: { snippets: [{text, source_id, filename, page, score}], sources: [...] }
    }

    // 3) Build STRICT system prompt (your required template)
    const systemPrompt = buildStrictTemplatePrompt({
      extracted,
      computed,
      hasEvidence: evidence.snippets.length > 0,
    });

    // 4) Build user message: case + evidence (if any)
    const userMessage = buildUserMessage(case_text, extracted, computed, evidence);

    // 5) Generate final note
    const final_note = await callOpenAIChat(env, {
      model,
      systemPrompt,
      userMessage,
      maxTokens: 900,
      temperature: 0.2,
    });

    // 6) Validate and (if needed) enforce rewrite once
    const validated = validateStrictTemplate(final_note);
    let finalStrict = final_note;

    if (!validated.ok) {
      const repairPrompt = buildRepairPrompt(validated.reason);
      finalStrict = await callOpenAIChat(env, {
        model,
        systemPrompt: repairPrompt,
        userMessage: final_note,
        maxTokens: 700,
        temperature: 0.0,
      });

      // If still invalid, we still return it but include a warning flag
      const revalidated = validateStrictTemplate(finalStrict);
      if (!revalidated.ok) {
        return jsonResponse(
          {
            ok: true,
            final_note: finalStrict,
            sources: evidence.sources,
            warnings: [`Template enforcement incomplete: ${revalidated.reason}`],
            debug: {
              extracted,
              computed,
              evidence_count: evidence.snippets.length,
            },
            timestamp: new Date().toISOString(),
          },
          200,
          corsHeaders
        );
      }
    }

    return jsonResponse(
      {
        ok: true,
        final_note: finalStrict,
        sources: evidence.sources, // <— هنا دليل الوصول للمحتوى
        debug: {
          extracted,
          computed,
          evidence_count: evidence.snippets.length,
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

// -------------------------
// STRICT TEMPLATE PROMPTS
// -------------------------

function buildStrictTemplatePrompt({ extracted, computed, hasEvidence }) {
  const { age, sex, weightKg, mrn } = extracted;
  const scr = extracted.scrUmol ?? null;

  const hintLines = [
    `Patient hints (best-effort extraction; may be N/A):`,
    `- MRN: ${mrn || "N/A"}`,
    `- Age: ${age ?? "N/A"}`,
    `- Sex: ${sex || "N/A"}`,
    `- Weight: ${weightKg ?? "N/A"} kg`,
    `- SCr: ${scr ?? "N/A"} umol/L`,
    `- CrCl: ${computed.crclMlMin ?? "N/A"} mL/min`,
    hasEvidence ? `- Evidence: PROVIDED (must cite in Sources section)` : `- Evidence: NOT PROVIDED`,
  ].join("\n");

  // This prompt makes the template a contract and forbids extra sections
  return `
You are THERA GUARD AI (Clinical Pharmacist).

ABSOLUTE OUTPUT CONTRACT:
- Output MUST follow EXACTLY the template below.
- Do NOT add any additional headings/sections.
- Do NOT output "SUBJECTIVE/OBJECTIVE/ASSESSMENT/PLAN".
- Use N/A for any missing detail.
- Keep it concise and clinical.
- If evidence is provided, ONLY use it to support recommendations and list citations in the "Sources:" block.

TEMPLATE (COPY EXACTLY, fill values only):

S: Patient (MRN: ), Y, kg admitted to ICU.
Reason for Admission:
PMH:
Home Meds:

O: Vitals:
Labs:
Renal: SCr umol/L, Calculated CrCl —

A: Primary admission problem and pharmacist clinical assessment.

P:
Current Medications:
Pharmacist Intervention:
Follow-up Plan:
Sources:

Rules:
- "Current Medications:" list only meds present in the case text (or N/A).
- "Pharmacist Intervention:" include ONLY medication-related interventions (renal dosing, contraindications, interactions, monitoring).
- "Sources:" If evidence is provided, list 1–5 source lines in this exact format:
  - [S1] <filename> p.<page or N/A>: <very short quote or paraphrase>
If no evidence provided, write: Sources: N/A

${hintLines}
`.trim();
}

function buildUserMessage(case_text, extracted, computed, evidence) {
  const lines = [];

  lines.push(`CASE TEXT:\n${case_text}`);

  // Provide computed CrCl to guide consistent output (but still allow N/A if missing)
  if (computed.crclMlMin != null) {
    lines.push(
      `\nCOMPUTED RENAL (best effort): CrCl ≈ ${computed.crclMlMin} mL/min (Cockcroft-Gault).`
    );
  }

  // Provide evidence snippets if any
  if (evidence.snippets.length > 0) {
    const top = evidence.snippets.slice(0, 6);
    lines.push(`\nEVIDENCE SNIPPETS (use for citations):`);
    top.forEach((s, i) => {
      const tag = `S${i + 1}`;
      lines.push(
        `- [${tag}] file=${s.filename || "N/A"} page=${s.page ?? "N/A"} score=${(s.score ?? 0).toFixed(3)}\n  ${s.text}`
      );
    });
  }

  return lines.join("\n");
}

function buildRepairPrompt(reason) {
  return `
You are a strict formatter.
Rewrite the content into the EXACT required template. Do not add anything else.

Failure reason: ${reason}

TEMPLATE:

S: Patient (MRN: ), Y, kg admitted to ICU.
Reason for Admission:
PMH:
Home Meds:

O: Vitals:
Labs:
Renal: SCr umol/L, Calculated CrCl —

A: Primary admission problem and pharmacist clinical assessment.

P:
Current Medications:
Pharmacist Intervention:
Follow-up Plan:
Sources:
`.trim();
}

// -------------------------
// VALIDATION
// -------------------------

function validateStrictTemplate(text) {
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
    "Current Medications:",
    "Pharmacist Intervention:",
    "Follow-up Plan:",
    "Sources:",
  ];

  for (const r of required) {
    if (!text.includes(r)) return { ok: false, reason: `Missing required line/heading: "${r}"` };
  }

  // Disallow classic SOAP headings
  const banned = ["SUBJECTIVE", "OBJECTIVE", "ASSESSMENT", "PLAN", "MEDICATION REVIEW"];
  for (const b of banned) {
    if (text.toUpperCase().includes(b)) return { ok: false, reason: `Contains banned heading: "${b}"` };
  }

  return { ok: true };
}

// -------------------------
// EXTRACTION + CrCl
// -------------------------

function extractBasics(caseText) {
  const t = caseText;

  // MRN best effort
  const mrnMatch = t.match(/\bMRN\b[:\s]*([0-9]{4,})/i) || t.match(/\bMR\s*No\b[:\s]*([0-9]{4,})/i);
  const mrn = mrnMatch ? mrnMatch[1] : "";

  // Age
  const ageMatch = t.match(/\b(age|aged)\b[:\s]*([0-9]{1,3})/i) || t.match(/\b([0-9]{1,3})\s*(y|yr|yrs|years)\b/i);
  const age = ageMatch ? parseInt(ageMatch[2] || ageMatch[1], 10) : null;

  // Sex
  let sex = "";
  if (/\bfemale\b/i.test(t) || /\bأنثى\b/.test(t)) sex = "female";
  if (/\bmale\b/i.test(t) || /\bذكر\b/.test(t)) sex = "male";

  // Weight (kg)
  const wMatch = t.match(/\bweight\b[:\s]*([0-9]{2,3}(?:\.[0-9])?)\s*kg/i) || t.match(/\b([0-9]{2,3}(?:\.[0-9])?)\s*kg\b/i);
  const weightKg = wMatch ? parseFloat(wMatch[1]) : null;

  // Serum creatinine in umol/L
  const scrMatch =
    t.match(/\b(creatinine|s\.?cr|scr)\b[^0-9]{0,10}([0-9]{2,4}(?:\.[0-9])?)\s*(umol\/l|µmol\/l|micromol\/l)?/i) ||
    t.match(/\bالكرياتينين\b[^0-9]{0,10}([0-9]{2,4}(?:\.[0-9])?)/);

  const scrUmol = scrMatch ? parseFloat(scrMatch[2] || scrMatch[1]) : null;

  return { mrn, age, sex, weightKg, scrUmol };
}

function computeCrCl({ age, sex, weightKg, scrUmol }) {
  // Cockcroft–Gault requires SCr mg/dL, convert from umol/L: mg/dL = umol/L / 88.4
  if (!age || !weightKg || !scrUmol) return { crclMlMin: null, scrMgDl: null };

  const scrMgDl = scrUmol / 88.4;
  if (!scrMgDl || scrMgDl <= 0) return { crclMlMin: null, scrMgDl: null };

  // CrCl = ((140-age) * weight) / (72 * SCr) ; female *0.85
  let crcl = ((140 - age) * weightKg) / (72 * scrMgDl);
  if (sex === "female") crcl *= 0.85;

  const crclRounded = Math.round(crcl);
  return { crclMlMin: Number.isFinite(crclRounded) ? crclRounded : null, scrMgDl: Number(scrMgDl.toFixed(2)) };
}

function buildQuery(case_text, extracted) {
  // A simple query string for retrieval
  const parts = [];
  parts.push("renal dosing anticoagulation ICU");
  if (extracted.scrUmol) parts.push(`creatinine ${extracted.scrUmol}`);
  if (extracted.age) parts.push(`age ${extracted.age}`);
  parts.push(case_text.slice(0, 500));
  return parts.join(" | ");
}

// -------------------------
// OPTIONAL: VECTOR STORE SEARCH (OpenAI)
// -------------------------

async function vectorStoreSearch(env, vectorStoreId, query) {
  // Uses OpenAI vector store search endpoint (requires you already ingested PDFs into the vector store)
  // Returns top snippets with metadata if available.
  const url = `https://api.openai.com/v1/vector_stores/${encodeURIComponent(vectorStoreId)}/search`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      max_results: 6,
    }),
  });

  if (!resp.ok) {
    // If vector search fails, do not fail the whole request; just return no evidence
    const errText = await resp.text().catch(() => "");
    console.error("Vector store search failed:", resp.status, errText);
    return { snippets: [], sources: [] };
  }

  const data = await resp.json();

  // Normalize results
  const results = Array.isArray(data.data) ? data.data : [];
  const snippets = results.map((r) => {
    const text = (r?.content?.[0]?.text ?? r?.text ?? "").toString().trim();
    const score = typeof r?.score === "number" ? r.score : null;

    // Metadata varies; we try best effort
    const filename = r?.metadata?.filename || r?.metadata?.file_name || r?.filename || null;
    const page = r?.metadata?.page || r?.metadata?.page_number || null;

    return { text: text.slice(0, 800), score, filename, page };
  }).filter(s => s.text);

  // Sources array (for UI / proof of retrieval)
  const sources = snippets.slice(0, 5).map((s, idx) => ({
    id: `S${idx + 1}`,
    filename: s.filename || "N/A",
    page: s.page ?? "N/A",
    score: s.score ?? null,
    excerpt: s.text.slice(0, 220),
  }));

  return { snippets, sources };
}

// -------------------------
// OPENAI CALL
// -------------------------

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

// -------------------------
// JSON RESPONSE
// -------------------------

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
