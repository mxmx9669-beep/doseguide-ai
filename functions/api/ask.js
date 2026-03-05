// ============================================================
// FILE: /functions/api/ask.js
// CLINICAL PHARMACIST AI PLATFORM — Backend v5.0
// Runtime: Cloudflare Pages Functions
// ============================================================

export async function onRequest(context) {
  const { request, env } = context;

  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST")    return jsonRes({ error: "Method not allowed" }, 405, CORS);

  try {
    const body = await request.json();
    const { case_text } = body;

    if (!case_text?.trim()) return jsonRes({ ok: false, error: "Missing case_text" }, 400, CORS);

    // ── STEP A: Extract structured data ─────────────────────
    const extracted = await stepA_extract(case_text, env);

    // ── STEP B: CrCl — pure math, no AI ─────────────────────
    const renal = computeCrCl(extracted);
    extracted.renal = renal;

    const renalLine = [
      `SCr: ${renal.scr_umol ?? "—"} µmol/L (${renal.scr_mgdl ?? "—"} mg/dL)`,
      `CrCl: ${renal.crcl ?? "—"} mL/min`,
      `Weight used: ${renal.weight_used ?? "—"} kg (${renal.weight_label ?? "—"})`,
    ].join(" | ");

    // ── Local rule-based checks (no AI cost) ────────────────
    const localMedCheck = runLocalMedCheck(extracted, renal);

    // ── Vector store search ──────────────────────────────────
    const protocols = await searchVectorStore(
      `pharmacotherapy ${extracted.reason_admission ?? ""} ${extracted.pmh ?? ""}`,
      env, 8
    );

    // ── STEP C1: SOAP organizer ──────────────────────────────
    const template1_soap = await aiCall(env, buildSoapSystem(protocols), buildSoapUser(extracted, renalLine), 1400);

    // ── STEP C2: Coverage check ──────────────────────────────
    const coverage = await aiCall(env, buildCovSystem(protocols), buildCovUser(extracted, renal), 1200);

    // ── STEP C3: Home meds review ────────────────────────────
    const home_meds_review = await aiCall(env, buildHomeSystem(protocols), buildHomeUser(extracted, renal), 1000);

    // ── STEP C4: DVT + SUP prophylaxis ───────────────────────
    const prophylaxis = await aiCall(env, buildProphySystem(protocols), buildProphyUser(extracted, renal), 900);

    // ── STEP C5: Medication deep verification ────────────────
    const med_verification = await aiCall(
      env,
      buildMedSystem(protocols, localMedCheck),
      buildMedUser(extracted, renal),
      1600
    );

    // ── STEP C6: Final pharmacist note ───────────────────────
    const final_note = await aiCall(
      env,
      buildNoteSystem(),
      buildNoteUser(extracted, renalLine, coverage, home_meds_review, prophylaxis, med_verification),
      1400
    );

    return jsonRes({
      ok: true,
      renal: {
        scr_umol:     renal.scr_umol,
        scr_mgdl:     renal.scr_mgdl,
        crcl:         renal.crcl,
        ibw:          renal.ibw,
        abw_adj:      renal.abw_adj,
        weight_used:  renal.weight_used,
        weight_label: renal.weight_label,
        missing:      renal.missing,
        line:         renalLine,
      },
      missing_data:      extracted.missing ?? [],
      local_med_check:   localMedCheck,
      template1_soap,
      coverage,
      home_meds_review,
      prophylaxis,
      med_verification,
      final_note,
      protocols_found:   protocols ? "✅" : "❌",
    }, 200, CORS);

  } catch (err) {
    console.error("Pipeline error:", err);
    return jsonRes({ ok: false, error: err.message || "Internal server error" }, 500, CORS);
  }
}

// ============================================================
// STEP A — Extract patient data via AI
// ============================================================
async function stepA_extract(caseText, env) {
  const system = `You are a clinical data extraction engine.
Extract patient data from the raw HIS/clinical text and return ONLY valid JSON.
No markdown, no explanation, no backticks — pure JSON only.

Schema:
{
  "mrn": string|null,
  "age": number|null,
  "sex": "male"|"female"|null,
  "weight_kg": number|null,
  "height_cm": number|null,
  "ward": string|null,
  "reason_admission": string|null,
  "pmh": string|null,
  "allergies": string|null,
  "vitals_text": string|null,
  "labs_text": string|null,
  "imaging": string|null,
  "home_meds_text": string|null,
  "home_meds_list": [{"name":string,"dose":string,"route":string,"frequency":string}],
  "current_meds_text": string|null,
  "current_meds_list": [{"name":string,"dose":string,"route":string,"frequency":string,"status":string}],
  "scr_umol": number|null,
  "missing": [string]
}

For "missing": list critical absent items from: age, weight, height, SCr, sex, current medications.`;

  const raw = await aiCall(env, system, `Extract from:\n\n${caseText}`, 1000);

  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    // Fallback: return minimal object so pipeline continues
    return {
      mrn: null, age: null, sex: null, weight_kg: null, height_cm: null,
      ward: null, reason_admission: null, pmh: null, allergies: "NKDA",
      vitals_text: null, labs_text: null, imaging: null,
      home_meds_text: null, home_meds_list: [],
      current_meds_text: null, current_meds_list: [],
      scr_umol: null,
      missing: ["Could not parse — check raw input"],
    };
  }
}

// ============================================================
// STEP B — CrCl (Cockcroft-Gault) — pure math
// ============================================================
function computeCrCl(d) {
  const missing = [];
  const age      = d.age       ?? null;
  const weight   = d.weight_kg ?? null;
  const height   = d.height_cm ?? null;
  const sex      = (d.sex ?? "").toLowerCase();
  const scr_umol = d.scr_umol  ?? null;

  if (!age)      missing.push("age");
  if (!weight)   missing.push("weight");
  if (!height)   missing.push("height");
  if (!sex)      missing.push("sex");
  if (!scr_umol) missing.push("SCr");

  const scr_mgdl = scr_umol ? round2(scr_umol / 88.42) : null;

  // IBW
  let ibw = null;
  if (height) {
    const inchOver5ft = (height / 2.54) - 60;
    ibw = sex === "female"
      ? round2(45.5 + 2.3 * inchOver5ft)
      : round2(50   + 2.3 * inchOver5ft);
  }

  // Weight selection
  let weight_used  = null;
  let weight_label = null;
  let abw_adj      = null;

  if (weight && ibw) {
    if (weight <= ibw * 1.2) {
      weight_used  = weight;
      weight_label = "ABW (≤ 120% IBW)";
    } else {
      abw_adj      = round2(ibw + 0.4 * (weight - ibw));
      weight_used  = abw_adj;
      weight_label = "Adjusted BW (obese)";
    }
  } else if (weight) {
    weight_used  = weight;
    weight_label = "ABW (height unknown)";
  }

  // CrCl
  let crcl = null;
  if (age && weight_used && scr_mgdl && sex) {
    const sexFactor = sex === "female" ? 0.85 : 1.0;
    crcl = round2(((140 - age) * weight_used) / (72 * scr_mgdl) * sexFactor);
    if (crcl < 0) crcl = 0;
  }

  return { scr_umol, scr_mgdl, crcl, ibw, abw_adj, weight_used, weight_label, missing };
}

// ============================================================
// LOCAL RULE-BASED MEDICATION CHECKS
// ============================================================
function runLocalMedCheck(data, renal) {
  const issues   = [];
  const meds     = [...(data.current_meds_list || []), ...(data.home_meds_list || [])];
  const medNames = meds.map(m => (m.name || "").toLowerCase());
  const { crcl }  = renal;
  const labs      = data.labs_text || "";

  // ── Helper extractors ──────────────────────────────────────
  const getLabVal = (regex) => {
    const m = labs.match(regex);
    return m ? parseFloat(m[1]) : null;
  };
  const k   = getLabVal(/potassium[:\s]+(\d+\.?\d*)/i) ?? getLabVal(/\bk\b[:\s]+(\d+\.?\d*)/i);
  const inr = getLabVal(/INR[:\s]+(\d+\.?\d*)/i);

  // ── Per-drug rules ─────────────────────────────────────────
  const rules = [
    {
      match: ["piperacillin", "pip-tazo", "tazobactam"],
      check: () => crcl !== null && crcl < 40,
      issue: {
        drug: "Piperacillin/Tazobactam",
        severity: "high",
        problem: `Renal dose adjustment required (CrCl = ${crcl} mL/min < 40)`,
        recommendation: "Reduce to 3.375 g IV q8h or 2.25 g IV q6h extended infusion",
        evidence: "Sanford Guide / Product labeling — CrCl-based dosing",
      },
    },
    {
      match: ["enoxaparin", "clexane"],
      check: () => crcl !== null && crcl < 30,
      issue: {
        drug: "Enoxaparin",
        severity: "high",
        problem: `Enoxaparin accumulation risk (CrCl = ${crcl} mL/min < 30)`,
        recommendation: "Switch to UFH (unfractionated heparin) or reduce to 30 mg SC daily with anti-Xa monitoring",
        evidence: "CHEST 2021 Antithrombotic Guidelines",
      },
    },
    {
      match: ["metformin"],
      check: () => crcl !== null && crcl < 45,
      issue: {
        drug: "Metformin",
        severity: crcl < 30 ? "high" : "medium",
        problem: `Lactic acidosis risk (CrCl = ${crcl} mL/min)`,
        recommendation: crcl < 30 ? "STOP metformin immediately" : "Reduce dose; reassess if CrCl < 30",
        evidence: "ADA Standards of Care 2024 / FDA label",
      },
    },
    {
      match: ["empagliflozin", "dapagliflozin", "canagliflozin"],
      check: () => crcl !== null && crcl < 45,
      issue: {
        drug: "SGLT2 inhibitor",
        severity: "medium",
        problem: `Reduced glycaemic efficacy and safety concern (CrCl = ${crcl} mL/min < 45)`,
        recommendation: "Discontinue SGLT2i; consider alternative antidiabetic",
        evidence: "ADA/EASD 2024 Guidelines",
      },
    },
    {
      match: ["spironolactone"],
      check: () => (crcl !== null && crcl < 30) || (k !== null && k > 5.2),
      issue: {
        drug: "Spironolactone",
        severity: "high",
        problem: crcl < 30
          ? `Contraindicated (CrCl = ${crcl} mL/min < 30)`
          : `Hyperkalaemia risk (K = ${k} mmol/L > 5.2)`,
        recommendation: "Withhold; monitor K daily; consider dose reduction when K normalises",
        evidence: "KDIGO AKI Guidelines / ESC HF Guidelines 2021",
      },
    },
    {
      match: ["warfarin"],
      check: () => inr !== null && inr > 3.5,
      issue: {
        drug: "Warfarin",
        severity: "high",
        problem: `Supratherapeutic INR = ${inr} — bleeding risk`,
        recommendation: inr > 4.5
          ? "Hold warfarin; administer Vitamin K 2.5–5 mg PO; recheck INR in 24 h"
          : "Hold one dose; recheck INR daily",
        evidence: "ACCP Antithrombotic Guidelines 10th ed.",
      },
    },
    {
      match: ["furosemide"],
      check: () => k !== null && k < 3.5,
      issue: {
        drug: "Furosemide",
        severity: "medium",
        problem: `Hypokalaemia (K = ${k} mmol/L) with loop diuretic`,
        recommendation: "Replace potassium (oral or IV); consider adding potassium-sparing diuretic",
        evidence: "ESC HF Guidelines 2021",
      },
    },
    {
      match: ["vancomycin"],
      check: () => crcl !== null && crcl < 50,
      issue: {
        drug: "Vancomycin",
        severity: "high",
        problem: `Requires TDM and dose adjustment (CrCl = ${crcl} mL/min)`,
        recommendation: "Calculate AUC-guided dosing; extend interval; monitor trough / AUC",
        evidence: "ASHP/IDSA/SIDP Vancomycin Consensus Guidelines 2020",
      },
    },
    {
      match: ["omeprazole"],
      check: () => medNames.some(n => n.includes("clopidogrel")),
      issue: {
        drug: "Omeprazole + Clopidogrel",
        severity: "medium",
        problem: "CYP2C19 interaction — omeprazole reduces clopidogrel antiplatelet effect",
        recommendation: "Switch to pantoprazole (preferred PPI with clopidogrel)",
        evidence: "FDA Drug Safety Communication 2010 / ACC/AHA",
      },
    },
  ];

  // ── Drug-drug interactions ─────────────────────────────────
  const ddi = [
    {
      drugs: ["warfarin", "aspirin"],
      issue: {
        drug: "Warfarin + Aspirin",
        severity: "high",
        problem: "Concurrent anticoagulant + antiplatelet — major bleeding risk",
        recommendation: "Assess indication; minimise concomitant use; monitor INR closely",
        evidence: "ACCP Guidelines",
      },
    },
    {
      drugs: ["amiodarone", "ciprofloxacin"],
      issue: {
        drug: "Amiodarone + Fluoroquinolone",
        severity: "high",
        problem: "QTc prolongation risk",
        recommendation: "Monitor ECG; consider alternative antibiotic",
        evidence: "CredibleMeds CombinedRisk database",
      },
    },
    {
      drugs: ["amiodarone", "levofloxacin"],
      issue: {
        drug: "Amiodarone + Levofloxacin",
        severity: "high",
        problem: "QTc prolongation risk",
        recommendation: "Monitor ECG; consider alternative antibiotic",
        evidence: "CredibleMeds CombinedRisk database",
      },
    },
    {
      drugs: ["simvastatin", "clarithromycin"],
      issue: {
        drug: "Simvastatin + Clarithromycin",
        severity: "high",
        problem: "CYP3A4 inhibition → myopathy / rhabdomyolysis risk",
        recommendation: "Hold simvastatin during clarithromycin course; switch to pravastatin",
        evidence: "FDA label / Lexicomp interaction database",
      },
    },
    {
      drugs: ["atorvastatin", "clarithromycin"],
      issue: {
        drug: "Atorvastatin + Clarithromycin",
        severity: "medium",
        problem: "CYP3A4 inhibition → increased statin exposure",
        recommendation: "Limit atorvastatin to 20 mg/day; monitor for myopathy",
        evidence: "Lexicomp interaction database",
      },
    },
    {
      drugs: ["spironolactone", "lisinopril"],
      issue: {
        drug: "Spironolactone + ACEi",
        severity: "high",
        problem: "Hyperkalaemia risk — two potassium-sparing agents",
        recommendation: "Monitor K daily; reduce doses if K > 5.0 mmol/L",
        evidence: "ESC HF Guidelines 2021",
      },
    },
    {
      drugs: ["spironolactone", "enalapril"],
      issue: {
        drug: "Spironolactone + ACEi",
        severity: "high",
        problem: "Hyperkalaemia risk — two potassium-sparing agents",
        recommendation: "Monitor K daily; reduce doses if K > 5.0 mmol/L",
        evidence: "ESC HF Guidelines 2021",
      },
    },
  ];

  // ── Apply per-drug rules ───────────────────────────────────
  for (const rule of rules) {
    const hit = meds.find(m =>
      rule.match.some(k => (m.name || "").toLowerCase().includes(k))
    );
    if (hit && rule.check()) issues.push(rule.issue);
  }

  // ── Apply DDI rules ────────────────────────────────────────
  for (const d of ddi) {
    const allPresent = d.drugs.every(drug =>
      medNames.some(n => n.includes(drug))
    );
    if (allPresent) issues.push(d.issue);
  }

  return issues;
}

// ============================================================
// AI CALL HELPERS
// ============================================================
async function aiCall(env, system, userMsg, maxTokens = 900) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const model = env.MODEL || "gpt-4o";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.15,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: userMsg  },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// ============================================================
// VECTOR STORE SEARCH
// ============================================================
async function searchVectorStore(query, env, maxResults = 8) {
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) return "";

  try {
    const res = await fetch(
      `https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type":  "application/json",
          "OpenAI-Beta":   "assistants=v2",
        },
        body: JSON.stringify({
          query,
          max_num_results: maxResults,
          ranking_options: { score_threshold: 0.35 },
        }),
      }
    );
    if (!res.ok) return "";

    const result = await res.json();
    const hits   = result?.data ?? [];
    if (!hits.length) return "";

    return hits
      .filter(item => (item.score ?? 0) >= 0.35)
      .map((item, i) => {
        const text = extractVSContent(item);
        const src  = item.filename || item.file_id || `Protocol-${i + 1}`;
        return `[SOURCE ${i + 1}: ${src} | score ${(item.score ?? 0).toFixed(3)}]\n${text.slice(0, 700)}`;
      })
      .join("\n\n---\n\n");
  } catch {
    return "";
  }
}

function extractVSContent(item) {
  if (!item.content) return item.text || "";
  if (Array.isArray(item.content)) return item.content.map(c => c.text || c.value || "").join("\n");
  if (typeof item.content === "string") return item.content;
  return item.content?.text || item.text || "";
}

// ============================================================
// SYSTEM / USER MESSAGE BUILDERS
// ============================================================

// ── C1 SOAP ───────────────────────────────────────────────
function buildSoapSystem(protocols) {
  return `You are a clinical pharmacist writing a structured SOAP case summary.
Be concise, professional, and use standard clinical abbreviations.
${protocols ? `\nReference protocols available:\n${protocols}` : ""}

Format exactly as:
SUBJECTIVE
• Chief complaint & HPI (2-3 lines)
• PMH: bullet list
• Home medications: list

OBJECTIVE
• Vitals (most recent)
• Relevant labs (abnormal flagged ↑/↓ with range)
• Imaging / investigations
• Renal function summary

ASSESSMENT
• Primary problem
• Active issues list

PLAN (Pharmacotherapy focus)
• Current inpatient medications: table format
  Drug | Dose | Route | Frequency | Status`;
}

function buildSoapUser(d, renalLine) {
  return `Patient: ${d.age ?? "?"}Y ${d.sex ?? "?"} | MRN: ${d.mrn ?? "—"} | Ward: ${d.ward ?? "—"}
Allergies: ${d.allergies ?? "NKDA"}
Reason for admission: ${d.reason_admission ?? "—"}
PMH: ${d.pmh ?? "—"}
Vitals: ${d.vitals_text ?? "—"}
Labs: ${d.labs_text ?? "—"}
Imaging: ${d.imaging ?? "—"}
Home meds: ${d.home_meds_text ?? "—"}
Current inpatient meds: ${d.current_meds_text ?? "—"}
Renal: ${renalLine}`;
}

// ── C2 Coverage ───────────────────────────────────────────
function buildCovSystem(protocols) {
  return `You are a clinical pharmacist performing problem-to-treatment coverage analysis.
Guideline evidence level: ESC 2021 HF, ACC/AHA, KDIGO, IDSA, local ICU protocols.
${protocols ? `\nAvailable protocols:\n${protocols}` : ""}

For each active problem:
1. State the problem
2. List guideline-recommended pharmacotherapy
3. Compare to what patient is receiving
4. Flag: COVERED ✅ | PARTIALLY COVERED ⚠️ | NOT COVERED ❌ | CONTRAINDICATED 🚫

Be direct. No preamble.`;
}

function buildCovUser(d, renal) {
  return `Reason for admission: ${d.reason_admission ?? "—"}
PMH: ${d.pmh ?? "—"}
Current meds: ${d.current_meds_text ?? "—"}
CrCl: ${renal.crcl ?? "—"} mL/min
Labs: ${d.labs_text ?? "—"}`;
}

// ── C3 Home meds ──────────────────────────────────────────
function buildHomeSystem(protocols) {
  return `You are a clinical pharmacist reviewing home medications at hospital admission.
${protocols ? `\nProtocols:\n${protocols}` : ""}

For EACH home medication state:
• Drug name + dose
• Decision: CONTINUE / HOLD / SWITCH / DOSE-ADJUST
• Reason (one sentence, guideline-cited if possible)
• If HOLD: specify restart criteria

Use consistent table-like formatting.`;
}

function buildHomeUser(d, renal) {
  return `Home medications: ${d.home_meds_text ?? "None documented"}
Reason for admission: ${d.reason_admission ?? "—"}
CrCl: ${renal.crcl ?? "—"} mL/min
Labs: ${d.labs_text ?? "—"}
Current inpatient meds: ${d.current_meds_text ?? "—"}`;
}

// ── C4 Prophylaxis ────────────────────────────────────────
function buildProphySystem(protocols) {
  return `You are a clinical pharmacist assessing VTE and stress ulcer prophylaxis.
${protocols ? `\nProtocols:\n${protocols}` : ""}

Structure your response as two sections:

1. VTE PROPHYLAXIS
   • Assess risk (Padua / Caprini score if possible)
   • Current VTE prophylaxis: state what is ordered
   • Recommendation: APPROPRIATE ✅ / CHANGE REQUIRED ⚠️ / MISSING ❌
   • Drug/dose/duration recommendation with rationale

2. STRESS ULCER PROPHYLAXIS (SUP)
   • Assess indication (mechanical ventilation, coagulopathy, ICU risk)
   • Current SUP: state what is ordered
   • Recommendation: APPROPRIATE ✅ / CHANGE REQUIRED ⚠️ / MISSING ❌
   • Drug/dose recommendation`;
}

function buildProphyUser(d, renal) {
  return `Patient: ${d.age ?? "?"}Y ${d.sex ?? "?"} | Ward: ${d.ward ?? "—"}
Reason for admission: ${d.reason_admission ?? "—"}
PMH: ${d.pmh ?? "—"}
Labs: ${d.labs_text ?? "—"}
CrCl: ${renal.crcl ?? "—"} mL/min
Current meds: ${d.current_meds_text ?? "—"}`;
}

// ── C5 Medication verification ────────────────────────────
function buildMedSystem(protocols, localIssues) {
  const localStr = localIssues.length
    ? `\nLOCAL RULES ALREADY DETECTED:\n${localIssues.map(i =>
        `• ${i.drug}: ${i.problem} → ${i.recommendation}`
      ).join("\n")}\n(Do NOT repeat these; focus on additional issues.)`
    : "";

  return `You are a senior clinical pharmacist performing deep medication verification.
${localStr}
${protocols ? `\nProtocols:\n${protocols}` : ""}

For each current inpatient medication, verify:
1. Indication — is it appropriate for this patient?
2. Dose — correct for weight / renal / hepatic function?
3. Frequency — correct?
4. Route — appropriate?
5. Drug-drug interactions (not already listed above)
6. Contraindications
7. Required monitoring (labs, levels, ECG, etc.)

Format each as:
💊 [DRUG NAME] [dose] [route] [frequency]
   Indication: ✅/⚠️/❌ …
   Dose: ✅/⚠️/❌ …
   DDI: ✅/⚠️ …
   Monitoring: …
   → PHARMACIST ACTION: [if any]`;
}

function buildMedUser(d, renal) {
  return `Patient: ${d.age ?? "?"}Y ${d.sex ?? "?"} | Weight: ${d.weight_kg ?? "?"}kg | CrCl: ${renal.crcl ?? "?"} mL/min
Labs: ${d.labs_text ?? "—"}
Current inpatient medications:
${JSON.stringify(d.current_meds_list, null, 2)}`;
}

// ── C6 Final note ─────────────────────────────────────────
function buildNoteSystem() {
  return `You are writing a formal clinical pharmacist consultation note for a hospital medical record.
Style: concise, professional, referenced. Use SOAP format. 
Start with: "CLINICAL PHARMACIST CONSULTATION NOTE"
End with: "Pharmacist: __________________ Date: __________"`;
}

function buildNoteUser(d, renalLine, coverage, homeMeds, prophylaxis, medVerification) {
  return `Patient: ${d.age ?? "?"}Y ${d.sex ?? "?"}
Ward: ${d.ward ?? "—"}
Admission: ${d.reason_admission ?? "—"}
PMH: ${d.pmh ?? "—"}
Renal: ${renalLine}

COVERAGE ANALYSIS:
${coverage ?? "—"}

HOME MEDS REVIEW:
${homeMeds ?? "—"}

PROPHYLAXIS:
${prophylaxis ?? "—"}

MEDICATION VERIFICATION:
${medVerification ?? "—"}

Write the complete pharmacist note. Be concise. Highlight any active interventions clearly.`;
}

// ============================================================
// UTILITIES
// ============================================================
function round2(n) {
  return Math.round(n * 100) / 100;
}

function jsonRes(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
