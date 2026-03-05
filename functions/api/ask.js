// File: /functions/api/ask.js
// TheraGuard AI — Clinical Decision Support Engine v2.1
// Upgraded: Fixed ICU SOAP template, intelligent lab classification,
// abnormal/borderline/drug-relevant lab filtering, structured pharmacist output

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
// LAB REFERENCE RANGES & CLASSIFICATION ENGINE
// Each entry: label, unit, low limit, high limit, list of
// drug classes that depend on this value for safe dosing.
// ============================================================

const LAB_RANGES = {
  // ── CBC ──────────────────────────────────────────────────
  hb:           { label:"Hb",            unit:"g/dL",    low:12.0,  high:17.5, drugs:["anticoagulants","iron","ESA"] },
  wbc:          { label:"WBC",           unit:"×10⁹/L",  low:4.0,   high:11.0, drugs:["antibiotics","immunosuppressants"] },
  plt:          { label:"Platelets",     unit:"×10⁹/L",  low:150,   high:400,  drugs:["anticoagulants","heparin","antiplatelet"] },
  neutrophil:   { label:"Neutrophils",   unit:"×10⁹/L",  low:1.8,   high:7.5,  drugs:["G-CSF","immunosuppressants"] },
  // ── Renal ────────────────────────────────────────────────
  scr_umol:     { label:"SCr",           unit:"µmol/L",  low:null,  high:106,  drugs:["vancomycin","aminoglycosides","NSAIDs","ACEi/ARB","contrast"] },
  scr_mgdl:     { label:"SCr",           unit:"mg/dL",   low:null,  high:1.2,  drugs:["vancomycin","aminoglycosides","NSAIDs","ACEi/ARB"] },
  urea:         { label:"Urea",          unit:"mmol/L",  low:null,  high:7.1,  drugs:[] },
  bun:          { label:"BUN",           unit:"mmol/L",  low:null,  high:7.1,  drugs:[] },
  // ── Electrolytes ─────────────────────────────────────────
  na:           { label:"Na",            unit:"mmol/L",  low:136,   high:145,  drugs:["diuretics","IV fluids"] },
  k:            { label:"K",             unit:"mmol/L",  low:3.5,   high:5.0,  drugs:["digoxin","antiarrhythmics","diuretics","ACEi/ARB","insulin"] },
  cl:           { label:"Cl",            unit:"mmol/L",  low:98,    high:107,  drugs:[] },
  bicarb:       { label:"HCO₃",          unit:"mmol/L",  low:22,    high:29,   drugs:["diuretics"] },
  ca:           { label:"Ca",            unit:"mmol/L",  low:2.12,  high:2.62, drugs:["digoxin","calcium channel blockers"] },
  mg:           { label:"Mg",            unit:"mmol/L",  low:0.74,  high:1.03, drugs:["aminoglycosides","amphotericin","diuretics","PPIs"] },
  phos:         { label:"Phos",          unit:"mmol/L",  low:0.81,  high:1.45, drugs:["phosphate binders"] },
  // ── Liver Function ───────────────────────────────────────
  alt:          { label:"ALT",           unit:"U/L",     low:null,  high:56,   drugs:["statins","azoles","paracetamol","hepatotoxic drugs"] },
  ast:          { label:"AST",           unit:"U/L",     low:null,  high:40,   drugs:["statins","hepatotoxic drugs"] },
  alp:          { label:"ALP",           unit:"U/L",     low:null,  high:120,  drugs:[] },
  bili_t:       { label:"Bili (Total)",  unit:"µmol/L",  low:null,  high:21,   drugs:["rifampicin","hepatotoxic drugs"] },
  albumin:      { label:"Albumin",       unit:"g/L",     low:35,    high:50,   drugs:["phenytoin","warfarin","vancomycin"] },
  // ── Coagulation ──────────────────────────────────────────
  inr:          { label:"INR",           unit:"",        low:null,  high:1.2,  drugs:["warfarin","heparin","antibiotics"] },
  pt:           { label:"PT",            unit:"sec",     low:null,  high:13.5, drugs:["warfarin"] },
  aptt:         { label:"aPTT",          unit:"sec",     low:null,  high:35,   drugs:["heparin","LMWH"] },
  fibrinogen:   { label:"Fibrinogen",    unit:"g/L",     low:2.0,   high:4.0,  drugs:[] },
  // ── Metabolic / Inflammatory ─────────────────────────────
  glucose:      { label:"Glucose",       unit:"mmol/L",  low:3.9,   high:7.8,  drugs:["insulin","steroids","octreotide"] },
  crp:          { label:"CRP",           unit:"mg/L",    low:null,  high:10,   drugs:["antibiotics"] },
  procalc:      { label:"PCT",           unit:"µg/L",    low:null,  high:0.5,  drugs:["antibiotics"] },
  lactate:      { label:"Lactate",       unit:"mmol/L",  low:null,  high:2.0,  drugs:["metformin"] },
  // ── TDM Levels ───────────────────────────────────────────
  vanc_trough:  { label:"Vanc Trough",   unit:"mg/L",    low:10,    high:20,   drugs:["vancomycin"] },
  vanc_auc:     { label:"Vanc AUC",      unit:"mg·h/L",  low:400,   high:600,  drugs:["vancomycin"] },
  genta_trough: { label:"Genta Trough",  unit:"mg/L",    low:null,  high:2,    drugs:["gentamicin"] },
  tobra_trough: { label:"Tobra Trough",  unit:"mg/L",    low:null,  high:2,    drugs:["tobramycin"] },
  digoxin:      { label:"Digoxin",       unit:"µg/L",    low:0.5,   high:2.0,  drugs:["digoxin"] },
  phenytoin:    { label:"Phenytoin",     unit:"mg/L",    low:10,    high:20,   drugs:["phenytoin"] },
  valproate:    { label:"Valproate",     unit:"mg/L",    low:50,    high:100,  drugs:["valproate"] },
  tacro:        { label:"Tacrolimus",    unit:"µg/L",    low:5,     high:15,   drugs:["tacrolimus"] },
  cyclo:        { label:"Ciclosporin",   unit:"µg/L",    low:100,   high:400,  drugs:["ciclosporin"] },
};

// Flag as borderline if within 15% of the reference limit
const BORDERLINE_MARGIN = 0.15;

function classifyLab(key, value) {
  const ref = LAB_RANGES[key];
  if (!ref) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return null;

  let status = "normal";
  let arrow = "";

  if (ref.high !== null && num > ref.high) {
    const pct = (num - ref.high) / ref.high;
    status = pct > BORDERLINE_MARGIN ? "high" : "borderline-high";
    arrow = "↑";
  } else if (ref.low !== null && num < ref.low) {
    const pct = (ref.low - num) / ref.low;
    status = pct > BORDERLINE_MARGIN ? "low" : "borderline-low";
    arrow = "↓";
  }

  return {
    key,
    label: ref.label,
    value: num,
    unit: ref.unit,
    status,
    arrow,
    isDrugRelated: ref.drugs.length > 0,
    drugRelated: ref.drugs,
    isAbnormal: status === "high" || status === "low",
    isBorderline: status === "borderline-high" || status === "borderline-low",
  };
}

// ============================================================
// CLINICAL CALCULATORS
// ============================================================

function calcCrCl(age, weight_kg, scr_umol, sex) {
  if (!age || !weight_kg || !scr_umol || !sex) return null;
  const scr_mgdl = scr_umol / 88.42;
  const sf = sex.toLowerCase().startsWith("f") ? 0.85 : 1.0;
  const val = ((140 - age) * weight_kg * sf) / (72 * scr_mgdl);
  const v = Math.round(val * 10) / 10;
  let category, cls;
  if (v >= 90) { category = "Normal (≥90)"; cls = "normal"; }
  else if (v >= 60) { category = "Mild impairment (60–89)"; cls = "mild"; }
  else if (v >= 30) { category = "Moderate impairment (30–59)"; cls = "moderate"; }
  else if (v >= 15) { category = "Severe impairment (15–29)"; cls = "severe"; }
  else { category = "Kidney failure (<15)"; cls = "failure"; }
  return { value: v, category, cls };
}

function calcIBW(height_cm, sex) {
  if (!height_cm || !sex) return null;
  const inches = height_cm / 2.54;
  return sex.toLowerCase().startsWith("f")
    ? Math.round((45.5 + 2.3 * (inches - 60)) * 10) / 10
    : Math.round((50   + 2.3 * (inches - 60)) * 10) / 10;
}

// ============================================================
// SOAP BUILDER — Fixed ICU Template
// ============================================================

function buildSoapNote(p, classifiedLabs, crcl, meds, interventions, followup, assessment) {
  // Helpers
  const fmtLab  = l => `    ${l.label.padEnd(18)}${l.value} ${l.arrow}  [${l.unit}]`;
  const fmtDrug = l => `    ${l.label.padEnd(18)}${l.value} ${l.arrow}  [${l.unit}]  →  Monitor: ${l.drugRelated.join(", ")}`;

  const scrEntry  = classifiedLabs.find(l => l.key === "scr_umol" || l.key === "scr_mgdl");
  const scrStr    = scrEntry ? `${scrEntry.value} ${scrEntry.unit} ${scrEntry.arrow}`.trim() : "—";
  const crclStr   = crcl ? `${crcl.value} mL/min  (${crcl.category})` : "—";

  const abnormal   = classifiedLabs.filter(l => l.isAbnormal);
  const borderline = classifiedLabs.filter(l => l.isBorderline);
  const drugMonitor = classifiedLabs.filter(l => l.isDrugRelated && (l.isAbnormal || l.isBorderline));

  // If SCr/CrCl not already in drug monitoring, always inject it
  const hasScrInMonitor = drugMonitor.some(l => l.key === "scr_umol" || l.key === "scr_mgdl");
  const crclLine = `    ${"SCr / CrCl".padEnd(18)}${scrStr} / ${crclStr}  →  Renal dosing review`;

  const medsBlock = (meds || []).length > 0
    ? meds.map(m =>
        `  - ${m.name}${m.dose ? `  ${m.dose}` : ""}${m.route ? `  ${m.route}` : ""}${m.frequency ? `  ${m.frequency}` : ""}`
      ).join("\n")
    : "  - (No medications documented)";

  const interventionText = interventions && interventions.trim()
    ? interventions.trim()
    : "  Patient reviewed; no interventions at this time.";

  const followupText = followup && followup.trim() ? followup.trim() : "OK.";

  return [
    `S:`,
    `  Patient (MRN: ${p.mrn || ""}), ${p.age || "—"}Y, ${p.weight || "—"}kg admitted to ICU.`,
    `  Reason for Admission: ${p.reason_admission || "—"}`,
    `  PMH: ${p.pmh || "—"}`,
    `  Home Meds: ${p.home_meds || "—"}`,
    ``,
    `─────────────────────────────────────────────────────`,
    `O:`,
    `  Vitals: ${p.vitals || "—"}`,
    ``,
    `  Labs:`,
    `    Renal:`,
    `      SCr:              ${scrStr}`,
    `      Calculated CrCl:  ${crclStr}`,
    ``,
    `    Key Abnormal or Relevant Labs:`,
    abnormal.length > 0
      ? abnormal.map(fmtLab).join("\n")
      : "    None",
    ``,
    `    Borderline Labs:`,
    borderline.length > 0
      ? borderline.map(fmtLab).join("\n")
      : "    None",
    ``,
    `    Drug-Related Monitoring Labs:`,
    !hasScrInMonitor ? crclLine : "",
    drugMonitor.length > 0
      ? drugMonitor.map(fmtDrug).join("\n")
      : (hasScrInMonitor ? "    None" : ""),
    ``,
    `─────────────────────────────────────────────────────`,
    `A:`,
    `  Primary admission for acute issues. Clinical review performed.`,
    assessment ? `  ${assessment}` : "",
    ``,
    `─────────────────────────────────────────────────────`,
    `P:`,
    `  Current Medications:`,
    medsBlock,
    ``,
    `  Pharmacist Intervention:`,
    `  ${interventionText}`,
    ``,
    `  Follow-up Plan:`,
    `  - Follow-up: ${followupText}`,
  ]
    .filter(line => line !== null && line !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
// MODE: CASE ANALYSIS — Full ICU Clinical Pharmacist Review
// ============================================================

async function handleCaseAnalysis(body, env, corsHeaders, language) {
  const { case_text, question } = body;
  if (!case_text) return jsonError("case_text is required", 400, corsHeaders);
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) return jsonError("Missing API credentials", 500, corsHeaders);

  // ── Step 1: Extract structured patient data ──────────────
  const extractionPrompt = `Extract ALL clinical data from this patient case. Return ONLY valid JSON, no markdown, no explanation.

Case text:
${case_text}

Return exactly this structure (use null for missing, empty arrays for missing lists):
{
  "mrn": null,
  "age": null,
  "sex": null,
  "weight_kg": null,
  "height_cm": null,
  "reason_admission": null,
  "pmh": null,
  "home_medications": null,
  "diagnosis": null,
  "allergies": [],
  "vitals": {
    "bp": null, "hr": null, "rr": null,
    "temp": null, "spo2": null, "gcs": null
  },
  "labs": {
    "hb": null, "wbc": null, "plt": null, "neutrophil": null,
    "scr_umol": null, "scr_mgdl": null, "urea": null, "bun": null,
    "na": null, "k": null, "cl": null, "bicarb": null,
    "ca": null, "mg": null, "phos": null,
    "alt": null, "ast": null, "alp": null, "bili_t": null, "albumin": null,
    "inr": null, "pt": null, "aptt": null, "fibrinogen": null,
    "glucose": null, "crp": null, "procalc": null, "lactate": null,
    "vanc_trough": null, "vanc_auc": null, "genta_trough": null,
    "digoxin": null, "phenytoin": null, "valproate": null,
    "tacro": null, "cyclo": null
  },
  "medications": [
    { "name": "", "dose": "", "route": "", "frequency": "", "indication": null }
  ],
  "interventions": null,
  "followup": null
}`;

  let extracted = {};
  try {
    const raw = await callGPT(env.OPENAI_API_KEY, {
      system: "Clinical data extraction. Return ONLY valid JSON. No markdown.",
      user: extractionPrompt,
      max_tokens: 1000,
    });
    extracted = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (_) {}

  // ── Step 2: Classify all labs ────────────────────────────
  const classifiedLabs = [];
  if (extracted.labs) {
    for (const [key, value] of Object.entries(extracted.labs)) {
      if (value === null || value === undefined) continue;
      const c = classifyLab(key, value);
      if (c) classifiedLabs.push(c);
    }
  }

  // ── Step 3: Calculate renal metrics ─────────────────────
  const scrUmol = extracted.labs?.scr_umol
    || (extracted.labs?.scr_mgdl ? extracted.labs.scr_mgdl * 88.42 : null);

  const crcl = calcCrCl(extracted.age, extracted.weight_kg, scrUmol, extracted.sex);
  const ibw  = calcIBW(extracted.height_cm, extracted.sex);
  const adjBw = (ibw && extracted.weight_kg && extracted.weight_kg > ibw * 1.2)
    ? Math.round((ibw + 0.4 * (extracted.weight_kg - ibw)) * 10) / 10
    : null;

  // ── Step 4: Format vitals ────────────────────────────────
  let vitalsStr = "—";
  if (extracted.vitals) {
    const v = extracted.vitals;
    const parts = [];
    if (v.bp)   parts.push(`BP ${v.bp} mmHg`);
    if (v.hr)   parts.push(`HR ${v.hr} bpm`);
    if (v.rr)   parts.push(`RR ${v.rr} /min`);
    if (v.temp) parts.push(`T ${v.temp}°C`);
    if (v.spo2) parts.push(`SpO₂ ${v.spo2}`);
    if (v.gcs)  parts.push(`GCS ${v.gcs}`);
    if (parts.length) vitalsStr = parts.join("  |  ");
  }

  // ── Step 5: Vector search ────────────────────────────────
  const searchQuery = question
    ? `${question} ${case_text.substring(0, 300)}`
    : case_text.substring(0, 500);
  const sources = await vectorSearch(env, searchQuery, 10);

  // ── Step 6: Clinical reasoning prompt ───────────────────
  const abnormalSummary = classifiedLabs
    .filter(l => l.isAbnormal || l.isBorderline)
    .map(l => `${l.label} ${l.value} ${l.arrow} [${l.unit}]`)
    .join(", ") || "None identified";

  const medsForPrompt = (extracted.medications || [])
    .map(m => `${m.name} ${m.dose || ""} ${m.route || ""} ${m.frequency || ""}`.trim())
    .join(" | ") || "None documented";

  const sourceText = sources.length > 0
    ? sources.map(s => `[${s.id}] ${s.filename}${s.page ? ` p.${s.page}` : ""}\n${s.excerpt}`).join("\n\n---\n\n")
    : "No protocol sources found — apply clinical judgment.";

  const reasoningPrompt = `You are a senior ICU clinical pharmacist performing a medication review.

Patient:
  Age/Sex/Weight: ${extracted.age || "?"}Y / ${extracted.sex || "?"} / ${extracted.weight_kg || "?"}kg
  Diagnosis: ${extracted.diagnosis || "Not specified"}
  CrCl (Cockcroft-Gault): ${crcl ? `${crcl.value} mL/min — ${crcl.category}` : "Unable to calculate"}
  Allergies: ${(extracted.allergies || []).join(", ") || "NKDA"}
  Medications: ${medsForPrompt}
  Abnormal/Borderline Labs: ${abnormalSummary}
${question ? `\nClinician Question: ${question}` : ""}

PROTOCOL SOURCES:
${sourceText}

Return ONLY this JSON structure, no markdown, no extra text:
{
  "assessment": "<2-3 sentence clinical pharmacist assessment>",
  "interventions": "<pharmacist interventions, one per line starting with dash. If none: 'Patient reviewed; no interventions at this time.'>",
  "followup": "<specific follow-up plan>",
  "dose_verification": [
    {
      "drug": "<name>",
      "ordered_dose": "<as written>",
      "protocol_dose": "<recommended dose per protocol>",
      "renal_adjustment": "<required adjustment or N/A>",
      "verdict": "<CORRECT|ADJUST|WRONG|NOT_IN_PROTOCOL>",
      "reference": "<source filename and page>"
    }
  ],
  "alerts": ["<alert 1>", "<alert 2>"]
}`;

  let reasoning = {
    assessment: "Clinical review performed.",
    interventions: "Patient reviewed; no interventions at this time.",
    followup: "OK.",
    dose_verification: [],
    alerts: [],
  };

  try {
    const raw = await callGPT(env.OPENAI_API_KEY, {
      system: "ICU clinical pharmacist. Return ONLY valid JSON. No markdown.",
      user: reasoningPrompt,
      max_tokens: 1400,
    });
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    reasoning = { ...reasoning, ...parsed };
  } catch (_) {}

  // ── Step 7: Build SOAP note ──────────────────────────────
  const soapNote = buildSoapNote(
    {
      mrn: extracted.mrn || "",
      age: extracted.age || "—",
      weight: extracted.weight_kg || "—",
      reason_admission: extracted.reason_admission || "—",
      pmh: extracted.pmh || "—",
      home_meds: extracted.home_medications || "—",
      vitals: vitalsStr,
    },
    classifiedLabs,
    crcl,
    extracted.medications || [],
    reasoning.interventions,
    reasoning.followup,
    reasoning.assessment
  );

  return new Response(
    JSON.stringify({
      ok: true,
      soap_note: soapNote,
      patient_parameters: {
        mrn: extracted.mrn,
        age: extracted.age,
        sex: extracted.sex,
        weight_kg: extracted.weight_kg,
        height_cm: extracted.height_cm,
        diagnosis: extracted.diagnosis,
        allergies: extracted.allergies || [],
        reason_admission: extracted.reason_admission,
        pmh: extracted.pmh,
        home_medications: extracted.home_medications,
      },
      clinical_metrics: {
        ...(crcl ? {
          creatinine_clearance_ml_min: crcl.value,
          renal_function_category: crcl.category,
          renal_class: crcl.cls,
        } : {}),
        ...(ibw   ? { ibw_kg: ibw }       : {}),
        ...(adjBw ? { adjusted_bw_kg: adjBw } : {}),
      },
      labs_classified: {
        abnormal:     classifiedLabs.filter(l => l.isAbnormal),
        borderline:   classifiedLabs.filter(l => l.isBorderline),
        drug_related: classifiedLabs.filter(l => l.isDrugRelated && (l.isAbnormal || l.isBorderline)),
        all_reported: classifiedLabs,
      },
      dose_verification: reasoning.dose_verification || [],
      clinical_alerts:   reasoning.alerts || [],
      assessment:        reasoning.assessment || "",
      sources: sources.map(s => ({
        id: s.id, filename: s.filename, page: s.page,
        score: s.score, excerpt: s.excerpt.substring(0, 300),
      })),
    }),
    { headers: { "Content-Type": "application/json", ...corsHeaders } }
  );
}

// ============================================================
// MODE: ASK
// ============================================================

async function handleAsk(body, env, corsHeaders, language) {
  const output_mode = (body.output_mode || "hybrid").toLowerCase();
  const source_mode = (body.source_mode || "off").toLowerCase();
  const question = body.question || body.q || "";

  if (!question) return jsonError("Question is required", 400, corsHeaders);
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) return jsonError("OPENAI_API_KEY or VECTOR_STORE_ID not set", 500, corsHeaders);

  const evidence = await vectorSearch(env, question, 10);

  if (source_mode === "required" && evidence.length === 0) {
    return new Response(JSON.stringify({
      ok: true, verdict: "NOT_FOUND",
      answer: "Not found in protocol.", citations: [],
      applied_output: { output_mode, source_mode },
    }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
  }

  let answer = "", citations = [];

  if (evidence.length === 0) {
    answer = "No information found in available sources.";
  } else {
    const evidenceText = formatEvidenceText(evidence);
    switch (output_mode) {
      case "verbatim": {
        const quotes = evidence.slice(0, 3).map(e => {
          const s = e.excerpt.split(/[.!?]+/).filter(x => x.trim().length > 20);
          const q = s.length > 0 ? s[0].trim() + "." : e.excerpt.substring(0, 150);
          return `"${q}"\n— ${e.filename}${e.page ? ` (p. ${e.page})` : ""}`;
        });
        answer = quotes.join("\n\n");
        citations = buildCitations(evidence, 250);
        break;
      }
      case "short": {
        answer = await callGPT(env.OPENAI_API_KEY, {
          system: "You are a clinical pharmacist AI. Answer using ONLY the provided sources.\nReply with 3-6 bullet points starting with •. No preamble.",
          user: `Question: ${question}\n\nSources:\n${evidenceText}`,
          max_tokens: 350,
        }) || "• No concise answer available";
        if (source_mode === "required") citations = buildCitations(evidence, 150);
        break;
      }
      default: {
        answer = await callGPT(env.OPENAI_API_KEY, {
          system: `You are a clinical pharmacist AI. Use ONLY the provided protocol sources.
ANSWER: [2-4 sentence synthesized answer]
KEY EVIDENCE:
• [quote/paraphrase] — [filename, page]
Do not add information not in the sources.`,
          user: `Question: ${question}\n\nSources:\n${evidenceText}`,
          max_tokens: 700,
        }) || "No answer generated";
        citations = buildCitations(evidence, 250);
      }
    }
  }

  const responseBody = {
    ok: true,
    verdict: evidence.length > 0 ? "OK" : "NOT_FOUND",
    answer,
    applied_output: { output_mode, source_mode },
  };
  if (source_mode !== "off") responseBody.citations = citations;

  return new Response(JSON.stringify(responseBody), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// ============================================================
// MODE: MONOGRAPH
// ============================================================

async function handleMonograph(body, env, corsHeaders, language) {
  const { drug_name, patient_context } = body;
  if (!drug_name) return jsonError("drug_name is required", 400, corsHeaders);
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) return jsonError("Missing API credentials", 500, corsHeaders);

  const evidence = await vectorSearch(env, `${drug_name} dosing indications contraindications renal`, 8);
  const evidenceText = evidence.length > 0
    ? evidence.map(e => `[${e.id}] ${e.filename}${e.page ? ` p.${e.page}` : ""}\n${e.excerpt}`).join("\n\n---\n\n")
    : "No protocol data found for this drug.";

  const monograph = await callGPT(env.OPENAI_API_KEY, {
    system: "Clinical pharmacist generating drug monographs from protocol sources.",
    user: `Generate a clinical drug monograph for: ${drug_name}
${patient_context ? `\nPatient context: ${patient_context}` : ""}

Using ONLY the provided protocol sources, structure as:
## DRUG MONOGRAPH: ${drug_name.toUpperCase()}
### INDICATIONS
### DOSING
**Standard Dosing:**
**Renal Adjustment:**
| CrCl (mL/min) | Dose Adjustment |
|---|---|
### ADMINISTRATION
### CONTRAINDICATIONS & WARNINGS
### DRUG INTERACTIONS
### MONITORING PARAMETERS
### ADVERSE EFFECTS

PROTOCOL SOURCES:
${evidenceText}

If not found in sources, state "Not specified in protocol."`,
    max_tokens: 1200,
  });

  return new Response(JSON.stringify({
    ok: true, drug_name,
    monograph: monograph || "Could not generate monograph.",
    sources: evidence.map(e => ({ id: e.id, filename: e.filename, page: e.page, score: e.score, excerpt: e.excerpt.substring(0, 250) })),
  }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// ============================================================
// MODE: ANTIBIOGRAM
// ============================================================

async function handleAntibiogram(body, env, corsHeaders, language) {
  const { organism, site_of_infection, patient_context, antibiotic } = body;
  if (!organism && !antibiotic) return jsonError("organism or antibiotic is required", 400, corsHeaders);
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) return jsonError("Missing API credentials", 500, corsHeaders);

  const searchTerms = [organism, antibiotic, site_of_infection, "susceptibility resistance"].filter(Boolean).join(" ");
  const evidence = await vectorSearch(env, searchTerms, 8);

  const analysis = await callGPT(env.OPENAI_API_KEY, {
    system: "Infectious disease pharmacist, antimicrobial stewardship expert.",
    user: `Susceptibility analysis.
${organism ? `Organism: ${organism}` : ""}
${antibiotic ? `Antibiotic: ${antibiotic}` : ""}
${site_of_infection ? `Site: ${site_of_infection}` : ""}
${patient_context ? `Patient context: ${patient_context}` : ""}

## SUSCEPTIBILITY ANALYSIS
## EMPIRIC THERAPY RECOMMENDATIONS
**First-line:**
**Alternative:**
**If resistant:**
## PK/PD CONSIDERATIONS
## DURATION OF THERAPY
## RESISTANCE ALERTS

SOURCES:
${evidence.length > 0
  ? evidence.map(s => `[${s.id}] ${s.filename}${s.page ? ` p.${s.page}` : ""}\n${s.excerpt}`).join("\n\n---\n\n")
  : "No antibiogram data found."}`,
    max_tokens: 1000,
  });

  return new Response(JSON.stringify({
    ok: true, organism: organism || null, antibiotic: antibiotic || null,
    site_of_infection: site_of_infection || null,
    analysis: analysis || "Could not generate analysis.",
    sources: evidence.map(s => ({ id: s.id, filename: s.filename, page: s.page, score: s.score, excerpt: s.excerpt.substring(0, 250) })),
  }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// ============================================================
// SHARED HELPERS
// ============================================================

async function vectorSearch(env, query, maxResults = 10) {
  const r = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ query, max_num_results: maxResults }),
  });
  if (!r.ok) return [];

  const data = await r.json();
  const evidence = [];

  (data.data || []).forEach((item, i) => {
    let content = "";
    const filename =
      item.attributes?.filename || item.attributes?.file_name ||
      item.filename || item.file_name || item.file_id || `source_${i + 1}`;

    if (item.content) {
      if (Array.isArray(item.content)) content = item.content.map(c => c.text || c.value || "").join("\n");
      else if (typeof item.content === "string") content = item.content;
      else if (item.content.text) content = item.content.text;
    }
    if (!content && item.text) content = item.text;
    if (!content && item.chunks) content = item.chunks.map(c => c.text || "").join("\n");
    if (!content?.trim()) return;

    let page = 0;
    const pm = content.match(/(?:Page|PAGE|page)\s*[:\-]?\s*(\d+)/i);
    if (pm) page = parseInt(pm[1]);
    if (!page && item.attributes?.page) page = parseInt(item.attributes.page) || 0;

    let section = "";
    const sm = content.match(/(?:Section|SECTION)\s+(\d+(?:\.\d+)*)\s*[–—\-]?\s*([^\n]+)/i);
    if (sm) section = (sm[2] || sm[1]).trim().substring(0, 80);

    evidence.push({
      id: `E${i + 1}`, filename, page, section,
      score: item.score ?? item.similarity ?? null,
      excerpt: content.substring(0, 2000),
    });
  });
  return evidence;
}

function formatEvidenceText(ev) {
  return ev.map(e =>
    `[SOURCE ${e.id}] File: ${e.filename}${e.page ? ` | Page: ${e.page}` : ""}${e.section ? ` | Section: ${e.section}` : ""}\nContent: ${e.excerpt}`
  ).join("\n\n---\n\n");
}

function buildCitations(ev, len = 250) {
  return ev.map(e => ({
    evidence_ids: [e.id], filename: e.filename,
    section: e.section || "", page: e.page || 0,
    score: e.score, excerpt: e.excerpt.substring(0, len),
  }));
}

async function callGPT(apiKey, { system, user, max_tokens = 600 }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2,
      max_tokens,
    }),
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content || null;
}

function jsonError(msg, status, headers) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });
}
