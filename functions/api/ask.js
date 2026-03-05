// File: /functions/api/ask.js
// TheraGuard AI — Clinical Decision Support Engine v2.0
// Upgraded: clinical reasoning layer, patient parameter extraction,
// CrCl calculation, dose verification, error detection, drug monographs, antibiogram

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
    const body = await request.json();
    const language = body.language || "en";
    const mode = (body.mode || "ask").toLowerCase();

    // Route to mode handlers
    switch (mode) {
      case "case_analysis":
      case "case":
        return await handleCaseAnalysis(body, env, corsHeaders, language);
      case "monograph":
        return await handleMonograph(body, env, corsHeaders, language);
      case "antibiogram":
        return await handleAntibiogram(body, env, corsHeaders, language);
      case "ask":
      default:
        return await handleAsk(body, env, corsHeaders, language);
    }
  } catch (error) {
    console.error("Function error:", error);
    return new Response(
      JSON.stringify({ ok: false, error: error.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
}

// ============================================================
// MODE: ASK — Standard Q&A with clinical context
// ============================================================
async function handleAsk(body, env, corsHeaders, language) {
  const output_mode = (body.output_mode || "hybrid").toLowerCase();
  const source_mode = (body.source_mode || "off").toLowerCase();
  const answer_style = body.answer_style || "recommended";
  const question = body.question || body.q || "";

  if (!question) {
    return jsonError("Question is required", 400, corsHeaders);
  }
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
    return jsonError("OPENAI_API_KEY or VECTOR_STORE_ID is not set", 500, corsHeaders);
  }
  if (!["hybrid", "short", "verbatim"].includes(output_mode)) {
    return jsonError("Invalid output_mode. Must be hybrid, short, or verbatim.", 400, corsHeaders);
  }
  if (!["required", "off"].includes(source_mode)) {
    return jsonError("Invalid source_mode. Must be required or off.", 400, corsHeaders);
  }

  const evidence = await vectorSearch(env, question, 10);

  if (source_mode === "required" && evidence.length === 0) {
    return new Response(
      JSON.stringify({
        ok: true,
        verdict: "NOT_FOUND",
        answer: language === "ar" ? "لم يتم العثور في البروتوكول" : "Not found in protocol",
        citations: [],
        applied_output: { output_mode, source_mode, answer_style },
      }),
      { headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  let answer = "";
  let citations = [];

  if (evidence.length === 0) {
    answer =
      language === "ar"
        ? "لم يتم العثور على معلومات في المصادر المتاحة."
        : "No information found in available sources.";
  } else {
    const evidenceText = formatEvidenceText(evidence);

    switch (output_mode) {
      case "verbatim": {
        const quotes = evidence.slice(0, 3).map((e) => {
          const sentences = e.excerpt.split(/[.!?]+/).filter((s) => s.trim().length > 20);
          const quote = sentences.length > 0 ? sentences[0].trim() + "." : e.excerpt.substring(0, 150);
          return `"${quote}"\n— ${e.filename}${e.page ? ` (p. ${e.page})` : ""}${e.section ? ` • ${e.section}` : ""}`;
        });
        answer = quotes.join("\n\n");
        citations = buildCitations(evidence, 250);
        break;
      }
      case "short": {
        const gptRes = await callGPT(env.OPENAI_API_KEY, {
          system: `You are a clinical pharmacist AI. Answer using ONLY the provided sources.
Reply with 3-6 bullet points. Each bullet starts with • and is one concise line. No preamble.`,
          user: `Question: ${question}\n\nSources:\n${evidenceText}`,
          max_tokens: 350,
        });
        answer = gptRes || "• No concise answer available";
        if (source_mode === "required") citations = buildCitations(evidence, 150);
        break;
      }
      case "hybrid":
      default: {
        const gptRes = await callGPT(env.OPENAI_API_KEY, {
          system: `You are a clinical pharmacist AI. Use ONLY the provided protocol sources.
Structure your response as:
ANSWER: [2-4 sentence synthesized answer]

KEY EVIDENCE:
• [direct quote or paraphrase] — [filename, page if available]
• [direct quote or paraphrase] — [filename, page if available]

Do not add information not in the sources.`,
          user: `Question: ${question}\n\nSources:\n${evidenceText}`,
          max_tokens: 700,
        });
        answer = gptRes || "No answer generated";
        citations = buildCitations(evidence, 250);
        break;
      }
    }
  }

  const responseBody = {
    ok: true,
    verdict: evidence.length > 0 ? "OK" : "NOT_FOUND",
    answer,
    applied_output: { output_mode, source_mode, answer_style },
  };
  if (source_mode !== "off") responseBody.citations = citations;

  return new Response(JSON.stringify(responseBody), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// ============================================================
// MODE: CASE ANALYSIS — Full clinical reasoning engine
// ============================================================
async function handleCaseAnalysis(body, env, corsHeaders, language) {
  const { case_text, question } = body;

  if (!case_text) return jsonError("case_text is required", 400, corsHeaders);
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
    return jsonError("Missing API credentials", 500, corsHeaders);
  }

  // ── Step 1: Extract patient parameters via GPT ──
  const extractionPrompt = `Extract patient parameters from the following clinical case. Return ONLY valid JSON.

Case: ${case_text}

Return this exact JSON structure (use null for missing values):
{
  "age": <number or null>,
  "sex": "<male|female|null>",
  "weight_kg": <number or null>,
  "height_cm": <number or null>,
  "serum_creatinine": <number or null>,
  "diagnosis": "<string or null>",
  "allergies": ["<string>"],
  "medications": [
    {
      "name": "<drug name>",
      "dose": "<dose string>",
      "route": "<route>",
      "frequency": "<frequency>"
    }
  ],
  "lab_values": {
    "wbc": <number or null>,
    "crp": <number or null>,
    "temperature": <number or null>
  }
}`;

  let patientParams = null;
  try {
    const extractRaw = await callGPT(env.OPENAI_API_KEY, {
      system: "You are a clinical data extraction engine. Return ONLY valid JSON, no markdown.",
      user: extractionPrompt,
      max_tokens: 600,
    });
    patientParams = JSON.parse(extractRaw.replace(/```json|```/g, "").trim());
  } catch (e) {
    patientParams = null;
  }

  // ── Step 2: Calculate clinical metrics ──
  const clinicalMetrics = {};

  if (patientParams) {
    // Cockcroft-Gault CrCl
    if (
      patientParams.age &&
      patientParams.weight_kg &&
      patientParams.serum_creatinine &&
      patientParams.sex
    ) {
      const sexFactor = patientParams.sex.toLowerCase() === "female" ? 0.85 : 1.0;
      const crcl =
        ((140 - patientParams.age) * patientParams.weight_kg * sexFactor) /
        (72 * patientParams.serum_creatinine);
      clinicalMetrics.creatinine_clearance_ml_min = Math.round(crcl * 10) / 10;
      clinicalMetrics.renal_function_category =
        crcl >= 90
          ? "Normal (≥90)"
          : crcl >= 60
          ? "Mild impairment (60-89)"
          : crcl >= 30
          ? "Moderate impairment (30-59)"
          : crcl >= 15
          ? "Severe impairment (15-29)"
          : "Kidney failure (<15)";
    }

    // IBW / BSA (Mosteller)
    if (patientParams.weight_kg && patientParams.height_cm) {
      const bsa =
        Math.sqrt((patientParams.height_cm * patientParams.weight_kg) / 3600);
      clinicalMetrics.bsa_m2 = Math.round(bsa * 100) / 100;

      const ibw =
        patientParams.sex?.toLowerCase() === "female"
          ? 45.5 + 2.3 * ((patientParams.height_cm / 2.54) - 60)
          : 50 + 2.3 * ((patientParams.height_cm / 2.54) - 60);
      clinicalMetrics.ibw_kg = Math.round(ibw * 10) / 10;

      const adjbw = ibw + 0.4 * (patientParams.weight_kg - ibw);
      if (patientParams.weight_kg > ibw * 1.2) {
        clinicalMetrics.adjusted_bw_kg = Math.round(adjbw * 10) / 10;
      }
    }
  }

  // ── Step 3: Vector search for protocol evidence ──
  const searchQuery = question
    ? `${question} ${case_text.substring(0, 300)}`
    : case_text.substring(0, 500);

  const sources = await vectorSearch(env, searchQuery, 10);

  // ── Step 4: Build protocol-aware clinical reasoning prompt ──
  const metricsText = Object.keys(clinicalMetrics).length
    ? `\nCALCULATED METRICS:\n${Object.entries(clinicalMetrics)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n")}`
    : "";

  const patientText = patientParams
    ? `\nEXTRACTED PATIENT PARAMETERS:\n${JSON.stringify(patientParams, null, 2)}`
    : "";

  const sourceText =
    sources.length > 0
      ? sources.map((s) => `[${s.id}] ${s.filename}${s.page ? ` p.${s.page}` : ""}\n${s.excerpt}`).join("\n\n---\n\n")
      : "No protocol sources found.";

  const clinicalPrompt = `You are a senior clinical pharmacist. Analyze the patient case and produce a full clinical assessment.

PATIENT CASE:
${case_text}
${patientText}
${metricsText}
${question ? `\nCLINICIAN QUESTION: ${question}` : ""}

PROTOCOL SOURCES:
${sourceText}

Produce a structured response with these exact sections:

## SOAP NOTE
**Subjective:** [Patient history, chief complaint, reported symptoms]
**Objective:** [Vitals, labs, current medications with doses]
**Assessment:** [Clinical interpretation, diagnosis, severity]
**Plan:** [Therapeutic interventions, monitoring parameters]

## DOSE VERIFICATION TABLE
For each medication, assess against protocol:
| Medication | Ordered Dose | Protocol Dose | Renal Adjustment Needed | Verdict | Reference |
|---|---|---|---|---|---|
[Fill rows — use ✓ CORRECT, ⚠ ADJUST, ✗ WRONG, or ? NOT IN PROTOCOL]

## CLINICAL ALERTS
List any:
- Dose errors or adjustments required (especially renal dosing based on CrCl ${clinicalMetrics.creatinine_clearance_ml_min || "unknown"} mL/min)
- Drug-drug interactions
- Contraindications
- Allergy cross-reactions
- Monitoring requirements

## CLINICAL INTERPRETATION
Brief clinical narrative synthesizing the case, key concerns, and recommended actions.

## EVIDENCE CITATIONS
[List protocol sources used with filename and page]

Be concise and clinically precise. If a drug is not in the sources, state "Not in protocol — apply clinical judgment."`;

  const gptRes = await callGPT(env.OPENAI_API_KEY, {
    system: "You are a clinical pharmacist AI with expertise in drug dosing, renal adjustment, and medication safety.",
    user: clinicalPrompt,
    max_tokens: 1800,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      patient_parameters: patientParams,
      clinical_metrics: clinicalMetrics,
      final_note: gptRes || "Could not generate case analysis.",
      sources: sources.map((s) => ({
        id: s.id,
        filename: s.filename,
        page: s.page,
        score: s.score,
        excerpt: s.excerpt.substring(0, 300),
      })),
    }),
    { headers: { "Content-Type": "application/json", ...corsHeaders } }
  );
}

// ============================================================
// MODE: MONOGRAPH — Drug information lookup
// ============================================================
async function handleMonograph(body, env, corsHeaders, language) {
  const { drug_name, patient_context } = body;

  if (!drug_name) return jsonError("drug_name is required", 400, corsHeaders);
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
    return jsonError("Missing API credentials", 500, corsHeaders);
  }

  // Search vector store for drug information
  const evidence = await vectorSearch(env, `${drug_name} dosing indications contraindications`, 8);

  const evidenceText = evidence.length > 0
    ? evidence.map((e) => `[${e.id}] ${e.filename}${e.page ? ` p.${e.page}` : ""}\n${e.excerpt}`).join("\n\n---\n\n")
    : "No protocol data found for this drug.";

  const patientCtx = patient_context ? `\nPATIENT CONTEXT: ${patient_context}` : "";

  const monographPrompt = `Generate a clinical drug monograph for: ${drug_name}
${patientCtx}

Using ONLY the provided protocol sources, structure the monograph as:

## DRUG MONOGRAPH: ${drug_name.toUpperCase()}

### INDICATIONS
[List approved indications from sources]

### DOSING
**Standard Dosing:**
[Doses from protocol]

**Renal Adjustment:**
| CrCl (mL/min) | Dose Adjustment |
|---|---|
[Fill from protocol or note "See protocol"]

**Hepatic Adjustment:**
[If available]

### ADMINISTRATION
[Route, preparation, infusion rates]

### CONTRAINDICATIONS & WARNINGS
[List from sources]

### DRUG INTERACTIONS
[Clinically significant interactions]

### MONITORING PARAMETERS
[Labs, levels, clinical endpoints]

### ADVERSE EFFECTS
[Key ADRs]

### NOTES
[Any special considerations]

PROTOCOL SOURCES:
${evidenceText}

If information is not in the protocol sources, state "Not specified in protocol."`;

  const gptRes = await callGPT(env.OPENAI_API_KEY, {
    system: "You are a clinical pharmacist generating drug monographs from protocol sources.",
    user: monographPrompt,
    max_tokens: 1200,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      drug_name,
      monograph: gptRes || "Could not generate monograph.",
      sources: evidence.map((e) => ({
        id: e.id,
        filename: e.filename,
        page: e.page,
        score: e.score,
        excerpt: e.excerpt.substring(0, 250),
      })),
    }),
    { headers: { "Content-Type": "application/json", ...corsHeaders } }
  );
}

// ============================================================
// MODE: ANTIBIOGRAM — Susceptibility analysis
// ============================================================
async function handleAntibiogram(body, env, corsHeaders, language) {
  const { organism, site_of_infection, patient_context, antibiotic } = body;

  if (!organism && !antibiotic) {
    return jsonError("organism or antibiotic is required", 400, corsHeaders);
  }
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
    return jsonError("Missing API credentials", 500, corsHeaders);
  }

  // Build search query
  const searchTerms = [organism, antibiotic, site_of_infection, "susceptibility resistance"]
    .filter(Boolean)
    .join(" ");

  const evidence = await vectorSearch(env, searchTerms, 8);

  const evidenceText = evidence.length > 0
    ? evidence.map((e) => `[${e.id}] ${e.filename}${e.page ? ` p.${e.page}` : ""}\n${e.excerpt}`).join("\n\n---\n\n")
    : "No antibiogram data found.";

  const antibiogramPrompt = `You are an infectious disease pharmacist. Analyze antibiotic susceptibility.

QUERY:
${organism ? `Organism: ${organism}` : ""}
${antibiotic ? `Antibiotic: ${antibiotic}` : ""}
${site_of_infection ? `Site of infection: ${site_of_infection}` : ""}
${patient_context ? `Patient context: ${patient_context}` : ""}

ANTIBIOGRAM / PROTOCOL SOURCES:
${evidenceText}

Provide:

## SUSCEPTIBILITY ANALYSIS
${organism ? `### ${organism} Susceptibility Profile` : "### Antibiotic Coverage Profile"}
[Table of susceptibility rates from antibiogram data if available]

## EMPIRIC THERAPY RECOMMENDATIONS
**First-line:** [drug + dose]
**Alternative:** [drug + dose]
**If resistant:** [drug + dose]

## TARGETED THERAPY
[If organism identified, specific treatment recommendations]

## PK/PD CONSIDERATIONS
[Relevant pharmacokinetic/pharmacodynamic targets for selected agents]

## DURATION OF THERAPY
[Recommended treatment duration]

## MONITORING
[Key parameters to monitor]

## RESISTANCE ALERTS
[Any notable resistance patterns or mechanisms to be aware of]

If susceptibility data is not available in sources, state "Local antibiogram data not found — consult institutional data."`;

  const gptRes = await callGPT(env.OPENAI_API_KEY, {
    system: "You are an infectious disease pharmacist with expertise in antimicrobial stewardship.",
    user: antibiogramPrompt,
    max_tokens: 1000,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      organism: organism || null,
      antibiotic: antibiotic || null,
      site_of_infection: site_of_infection || null,
      analysis: gptRes || "Could not generate susceptibility analysis.",
      sources: evidence.map((e) => ({
        id: e.id,
        filename: e.filename,
        page: e.page,
        score: e.score,
        excerpt: e.excerpt.substring(0, 250),
      })),
    }),
    { headers: { "Content-Type": "application/json", ...corsHeaders } }
  );
}

// ============================================================
// SHARED HELPERS
// ============================================================

async function vectorSearch(env, query, maxResults = 10) {
  const searchResponse = await fetch(
    `https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({ query, max_num_results: maxResults }),
    }
  );

  if (!searchResponse.ok) return [];

  const searchData = await searchResponse.json();
  const evidence = [];

  if (searchData.data && Array.isArray(searchData.data)) {
    searchData.data.forEach((item, index) => {
      let content = "";

      let filename =
        item.attributes?.filename ||
        item.attributes?.file_name ||
        item.filename ||
        item.file_name ||
        item.file_id ||
        `source_${index + 1}`;

      if (item.content) {
        if (Array.isArray(item.content)) {
          content = item.content
            .map((c) => c.text || c.value || "")
            .filter((t) => t)
            .join("\n");
        } else if (typeof item.content === "string") {
          content = item.content;
        } else if (item.content.text) {
          content = item.content.text;
        }
      }
      if (!content && item.text) content = item.text;
      if (!content && item.chunks) {
        content = item.chunks.map((c) => c.text || "").join("\n");
      }
      if (!content || !content.trim()) return;

      // Page extraction
      let page = 0;
      const pageMatch =
        content.match(/(?:Page|PAGE|page)\s*[:\-]?\s*(\d+)/i) ||
        content.match(/\bp\.?\s*(\d+)\b/i) ||
        content.match(/\[p\.\s*(\d+)\]/i);
      if (pageMatch) page = parseInt(pageMatch[1]);
      if (!page && item.attributes?.page) page = parseInt(item.attributes.page) || 0;
      if (!page && item.metadata?.page) page = parseInt(item.metadata.page) || 0;

      // Section extraction
      let section = "";
      const sectionMatch =
        content.match(/(?:Section|SECTION)\s+(\d+(?:\.\d+)*)\s*[–—\-]?\s*([^\n]+)/i) ||
        content.match(/^#{1,3}\s+([^\n]+)/m) ||
        content.match(/^\d+\.\d+\s+([^\n]+)/m);
      if (sectionMatch) {
        section = (sectionMatch[2] || sectionMatch[1]).trim().substring(0, 80);
      }

      evidence.push({
        id: `E${index + 1}`,
        filename,
        page,
        section,
        score: item.score ?? item.similarity ?? null,
        excerpt: content.substring(0, 2000),
        full_content: content,
      });
    });
  }

  return evidence;
}

function formatEvidenceText(evidence) {
  return evidence
    .map(
      (e) =>
        `[SOURCE ${e.id}] File: ${e.filename}${e.page ? ` | Page: ${e.page}` : ""}${e.section ? ` | Section: ${e.section}` : ""}\nContent: ${e.excerpt}`
    )
    .join("\n\n---\n\n");
}

function buildCitations(evidence, excerptLen = 250) {
  return evidence.map((e) => ({
    evidence_ids: [e.id],
    filename: e.filename,
    section: e.section || "",
    page: e.page || 0,
    score: e.score,
    excerpt: e.excerpt.substring(0, excerptLen),
  }));
}

async function callGPT(apiKey, { system, user, max_tokens = 600 }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

function jsonError(message, status, corsHeaders) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
