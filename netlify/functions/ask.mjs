// File: /functions/api/ask.js
// DoseGuide AI — Clinical Pharmacist Validation Engine
// RULE: Drugs/Diagnoses = protocol files ONLY | Labs/Vitals = general knowledge OK

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
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  try {
    const body = await request.json();
    const language = body.language || "en";
    const output_mode = (body.output_mode || "hybrid").toLowerCase();
    const source_mode = (body.source_mode || "off").toLowerCase();
    const answer_style = body.answer_style || "recommended";

    if (!["hybrid", "short", "verbatim"].includes(output_mode)) {
      return new Response(JSON.stringify({ error: "Invalid output_mode. Must be hybrid, short, or verbatim." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (!["required", "off"].includes(source_mode)) {
      return new Response(JSON.stringify({ error: "Invalid source_mode. Must be required or off." }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY or VECTOR_STORE_ID is not set" }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ══════════════════════════════════════════════════
    // CASE ANALYSIS MODE
    // ══════════════════════════════════════════════════
    if (body.mode === "case_analysis" && body.case_text) {
      return await handleCaseAnalysis({
        case_text: body.case_text,
        language,
        answer_style,
        output_mode,
        source_mode,
        env,
        corsHeaders
      });
    }

    // ══════════════════════════════════════════════════
    // STANDARD Q&A MODE (unchanged)
    // ══════════════════════════════════════════════════
    const question = body.question || body.q || "";
    if (!question) {
      return new Response(JSON.stringify({ error: "Question is required" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const evidence = await vectorSearch(env, question);

    if (source_mode === "required") {
      const hasValidEvidence = evidence.some(e => e.filename && e.filename.length > 0 && e.page > 0 && e.section && e.section.length > 0);
      if (evidence.length === 0 || !hasValidEvidence) {
        return new Response(JSON.stringify({
          ok: true, verdict: "NOT_FOUND",
          answer: language === 'ar' ? "غير موجود في قاعدة البيانات البروتوكولية" : "Not found in protocol database",
          citations: [],
          applied_output: { output_mode, source_mode, answer_style }
        }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      }
    }

    const { answer, citations } = await generateQAAnswer({ question, evidence, output_mode, source_mode, language, env });

    if (source_mode === "off") {
      return new Response(JSON.stringify({
        ok: true, verdict: "OK", answer,
        applied_output: { output_mode, source_mode, answer_style }
      }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    return new Response(JSON.stringify({
      ok: true, verdict: "OK", answer, citations,
      applied_output: { output_mode, source_mode, answer_style }
    }), { headers: { "Content-Type": "application/json", ...corsHeaders } });

  } catch (error) {
    console.error("Function error:", error);
    return new Response(JSON.stringify({ ok: false, error: error.message || "Internal server error" }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// CASE ANALYSIS HANDLER
// ══════════════════════════════════════════════════════════════════
async function handleCaseAnalysis({ case_text, language, answer_style, output_mode, source_mode, env, corsHeaders }) {

  // ── STEP 1: Extract entities from case text ──
  const extractionPrompt = `You are a clinical data extractor. From the clinical case text below, extract:
1. diagnoses (array of strings)
2. medications (array of {name, dose, route, frequency, duration, indication})
3. labs (array of {name, value, unit})
4. vitals (array of {name, value, unit})
5. patient_info ({age, weight, sex, scr_value, scr_unit})

Return ONLY valid JSON, no markdown, no explanation.
Example: {"diagnoses":[],"medications":[],"labs":[],"vitals":[],"patient_info":{}}

Case text:
${case_text}`;

  let entities = { diagnoses: [], medications: [], labs: [], vitals: [], patient_info: {} };
  try {
    const extractRes = await callGPT(env, extractionPrompt, "", 1000);
    const clean = extractRes.replace(/```json|```/g, "").trim();
    entities = JSON.parse(clean);
  } catch (e) {
    console.error("Entity extraction failed:", e);
  }

  // ── STEP 2: CrCl Calculation ──
  const renalInfo = calculateCrCl(entities.patient_info);

  // ── STEP 3: Vector searches for each drug + diagnosis ──
  const searchQueries = [];

  (entities.medications || []).forEach(med => {
    const name = med.name || "";
    searchQueries.push(`${name} dosing renal adjustment CrCl`);
    searchQueries.push(`${name} contraindications drug interactions`);
    searchQueries.push(`${name} monitoring requirements`);
  });

  (entities.diagnoses || []).forEach(dx => {
    searchQueries.push(`${dx} treatment protocol pharmacotherapy`);
    searchQueries.push(`${dx} drug therapy guidelines`);
  });

  // Labs — general knowledge allowed, but still search for drug-lab conflicts
  (entities.labs || []).forEach(lab => {
    searchQueries.push(`${lab.name} drug interaction cutoff threshold`);
  });

  // Run searches (deduplicated, max 15)
  const uniqueQueries = [...new Set(searchQueries)].slice(0, 15);
  const allEvidence = {};

  await Promise.all(uniqueQueries.map(async (q) => {
    const results = await vectorSearch(env, q);
    results.forEach(e => {
      allEvidence[e.id + q] = { ...e, search_query: q };
    });
  }));

  const evidenceArray = Object.values(allEvidence);

  // ── STEP 4: Build SOAP from case_text ──
  const soapPrompt = `You are a clinical pharmacist. Organize the following messy clinical case into a structured SOAP note.

STRICT RULES:
- S (Subjective): Chief complaint, history, symptoms, PMH, home medications
- O (Objective): Vitals, labs with values+units+reference ranges+flags, imaging, active orders
- A (Assessment): Numbered list of all diagnoses/problems by severity (CRITICAL first)
- P (Plan): Leave blank — will be filled separately

For labs, use this format:
| Parameter | Value | Unit | Reference | Flag |

For medications table use:
| # | Drug | Dose | Route | Frequency | Duration | Status |

Include CrCl calculation:
- Show formula used
- Show unit conversion if SCr in µmol/L (÷88.4 to get mg/dL)
- Show result in mL/min
- State renal category: ESRD(<15), Severe(15-29), Moderate(30-59), Mild(60-89), Normal(≥90)
- If weight/age/sex missing: state "insufficient data for CrCl"

Output in clean markdown. Language: ${language === 'ar' ? 'Arabic' : 'English'}.

CASE TEXT:
${case_text}`;

  const soapNote = await callGPT(env, soapPrompt, "", 2000);

  // ── STEP 5: Generate Interventions with citations ──
  const evidenceContext = evidenceArray.map(e =>
    `[FILE: ${e.filename} | Section: ${e.section || 'N/A'} | Page: ${e.page || 'N/A'}]\n${e.excerpt}`
  ).join('\n\n---\n\n');

  const interventionPrompt = `You are a strict Clinical Pharmacist Validation Engine.

CRITICAL RULES — NON-NEGOTIABLE:
1. For DRUGS and DIAGNOSES: Every finding MUST cite a specific file from the PROVIDED EVIDENCE below
2. If a drug/diagnosis has NO evidence in the provided files: state "NOT_FOUND in protocol database" — do NOT use general knowledge
3. For LABS/VITALS interpretation (reference ranges, normal values): general medical knowledge IS allowed — no citation needed
4. Never invent citations or file names

PATIENT RENAL STATUS: ${renalInfo.summary}

EXTRACTED ENTITIES:
- Diagnoses: ${JSON.stringify(entities.diagnoses)}
- Medications: ${JSON.stringify(entities.medications)}
- Labs: ${JSON.stringify(entities.labs)}
- Vitals: ${JSON.stringify(entities.vitals)}

PROVIDED PROTOCOL EVIDENCE:
${evidenceContext || "NO EVIDENCE RETRIEVED FROM PROTOCOL FILES"}

TASK: Generate pharmacist interventions as JSON array. Each intervention:
{
  "severity": "CRITICAL|HIGH|MODERATE|LOW",
  "type": "DOSE_ERROR|INTERACTION|LAB_CUTOFF|CONTRAINDICATION|MISSING_THERAPY|NO_INDICATION|MONITORING|NOT_FOUND",
  "drug_or_topic": "string",
  "problem": "clear description",
  "correction": "actionable correction",
  "rationale": "2 sentences max",
  "source": "FILE_PROTOCOL (filename+section+page) | GENERAL_MEDICAL_KNOWLEDGE | NOT_FOUND_IN_PROTOCOL",
  "citations": [{"filename":"...","section":"...","page":0,"excerpt":"..."}]
}

Also provide:
- missing_medications: array of {drug, reason}  
- no_indication: array of {drug, reason}
- duplicates: array of {drugs, reason}
- unparsed: array of strings (things that couldn't be clearly parsed)
- safety_status: "CRITICAL_ISSUES_FOUND" | "ISSUES_FOUND" | "CLEAN"

Return ONLY valid JSON:
{
  "interventions": [...],
  "missing_medications": [...],
  "no_indication": [...],
  "duplicates": [...],
  "unparsed": [...],
  "safety_status": "..."
}`;

  let auditResult = {
    interventions: [],
    missing_medications: [],
    no_indication: [],
    duplicates: [],
    unparsed: [],
    safety_status: "ISSUES_FOUND"
  };

  try {
    const auditRaw = await callGPT(env, interventionPrompt, "", 3000);
    const clean = auditRaw.replace(/```json|```/g, "").trim();
    auditResult = JSON.parse(clean);
  } catch (e) {
    console.error("Audit generation failed:", e);
    auditResult.unparsed.push("Audit generation error: " + e.message);
  }

  // ── STEP 6: Generate Monitoring Plan ──
  const monitoringPrompt = `Based on these patient issues and medications, generate a concise monitoring plan table:
Issues: ${JSON.stringify(entities.diagnoses)}
Meds: ${JSON.stringify(entities.medications?.map(m => m.name))}
Labs: ${JSON.stringify(entities.labs)}
Renal: ${renalInfo.summary}

Format as markdown table:
| Parameter | Target | Frequency | Reason |

Use general medical knowledge for monitoring targets. Keep it clinical and concise.`;

  const monitoringPlan = await callGPT(env, monitoringPrompt, "", 800);

  // ── STEP 7: Build consolidated citations ──
  const allCitations = [];
  (auditResult.interventions || []).forEach(inv => {
    (inv.citations || []).forEach(c => {
      if (c.filename && !allCitations.find(x => x.filename === c.filename && x.section === c.section)) {
        allCitations.push(c);
      }
    });
  });

  // ── STEP 8: Assemble final answer ──
  const answer = buildFinalNote({
    soapNote,
    entities,
    renalInfo,
    auditResult,
    monitoringPlan,
    language
  });

  return new Response(JSON.stringify({
    ok: true,
    verdict: auditResult.safety_status === "CLEAN" ? "OK" : "ISSUES_FOUND",
    answer,
    clinical_findings: auditResult.interventions || [],
    missing_medications: auditResult.missing_medications || [],
    no_indication: auditResult.no_indication || [],
    duplicates: auditResult.duplicates || [],
    unparsed: auditResult.unparsed || [],
    safety_status: auditResult.safety_status || "ISSUES_FOUND",
    citations: allCitations,
    renal_info: renalInfo,
    applied_output: { output_mode, source_mode, answer_style, mode: "case_analysis" }
  }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// ══════════════════════════════════════════════════════════════════
// BUILD FINAL NOTE (structured text for display)
// ══════════════════════════════════════════════════════════════════
function buildFinalNote({ soapNote, entities, renalInfo, auditResult, monitoringPlan, language }) {
  const interventions = auditResult.interventions || [];
  const critical = interventions.filter(i => i.severity === "CRITICAL");
  const high = interventions.filter(i => i.severity === "HIGH");
  const moderate = interventions.filter(i => i.severity === "MODERATE");
  const low = interventions.filter(i => i.severity === "LOW");

  const formatIntervention = (inv, idx) => {
    const severityEmoji = { CRITICAL: "🔴🔴", HIGH: "🔴", MODERATE: "🟡", LOW: "🟢" }[inv.severity] || "⚪";
    const sourceNote = inv.source?.includes("NOT_FOUND")
      ? "⚠️ NOT_FOUND in protocol database — UNSUPPORTED_BY_PROTOCOL"
      : inv.source?.includes("GENERAL")
        ? "ℹ️ General medical knowledge (labs/vitals)"
        : `📄 ${inv.source || "Protocol file"}`;

    return `**[INT-${idx + 1}] ${severityEmoji} ${inv.severity} — ${inv.drug_or_topic || inv.type}**
- **Problem:** ${inv.problem}
- **Correction:** ${inv.correction}
- **Rationale:** ${inv.rationale}
- **Evidence:** ${sourceNote}
${inv.citations?.length ? inv.citations.map(c => `  - 📎 ${c.filename} | ${c.section || ''} | p.${c.page || 'N/A'}`).join('\n') : ''}`;
  };

  const allOrdered = [...critical, ...high, ...moderate, ...low];

  let note = `---
## 📋 STRUCTURED SOAP NOTE

${soapNote}

---
## 💊 PHARMACIST INTERVENTIONS (${allOrdered.length} total — Protocol-Locked)

${allOrdered.length === 0 ? "✅ No interventions required." : allOrdered.map((inv, i) => formatIntervention(inv, i)).join('\n\n')}
`;

  if ((auditResult.missing_medications || []).length > 0) {
    note += `\n---\n## ⚠️ MISSING THERAPIES\n`;
    auditResult.missing_medications.forEach(m => {
      note += `- **${m.drug}**: ${m.reason}\n`;
    });
  }

  if ((auditResult.no_indication || []).length > 0) {
    note += `\n---\n## ❌ NO INDICATION DOCUMENTED\n`;
    auditResult.no_indication.forEach(m => {
      note += `- **${m.drug}**: ${m.reason}\n`;
    });
  }

  if ((auditResult.duplicates || []).length > 0) {
    note += `\n---\n## 🔄 DUPLICATES / THERAPEUTIC DUPLICATION\n`;
    auditResult.duplicates.forEach(d => {
      note += `- ${Array.isArray(d.drugs) ? d.drugs.join(' + ') : d.drugs}: ${d.reason}\n`;
    });
  }

  note += `\n---\n## 📊 MONITORING PLAN\n\n${monitoringPlan}`;

  if ((auditResult.unparsed || []).length > 0) {
    note += `\n---\n## ⚠️ UNPARSED / NEEDS CLARIFICATION\n`;
    auditResult.unparsed.forEach((u, i) => {
      note += `${i + 1}. ${u}\n`;
    });
  }

  return note;
}

// ══════════════════════════════════════════════════════════════════
// CrCl CALCULATION (Cockcroft-Gault)
// ══════════════════════════════════════════════════════════════════
function calculateCrCl(patient_info) {
  if (!patient_info) return { summary: "Insufficient data for CrCl calculation", crcl: null, category: null };

  let { age, weight, sex, scr_value, scr_unit } = patient_info;

  const missing = [];
  if (!age) missing.push("age");
  if (!weight) missing.push("weight");
  if (!sex) missing.push("sex");
  if (!scr_value) missing.push("SCr");

  if (missing.length > 0) {
    return {
      summary: `Insufficient data for CrCl — missing: ${missing.join(", ")}`,
      crcl: null,
      category: null,
      missing
    };
  }

  // Convert µmol/L → mg/dL if needed
  let scrMgDl = parseFloat(scr_value);
  if (scr_unit && scr_unit.toLowerCase().includes("umol")) {
    scrMgDl = scrMgDl / 88.4;
  }

  const isFemale = sex.toLowerCase().startsWith("f");
  const crcl = ((140 - age) * weight) / (72 * scrMgDl) * (isFemale ? 0.85 : 1);
  const crclRounded = Math.round(crcl * 10) / 10;

  let category = "";
  if (crclRounded < 15) category = "ESRD (< 15 mL/min)";
  else if (crclRounded < 30) category = "Severe CKD (15–29 mL/min)";
  else if (crclRounded < 60) category = "Moderate CKD (30–59 mL/min)";
  else if (crclRounded < 90) category = "Mild CKD (60–89 mL/min)";
  else category = "Normal (≥ 90 mL/min)";

  return {
    summary: `CrCl = ${crclRounded} mL/min — ${category} | SCr used: ${scrMgDl.toFixed(2)} mg/dL (${scr_value} ${scr_unit}) | Age: ${age} | Weight: ${weight} kg | Sex: ${sex}`,
    crcl: crclRounded,
    category,
    scr_converted: scrMgDl.toFixed(2)
  };
}

// ══════════════════════════════════════════════════════════════════
// VECTOR SEARCH (unchanged from original)
// ══════════════════════════════════════════════════════════════════
async function vectorSearch(env, query) {
  try {
    const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({ query, max_num_results: 8 })
    });

    if (!searchResponse.ok) return [];
    const searchData = await searchResponse.json();
    const evidence = [];

    if (searchData.data && Array.isArray(searchData.data)) {
      searchData.data.forEach((item, index) => {
        let content = '';
        let filename = item.file_id || item.filename || `source_${index + 1}`;
        let page = 0;
        let section = '';

        if (item.content) {
          if (Array.isArray(item.content)) {
            content = item.content.map(c => c.text || c.value || '').filter(t => t).join('\n');
          } else if (typeof item.content === 'string') {
            content = item.content;
          } else if (item.content.text) {
            content = item.content.text;
          }
        }
        if (item.text) content = item.text;

        const pageMatch = content.match(/(?:Page|PAGE|page)\s*(\d+)/i) || content.match(/p\.\s*(\d+)/i);
        if (pageMatch) page = parseInt(pageMatch[1]);

        const sectionMatch = content.match(/(?:Section|SECTION)\s+(\d+(?:\.\d+)*)\s*[–—-]?\s*([^\n]+)/i) ||
          content.match(/##+\s*([^\n]+)/) || content.match(/^\d+\.\d+\s+([^\n]+)/m);
        if (sectionMatch) section = (sectionMatch[2] || sectionMatch[1]).trim();

        if (content && content.trim()) {
          evidence.push({
            id: `E${index + 1}_${Date.now()}`,
            filename,
            page,
            section,
            excerpt: content.substring(0, 2000),
            full_content: content
          });
        }
      });
    }
    return evidence;
  } catch (e) {
    console.error("Vector search error:", e);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════
// GPT CALL HELPER
// ══════════════════════════════════════════════════════════════════
async function callGPT(env, systemPrompt, userMessage, maxTokens = 1000) {
  const messages = [{ role: 'system', content: systemPrompt }];
  if (userMessage) messages.push({ role: 'user', content: userMessage });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: "gpt-4o", messages, temperature: 0.2, max_tokens: maxTokens })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ══════════════════════════════════════════════════════════════════
// STANDARD Q&A ANSWER GENERATOR (unchanged logic)
// ══════════════════════════════════════════════════════════════════
async function generateQAAnswer({ question, evidence, output_mode, source_mode, language, env }) {
  if (evidence.length === 0) {
    return {
      answer: language === 'ar' ? "لم يتم العثور على معلومات في قاعدة البيانات البروتوكولية." : "No information found in available sources.",
      citations: []
    };
  }

  const evidenceText = evidence.map(e => `[SOURCE ${e.id}] File: ${e.filename}\nContent: ${e.excerpt}`).join('\n\n---\n\n');
  let answer = "";
  let citations = [];

  if (output_mode === "verbatim") {
    const quotes = evidence.map(e => {
      const sentences = e.excerpt.split(/[.!?]+/).filter(s => s.trim().length > 20);
      const quote = sentences.length > 0 ? sentences[0].trim() + '.' : e.excerpt.substring(0, 150);
      return `"${quote}" — ${e.filename} (Section: ${e.section || 'General'}, Page: ${e.page || 'N/A'})`;
    }).slice(0, 3);
    answer = quotes.join('\n\n');
    citations = evidence.map(e => ({ evidence_ids: [e.id], filename: e.filename, section: e.section || 'General', page: e.page || 0, excerpt: e.excerpt.substring(0, 250) }));
  } else if (output_mode === "short") {
    const prompt = `Answer in 3-6 bullet points (•). Each bullet: one line, concise. ONLY use provided sources. Language: ${language}.`;
    answer = await callGPT(env, prompt, `Question: ${question}\n\nSources:\n${evidenceText}`, 300);
    if (source_mode === "required") citations = evidence.map(e => ({ evidence_ids: [e.id], filename: e.filename, section: e.section || 'General', page: e.page || 0, excerpt: e.excerpt.substring(0, 150) }));
  } else {
    const prompt = `Provide a brief synthesized answer, then 2-3 relevant direct quotes from sources. Format: ANSWER: ... then QUOTES: ... Language: ${language}.`;
    answer = await callGPT(env, prompt, `Question: ${question}\n\nSources:\n${evidenceText}`, 600);
    citations = evidence.map(e => ({ evidence_ids: [e.id], filename: e.filename, section: e.section || 'General', page: e.page || 0, excerpt: e.excerpt.substring(0, 250) }));
  }

  return { answer, citations };
}
