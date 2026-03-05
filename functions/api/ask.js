// File: /functions/api/ask.js
// VERSION 3 — Full fix: case analysis returns complete SOAP note + sources

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

    // ── Validate env ────────────────────────────────────────────────────────
    if (!env.OPENAI_API_KEY) {
      return jsonError("OPENAI_API_KEY is not set", 500, corsHeaders);
    }
    if (!env.VECTOR_STORE_ID) {
      return jsonError("VECTOR_STORE_ID is not set", 500, corsHeaders);
    }

    const language      = body.language     || "en";
    const output_mode   = (body.output_mode || "hybrid").toLowerCase();
    const source_mode   = (body.source_mode || "off").toLowerCase();
    const answer_style  = body.answer_style  || "recommended";

    // ── CASE ANALYSIS MODE ───────────────────────────────────────────────────
    // Check this BEFORE output_mode validation so it never gets blocked
    if (body.mode === "case_analysis" || (body.case_text && body.case_text.trim())) {
      return await handleCaseAnalysis(body, env, corsHeaders, language);
    }

    // ── Validate output/source modes (Q&A only) ──────────────────────────────
    if (!["hybrid", "short", "verbatim"].includes(output_mode)) {
      return jsonError("Invalid output_mode. Must be hybrid, short, or verbatim.", 400, corsHeaders);
    }
    if (!["required", "off"].includes(source_mode)) {
      return jsonError("Invalid source_mode. Must be required or off.", 400, corsHeaders);
    }

    // ── STANDARD Q&A MODE ────────────────────────────────────────────────────
    const question = (body.question || body.q || "").trim();
    if (!question) {
      return jsonError("Question is required", 400, corsHeaders);
    }

    // Vector search
    const evidence = await vectorSearch(env, question, 10);

    // Protocol-Locked gate
    if (source_mode === "required" && evidence.length === 0) {
      return new Response(JSON.stringify({
        ok: true,
        verdict: "NOT_FOUND",
        answer: "Not found in protocol",
        citations: [],
        applied_output: { output_mode, source_mode, answer_style },
      }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Build answer
    const { answer, citations } = await buildAnswer({
      output_mode,
      source_mode,
      evidence,
      question,
      apiKey: env.OPENAI_API_KEY,
      language,
    });

    return new Response(JSON.stringify({
      ok: true,
      verdict: evidence.length > 0 ? "OK" : "NOT_FOUND",
      answer,
      ...(source_mode !== "off" ? { citations } : {}),
      applied_output: { output_mode, source_mode, answer_style },
    }), { headers: { "Content-Type": "application/json", ...corsHeaders } });

  } catch (err) {
    console.error("onRequest error:", err);
    return jsonError(err.message || "Internal server error", 500, corsHeaders);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CASE ANALYSIS
// ════════════════════════════════════════════════════════════════════════════

async function handleCaseAnalysis(body, env, corsHeaders, language) {
  const case_text = (body.case_text || "").trim();
  const question  = (body.question  || "").trim();

  if (!case_text) {
    return jsonError("case_text is required for case_analysis mode", 400, corsHeaders);
  }

  // Build focused search query from the case
  const searchQuery = question
    ? `${question} ${case_text.substring(0, 400)}`
    : case_text.substring(0, 600);

  const evidence = await vectorSearch(env, searchQuery, 10);

  const sourceText = evidence.length > 0
    ? evidence.map(e =>
        `[${e.id}] ${e.filename}${e.page ? ` | Page ${e.page}` : ""}\n${e.excerpt}`
      ).join("\n\n---\n\n")
    : "No protocol sources retrieved — base your analysis on standard clinical guidelines.";

  // ── Comprehensive SOAP + dose verification prompt ─────────────────────────
  const soapPrompt = `You are a senior clinical pharmacist AI. Analyze the following patient case thoroughly.

══ PATIENT CASE ══
${case_text}
${question ? `\n══ CLINICIAN QUESTION ══\n${question}` : ""}

══ PROTOCOL SOURCES ══
${sourceText}

Produce the following structured report:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 SOAP NOTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
S (Subjective): Chief complaint, history, symptoms

O (Objective): Vitals, labs, imaging, ECG findings

A (Assessment): Primary diagnosis + differentials, severity classification

P (Plan): Pharmacological + non-pharmacological management

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💊 DOSE VERIFICATION TABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each identified or likely medication:
| Drug | Ordered/Likely Dose | Protocol Recommended | Verdict | Reference |

Use verdicts: ✓ CORRECT | ⚠ ADJUST | ✗ WRONG | ℹ NOT IN PROTOCOL

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠ CLINICAL ALERTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Renal dose adjustments needed
• Drug interactions
• Contraindications
• Critical lab values requiring action

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 EVIDENCE CITATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
List protocol sources used with filename and page.

Be precise, clinical, and actionable. Flag any life-threatening issues with 🚨.`;

  const final_note = await callGPT(env.OPENAI_API_KEY, {
    system: "You are a senior clinical pharmacist AI. Provide structured, evidence-based clinical analysis. Be thorough and precise.",
    user: soapPrompt,
    max_tokens: 1800,
    temperature: 0.15,
  });

  // Map evidence to sources format expected by frontend
  const sources = evidence.map(e => ({
    id: e.id,
    filename: e.filename,
    page: e.page || 0,
    score: e.score,
    excerpt: e.excerpt.substring(0, 400),
  }));

  return new Response(JSON.stringify({
    ok: true,
    final_note: final_note || "Could not generate analysis. Please check your OpenAI API key and vector store configuration.",
    sources,
  }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// ════════════════════════════════════════════════════════════════════════════
// Q&A ANSWER BUILDER
// ════════════════════════════════════════════════════════════════════════════

async function buildAnswer({ output_mode, source_mode, evidence, question, apiKey, language }) {
  if (evidence.length === 0) {
    return {
      answer: language === "ar"
        ? "لم يتم العثور على معلومات في المصادر المتاحة."
        : "No information found in available sources.",
      citations: [],
    };
  }

  const evidenceText = evidence.map(e =>
    `[SOURCE ${e.id}] File: ${e.filename}${e.page ? ` | Page: ${e.page}` : ""}\nContent: ${e.excerpt}`
  ).join("\n\n---\n\n");

  let answer = "";
  let citations = [];

  switch (output_mode) {

    case "verbatim": {
      const quotes = evidence.slice(0, 3).map(e => {
        const sentences = e.excerpt.split(/[.!?]+/).filter(s => s.trim().length > 20);
        const quote = sentences.length > 0 ? sentences[0].trim() + "." : e.excerpt.substring(0, 150);
        return `"${quote}"\n— ${e.filename}${e.page ? ` (p. ${e.page})` : ""}`;
      });
      answer    = quotes.join("\n\n");
      citations = buildCitations(evidence, 250);
      break;
    }

    case "short": {
      answer = await callGPT(apiKey, {
        system: `You are a clinical pharmacist AI. Answer using ONLY the provided sources.
Reply with 3-6 bullet points. Each bullet starts with • and is one concise clinical line. No preamble or postamble.`,
        user: `Question: ${question}\n\nSources:\n${evidenceText}`,
        max_tokens: 350,
      }) || "• No concise answer available";
      if (source_mode === "required") citations = buildCitations(evidence, 150);
      break;
    }

    case "hybrid":
    default: {
      answer = await callGPT(apiKey, {
        system: `You are a clinical pharmacist AI. Use ONLY the provided protocol sources. Do not add external knowledge.
Format your response as:

ANSWER:
[2-4 sentence synthesized clinical answer]

KEY EVIDENCE:
• [key point with dose/recommendation] — [filename, page if available]
• [key point] — [filename, page if available]
• [key point] — [filename, page if available]`,
        user: `Question: ${question}\n\nSources:\n${evidenceText}`,
        max_tokens: 700,
      }) || "No answer generated";
      citations = buildCitations(evidence, 250);
      break;
    }
  }

  return { answer, citations };
}

// ════════════════════════════════════════════════════════════════════════════
// VECTOR SEARCH
// ════════════════════════════════════════════════════════════════════════════

async function vectorSearch(env, query, maxResults = 10) {
  try {
    const res = await fetch(
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

    if (!res.ok) {
      console.error("Vector search HTTP error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    if (!data.data || !Array.isArray(data.data)) return [];

    const evidence = [];
    data.data.forEach((item, index) => {

      // ── Extract content ────────────────────────────────────────────────
      let content = "";
      if (item.content) {
        if (Array.isArray(item.content)) {
          content = item.content.map(c => c.text || c.value || "").filter(Boolean).join("\n");
        } else if (typeof item.content === "string") {
          content = item.content;
        } else if (item.content.text) {
          content = item.content.text;
        }
      }
      if (!content && item.text) content = item.text;
      if (!content && Array.isArray(item.chunks)) {
        content = item.chunks.map(c => c.text || "").join("\n");
      }
      if (!content?.trim()) return; // skip empty chunks

      // ── Extract filename ───────────────────────────────────────────────
      // OpenAI vector store returns filename in attributes or at top level
      const filename =
        item.attributes?.filename  ||
        item.attributes?.file_name ||
        item.attributes?.name      ||
        item.filename              ||
        item.file_name             ||
        item.name                  ||
        item.file_id               ||
        `source_${index + 1}`;

      // ── Extract page ───────────────────────────────────────────────────
      let page = parseInt(item.attributes?.page || item.metadata?.page || 0) || 0;
      if (!page) {
        const m = content.match(/(?:Page|PAGE|page)\s*[:\-]?\s*(\d+)/i) ||
                  content.match(/\[p\.\s*(\d+)\]/i);
        if (m) page = parseInt(m[1]) || 0;
      }

      // ── Score ──────────────────────────────────────────────────────────
      const score = item.score ?? item.similarity ?? null;

      evidence.push({
        id:           `E${index + 1}`,
        filename,
        page,
        score,
        excerpt:      content.substring(0, 2000),
        full_content: content,
      });
    });

    return evidence;
  } catch (err) {
    console.error("vectorSearch error:", err);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function buildCitations(evidence, excerptLen = 250) {
  return evidence.map(e => ({
    evidence_ids: [e.id],
    filename:     e.filename,
    page:         e.page || 0,
    score:        e.score,
    excerpt:      e.excerpt.substring(0, excerptLen),
  }));
}

async function callGPT(apiKey, { system, user, max_tokens = 600, temperature = 0.2 }) {
  try {
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
          { role: "user",   content: user   },
        ],
        temperature,
        max_tokens,
      }),
    });

    if (!res.ok) {
      console.error("GPT HTTP error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error("callGPT error:", err);
    return null;
  }
}

function jsonError(message, status, corsHeaders) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
