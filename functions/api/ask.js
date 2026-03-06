/**
 * /functions/api/ask.js
 * Clinical Medication Audit Engine — Backend
 * Protocol-aware, general-purpose clinical decision support
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-5";

// ─────────────────────────────────────────────────────────────
// CORS + Request Handling
// ─────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return corsResponse(new Response(null, { status: 204 }));
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();
    const mode = body.mode || "case_analysis";

    let result;
    switch (mode) {
      case "case_analysis":
        result = await handleCaseAnalysis(body, env);
        break;
      case "ask":
        result = await handleAsk(body, env);
        break;
      case "monograph":
        result = await handleMonograph(body, env);
        break;
      case "antibiogram":
        result = await handleAntibiogram(body, env);
        break;
      default:
        result = await handleCaseAnalysis(body, env);
    }

    return corsResponse(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  } catch (err) {
    console.error("Engine error:", err);
    return corsResponse(
      new Response(
        JSON.stringify({ error: "Clinical engine error", details: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    );
  }
}

function corsResponse(response) {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return r;
}

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT — INTERNAL REASONING ENGINE
// The model reasons fully here; output is structured JSON only
// ─────────────────────────────────────────────────────────────
function buildCaseAnalysisSystemPrompt() {
  return `You are a senior clinical pharmacist reviewer embedded in a hospital-grade clinical decision support engine.

Your task is to perform a complete, expert-level pharmaceutical and clinical review of the patient case provided. You must reason deeply and comprehensively INTERNALLY, then produce ONLY structured JSON output.

════════════════════════════════════════════════════════
INTERNAL REASONING LAYERS (hidden — not exposed to user)
════════════════════════════════════════════════════════

Layer 1 — Patient Data Extraction & Normalization
- Extract: age, sex, weight, height, MRN, care setting (ICU/ward/outpatient), reason for admission
- Extract all labs, vitals, cultures, allergies, PMH, home meds, current orders
- Normalize units (convert mg/dL ↔ µmol/L, mmHg, etc.)
- Calculate CrCl using Cockcroft-Gault (use ideal body weight if obese, adjusted BW if needed)
- Classify renal function: Normal (>90), Mild (60–89), Moderate (30–59), Severe (15–29), ESRD (<15), RRT
- Classify hepatic function using available data (Child-Pugh if possible)
- Classify labs into: CBC, Renal, Electrolytes, LFT, Coagulation, Infection/Sepsis, Glucose/Metabolic, TDM

Layer 2 — Problem / Disease Identification
- Identify all active problems and diagnoses from text
- Determine severity and acuity of each problem
- Map expected guideline-based pharmacotherapy for each problem
- Flag problems that are untreated or undertreated
- Flag problems needing prophylaxis (DVT, GI, etc.)

Layer 3 — Medication Audit (per drug)
For EACH medication order, internally assess:
- Drug name and class
- Indication (matched or unmatched)
- Ordered dose vs standard dose range
- Dose appropriateness for indication
- Renal dose adjustment needed?
- Hepatic dose adjustment needed?
- Weight-based appropriateness
- Route appropriateness
- Frequency appropriateness
- Duration appropriateness
- Contraindications present?
- Drug-drug interactions (clinically significant only)
- Allergy conflicts
- Duplication of therapy
- Monitoring requirements (levels, labs, ECG, etc.)
- Prophylaxis vs treatment mismatch

Layer 4 — Disease–Drug Gap Analysis
- Compare ordered medications against expected therapy for each problem
- Detect: missing therapy, wrong drug, wrong dose, wrong route, wrong frequency, wrong duration
- Flag overtreatment and undertreatment
- Flag prophylaxis written as treatment and vice versa

Layer 5 — Safety & Risk Assessment
- QT prolongation risk (list QT drugs, cumulative risk)
- Bleeding/anticoagulation risk
- Nephrotoxicity combinations
- Hepatotoxicity combinations
- Hypotension risk combinations
- Electrolyte depletion risks
- CNS/sedation risk combinations
- Serotonin syndrome risk
- Dangerous dose combinations

Layer 6 — Evidence Matching
- For each intervention and recommendation, match to guideline, protocol, or monograph evidence
- Cite source name, guideline body, year, and recommendation level when known
- Prefer: IDSA, AHA, ESC, ASHP, BNF, Micromedex, WHO, local antibiogram/formulary references

════════════════════════════════════════════════════════
OUTPUT FORMAT — STRICT JSON ONLY
════════════════════════════════════════════════════════

Return ONLY valid JSON. No prose, no markdown, no explanations outside the JSON.

The JSON must have this exact structure:

{
  "soap_note": {
    "subjective": {
      "patient_summary": "string — concise patient identifier line",
      "reason_for_admission": "string",
      "pmh": ["string"],
      "home_medications": ["string"],
      "allergies": ["string"],
      "social_history": "string or null"
    },
    "objective": {
      "vitals": {
        "bp": "string or null",
        "hr": "string or null",
        "rr": "string or null",
        "temp": "string or null",
        "spo2": "string or null",
        "weight": "string or null",
        "height": "string or null",
        "bmi": "string or null"
      },
      "labs": {
        "renal": {
          "scr": "value + unit + status (H/L/N) or null",
          "bun_urea": "string or null",
          "crcl_calculated": "string or null",
          "crcl_method": "string or null",
          "renal_classification": "string or null"
        },
        "cbc": {
          "hb": "string or null",
          "wbc": "string or null",
          "platelets": "string or null",
          "neutrophils": "string or null",
          "lymphocytes": "string or null",
          "hematocrit": "string or null"
        },
        "electrolytes": {
          "sodium": "string or null",
          "potassium": "string or null",
          "chloride": "string or null",
          "bicarbonate": "string or null",
          "calcium": "string or null",
          "magnesium": "string or null",
          "phosphate": "string or null"
        },
        "liver_function": {
          "alt": "string or null",
          "ast": "string or null",
          "alp": "string or null",
          "ggt": "string or null",
          "total_bilirubin": "string or null",
          "direct_bilirubin": "string or null",
          "albumin": "string or null",
          "total_protein": "string or null"
        },
        "coagulation": {
          "inr": "string or null",
          "pt": "string or null",
          "aptt": "string or null",
          "fibrinogen": "string or null",
          "d_dimer": "string or null"
        },
        "infection_sepsis": {
          "crp": "string or null",
          "procalcitonin": "string or null",
          "lactate": "string or null",
          "esr": "string or null",
          "blood_cultures": "string or null",
          "wound_cultures": "string or null",
          "urine_cultures": "string or null",
          "other_cultures": "string or null"
        },
        "glucose_metabolic": {
          "glucose": "string or null",
          "hba1c": "string or null",
          "tsh": "string or null",
          "lipids": "string or null",
          "uric_acid": "string or null",
          "ammonia": "string or null"
        },
        "tdm_drug_monitoring": {
          "vancomycin": "string or null",
          "gentamicin_amikacin": "string or null",
          "digoxin": "string or null",
          "phenytoin": "string or null",
          "valproate": "string or null",
          "tacrolimus": "string or null",
          "cyclosporine": "string or null",
          "lithium": "string or null",
          "methotrexate": "string or null",
          "other": "string or null"
        },
        "summary_flag": "string — 'abnormalities_present' or 'no_significant_abnormalities'"
      },
      "microbiology_summary": "string or null",
      "imaging_summary": "string or null"
    },
    "assessment": {
      "primary_problems": ["string"],
      "active_diagnoses": ["string"],
      "clinical_context": "string",
      "renal_hepatic_summary": "string",
      "medication_related_assessment": "string"
    },
    "plan": {
      "current_medications_reviewed": ["string"],
      "pharmacist_intervention_summary": "string",
      "followup_plan": ["string"]
    }
  },
  "pharmacist_interventions": [
    {
      "intervention_id": "number",
      "priority": "CRITICAL | HIGH | MODERATE | LOW",
      "category": "string (e.g. Dose Adjustment, Missing Therapy, Allergy Conflict, Contraindication, Monitoring, Duplication, Route, Frequency, Duration, Safety Alert)",
      "drug_involved": "string",
      "problem_identified": "string",
      "recommendation": "string",
      "rationale": "string",
      "supporting_citation": "string"
    }
  ],
  "medication_adjustments": [
    {
      "drug_name": "string",
      "ordered_as": "string",
      "recommended_as": "string",
      "reason": "string",
      "adjustment_type": "string (Dose Change / Route Change / Frequency Change / Discontinue / Add New / Substitute / Monitor)",
      "urgency": "Immediate | Within 24h | Routine",
      "citation": "string"
    }
  ],
  "citations": [
    {
      "citation_id": "number",
      "source": "string",
      "guideline_body": "string or null",
      "year": "string or null",
      "recommendation_class": "string or null",
      "relevance": "string"
    }
  ],
  "case_metadata": {
    "review_timestamp": "ISO string",
    "engine_version": "2.0",
    "care_setting": "string",
    "total_interventions": "number",
    "critical_alerts": "number",
    "renal_adjusted_drugs": "number"
  }
}

════════════════════════════════════════════════════════
SOAP FORMATTING RULES
════════════════════════════════════════════════════════

1. Labs must be grouped by category as shown above — never as a flat mixed list
2. Abnormal labs: mark with ↑ or ↓ and note clinical significance
3. Only include lab categories where data is present or clinically relevant
4. If no abnormalities: set summary_flag to "no_significant_abnormalities"
5. CrCl must always be calculated and displayed if SCr is available
6. Renal classification must always be stated
7. The assessment must be clinically meaningful, not just a list
8. The plan must reflect pharmacist actions, not physician decisions
9. Keep the SOAP elegant — not a data dump

════════════════════════════════════════════════════════
INTERVENTION FORMATTING RULES
════════════════════════════════════════════════════════

- CRITICAL: Allergy conflicts, life-threatening doses, severe contraindications
- HIGH: Significant dose errors, renal/hepatic adjustments needed, missing essential therapy
- MODERATE: Monitoring gaps, potential interactions, suboptimal therapy
- LOW: Documentation issues, minor optimizations, prophylaxis considerations

Each intervention must include: problem, recommendation, rationale, citation.

════════════════════════════════════════════════════════
EVIDENCE CITATION RULES
════════════════════════════════════════════════════════

Prefer evidence from: IDSA, AHA/ACC, ESC, ASHP, BNF, WHO, Micromedex, UpToDate, local formulary.
Always include guideline year if known.
For antimicrobials: cite susceptibility data, local antibiogram, or IDSA/SCCM when relevant.
For anticoagulation: cite ACCP/ASH guidelines.
For renal dosing: cite Lexicomp, Micromedex, or renal drug handbook.

════════════════════════════════════════════════════════
GENERAL CLINICAL COVERAGE REQUIREMENT
════════════════════════════════════════════════════════

You must handle ALL clinical domains:
- Infectious diseases (bacterial, fungal, viral, parasitic)
- Anticoagulation and thrombosis
- Cardiovascular (ACS, HF, arrhythmia, hypertension)
- Diabetes and metabolic
- Renal impairment and electrolytes
- ICU (sepsis, ARDS, hemodynamic support, sedation/analgesia)
- Neurology (seizures, stroke, pain)
- Hematology (anemia, coagulopathy)
- Hepatic disease and cirrhosis
- Transplant and immunosuppression
- Oncology supportive care
- Palliative and pain management
- General ward/internal medicine

Apply clinical reasoning appropriate to the case presented.
Do not limit analysis to one disease module.

Return ONLY the JSON object. No other text.`;
}

// ─────────────────────────────────────────────────────────────
// CASE ANALYSIS HANDLER
// ─────────────────────────────────────────────────────────────
async function handleCaseAnalysis(body, env) {
  const apiKey = env?.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("API key not configured");

  const caseText = body.case_text || body.query || body.message || "";
  if (!caseText.trim()) {
    return buildEmptyResponse("No case input provided.");
  }

  const userPrompt = `Please perform a complete clinical pharmacist review of the following patient case. Apply all internal reasoning layers. Return only the structured JSON response.

PATIENT CASE:
${caseText}

${body.additional_context ? `ADDITIONAL CONTEXT:\n${body.additional_context}` : ""}

${body.focus_area ? `FOCUS AREA:\n${body.focus_area}` : ""}

Return the complete JSON response as specified.`;

  const response = await callAnthropicAPI(
    apiKey,
    buildCaseAnalysisSystemPrompt(),
    userPrompt,
    8000
  );

  const parsed = parseJSON(response);
  if (!parsed) {
    return buildFallbackResponse(response);
  }

  // Inject metadata
  if (parsed.case_metadata) {
    parsed.case_metadata.review_timestamp = new Date().toISOString();
    parsed.case_metadata.total_interventions =
      parsed.pharmacist_interventions?.length || 0;
    parsed.case_metadata.critical_alerts =
      parsed.pharmacist_interventions?.filter(
        (i) => i.priority === "CRITICAL"
      ).length || 0;
    parsed.case_metadata.renal_adjusted_drugs =
      parsed.medication_adjustments?.filter((m) =>
        m.reason?.toLowerCase().includes("renal")
      ).length || 0;
  }

  return { success: true, mode: "case_analysis", data: parsed };
}

// ─────────────────────────────────────────────────────────────
// ASK MODE — General Clinical Q&A
// ─────────────────────────────────────────────────────────────
async function handleAsk(body, env) {
  const apiKey = env?.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("API key not configured");

  const question = body.query || body.message || body.question || "";
  if (!question.trim()) return { success: false, error: "No question provided" };

  const systemPrompt = `You are a senior clinical pharmacist with expertise across all therapeutic areas. 
Answer clinical questions with precision, citing evidence where appropriate. 
Be concise but clinically complete. Use medical terminology appropriate for healthcare professionals.
Format your answer clearly with any relevant dosing, monitoring, or safety information.`;

  const response = await callAnthropicAPI(apiKey, systemPrompt, question, 2000);

  return {
    success: true,
    mode: "ask",
    data: {
      answer: response,
      disclaimer:
        "Clinical information for professional use. Always verify against current guidelines and patient-specific factors.",
    },
  };
}

// ─────────────────────────────────────────────────────────────
// MONOGRAPH MODE
// ─────────────────────────────────────────────────────────────
async function handleMonograph(body, env) {
  const apiKey = env?.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("API key not configured");

  const drug = body.drug || body.query || "";
  if (!drug.trim()) return { success: false, error: "No drug name provided" };

  const systemPrompt = `You are a clinical pharmacist generating a structured drug monograph.
Return a comprehensive but focused monograph in this JSON format:
{
  "drug_name": "string",
  "class": "string",
  "mechanism": "string",
  "indications": ["string"],
  "standard_dosing": [{"indication": "string", "dose": "string", "route": "string", "frequency": "string"}],
  "renal_adjustment": [{"crcl_range": "string", "adjustment": "string"}],
  "hepatic_adjustment": "string",
  "contraindications": ["string"],
  "major_interactions": [{"drug": "string", "severity": "string", "management": "string"}],
  "monitoring": ["string"],
  "adverse_effects": {"common": ["string"], "serious": ["string"]},
  "special_populations": {"pregnancy": "string", "lactation": "string", "pediatric": "string", "elderly": "string"},
  "key_clinical_pearls": ["string"],
  "references": ["string"]
}
Return ONLY the JSON.`;

  const response = await callAnthropicAPI(
    apiKey,
    systemPrompt,
    `Generate a clinical monograph for: ${drug}`,
    3000
  );

  const parsed = parseJSON(response);
  return {
    success: true,
    mode: "monograph",
    data: parsed || { raw: response },
  };
}

// ─────────────────────────────────────────────────────────────
// ANTIBIOGRAM MODE
// ─────────────────────────────────────────────────────────────
async function handleAntibiogram(body, env) {
  const apiKey = env?.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("API key not configured");

  const organism = body.organism || body.query || "";
  const site = body.site || "";
  const patientContext = body.patient_context || "";

  const systemPrompt = `You are a clinical pharmacist and infectious disease specialist.
Provide antibiotic susceptibility guidance and treatment recommendations based on organism, infection site, and patient context.
Return structured JSON with treatment options, dosing, and evidence citations.
Format:
{
  "organism": "string",
  "infection_site": "string",
  "first_line_therapy": [{"drug": "string", "dose": "string", "route": "string", "duration": "string", "notes": "string"}],
  "alternative_therapy": [{"drug": "string", "dose": "string", "route": "string", "duration": "string", "notes": "string"}],
  "drugs_to_avoid": [{"drug": "string", "reason": "string"}],
  "de_escalation_opportunities": "string",
  "monitoring": ["string"],
  "references": ["string"]
}
Return ONLY the JSON.`;

  const query = `Organism: ${organism}\nInfection site: ${site}\nPatient context: ${patientContext}`;
  const response = await callAnthropicAPI(apiKey, systemPrompt, query, 2500);
  const parsed = parseJSON(response);

  return {
    success: true,
    mode: "antibiogram",
    data: parsed || { raw: response },
  };
}

// ─────────────────────────────────────────────────────────────
// ANTHROPIC API CALLER
// ─────────────────────────────────────────────────────────────
async function callAnthropicAPI(apiKey, systemPrompt, userMessage, maxTokens = 4000) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || "";
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
function parseJSON(text) {
  try {
    // Strip markdown code fences
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    // Try extracting JSON object from response
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch {
      return null;
    }
    return null;
  }
}

function buildEmptyResponse(reason) {
  return {
    success: false,
    mode: "case_analysis",
    error: reason,
    data: null,
  };
}

function buildFallbackResponse(rawText) {
  return {
    success: true,
    mode: "case_analysis",
    parse_error: true,
    data: {
      soap_note: {
        subjective: { patient_summary: "Unable to parse structured response" },
        objective: { labs: { summary_flag: "no_significant_abnormalities" } },
        assessment: { clinical_context: rawText },
        plan: { pharmacist_intervention_summary: "Manual review required." },
      },
      pharmacist_interventions: [],
      medication_adjustments: [],
      citations: [],
      case_metadata: {
        review_timestamp: new Date().toISOString(),
        engine_version: "2.0",
        parse_error: true,
      },
    },
  };
}
