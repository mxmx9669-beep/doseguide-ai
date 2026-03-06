// File: /functions/api/ask.js
// TheraGuard AI — General Clinical Audit Engine
// Visible output only: SOAP + Interventions + Adjustments + Citations

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
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
  }

  try {
    const body = await request.json();
    const mode = (body.mode || "ask").toLowerCase();
    const language = (body.language || "en").toLowerCase();

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
    return jsonResponse(
      {
        ok: false,
        error: error?.message || "Internal server error",
      },
      500,
      corsHeaders
    );
  }
}

/* =========================================================
   CONFIG
========================================================= */

const LAB_RANGES = {
  // CBC
  hb:         { label: "Hb", unit: "g/dL", low: 12, high: 17.5, section: "cbc", drugRelated: ["anticoagulants", "iron", "ESA"] },
  wbc:        { label: "WBC", unit: "×10⁹/L", low: 4, high: 11, section: "cbc", drugRelated: ["antibiotics", "immunosuppressants"] },
  plt:        { label: "Platelets", unit: "×10⁹/L", low: 150, high: 400, section: "cbc", drugRelated: ["anticoagulants", "heparin", "antiplatelet"] },
  neutrophil: { label: "Neutrophils", unit: "×10⁹/L", low: 1.8, high: 7.5, section: "cbc", drugRelated: ["G-CSF", "immunosuppressants"] },

  // Renal
  scr_umol:   { label: "SCr", unit: "µmol/L", low: null, high: 106, section: "renal", drugRelated: ["renal dosing", "nephrotoxins"] },
  scr_mgdl:   { label: "SCr", unit: "mg/dL", low: null, high: 1.2, section: "renal", drugRelated: ["renal dosing", "nephrotoxins"] },
  urea:       { label: "Urea", unit: "mmol/L", low: null, high: 7.1, section: "renal", drugRelated: [] },
  bun:        { label: "BUN", unit: "mmol/L", low: null, high: 7.1, section: "renal", drugRelated: [] },

  // Electrolytes
  na:         { label: "Na", unit: "mmol/L", low: 136, high: 145, section: "electrolytes", drugRelated: ["IV fluids", "diuretics"] },
  k:          { label: "K", unit: "mmol/L", low: 3.5, high: 5.0, section: "electrolytes", drugRelated: ["diuretics", "ACEi/ARB", "insulin", "antiarrhythmics"] },
  cl:         { label: "Cl", unit: "mmol/L", low: 98, high: 107, section: "electrolytes", drugRelated: [] },
  bicarb:     { label: "HCO3", unit: "mmol/L", low: 22, high: 29, section: "electrolytes", drugRelated: ["diuretics"] },
  ca:         { label: "Ca", unit: "mmol/L", low: 2.12, high: 2.62, section: "electrolytes", drugRelated: ["calcium therapy", "digoxin"] },
  mg:         { label: "Mg", unit: "mmol/L", low: 0.74, high: 1.03, section: "electrolytes", drugRelated: ["aminoglycosides", "diuretics", "PPIs"] },
  phos:       { label: "Phos", unit: "mmol/L", low: 0.81, high: 1.45, section: "electrolytes", drugRelated: ["phosphate binders"] },

  // Liver
  alt:        { label: "ALT", unit: "U/L", low: null, high: 56, section: "liver", drugRelated: ["hepatotoxic drugs", "paracetamol", "statins"] },
  ast:        { label: "AST", unit: "U/L", low: null, high: 40, section: "liver", drugRelated: ["hepatotoxic drugs", "statins"] },
  alp:        { label: "ALP", unit: "U/L", low: null, high: 120, section: "liver", drugRelated: [] },
  bili_t:     { label: "Total Bilirubin", unit: "µmol/L", low: null, high: 21, section: "liver", drugRelated: ["hepatotoxic drugs"] },
  albumin:    { label: "Albumin", unit: "g/L", low: 35, high: 50, section: "liver", drugRelated: ["warfarin", "phenytoin", "protein binding"] },

  // Coagulation
  inr:        { label: "INR", unit: "", low: null, high: 1.2, section: "coagulation", drugRelated: ["warfarin", "bleeding risk"] },
  pt:         { label: "PT", unit: "sec", low: null, high: 13.5, section: "coagulation", drugRelated: ["warfarin"] },
  aptt:       { label: "aPTT", unit: "sec", low: null, high: 35, section: "coagulation", drugRelated: ["heparin"] },
  fibrinogen: { label: "Fibrinogen", unit: "g/L", low: 2, high: 4, section: "coagulation", drugRelated: [] },

  // Infection / Sepsis
  crp:        { label: "CRP", unit: "mg/L", low: null, high: 10, section: "infection", drugRelated: ["antibiotics"] },
  procalc:    { label: "PCT", unit: "µg/L", low: null, high: 0.5, section: "infection", drugRelated: ["antibiotics"] },
  lactate:    { label: "Lactate", unit: "mmol/L", low: null, high: 2.0, section: "infection", drugRelated: ["sepsis", "metformin"] },

  // Glucose / metabolic
  glucose:    { label: "Glucose", unit: "mmol/L", low: 3.9, high: 7.8, section: "metabolic", drugRelated: ["insulin", "steroids"] },

  // TDM
  vanc_trough:{ label: "Vancomycin Trough", unit: "mg/L", low: 10, high: 20, section: "tdm", drugRelated: ["vancomycin"] },
  vanc_auc:   { label: "Vancomycin AUC", unit: "mg·h/L", low: 400, high: 600, section: "tdm", drugRelated: ["vancomycin"] },
  genta_trough:{ label: "Gentamicin Trough", unit: "mg/L", low: null, high: 2, section: "tdm", drugRelated: ["gentamicin"] },
  tobra_trough:{ label: "Tobramycin Trough", unit: "mg/L", low: null, high: 2, section: "tdm", drugRelated: ["tobramycin"] },
  digoxin:    { label: "Digoxin", unit: "µg/L", low: 0.5, high: 2, section: "tdm", drugRelated: ["digoxin"] },
  phenytoin:  { label: "Phenytoin", unit: "mg/L", low: 10, high: 20, section: "tdm", drugRelated: ["phenytoin"] },
  valproate:  { label: "Valproate", unit: "mg/L", low: 50, high: 100, section: "tdm", drugRelated: ["valproate"] },
  tacro:      { label: "Tacrolimus", unit: "µg/L", low: 5, high: 15, section: "tdm", drugRelated: ["tacrolimus"] },
  cyclo:      { label: "Cyclosporine", unit: "µg/L", low: 100, high: 400, section: "tdm", drugRelated: ["cyclosporine"] },
};

const BORDERLINE_MARGIN = 0.15;

const LAB_SECTION_ORDER = [
  "renal",
  "cbc",
  "electrolytes",
  "liver",
  "coagulation",
  "infection",
  "metabolic",
  "tdm",
];

const SECTION_TITLES = {
  renal: "Renal",
  cbc: "CBC",
  electrolytes: "Electrolytes",
  liver: "Liver Function",
  coagulation: "Coagulation",
  infection: "Infection / Sepsis Profile",
  metabolic: "Glucose / Metabolic",
  tdm: "Drug Monitoring / TDM",
};

/* =========================================================
   MAIN MODES
========================================================= */

async function handleAsk(body, env, corsHeaders, language) {
  const question = body.question || body.q || "";
  const output_mode = (body.output_mode || "hybrid").toLowerCase();
  const source_mode = (body.source_mode || "off").toLowerCase();

  if (!question) {
    return jsonResponse({ ok: false, error: "Question is required" }, 400, corsHeaders);
  }

  requireApiCredentials(env);

  const evidence = await vectorSearch(env, question, 10);

  if (source_mode === "required" && evidence.length === 0) {
    return jsonResponse(
      {
        ok: true,
        verdict: "NOT_FOUND",
        answer: language === "ar" ? "لم يتم العثور على إجابة في البروتوكول." : "Not found in protocol.",
        citations: [],
        applied_output: { output_mode, source_mode },
      },
      200,
      corsHeaders
    );
  }

  if (evidence.length === 0) {
    return jsonResponse(
      {
        ok: true,
        verdict: "NOT_FOUND",
        answer: language === "ar" ? "لا توجد معلومات في المصادر المتاحة." : "No information found in available sources.",
        citations: source_mode === "off" ? undefined : [],
        applied_output: { output_mode, source_mode },
      },
      200,
      corsHeaders
    );
  }

  const evidenceText = formatEvidenceText(evidence);

  let answer = "";
  if (output_mode === "verbatim") {
    answer = buildVerbatimAnswer(evidence);
  } else if (output_mode === "short") {
    answer =
      (await callGPT(env.OPENAI_API_KEY, {
        system:
          "You are a clinical pharmacist AI. Answer using ONLY the provided sources. Return 3-6 concise bullet points, each beginning with • . No preamble.",
        user: `Question: ${question}\n\nSources:\n${evidenceText}`,
        max_tokens: 350,
      })) || "• No concise answer available";
  } else {
    answer =
      (await callGPT(env.OPENAI_API_KEY, {
        system:
          "You are a clinical pharmacist AI. Use ONLY the provided sources.\nFormat:\nANSWER: [2-4 sentence answer]\n\nKEY EVIDENCE:\n• ... — [filename, page if available]\nDo not add unsupported information.",
        user: `Question: ${question}\n\nSources:\n${evidenceText}`,
        max_tokens: 700,
      })) || "No answer generated.";
  }

  const response = {
    ok: true,
    verdict: "OK",
    answer,
    applied_output: { output_mode, source_mode },
  };

  if (source_mode !== "off") {
    response.citations = buildCitations(evidence, 250);
  }

  return jsonResponse(response, 200, corsHeaders);
}

async function handleMonograph(body, env, corsHeaders, language) {
  const drug_name = body.drug_name || body.drug || "";
  const patient_context = body.patient_context || "";

  if (!drug_name) {
    return jsonResponse({ ok: false, error: "drug_name is required" }, 400, corsHeaders);
  }

  requireApiCredentials(env);

  const evidence = await vectorSearch(env, `${drug_name} dosing indications renal warnings contraindications`, 8);
  const evidenceText = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";

  const monograph =
    (await callGPT(env.OPENAI_API_KEY, {
      system: "You are a clinical pharmacist generating a concise protocol-based monograph.",
      user: `Generate a concise clinical monograph for ${drug_name}.
${patient_context ? `Patient context: ${patient_context}\n` : ""}
Use ONLY the provided sources.
Structure:
## Drug
## Key Indications
## Standard Dosing
## Renal Adjustment
## Major Warnings / Contraindications
## Monitoring
## Important Notes

Sources:
${evidenceText}`,
      max_tokens: 900,
    })) || "Could not generate monograph.";

  return jsonResponse(
    {
      ok: true,
      drug_name,
      monograph,
      citations: buildCitations(evidence, 220),
    },
    200,
    corsHeaders
  );
}

async function handleAntibiogram(body, env, corsHeaders, language) {
  const organism = body.organism || "";
  const antibiotic = body.antibiotic || "";
  const site_of_infection = body.site_of_infection || "";
  const patient_context = body.patient_context || "";

  if (!organism && !antibiotic) {
    return jsonResponse({ ok: false, error: "organism or antibiotic is required" }, 400, corsHeaders);
  }

  requireApiCredentials(env);

  const query = [organism, antibiotic, site_of_infection, "susceptibility resistance empiric therapy"].filter(Boolean).join(" ");
  const evidence = await vectorSearch(env, query, 8);
  const evidenceText = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";

  const analysis =
    (await callGPT(env.OPENAI_API_KEY, {
      system: "You are an infectious disease pharmacist. Use only provided sources.",
      user: `Provide a concise susceptibility-style interpretation.

Organism: ${organism || "N/A"}
Antibiotic: ${antibiotic || "N/A"}
Site: ${site_of_infection || "N/A"}
Patient context: ${patient_context || "N/A"}

Format:
## Interpretation
## Empiric / Targeted Considerations
## Key Risks / Notes

Sources:
${evidenceText}`,
      max_tokens: 900,
    })) || "Could not generate antibiogram analysis.";

  return jsonResponse(
    {
      ok: true,
      organism: organism || null,
      antibiotic: antibiotic || null,
      site_of_infection: site_of_infection || null,
      analysis,
      citations: buildCitations(evidence, 220),
    },
    200,
    corsHeaders
  );
}

async function handleCaseAnalysis(body, env, corsHeaders, language) {
  const case_text = body.case_text || "";
  const question = body.question || "";

  if (!case_text) {
    return jsonResponse({ ok: false, error: "case_text is required" }, 400, corsHeaders);
  }

  requireApiCredentials(env);

  // 1) Structured extraction
  const extracted = await extractCaseJson(env, case_text);

  // 2) Normalize + metrics
  const normalized = normalizeExtractedCase(extracted);
  const classifiedLabs = classifyLabs(normalized.labs || {});
  const crcl = calcCrCl(
    normalized.age,
    normalized.weight_kg,
    normalized.labs?.scr_umol || (normalized.labs?.scr_mgdl ? normalized.labs.scr_mgdl * 88.42 : null),
    normalized.sex
  );

  // 3) Search evidence with patient context
  const searchSeed = buildCaseSearchSeed(normalized, case_text, question);
  const evidence = await vectorSearch(env, searchSeed, 10);

  // 4) Hidden clinical reasoning
  const hiddenReasoning = await runHiddenClinicalReasoning({
    env,
    normalized,
    classifiedLabs,
    crcl,
    evidence,
    question,
    language,
  });

  // 5) Visible outputs only
  const soapNote = buildSoapNote({
    patient: normalized,
    classifiedLabs,
    crcl,
    assessment: hiddenReasoning.assessment,
    interventionsSummary: hiddenReasoning.interventions_summary,
    followupPlan: hiddenReasoning.followup_plan,
  });

  const response = {
    ok: true,
    soap_note: soapNote,
    pharmacist_interventions: hiddenReasoning.interventions || [],
    medication_adjustments: hiddenReasoning.medication_adjustments || [],
    citations: buildCitations(evidence, 250),
  };

  return jsonResponse(response, 200, corsHeaders);
}

/* =========================================================
   CASE ANALYSIS CORE
========================================================= */

async function extractCaseJson(env, caseText) {
  const prompt = `Extract structured patient data from the case below.
Return ONLY valid JSON with no markdown and no extra commentary.

Case:
${caseText}

Return exactly this schema:
{
  "mrn": null,
  "patient_name": null,
  "age": null,
  "sex": null,
  "weight_kg": null,
  "height_cm": null,
  "care_setting": null,
  "reason_admission": null,
  "pmh": null,
  "home_medications": null,
  "diagnosis": null,
  "allergies": [],
  "vitals": {
    "bp": null,
    "hr": null,
    "rr": null,
    "temp": null,
    "spo2": null,
    "gcs": null
  },
  "labs": {
    "hb": null,
    "wbc": null,
    "plt": null,
    "neutrophil": null,
    "scr_umol": null,
    "scr_mgdl": null,
    "urea": null,
    "bun": null,
    "na": null,
    "k": null,
    "cl": null,
    "bicarb": null,
    "ca": null,
    "mg": null,
    "phos": null,
    "alt": null,
    "ast": null,
    "alp": null,
    "bili_t": null,
    "albumin": null,
    "inr": null,
    "pt": null,
    "aptt": null,
    "fibrinogen": null,
    "glucose": null,
    "crp": null,
    "procalc": null,
    "lactate": null,
    "vanc_trough": null,
    "vanc_auc": null,
    "genta_trough": null,
    "tobra_trough": null,
    "digoxin": null,
    "phenytoin": null,
    "valproate": null,
    "tacro": null,
    "cyclo": null
  },
  "medications": [
    {
      "name": "",
      "dose": "",
      "route": "",
      "frequency": "",
      "indication": null
    }
  ]
}`;

  try {
    const raw = await callGPT(env.OPENAI_API_KEY, {
      system: "You extract clinical case data. Return only valid JSON.",
      user: prompt,
      max_tokens: 1200,
    });

    if (!raw) return emptyExtractedCase();
    return JSON.parse(stripCodeFences(raw));
  } catch (e) {
    console.error("extractCaseJson error:", e);
    return emptyExtractedCase();
  }
}

function normalizeExtractedCase(extracted) {
  const base = emptyExtractedCase();
  const merged = {
    ...base,
    ...extracted,
    vitals: { ...base.vitals, ...(extracted?.vitals || {}) },
    labs: { ...base.labs, ...(extracted?.labs || {}) },
    medications: Array.isArray(extracted?.medications) ? extracted.medications : [],
    allergies: Array.isArray(extracted?.allergies) ? extracted.allergies : [],
  };

  merged.age = toNumberOrNull(merged.age);
  merged.weight_kg = toNumberOrNull(merged.weight_kg);
  merged.height_cm = toNumberOrNull(merged.height_cm);

  for (const key of Object.keys(merged.labs)) {
    merged.labs[key] = toNumberOrNull(merged.labs[key]);
  }

  return merged;
}

function classifyLabs(labs) {
  const out = [];
  for (const [key, value] of Object.entries(labs || {})) {
    if (value === null || value === undefined || value === "") continue;
    const ref = LAB_RANGES[key];
    if (!ref) continue;
    const num = Number(value);
    if (Number.isNaN(num)) continue;

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

    out.push({
      key,
      label: ref.label,
      value: num,
      unit: ref.unit,
      section: ref.section,
      status,
      arrow,
      isAbnormal: status === "high" || status === "low",
      isBorderline: status === "borderline-high" || status === "borderline-low",
      drugRelated: ref.drugRelated || [],
      isDrugRelevant: Array.isArray(ref.drugRelated) && ref.drugRelated.length > 0,
    });
  }

  return out.sort((a, b) => {
    const severityRank = (x) => (x.isAbnormal ? 0 : x.isBorderline ? 1 : 2);
    const sectionRank = LAB_SECTION_ORDER.indexOf(xSafe(a.section));
    const sectionRankB = LAB_SECTION_ORDER.indexOf(xSafe(b.section));
    if (severityRank(a) !== severityRank(b)) return severityRank(a) - severityRank(b);
    if (sectionRank !== sectionRankB) return sectionRank - sectionRankB;
    return a.label.localeCompare(b.label);
  });
}

async function runHiddenClinicalReasoning({ env, normalized, classifiedLabs, crcl, evidence, question, language }) {
  const medsText =
    (normalized.medications || []).map(m => `${m.name || ""} ${m.dose || ""} ${m.route || ""} ${m.frequency || ""}`.trim()).join(" | ") || "None documented";

  const labSummary =
    classifiedLabs.map(l => `${l.label} ${l.value}${l.unit ? ` ${l.unit}` : ""} ${l.arrow}`.trim()).join(", ") || "No significant labs available";

  const evidenceText = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";

  const prompt = `You are a senior clinical pharmacist performing a hidden internal medication audit.
DO NOT reveal chain-of-thought.
Return ONLY valid JSON.

Patient summary:
- Name: ${normalized.patient_name || "N/A"}
- Age: ${normalized.age || "N/A"}
- Sex: ${normalized.sex || "N/A"}
- Weight: ${normalized.weight_kg || "N/A"} kg
- Care setting: ${normalized.care_setting || "N/A"}
- Diagnosis: ${normalized.diagnosis || "N/A"}
- Reason for admission: ${normalized.reason_admission || "N/A"}
- Allergies: ${(normalized.allergies || []).join(", ") || "None documented"}
- PMH: ${normalized.pmh || "N/A"}
- Home meds: ${normalized.home_medications || "N/A"}
- Current medications: ${medsText}
- CrCl: ${crcl ? `${crcl.value} mL/min (${crcl.category})` : "Unable to calculate"}
- Relevant labs: ${labSummary}
${question ? `- Clinician question: ${question}` : ""}

Use ONLY the provided sources for protocol-supported recommendations when available.
If direct protocol support is not found, say "Not clearly specified in available protocol" in the reference/reason field rather than inventing evidence.

Sources:
${evidenceText}

Return exactly this JSON:
{
  "assessment": "2-4 sentence concise clinical pharmacist assessment",
  "interventions_summary": "1-2 sentence concise summary",
  "followup_plan": "short follow-up plan",
  "interventions": [
    {
      "severity": "Critical|Major|Moderate|Minor",
      "problem": "short problem statement",
      "recommendation": "clear action",
      "reference": "filename and page if available, or Not clearly specified in available protocol"
    }
  ],
  "medication_adjustments": [
    {
      "drug": "name",
      "ordered": "current order",
      "recommended": "recommended action or corrected order",
      "verdict": "CORRECT|ADJUST|STOP|MONITOR|NOT_IN_PROTOCOL",
      "reason": "brief explanation",
      "reference": "filename and page if available, or Not clearly specified in available protocol"
    }
  ]
}`;

  try {
    const raw = await callGPT(env.OPENAI_API_KEY, {
      system: "You are a clinical pharmacist. Return only valid JSON with no markdown.",
      user: prompt,
      max_tokens: 1600,
    });

    const parsed = JSON.parse(stripCodeFences(raw || "{}"));

    return {
      assessment: parsed.assessment || "Clinical pharmacist review performed.",
      interventions_summary: parsed.interventions_summary || "Medication review completed.",
      followup_plan: parsed.followup_plan || "Follow-up as clinically indicated.",
      interventions: Array.isArray(parsed.interventions) ? parsed.interventions : [],
      medication_adjustments: Array.isArray(parsed.medication_adjustments) ? parsed.medication_adjustments : [],
    };
  } catch (e) {
    console.error("runHiddenClinicalReasoning error:", e);
    return {
      assessment: "Clinical pharmacist review performed based on available patient data and sources.",
      interventions_summary: "Please review medication appropriateness, dosing, and monitoring based on the available case details.",
      followup_plan: "Reassess medications, renal function, and clinical response.",
      interventions: [],
      medication_adjustments: [],
    };
  }
}

function buildSoapNote({ patient, classifiedLabs, crcl, assessment, interventionsSummary, followupPlan }) {
  const carePlace = patient.care_setting || "ICU";
  const weightStr = patient.weight_kg != null ? `${patient.weight_kg} kg` : "— kg";
  const ageStr = patient.age != null ? `${patient.age}Y` : "Y";
  const mrnStr = patient.mrn || "";
  const reason = patient.reason_admission || "N/A";
  const pmh = patient.pmh || "N/A";
  const homeMeds = patient.home_medications || "N/A";

  const vitalsLines = buildVitalsLines(patient.vitals || {});
  const labsBlock = buildClassifiedLabsBlock(classifiedLabs, crcl);

  const currentMeds = Array.isArray(patient.medications) && patient.medications.length
    ? patient.medications.map(m => {
        const parts = [m.name, m.dose, m.route, m.frequency].filter(Boolean);
        return `- ${parts.join(" ").replace(/\s+/g, " ").trim()}`;
      }).join("\n")
    : "- No medications started";

  return [
    `S:`,
    `Patient (MRN: ${mrnStr}), ${ageStr}, ${weightStr} admitted to ${carePlace}.`,
    `Reason for Admission: ${reason}`,
    `PMH: ${pmh}`,
    `Home Meds: ${homeMeds}`,
    ``,
    `O:`,
    `Vitals:`,
    vitalsLines || `- Within normal limits`,
    ``,
    `Labs:`,
    labsBlock,
    ``,
    `A:`,
    assessment || `Primary admission for acute issues. Clinical review performed.`,
    ``,
    `P:`,
    `Current Medications:`,
    currentMeds,
    ``,
    `Pharmacist Intervention:`,
    interventionsSummary || `Patient reviewed; no interventions at this time.`,
    ``,
    `Follow-up Plan:`,
    `- Follow-up: ${followupPlan || "OK."}`,
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildVitalsLines(vitals) {
  const out = [];
  if (vitals.bp) out.push(`- BP: ${vitals.bp}`);
  if (vitals.hr != null) out.push(`- HR: ${vitals.hr}`);
  if (vitals.rr != null) out.push(`- RR: ${vitals.rr}`);
  if (vitals.temp != null) out.push(`- Temp: ${vitals.temp}`);
  if (vitals.spo2 != null) out.push(`- SpO2: ${vitals.spo2}`);
  if (vitals.gcs != null) out.push(`- GCS: ${vitals.gcs}`);
  return out.join("\n");
}

function buildClassifiedLabsBlock(classifiedLabs, crcl) {
  if (!classifiedLabs.length && !crcl) {
    return `- No clinically significant abnormalities detected.`;
  }

  const bySection = {};
  for (const sec of LAB_SECTION_ORDER) bySection[sec] = [];

  for (const lab of classifiedLabs) {
    const include =
      lab.isAbnormal ||
      lab.isBorderline ||
      lab.isDrugRelevant ||
      lab.section === "renal";

    if (!include) continue;
    if (!bySection[lab.section]) bySection[lab.section] = [];
    bySection[lab.section].push(lab);
  }

  const blocks = [];

  // Force renal block if CrCl exists
  if (crcl || (bySection.renal && bySection.renal.length)) {
    const renalLines = [];
    const scr = (bySection.renal || []).find(x => x.key === "scr_umol" || x.key === "scr_mgdl");
    if (scr) renalLines.push(`- ${scr.label}: ${scr.value} ${scr.unit}${scr.arrow ? ` ${scr.arrow}` : ""}`);
    const urea = (bySection.renal || []).find(x => x.key === "urea" || x.key === "bun");
    if (urea) renalLines.push(`- ${urea.label}: ${urea.value} ${urea.unit}${urea.arrow ? ` ${urea.arrow}` : ""}`);
    if (crcl) renalLines.push(`- Calculated CrCl: ${crcl.value} mL/min (${crcl.category})`);
    if (!renalLines.length) renalLines.push(`- Calculated CrCl: ${crcl ? `${crcl.value} mL/min (${crcl.category})` : "—"}`);
    blocks.push(`Renal:\n${renalLines.join("\n")}`);
  }

  for (const section of LAB_SECTION_ORDER.filter(s => s !== "renal")) {
    const lines = (bySection[section] || []).map(l => {
      const monitorNote = l.isDrugRelevant ? ` [drug-relevant]` : "";
      return `- ${l.label}: ${l.value} ${l.unit}${l.arrow ? ` ${l.arrow}` : ""}${monitorNote}`;
    });
    if (lines.length) {
      blocks.push(`${SECTION_TITLES[section]}:\n${lines.join("\n")}`);
    }
  }

  return blocks.length ? blocks.join("\n\n") : `- No clinically significant abnormalities detected.`;
}

/* =========================================================
   VECTOR SEARCH + CITATIONS
========================================================= */

async function vectorSearch(env, query, maxResults = 10) {
  const res = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      query,
      max_num_results: maxResults,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("vectorSearch failed:", txt);
    return [];
  }

  const data = await res.json();
  const evidence = [];

  for (let i = 0; i < (data.data || []).length; i++) {
    const item = data.data[i];
    let content = "";

    const filename =
      item.attributes?.filename ||
      item.attributes?.file_name ||
      item.filename ||
      item.file_name ||
      item.file_id ||
      `source_${i + 1}`;

    if (item.content) {
      if (Array.isArray(item.content)) {
        content = item.content.map(c => c.text || c.value || "").join("\n");
      } else if (typeof item.content === "string") {
        content = item.content;
      } else if (item.content?.text) {
        content = item.content.text;
      }
    }
    if (!content && item.text) content = item.text;
    if (!content && Array.isArray(item.chunks)) content = item.chunks.map(c => c.text || "").join("\n");
    if (!content || !content.trim()) continue;

    let page = 0;
    const pm =
      content.match(/(?:Page|PAGE|page)\s*[:\-]?\s*(\d+)/i) ||
      content.match(/\bp\.?\s*(\d+)\b/i) ||
      content.match(/\[p\.\s*(\d+)\]/i);
    if (pm) page = parseInt(pm[1], 10);
    if (!page && item.attributes?.page) page = parseInt(item.attributes.page, 10) || 0;
    if (!page && item.metadata?.page) page = parseInt(item.metadata.page, 10) || 0;

    let section = "";
    const sm =
      content.match(/(?:Section|SECTION)\s+(\d+(?:\.\d+)*)\s*[–—\-]?\s*([^\n]+)/i) ||
      content.match(/^#{1,3}\s+([^\n]+)/m) ||
      content.match(/^\d+\.\d+\s+([^\n]+)/m);
    if (sm) section = (sm[2] || sm[1] || "").trim().substring(0, 80);

    evidence.push({
      id: `E${i + 1}`,
      filename,
      page,
      section,
      score: item.score ?? item.similarity ?? null,
      excerpt: content.substring(0, 2000),
    });
  }

  return evidence;
}

function formatEvidenceText(evidence) {
  return evidence
    .map(
      e =>
        `[SOURCE ${e.id}] File: ${e.filename}${e.page ? ` | Page: ${e.page}` : ""}${e.section ? ` | Section: ${e.section}` : ""}\nContent: ${e.excerpt}`
    )
    .join("\n\n---\n\n");
}

function buildCitations(evidence, excerptLen = 250) {
  return evidence.map(e => ({
    evidence_ids: [e.id],
    filename: e.filename,
    section: e.section || "",
    page: e.page || 0,
    score: e.score,
    excerpt: e.excerpt.substring(0, excerptLen),
  }));
}

function buildVerbatimAnswer(evidence) {
  return evidence.slice(0, 3).map(e => {
    const sentences = e.excerpt.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
    const first = sentences.find(s => s.length > 20) || e.excerpt.substring(0, 150);
    return `"${first.endsWith(".") ? first : `${first}.`}"\n— ${e.filename}${e.page ? ` (p. ${e.page})` : ""}`;
  }).join("\n\n");
}

/* =========================================================
   GPT HELPER
========================================================= */

async function callGPT(apiKey, { system, user, max_tokens = 600 }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || null;
}

/* =========================================================
   CALCULATORS + UTILS
========================================================= */

function calcCrCl(age, weightKg, scrUmol, sex) {
  if (!age || !weightKg || !scrUmol || !sex) return null;
  const scrMgDl = scrUmol / 88.42;
  const sexFactor = String(sex).toLowerCase().startsWith("f") ? 0.85 : 1;
  const value = ((140 - age) * weightKg * sexFactor) / (72 * scrMgDl);
  const rounded = Math.round(value * 10) / 10;

  let category = "Unknown";
  if (rounded >= 90) category = "Normal (≥90)";
  else if (rounded >= 60) category = "Mild impairment (60–89)";
  else if (rounded >= 30) category = "Moderate impairment (30–59)";
  else if (rounded >= 15) category = "Severe impairment (15–29)";
  else category = "Kidney failure (<15)";

  return { value: rounded, category };
}

function buildCaseSearchSeed(normalized, caseText, question) {
  const meds = (normalized.medications || []).map(m => m.name).filter(Boolean).join(" ");
  const diagnosis = normalized.diagnosis || "";
  const allergies = (normalized.allergies || []).join(" ");
  return [diagnosis, meds, allergies, question, caseText.substring(0, 300)].filter(Boolean).join(" ");
}

function emptyExtractedCase() {
  return {
    mrn: null,
    patient_name: null,
    age: null,
    sex: null,
    weight_kg: null,
    height_cm: null,
    care_setting: null,
    reason_admission: null,
    pmh: null,
    home_medications: null,
    diagnosis: null,
    allergies: [],
    vitals: {
      bp: null,
      hr: null,
      rr: null,
      temp: null,
      spo2: null,
      gcs: null,
    },
    labs: {
      hb: null,
      wbc: null,
      plt: null,
      neutrophil: null,
      scr_umol: null,
      scr_mgdl: null,
      urea: null,
      bun: null,
      na: null,
      k: null,
      cl: null,
      bicarb: null,
      ca: null,
      mg: null,
      phos: null,
      alt: null,
      ast: null,
      alp: null,
      bili_t: null,
      albumin: null,
      inr: null,
      pt: null,
      aptt: null,
      fibrinogen: null,
      glucose: null,
      crp: null,
      procalc: null,
      lactate: null,
      vanc_trough: null,
      vanc_auc: null,
      genta_trough: null,
      tobra_trough: null,
      digoxin: null,
      phenytoin: null,
      valproate: null,
      tacro: null,
      cyclo: null,
    },
    medications: [],
  };
}

function requireApiCredentials(env) {
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
    throw new Error("OPENAI_API_KEY or VECTOR_STORE_ID is not set");
  }
}

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function stripCodeFences(text) {
  return String(text || "").replace(/```json|```/gi, "").trim();
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function xSafe(v) {
  return v || "";
}
