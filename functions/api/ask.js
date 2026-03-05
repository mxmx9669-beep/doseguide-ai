// File: /functions/api/ask.js
// FIXED: source_mode "required" no longer blocks valid evidence that lacks page/section metadata

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { 
      status: 204,
      headers: corsHeaders 
    });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  try {
    const body = await request.json();
    const language = body.language || "en";
    
    // ========== EXTRACT OUTPUT CONFIGURATION ==========
    const output_mode = (body.output_mode || "hybrid").toLowerCase();
    const source_mode = (body.source_mode || "off").toLowerCase();
    const answer_style = body.answer_style || "recommended";
    
    if (!["hybrid", "short", "verbatim"].includes(output_mode)) {
      return new Response(JSON.stringify({ 
        error: "Invalid output_mode. Must be hybrid, short, or verbatim." 
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
    
    if (!["required", "off"].includes(source_mode)) {
      return new Response(JSON.stringify({ 
        error: "Invalid source_mode. Must be required or off." 
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ========== CASE ANALYSIS MODE ==========
    if (body.mode === "case_analysis" && body.case_text) {
      return await handleCaseAnalysis(body, env, corsHeaders, language);
    }
    
    // ========== STANDARD Q&A MODE ==========
    const question = body.question || body.q || "";
    
    if (!question) {
      return new Response(JSON.stringify({ error: "Question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
      return new Response(JSON.stringify({ 
        error: "OPENAI_API_KEY or VECTOR_STORE_ID is not set" 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ========== VECTOR SEARCH ==========
    const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        query: question,
        max_num_results: 10
      })
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      return new Response(JSON.stringify({ 
        error: "Vector search failed",
        details: errorText
      }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const searchData = await searchResponse.json();
    
    // ========== EXTRACT EVIDENCE ==========
    const evidence = [];
    if (searchData.data && Array.isArray(searchData.data)) {
      searchData.data.forEach((item, index) => {
        let content = '';
        
        // Try to get a human-readable filename from attributes first
        let filename = 
          item.attributes?.filename ||
          item.attributes?.file_name ||
          item.filename ||
          item.file_name ||
          '';

        // If still empty, use file_id as fallback
        if (!filename) {
          filename = item.file_id || `source_${index + 1}`;
        }

        let page = 0;
        let section = '';
        
        // Extract content from all possible shapes
        if (item.content) {
          if (Array.isArray(item.content)) {
            content = item.content
              .map(c => c.text || c.value || '')
              .filter(t => t)
              .join('\n');
          } else if (typeof item.content === 'string') {
            content = item.content;
          } else if (item.content.text) {
            content = item.content.text;
          }
        }
        if (!content && item.text) content = item.text;
        
        // Also check chunks array (some vector store formats)
        if (!content && item.chunks && Array.isArray(item.chunks)) {
          content = item.chunks.map(c => c.text || '').join('\n');
        }

        if (!content || !content.trim()) return; // skip empty

        // Try to extract page number from content text
        const pageMatch = 
          content.match(/(?:Page|PAGE|page)\s*[:\-]?\s*(\d+)/i) || 
          content.match(/\bp\.?\s*(\d+)\b/i) ||
          content.match(/\[p\.\s*(\d+)\]/i);
        if (pageMatch) page = parseInt(pageMatch[1]);

        // Also check metadata/attributes for page
        if (!page && item.attributes?.page) page = parseInt(item.attributes.page) || 0;
        if (!page && item.metadata?.page) page = parseInt(item.metadata.page) || 0;
        
        // Try to extract section
        const sectionMatch = 
          content.match(/(?:Section|SECTION)\s+(\d+(?:\.\d+)*)\s*[–—\-]?\s*([^\n]+)/i) ||
          content.match(/^#{1,3}\s+([^\n]+)/m) ||
          content.match(/^\d+\.\d+\s+([^\n]+)/m);
        if (sectionMatch) {
          section = (sectionMatch[2] || sectionMatch[1]).trim().substring(0, 80);
        }

        // Similarity score
        const score = item.score ?? item.similarity ?? null;
        
        evidence.push({
          id: `E${index + 1}`,
          filename,
          page,
          section,
          score,
          excerpt: content.substring(0, 2000),
          full_content: content
        });
      });
    }

    // ========== SOURCE_MODE = "required" — FIXED VALIDATION ==========
    // Only require that we found at least one chunk with real content.
    // Do NOT block on missing page/section — those are metadata that may not exist.
    if (source_mode === "required" && evidence.length === 0) {
      return new Response(JSON.stringify({
        ok: true,
        verdict: "NOT_FOUND",
        answer: "Not found in protocol",
        citations: [],
        applied_output: { output_mode, source_mode, answer_style }
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ========== BUILD ANSWER BY OUTPUT_MODE ==========
    let answer = "";
    let citations = [];

    if (evidence.length === 0) {
      answer = language === 'ar'
        ? "لم يتم العثور على معلومات في المصادر المتاحة."
        : "No information found in available sources.";
    } else {
      const evidenceText = evidence.map(e =>
        `[SOURCE ${e.id}] File: ${e.filename}${e.page ? ` | Page: ${e.page}` : ''}${e.section ? ` | Section: ${e.section}` : ''}\nContent: ${e.excerpt}`
      ).join('\n\n---\n\n');

      switch (output_mode) {

        // ── VERBATIM ────────────────────────────────────────────────────────
        case "verbatim": {
          const quotes = evidence.slice(0, 3).map(e => {
            const sentences = e.excerpt.split(/[.!?]+/).filter(s => s.trim().length > 20);
            const quote = sentences.length > 0
              ? sentences[0].trim() + '.'
              : e.excerpt.substring(0, 150);
            return `"${quote}"\n— ${e.filename}${e.page ? ` (p. ${e.page})` : ''}${e.section ? ` • ${e.section}` : ''}`;
          });
          answer = quotes.join('\n\n');
          citations = buildCitations(evidence, 250);
          break;
        }

        // ── SHORT ────────────────────────────────────────────────────────────
        case "short": {
          const gptRes = await callGPT(env.OPENAI_API_KEY, {
            system: `You are a clinical pharmacist AI. Answer using ONLY the provided sources. 
Reply with 3-6 bullet points. Each bullet starts with • and is one concise line. No preamble.`,
            user: `Question: ${question}\n\nSources:\n${evidenceText}`,
            max_tokens: 350
          });
          answer = gptRes || "• No concise answer available";
          if (source_mode === "required") citations = buildCitations(evidence, 150);
          break;
        }

        // ── HYBRID (default) ─────────────────────────────────────────────────
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
            max_tokens: 700
          });
          answer = gptRes || "No answer generated";
          citations = buildCitations(evidence, 250);
          break;
        }
      }
    }

    // ========== RESPONSE ==========
    const responseBody = {
      ok: true,
      verdict: evidence.length > 0 ? "OK" : "NOT_FOUND",
      answer,
      applied_output: { output_mode, source_mode, answer_style }
    };

    if (source_mode !== "off") {
      responseBody.citations = citations;
    }

    return new Response(JSON.stringify(responseBody), {
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });

  } catch (error) {
    console.error("Function error:", error);
    return new Response(JSON.stringify({ 
      ok: false,
      error: error.message || "Internal server error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}

// ============================================================
// HELPERS
// ============================================================

function buildCitations(evidence, excerptLen = 250) {
  return evidence.map(e => ({
    evidence_ids: [e.id],
    filename: e.filename,
    section: e.section || '',
    page: e.page || 0,
    score: e.score,
    excerpt: e.excerpt.substring(0, excerptLen)
  }));
}

async function callGPT(apiKey, { system, user, max_tokens = 600 }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.2,
      max_tokens
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

// ============================================================
// CASE ANALYSIS MODE
// ============================================================

async function handleCaseAnalysis(body, env, corsHeaders, language) {
  const { case_text, question } = body;

  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
    return new Response(JSON.stringify({ error: "Missing API credentials" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // Search vector store with case context
  const searchQuery = question
    ? `${question} ${case_text.substring(0, 300)}`
    : case_text.substring(0, 500);

  const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2'
    },
    body: JSON.stringify({ query: searchQuery, max_num_results: 8 })
  });

  let sources = [];
  if (searchResponse.ok) {
    const searchData = await searchResponse.json();
    if (searchData.data && Array.isArray(searchData.data)) {
      searchData.data.forEach((item, index) => {
        let content = '';
        let filename =
          item.attributes?.filename ||
          item.attributes?.file_name ||
          item.filename ||
          item.file_name ||
          item.file_id ||
          `source_${index + 1}`;

        if (item.content) {
          if (Array.isArray(item.content)) {
            content = item.content.map(c => c.text || c.value || '').join('\n');
          } else if (typeof item.content === 'string') {
            content = item.content;
          } else if (item.content.text) {
            content = item.content.text;
          }
        }
        if (!content && item.text) content = item.text;
        if (!content) return;

        const pageMatch = content.match(/(?:Page|page|PAGE)\s*[:\-]?\s*(\d+)/i);
        const page = pageMatch ? parseInt(pageMatch[1]) : 0;

        sources.push({
          id: `S${index + 1}`,
          filename,
          page,
          score: item.score ?? null,
          excerpt: content.substring(0, 500)
        });
      });
    }
  }

  const sourceText = sources.map(s =>
    `[${s.id}] ${s.filename}${s.page ? ` p.${s.page}` : ''}\n${s.excerpt}`
  ).join('\n\n---\n\n');

  const soapPrompt = `You are a senior clinical pharmacist. Analyze the patient case below and produce a structured SOAP note with medication dose verification against the provided protocol sources.

PATIENT CASE:
${case_text}
${question ? `\nCLINICIAN QUESTION: ${question}` : ''}

PROTOCOL SOURCES:
${sourceText || "No protocol sources found."}

Produce:
1. SOAP NOTE (Subjective / Objective / Assessment / Plan)
2. DOSE VERIFICATION TABLE — for each medication: dose ordered | recommended per protocol | verdict (✓ CORRECT / ⚠ ADJUST / ✗ WRONG) | reference
3. CLINICAL ALERTS — any drug interactions, renal adjustments, contraindications
4. EVIDENCE CITATIONS — list sources used

Be concise and clinically precise. If a drug is not in the sources, state "Not in protocol — use clinical judgment."`;

  const gptRes = await callGPT(env.OPENAI_API_KEY, {
    system: "You are a clinical pharmacist AI. Provide structured clinical analysis.",
    user: soapPrompt,
    max_tokens: 1200
  });

  return new Response(JSON.stringify({
    ok: true,
    final_note: gptRes || "Could not generate case analysis.",
    sources
  }), {
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
