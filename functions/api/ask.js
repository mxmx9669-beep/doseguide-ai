// ============================================================
// FILE: /functions/api/ask.js
// CLINICAL PHARMACIST AI PLATFORM — Backend v3.0
// Runtime: Cloudflare Pages Functions
//
// PIPELINE (what runs internally, user only sees final output):
//   A  → Extract & structure patient data
//   B  → Compute CrCl (pure code, no AI)
//   C1 → Organize case into SOAP Template-1
//   C2 → Problem coverage check (admission context, guidelines)
//   C3 → Home meds management at admission (continue/hold/switch)
//   C4 → DVT & stress ulcer prophylaxis assessment
//   C5 → Medication-by-medication deep verification
//   C6 → Final pharmacist SOAP note (Template-2, ready to copy)
// ============================================================

export async function onRequest(context) {
  const { request, env } = context;

  const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST")    return json({ error: "Method not allowed" }, 405, CORS);
  if (!env.OPENAI_API_KEY)          return json({ ok: false, error: "OPENAI_API_KEY not configured" }, 500, CORS);

  try {
    const body = await request.json();
    const { case_text } = body;

    if (!case_text?.trim()) return json({ ok: false, error: "Missing case_text" }, 400, CORS);

    // ── STEP A: Extract & structure ──────────────────────────
    console.log("🔍 A: Extracting structured data...");
    const data = await stepA_extract(case_text, env);

    // ── STEP B: CrCl — pure code, no AI ─────────────────────
    console.log("🧮 B: Computing CrCl...");
    const renal = stepB_computeCrCl(data);
    data.renal = { scr_umol: data.scr_umol ?? null, ...renal };

    const scrDisp  = data.renal.scr_umol ?? "—";
    const crclDisp = renal.crcl !== null ? renal.crcl : "—";
    const renalLine = `SCr ${scrDisp} µmol/L → ${renal.scr_mgdl ?? "—"} mg/dL | CrCl ${crclDisp} mL/min (${renal.weight_label ?? "weight unknown"})`;

    // ── STEP C1: Organize case → Template-1 SOAP ────────────
    console.log("📋 C1: Case organizer...");
    const template1_soap = await stepC1_organize(data, renalLine, env);

    // ── STEP C2: Problem coverage check ─────────────────────
    console.log("🔬 C2: Problem coverage check...");
    const coverage = await stepC2_problemCoverage(data, renal, env);

    // ── STEP C3: Home meds at admission ─────────────────────
    console.log("💊 C3: Home medications management...");
    const homeMedsReview = await stepC3_homeMeds(data, renal, env);

    // ── STEP C4: DVT + SUP prophylaxis ──────────────────────
    console.log("🛡️ C4: DVT & SUP prophylaxis...");
    const prophylaxis = await stepC4_prophylaxis(data, renal, env);

    // ── STEP C5: Medication deep verification ───────────────
    console.log("🔎 C5: Medication verification...");
    const medVerification = await stepC5_medVerification(data, renal, env);

    // ── STEP C6: Final pharmacist note ──────────────────────
    console.log("📝 C6: Final pharmacist note...");
    const finalNote = await stepC6_finalNote(
      data, renalLine, coverage, homeMedsReview, prophylaxis, medVerification, env
    );

    // ── RESPONSE ─────────────────────────────────────────────
    return json({
      ok: true,
      // Renal summary
      renal: {
        scr_umol:     data.renal.scr_umol,
        scr_mgdl:     renal.scr_mgdl,
        crcl:         renal.crcl,
        ibw:          renal.ibw,
        abw_adj:      renal.abw_adj,
        weight_used:  renal.weight_used,
        weight_label: renal.weight_label,
        missing:      renal.missing,
        line:         renalLine,
      },
      missing_data:      data.missing ?? [],
      // Structured data for UI display
      template1_soap,
      coverage,
      home_meds_review:  homeMedsReview,
      prophylaxis,
      med_verification:  medVerification,
      // Final ready-to-copy note
      final_note:        finalNote,
    }, 200, CORS);

  } catch (err) {
    console.error("Pipeline error:", err);
    return json({ ok: false, error: err.message || "Internal server error" }, 500, CORS);
  }
}

// ============================================================
// STEP A — Extract structured data from any free-text input
// ============================================================
async function stepA_extract(caseText, env) {
  const system = `You are a clinical data extractor for a hospital pharmacy system.
Extract ALL available data from the unstructured clinical text.

STRICT RULES:
- NO assumptions. If not explicitly stated → null.
- Do NOT invent diagnoses, medications, or lab values.
- current_meds_list = medications WRITTEN/ORDERED in the hospital chart right now.
- home_meds_list = medications the patient was taking AT HOME before admission.
- Return ONLY valid JSON. No markdown, no explanation, no code fences.

JSON schema:
{
  "mrn": null,
  "age": null,
  "sex": null,
  "height_raw": null,
  "weight_kg": null,
  "ward": null,
  "reason_admission": null,
  "pmh": null,
  "allergies": null,
  "vitals_text": null,
  "labs_text": null,
  "scr_umol": null,
  "imaging": null,
  "home_meds_text": null,
  "home_meds_list": [{"name":"","dose":null,"frequency":null,"route":null,"indication":null}],
  "current_meds_text": null,
  "current_meds_list": [{"name":"","dose":null,"frequency":null,"route":null,"indication":null}],
  "missing": []
}`;

  const raw = await OpenAICall(env, system,
    `Extract all structured data from this clinical case:\n\n${caseText}`, 900);

  try {
    const parsed = safeParseJSON(raw, null);
    if (!parsed) throw new Error("parse failed");

    const missing = [];
    if (!parsed.age)       missing.push("age");
    if (!parsed.sex)       missing.push("sex");
    if (!parsed.weight_kg) missing.push("weight");
    if (!parsed.scr_umol)  missing.push("SCr");

    return { ...parsed, missing };
  } catch {
    return {
      mrn: null, age: null, sex: null, height_raw: null, weight_kg: null,
      ward: null, reason_admission: null, pmh: null, allergies: null,
      vitals_text: null, labs_text: null, scr_umol: null, imaging: null,
      home_meds_text: null, home_meds_list: [],
      current_meds_text: null, current_meds_list: [],
      missing: ["age", "sex", "weight", "SCr"],
    };
  }
}

// ============================================================
// STEP B — Cockcroft-Gault CrCl (pure code, zero AI)
// ============================================================
function stepB_computeCrCl(data) {
  const r = {
    scr_mgdl: null, ibw: null, abw_adj: null,
    weight_used: null, weight_label: null,
    crcl: null, missing: [],
  };

  if (!data.age)       r.missing.push("age");
  if (!data.sex)       r.missing.push("sex");
  if (!data.weight_kg) r.missing.push("weight");
  if (!data.scr_umol)  r.missing.push("SCr");
  if (r.missing.length) return r;

  r.scr_mgdl = parseFloat((data.scr_umol / 88.4).toFixed(3));
  const female = String(data.sex).toLowerCase().startsWith("f");

  // Height → inches
  let heightIn = null;
  if (data.height_raw) {
    const s = String(data.height_raw).toLowerCase();
    let cm = null;
    const mCm   = s.match(/(\d+\.?\d*)\s*cm/);
    const mFtIn = s.match(/(\d+)\s*(?:ft|')\s*(\d*)\s*(?:in|")?/);
    const mIn   = s.match(/(\d+\.?\d*)\s*(?:in|")/);
    const mNum  = s.match(/^(\d+\.?\d*)$/);
    if (mCm)        cm = parseFloat(mCm[1]);
    else if (mFtIn) cm = parseInt(mFtIn[1]) * 30.48 + parseInt(mFtIn[2] || 0) * 2.54;
    else if (mIn)   cm = parseFloat(mIn[1]) * 2.54;
    else if (mNum)  cm = parseFloat(mNum[1]) > 100 ? parseFloat(mNum[1]) : parseFloat(mNum[1]) * 2.54;
    if (cm) heightIn = cm / 2.54;
  }

  // IBW (Devine) + ABW
  if (heightIn && heightIn > 60) {
    r.ibw     = parseFloat((female ? 45.5 + 2.3*(heightIn-60) : 50 + 2.3*(heightIn-60)).toFixed(1));
    r.abw_adj = parseFloat((r.ibw + 0.4*(data.weight_kg - r.ibw)).toFixed(1));
  }

  // Weight selection
  if (r.ibw && data.weight_kg >= 1.2 * r.ibw) {
    r.weight_used  = r.abw_adj;
    r.weight_label = "ABW adjusted (obese ≥1.2×IBW)";
  } else if (r.ibw && data.weight_kg <= r.ibw) {
    r.weight_used  = data.weight_kg;
    r.weight_label = "Actual BW (≤IBW)";
  } else {
    r.weight_used  = data.weight_kg;
    r.weight_label = r.ibw ? "Actual BW" : "Actual BW (height missing)";
  }

  // Cockcroft-Gault
  if (r.scr_mgdl > 0) {
    r.crcl = Math.max(0, Math.round(
      ((140 - data.age) * r.weight_used * (female ? 0.85 : 1.0)) / (72 * r.scr_mgdl)
    ));
  }

  return r;
}

// ============================================================
// STEP C1 — Organize case into structured SOAP Template-1
// No recommendations — pure documentation
// ============================================================
async function stepC1_organize(data, renalLine, env) {
  const system = `You are a clinical documentation formatter.
Organize the patient data into a structured SOAP note. NO recommendations, NO interventions, NO clinical opinions.

Output EXACTLY this format:

S: Patient (MRN: __), __ Y, __ kg admitted to __.
Reason for Admission: __
PMH: __
Allergies: __
Home Medications: __

O: Vitals: __
Labs: __
Imaging: __
Renal: __

A: Primary admission for __ [copied verbatim — do NOT interpret].

P: Current inpatient medications:
__

RULES:
- Missing fields → N/A
- Missing numbers → —
- Renal line → copy exactly as given
- A: section → verbatim reason only`;

  return OpenAICall(env, system,
    `Organize this patient data into Template-1 SOAP.\n\n${buildContext(data, renalLine)}`, 700);
}

// ============================================================
// STEP C2 — Problem coverage check
// For each problem: what does the guideline say pharmacologically?
// Is the patient receiving it? What is missing?
// ============================================================
async function stepC2_problemCoverage(data, renal, env) {
  // Search vector store for relevant guidelines
  const allProblems = [data.reason_admission, data.pmh].filter(Boolean).join(", ");
  const vectorCtx = await searchVectorStore(
    `pharmacotherapy guidelines ${allProblems} inpatient management`, env
  );

  const system = `You are a senior clinical pharmacist consultant reviewing an inpatient case.

YOUR TASK: For each problem (primary admission diagnosis + comorbidities), evaluate PHARMACOTHERAPY ONLY.
- Non-drug interventions (surgery, physiotherapy, oxygen, etc.) are NOT your concern here.
- Focus exclusively on medications.

ADMISSION CONTEXT RULE (CRITICAL):
- Comorbidities in an inpatient must be managed per INPATIENT/ACUTE guidelines, NOT outpatient guidelines.
- Example: Type 2 DM at home on oral agents → inpatient guideline recommends insulin protocol.
- Example: Hypertension on oral antihypertensives → assess if IV needed based on BP values.
- You MUST flag when home therapy should change because of admission context.

For each problem output:

PROBLEM: [name]
GUIDELINE PHARMACOTHERAPY: [what guidelines recommend for this problem in an INPATIENT setting — drug class, specific agents, dosing targets]
SOURCE: [guideline name + year + section — from local protocol if available, else AHA/ACC/IDSA/ADA/ASHP/BNF/UpToDate]
PATIENT STATUS:
  ✅ COVERED: [what's appropriately prescribed]
  ❌ MISSING: [what's not prescribed but should be]
  ⚠️ NEEDS REVIEW: [prescribed but requires assessment — e.g., dose, route, interaction]
SUMMARY: [1–2 sentence verdict]

---

${vectorCtx ? `LOCAL PROTOCOL FILES AVAILABLE (cite these first):\n${vectorCtx}` : "No local protocol files — cite AHA/ACC/IDSA/ADA international guidelines with year and section."}`;

  const userMsg = `Patient case:
${buildContext(data, `CrCl: ${renal.crcl ?? "unknown"} mL/min`)}

Perform problem-by-problem pharmacotherapy coverage check.
Include ALL problems: reason for admission AND comorbidities from PMH.`;

  return OpenAICall(env, system, userMsg, 1400);
}

// ============================================================
// STEP C3 — Home medications management at admission
// Should each home med be CONTINUED, HELD, or SWITCHED?
// ============================================================
async function stepC3_homeMeds(data, renal, env) {
  if (!data.home_meds_list?.length && !data.home_meds_text) {
    return "No home medications documented.";
  }

  const vectorCtx = await searchVectorStore(
    `home medication management admission hold continue ${data.reason_admission ?? ""}`, env
  );

  const system = `You are a senior clinical pharmacist reviewing home medications at the time of hospital admission.

For EACH home medication, decide:
  ✅ CONTINUE — safe and appropriate during admission
  ⏸️ HOLD — should be withheld during admission (state reason and when to restart)
  🔄 SWITCH — replace with inpatient alternative (state what and why)
  ⚠️ REVIEW — needs monitoring or dose adjustment

INPATIENT CONTEXT RULES:
- Oral antidiabetics (metformin, SGLT2i, etc.) → typically hold at admission; switch to insulin protocol
- ACEi/ARBs → hold if AKI, hypotension, or contrast planned
- Antihypertensives → reassess if patient is NPO, hypotensive, or BP controlled
- Anticoagulants → reassess based on indication, bleeding risk, procedures
- NSAIDs → hold in AKI, GI risk, post-operative
- Diuretics → reassess in electrolyte imbalance or volume depletion
- Statins → continue unless liver issue
- Always consider renal function: CrCl ${renal.crcl ?? "unknown"} mL/min

For each med output:
DRUG: [name + dose + frequency]
DECISION: [✅/⏸️/🔄/⚠️] [action]
REASON: [clinical rationale]
EVIDENCE: [guideline / protocol source — or "Evidence not found in local protocol."]

${vectorCtx ? `LOCAL PROTOCOL FILES:\n${vectorCtx}` : "No local protocol — use international guidelines (ADA 2024, ACC/AHA, KDIGO, etc.)"}`;

  const userMsg = `Patient:
Age: ${data.age ?? "?"} | Sex: ${data.sex ?? "?"} | Weight: ${data.weight_kg ?? "?"} kg | CrCl: ${renal.crcl ?? "?"} mL/min
Admission Reason: ${data.reason_admission ?? "N/A"}
PMH: ${data.pmh ?? "N/A"}
Allergies: ${data.allergies ?? "N/A"}
Labs: ${data.labs_text ?? "N/A"}

Home Medications:
${data.home_meds_text ?? JSON.stringify(data.home_meds_list, null, 2)}

Review each home medication for admission management.`;

  return OpenAICall(env, system, userMsg, 1000);
}

// ============================================================
// STEP C4 — DVT & Stress Ulcer Prophylaxis (SUP) assessment
// ============================================================
async function stepC4_prophylaxis(data, renal, env) {
  const vectorCtx = await searchVectorStore(
    `DVT VTE prophylaxis stress ulcer SUP inpatient protocol ${data.reason_admission ?? ""}`, env
  );

  const system = `You are a clinical pharmacist assessing inpatient prophylaxis needs.

ASSESS TWO THINGS:

━━━ 1. VTE / DVT PROPHYLAXIS ━━━
- Use Padua Prediction Score for medical patients OR Caprini Score for surgical.
- State the score and risk level (LOW / MODERATE / HIGH).
- Recommend: pharmacological (LMWH / UFH / fondaparinux — renal-adjusted) or mechanical (IPC) or both.
- Check if currently ordered. Flag if missing or wrong dose.
- Renal consideration: CrCl ${renal.crcl ?? "unknown"} mL/min (adjust enoxaparin if CrCl <30).
- Contraindications: active bleeding, thrombocytopenia, recent surgery, etc.

━━━ 2. STRESS ULCER PROPHYLAXIS (SUP) ━━━
- Assess SUP risk factors: ICU, mechanical ventilation >48h, coagulopathy, history of GI bleed, high-dose steroids, NSAID use, multiple organ failure.
- If indicated → recommend PPI or H2RA (state preference + dose).
- If NOT indicated → state clearly (avoid unnecessary PPI use).
- Check if currently ordered appropriately.

For each, output:
INDICATION: [Yes/No + risk factors present]
RECOMMENDED REGIMEN: [drug + dose + frequency + duration]
CURRENT STATUS: [✅ Ordered correctly / ❌ Missing / ⚠️ Wrong dose or agent]
EVIDENCE: [protocol or guideline source]

${vectorCtx ? `LOCAL PROTOCOL:\n${vectorCtx}` : "No local protocol — cite ASHP/ACCP/CHEST/ACC guidelines with year."}`;

  const userMsg = `Patient:
Age: ${data.age ?? "?"} | Sex: ${data.sex ?? "?"} | Weight: ${data.weight_kg ?? "?"} kg | CrCl: ${renal.crcl ?? "?"} mL/min
Admission: ${data.reason_admission ?? "N/A"}
PMH: ${data.pmh ?? "N/A"}
Labs: ${data.labs_text ?? "N/A"}
Vitals: ${data.vitals_text ?? "N/A"}
Current meds: ${data.current_meds_text ?? "N/A"}

Assess DVT and SUP prophylaxis.`;

  return OpenAICall(env, system, userMsg, 900);
}

// ============================================================
// STEP C5 — Medication-by-medication deep verification
// Every current inpatient med goes through a fine filter
// ============================================================
async function stepC5_medVerification(data, renal, env) {
  const medList = data.current_meds_list ?? [];

  if (!medList.length) return "No current inpatient medications documented.";

  const medNames = medList.map(m => m.name).join(", ");
  const vectorCtx = await searchVectorStore(
    `drug monograph dosing renal adjustment monitoring ${medNames}`, env
  );

  const system = `You are a clinical pharmacist performing a rigorous medication review using the Drug Monograph (from local PDFs if available, else standard references: Lexicomp, BNF, Micromedex, UpToDate).

For EACH medication, evaluate ALL of the following. Be SPECIFIC — use actual patient values.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💊 DRUG: [name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 Indication:
  - Is the indication documented and appropriate for this patient? [Yes / No / Unclear]
  - Evidence: [citation]

📌 Dose:
  - Prescribed: [what's written]
  - Recommended: [standard range for this indication]
  - Renal adjustment needed? CrCl = ${renal.crcl ?? "unknown"} mL/min → [adjusted dose if needed]
  - Weight-based? → [calculated dose if applicable: weight used = ${renal.weight_used ?? "unknown"} kg]
  - Assessment: [✅ Correct / ❌ Issue: state problem]
  - Evidence: [citation]

📌 Frequency:
  - Prescribed vs. recommended: [assessment]
  - Renal or hepatic adjustment needed? [Yes/No + detail]

📌 Route:
  - Appropriate? [Yes/No — e.g., oral when NPO?]

📌 Drug–Drug Interactions (DDI):
  - With other current meds: [list any significant interactions + severity]
  - Management: [monitor / switch / avoid]
  - Evidence: [citation]

📌 Contraindications & Drug–Disease:
  - Any contraindication given PMH or current condition? [list if yes]
  - Evidence: [citation]

📌 Drug–Lab Conflicts:
  - Any lab value that flags concern with this drug?
  - Example: nephrotoxic drug + AKI, K+ rising + ACEI, INR elevated + warfarin
  - Evidence: [citation]

📌 Monitoring Required:
  - Parameters to monitor: [list]
  - Target values: [specific targets]
  - Frequency: [e.g., daily, weekly, at 48h]

📌 Allergies:
  - Any documented allergy conflict? [Yes/No]

📌 Overall Assessment:
  ✅ No issues | ⚠️ Requires monitoring | ❌ Intervention needed: [what]

EVIDENCE RULES:
- Cite LOCAL protocol PDF if available (filename + section).
- If not → cite Lexicomp / BNF / IDSA / ACC/AHA / KDIGO / UpToDate with year and section.
- NEVER fabricate citations. If unknown → "Evidence not found in local protocol."

${vectorCtx ? `LOCAL DRUG MONOGRAPH FILES:\n${vectorCtx}` : "No local drug files — use standard references (Lexicomp, BNF, UpToDate, etc.)"}`;

  const userMsg = `Patient:
Age: ${data.age ?? "?"} Y | Sex: ${data.sex ?? "?"} | Weight: ${data.weight_kg ?? "?"} kg | CrCl: ${renal.crcl ?? "?"} mL/min
IBW: ${renal.ibw ?? "?"} kg | Weight used for dosing: ${renal.weight_used ?? "?"} kg (${renal.weight_label ?? "?"})
PMH: ${data.pmh ?? "N/A"}
Allergies: ${data.allergies ?? "N/A"}
Labs: ${data.labs_text ?? "N/A"}
Vitals: ${data.vitals_text ?? "N/A"}
Admission: ${data.reason_admission ?? "N/A"}

ALL current inpatient medications:
${JSON.stringify(medList, null, 2)}

Perform deep medication verification for each drug.`;

  return OpenAICall(env, system, userMsg, 2000);
}

// ============================================================
// STEP C6 — Final Pharmacist SOAP Note (Template-2)
// Ready to copy and paste into the medical record
// ============================================================
async function stepC6_finalNote(data, renalLine, coverage, homeMedsReview, prophylaxis, medVerification, env) {
  const system = `You are a senior clinical pharmacist writing a formal pharmacist consultation note.
This note will be copied directly into the patient's medical record.

Output EXACTLY this structure. Plain text only. No markdown, no bold, no asterisks, no code fences.

════════════════════════════════════════════
CLINICAL PHARMACIST CONSULTATION NOTE
════════════════════════════════════════════

S: Patient (MRN: __), __ Y __ admitted to __.
Reason for Admission: __
PMH: __
Allergies: __
Home Medications: __

O: Vitals: __
Labs: __
Renal Function: __

A: Clinical pharmacotherapy review performed for patient admitted with __.
[1–2 sentence summary of key clinical findings relevant to pharmacotherapy]

P:
─── PROBLEM-BASED PHARMACOTHERAPY COVERAGE ───
[For each problem: state guideline recommendation briefly, then current status — COVERED / PARTIAL / GAP]

─── HOME MEDICATIONS AT ADMISSION ───
[Each home med: CONTINUE / HOLD / SWITCH — one line per drug with brief reason]

─── PROPHYLAXIS ───
VTE: [recommendation + current status]
SUP: [recommendation + current status]

─── MEDICATION INTERVENTIONS ───
[List each issue found in med verification as a numbered intervention:]
[N]. [Drug] — [Issue] → [Recommended action]
     Evidence: [citation]

─── MONITORING PLAN ───
[Key parameters, targets, and frequency]

─── PHARMACIST SIGNATURE ───
Clinical Pharmacist | Date: [leave blank]

RULES:
- Interventions must include evidence.
- "Evidence not found in local protocol." if no citation available.
- Monitoring plan must have specific targets and timeframes.
- Summary should be concise — this is a note, not a report.`;

  const userMsg = `Generate the final pharmacist note from this case review.

PATIENT:
${buildContext(data, renalLine)}

PROBLEM COVERAGE REVIEW:
${coverage}

HOME MEDICATIONS REVIEW:
${homeMedsReview}

PROPHYLAXIS ASSESSMENT:
${prophylaxis}

MEDICATION VERIFICATION:
${medVerification}`;

  return OpenAICall(env, system, userMsg, 1800);
}

// ============================================================
// HELPER: Vector Store Search — with diagnostics
// ============================================================
async function searchVectorStore(query, env, maxResults = 8) {
  if (!env.OPENAI_API_KEY) { console.warn("⚠️ VS: no API key"); return ""; }
  if (!env.VECTOR_STORE_ID) { console.warn("⚠️ VS: no VECTOR_STORE_ID"); return ""; }

  console.log(`🔎 VS search: "${query.substring(0, 80)}..."`);

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
        body: JSON.stringify({ query, max_num_results: maxResults, include_metadata: true }),
      }
    );

    console.log(`🔎 VS status: ${res.status}`);
    if (!res.ok) {
      const err = await res.text();
      console.error(`❌ VS ${res.status}: ${err}`);
      if (res.status === 404) console.error(`❌ VECTOR_STORE_ID "${env.VECTOR_STORE_ID}" not found`);
      if (res.status === 401) console.error("❌ API key invalid or expired");
      return "";
    }

    const result = await res.json();
    const hits = result?.data?.length ?? 0;
    console.log(`✅ VS: ${hits} hit(s)`);
    if (!hits) return "";

    return result.data.map((item, i) => {
      const content  = extractContent(item);
      const filename = item.filename || item.file_id || `Protocol ${i + 1}`;
      const page     = item.metadata?.page || item.metadata?.section || "";
      const pageInfo = page ? ` [${page}]` : "";
      console.log(`  📄 ${filename}${pageInfo} score=${item.score?.toFixed(3) ?? "?"}`);
      return `--- SOURCE: ${filename}${pageInfo} ---\n${content.substring(0, 600)}`;
    }).join("\n\n");

  } catch (err) {
    console.error("❌ VS fetch error:", err.message);
    return "";
  }
}

// ============================================================
// HELPER: Build patient context block
// ============================================================
function buildContext(data, renalLine) {
  return `MRN: ${data.mrn ?? "—"}
Age: ${data.age ?? "—"} Y | Sex: ${data.sex ?? "—"} | Weight: ${data.weight_kg ?? "—"} kg | Height: ${data.height_raw ?? "—"}
Ward: ${data.ward ?? "—"}
Reason for Admission: ${data.reason_admission ?? "N/A"}
PMH: ${data.pmh ?? "N/A"}
Allergies: ${data.allergies ?? "N/A"}
Home Medications: ${data.home_meds_text ?? "N/A"}
Vitals: ${data.vitals_text ?? "N/A"}
Labs: ${data.labs_text ?? "N/A"}
Imaging: ${data.imaging ?? "N/A"}
Current Inpatient Medications: ${data.current_meds_text ?? "N/A"}
Renal: ${renalLine}`.trim();
}

// ============================================================
// HELPER: Extract content from vector store item
// ============================================================
function extractContent(item) {
  if (!item.content) return item.text || "";
  if (Array.isArray(item.content)) return item.content.map(c => c.text || c.value || "").join("\n");
  if (typeof item.content === "string") return item.content;
  if (item.content.text) return item.content.text;
  return item.text || "";
}

// ============================================================
// HELPER: Safe JSON parse
// ============================================================
function safeParseJSON(raw, fallback) {
  try {
    return JSON.parse(raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim());
  } catch {
    return fallback;
  }
}

// ============================================================
// HELPER: OpenAI chat completion
// ============================================================
async function OpenAICall(env, system, userMessage, maxTokens = 800) {
  const model = env.MODEL || "gpt-4-turbo-preview";
  console.log(`🤖 OpenAI call | model=${model} | maxTokens=${maxTokens}`);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("❌ OpenAI error:", err);
    throw new Error(`OpenAI API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ============================================================
// HELPER: JSON HTTP response
// ============================================================
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
