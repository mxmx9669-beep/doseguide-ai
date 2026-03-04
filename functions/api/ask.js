// ============================================================
// FILE: /functions/api/ask.js
// CLINICAL PHARMACIST AI PLATFORM — Backend v2.1
// Runtime: Cloudflare Pages Functions
// Pipeline: Staged workflow with backward compatibility
// ============================================================

export async function onRequest(context) {
  const { request, env } = context;

  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // ── CORS preflight ──────────────────────────────────────────
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, CORS);
  }

  // ── Validate env ────────────────────────────────────────────
  if (!env.OPENAI_API_KEY) {
    return json({ ok: false, error: "OPENAI_API_KEY not configured" }, 500, CORS);
  }

  try {
    const body = await request.json();
    const { case_text, stage = 5 } = body; // Default to stage 5 for backward compatibility

    if (!case_text || !case_text.trim()) {
      return json({ ok: false, error: "Missing case_text" }, 400, CORS);
    }

    // Validate stage is between 1-5
    const requestedStage = parseInt(stage);
    if (isNaN(requestedStage) || requestedStage < 1 || requestedStage > 5) {
      return json({ ok: false, error: "Stage must be between 1 and 5" }, 400, CORS);
    }

    // ── STEP A: Extract structured JSON (via OpenAI AI) ──────
    console.log("🔍 Step A: Extracting structured data via AI...");
    const extractedData = await stepA_extract(case_text, env);

    // ── STEP B: Compute CrCl — pure code, zero AI ───────────────
    console.log("🧮 Step B: Computing CrCl in code...");
    const renalResult = stepB_computeCrCl(extractedData);
    extractedData.renal = { ...extractedData.renal, ...renalResult };

    // Build renal display line (used across stages)
    const renalLine = renalResult.crcl !== null
      ? `SCr ${extractedData.renal.scr_umol ?? "—"} umol, Calculated CrCl ${renalResult.crcl} mL/min`
      : `SCr ${extractedData.renal.scr_umol ?? "—"} umol, Calculated CrCl —`;

    // ── STAGE 1: Case Organizer ────────────────────────────────
    if (requestedStage === 1) {
      console.log("📋 Stage 1: Case Organizer...");
      const template1_soap = await stage1_caseOrganizer(extractedData, renalLine, env);
      
      return json({
        ok: true,
        stage: 1,
        template1_soap,
        extracted_data: extractedData,
        renal: {
          scr_umol: extractedData.renal.scr_umol,
          scr_mgdl: renalResult.scr_mgdl,
          crcl: renalResult.crcl,
          ibw: renalResult.ibw,
          abw_adj: renalResult.abw_adj,
          weight_used: renalResult.weight_used,
          weight_label: renalResult.weight_label,
          missing: renalResult.missing,
          line: renalLine,
        },
        missing_data: extractedData.missing ?? [],
        problems: await detectProblemsFromExtractedData(extractedData, env),
      }, 200, CORS);
    }

    // ── STAGE 2: Problem-to-Treatment Coverage Check ───────────
    if (requestedStage === 2) {
      console.log("📋 Stage 2: Problem-to-Treatment Coverage Check...");
      const problems = await detectProblemsFromExtractedData(extractedData, env);
      const coverageCheck = await stage2_coverageCheck(extractedData, problems, env);
      
      return json({
        ok: true,
        stage: 2,
        template1_soap: await stage1_caseOrganizer(extractedData, renalLine, env),
        renal: {
          scr_umol: extractedData.renal.scr_umol,
          scr_mgdl: renalResult.scr_mgdl,
          crcl: renalResult.crcl,
          ibw: renalResult.ibw,
          abw_adj: renalResult.abw_adj,
          weight_used: renalResult.weight_used,
          weight_label: renalResult.weight_label,
          missing: renalResult.missing,
          line: renalLine,
        },
        missing_data: extractedData.missing ?? [],
        problem_list: problems,
        coverage_check: coverageCheck,
        gaps: coverageCheck.gaps,
      }, 200, CORS);
    }

    // ── STAGE 3: Medication-by-Medication Verification ─────────
    if (requestedStage === 3) {
      console.log("📋 Stage 3: Medication Verification...");
      const problems = await detectProblemsFromExtractedData(extractedData, env);
      const coverageCheck = await stage2_coverageCheck(extractedData, problems, env);
      const medChecks = await stage3_medicationVerification(extractedData, renalResult, problems, env);
      
      return json({
        ok: true,
        stage: 3,
        template1_soap: await stage1_caseOrganizer(extractedData, renalLine, env),
        renal: {
          scr_umol: extractedData.renal.scr_umol,
          scr_mgdl: renalResult.scr_mgdl,
          crcl: renalResult.crcl,
          ibw: renalResult.ibw,
          abw_adj: renalResult.abw_adj,
          weight_used: renalResult.weight_used,
          weight_label: renalResult.weight_label,
          missing: renalResult.missing,
          line: renalLine,
        },
        missing_data: extractedData.missing ?? [],
        problem_list: problems,
        coverage_check: coverageCheck,
        gaps: coverageCheck.gaps,
        med_checks: medChecks,
      }, 200, CORS);
    }

    // ── STAGE 4: Drug Monograph Cards ──────────────────────────
    if (requestedStage === 4) {
      console.log("📋 Stage 4: Drug Monograph Cards...");
      const problems = await detectProblemsFromExtractedData(extractedData, env);
      const coverageCheck = await stage2_coverageCheck(extractedData, problems, env);
      const medChecks = await stage3_medicationVerification(extractedData, renalResult, problems, env);
      const drugCards = await stage4_drugCards(extractedData, renalResult, medChecks, env);
      
      return json({
        ok: true,
        stage: 4,
        template1_soap: await stage1_caseOrganizer(extractedData, renalLine, env),
        renal: {
          scr_umol: extractedData.renal.scr_umol,
          scr_mgdl: renalResult.scr_mgdl,
          crcl: renalResult.crcl,
          ibw: renalResult.ibw,
          abw_adj: renalResult.abw_adj,
          weight_used: renalResult.weight_used,
          weight_label: renalResult.weight_label,
          missing: renalResult.missing,
          line: renalLine,
        },
        missing_data: extractedData.missing ?? [],
        problem_list: problems,
        coverage_check: coverageCheck,
        gaps: coverageCheck.gaps,
        med_checks: medChecks,
        drug_cards: drugCards,
      }, 200, CORS);
    }

    // ── STAGE 5: Complete Pipeline (Backward Compatible) ───────
    console.log("📋 Stage 5: Complete pipeline...");
    
    // Run all stages but combine into existing format
    const problems = await detectProblemsFromExtractedData(extractedData, env);
    const coverageCheck = await stage2_coverageCheck(extractedData, problems, env);
    const medChecks = await stage3_medicationVerification(extractedData, renalResult, problems, env);
    const drugCards = await stage4_drugCards(extractedData, renalResult, medChecks, env);
    
    // ── STEP C1: Template-1 SOAP ───────────────────────────────
    console.log("📋 Step C1: Generating Template-1 SOAP...");
    const template1_soap = await stepC1_template1(extractedData, renalLine, env);

    // ── STEP C2: Clinical Analysis ─────────────────────────────
    console.log("🔬 Step C2: Clinical analysis...");
    const clinical_analysis = await stepC2_analysis(extractedData, renalResult, env);

    // ── STEP C3: Pharmacotherapy Review ────────────────────────
    console.log("💊 Step C3: Pharmacotherapy review...");
    const pharmacotherapy_review = await stepC3_pharmaReview(extractedData, renalResult, clinical_analysis, env);

    // ── STEP C4: Protocol Detection + Interventions ────────────
    console.log("📁 Step C4: Protocol-locked interventions...");
    const interventions = await stepC4_interventions(
      extractedData, renalResult, clinical_analysis, pharmacotherapy_review, env
    );

    // ── STEP C5: Template-2 Pharmacist SOAP Note ────────────────
    console.log("📝 Step C5: Generating Template-2 Pharmacist SOAP...");
    const template2_soap = await stepC5_template2(
      extractedData, renalLine, clinical_analysis, interventions, env
    );

    // ── FINAL RESPONSE (Backward Compatible) ────────────────────
    return json({
      ok: true,
      stage: 5,
      template1_soap,
      clinical_analysis,
      pharmacotherapy_review,
      interventions,
      template2_soap,
      renal: {
        scr_umol: extractedData.renal.scr_umol,
        scr_mgdl: renalResult.scr_mgdl,
        crcl: renalResult.crcl,
        ibw: renalResult.ibw,
        abw_adj: renalResult.abw_adj,
        weight_used: renalResult.weight_used,
        weight_label: renalResult.weight_label,
        missing: renalResult.missing,
        line: renalLine,
      },
      missing_data: extractedData.missing ?? [],
      // Additional stage data for completeness (optional)
      problem_list: problems,
      coverage_check: coverageCheck,
      gaps: coverageCheck.gaps,
      med_checks: medChecks,
      drug_cards: drugCards,
    }, 200, CORS);

  } catch (err) {
    console.error("Pipeline error:", err);
    return json({ ok: false, error: err.message || "Internal server error" }, 500, CORS);
  }
}

// ============================================================
// STAGE 1: Case Organizer
// ============================================================
async function stage1_caseOrganizer(data, renalLine, env) {
  const system = `You are a clinical documentation formatter. Generate a structured SOAP note with NO recommendations or interventions.

STRICT RULES:
- A: section → copy diagnosis/reason VERBATIM from the data. Do NOT interpret or invent.
- If not explicitly stated → write: Primary admission for N/A
- Renal line → copy exactly as provided.
- Missing text fields → N/A  |  Missing numbers → —
- DO NOT add any clinical recommendations, medication changes, or interventions.

Output format (reproduce exactly this structure):

S: Patient (MRN: <mrn or blank>), <age or blank> Y, <weight or blank> kg admitted to <ward or blank>.
Reason for Admission: <text or N/A>
PMH: <text or N/A>
Home Meds: <list or N/A>

O: Vitals: <text or N/A>
Labs: <text or N/A>
Renal: <renal_line>

A: Primary admission for <verbatim reason or N/A>.

P: [Stage 1 - Assessment only. No recommendations yet.]`;

  const ctx = buildContext(data, renalLine);
  return OpenAICall(env, system, `Generate Template-1 SOAP (Stage 1 - no recommendations).\n\n${ctx}`, 600);
}

// ============================================================
// STAGE 2: Problem-to-Treatment Coverage Check
// ============================================================
async function stage2_coverageCheck(data, problems, env) {
  const medList = (data.current_meds_list || []).map(m => m.name).join(", ");
  
  const system = `You are a clinical pharmacist performing a guideline-driven coverage check.

For each problem/diagnosis identified:
1. Determine the recommended pharmacotherapy from LOCAL protocols if available, or from international guidelines.
2. Compare with current medications list.
3. Classify as:
   - MATCHED: Appropriate coverage present
   - PARTIAL: Some elements missing
   - NOT COVERED: Missing key therapy
4. List specific gaps with evidence citations.

CRITICAL RULES:
- Only use problems explicitly stated in the case.
- Every recommendation MUST have evidence citation (protocol filename, guideline with year/section).
- If evidence not found in local protocol → cite authoritative guideline.
- If no evidence at all → "Evidence not found in local protocol."

Output JSON format:
{
  "problems": [
    {
      "name": "problem name",
      "recommended_therapy": "what should be given",
      "current_coverage": "what patient is receiving",
      "status": "MATCHED|PARTIAL|NOT COVERED",
      "gaps": ["specific missing elements"],
      "evidence": "citation with source and year/section"
    }
  ],
  "gaps": ["summary list of all gaps"]
}`;

  const vectorContext = await searchEnhancedVectorStore(
    `treatment guidelines for ${problems.map(p => p.name).join(" ")} ${medList}`,
    env
  );

  const userMsg = `Perform coverage check for these problems:

Problems: ${JSON.stringify(problems, null, 2)}

Current Medications: ${medList || "None listed"}

${vectorContext ? `LOCAL PROTOCOL CONTENT:\n${vectorContext}` : "No local protocol files available — use international guidelines."}`;

  const response = await OpenAICall(env, system, userMsg, 800);
  
  try {
    return JSON.parse(response.replace(/```json|```/g, "").trim());
  } catch {
    return {
      problems: problems.map(p => ({
        name: p.name,
        recommended_therapy: "Unable to determine",
        current_coverage: "Unknown",
        status: "UNKNOWN",
        gaps: ["Insufficient data to assess"],
        evidence: "Evidence not found in local protocol."
      })),
      gaps: ["Unable to assess coverage gaps"]
    };
  }
}

// ============================================================
// STAGE 3: Medication-by-Medication Verification
// ============================================================
async function stage3_medicationVerification(data, renalResult, problems, env) {
  const medList = data.current_meds_list || [];
  const problemNames = problems.map(p => p.name).join(", ");
  
  const system = `You are a clinical pharmacist performing strict medication verification.

For EACH current medication, evaluate ALL of these factors using patient-specific data:

1. Indication present? (from problem list / case facts)
2. Dose correct for age/weight/renal function (CrCl: ${renalResult.crcl || "unknown"} mL/min)
3. Frequency correct?
4. Duration defined?
5. Contraindications based on PMH and current labs/vitals?
6. Drug–drug interactions with other meds?
7. Drug–lab conflicts (e.g., nephrotoxic meds in AKI, K+ with ACEI/ARB, INR with warfarin, etc.)
8. Monitoring parameters required with targets + timeframe?

CRITICAL RULES:
- MUST use actual patient data: age ${data.age || "unknown"}, weight ${data.weight_kg || "unknown"}kg, CrCl ${renalResult.crcl || "unknown"}
- If data missing for any check → explicitly state "Cannot assess because missing X"
- Every issue flagged MUST have evidence citation
- If evidence not found → "Evidence not found in local protocol."

Output JSON format:
{
  "medications": [
    {
      "name": "medication name",
      "checks": {
        "indication": {"status": "OK|ISSUE|CANNOT_ASSESS", "note": "explanation", "evidence": "citation"},
        "dose": {"status": "OK|ISSUE|CANNOT_ASSESS", "note": "explanation", "evidence": "citation"},
        "frequency": {"status": "OK|ISSUE|CANNOT_ASSESS", "note": "explanation"},
        "duration": {"status": "OK|ISSUE|CANNOT_ASSESS", "note": "explanation"},
        "contraindications": {"status": "OK|ISSUE|CANNOT_ASSESS", "note": "explanation", "evidence": "citation"},
        "interactions": {"status": "OK|ISSUE|CANNOT_ASSESS", "note": "explanation", "evidence": "citation"},
        "drug_lab": {"status": "OK|ISSUE|CANNOT_ASSESS", "note": "explanation", "evidence": "citation"},
        "monitoring": {"status": "OK|ISSUE|CANNOT_ASSESS", "note": "required monitoring", "evidence": "citation"}
      },
      "issues": ["list of specific issues found"],
      "missing_data_needed": ["what's missing to fully assess"]
    }
  ]
}`;

  const vectorContext = await searchEnhancedVectorStore(
    `medication safety monitoring contraindications dosing ${medList.map(m => m.name).join(" ")}`,
    env
  );

  const userMsg = `Perform medication verification for this patient:

Patient Data:
- Age: ${data.age || "unknown"}
- Weight: ${data.weight_kg || "unknown"} kg
- CrCl: ${renalResult.crcl || "unknown"} mL/min
- Sex: ${data.sex || "unknown"}
- PMH: ${data.pmh || "N/A"}
- Labs: ${data.labs_text || "N/A"}
- Vitals: ${data.vitals_text || "N/A"}

Problems: ${problemNames || "None identified"}

Medications to verify:
${JSON.stringify(medList, null, 2)}

${vectorContext ? `LOCAL PROTOCOL CONTENT:\n${vectorContext}` : "No local protocol files available — use international guidelines."}`;

  const response = await OpenAICall(env, system, userMsg, 1200);
  
  try {
    return JSON.parse(response.replace(/```json|```/g, "").trim());
  } catch {
    return {
      medications: medList.map(med => ({
        name: med.name,
        checks: {
          indication: {status: "CANNOT_ASSESS", note: "Unable to verify", evidence: "Evidence not found in local protocol."},
          dose: {status: "CANNOT_ASSESS", note: "Unable to verify", evidence: "Evidence not found in local protocol."},
          frequency: {status: "CANNOT_ASSESS", note: "Unable to verify"},
          duration: {status: "CANNOT_ASSESS", note: "Unable to verify"},
          contraindications: {status: "CANNOT_ASSESS", note: "Unable to verify", evidence: "Evidence not found in local protocol."},
          interactions: {status: "CANNOT_ASSESS", note: "Unable to verify", evidence: "Evidence not found in local protocol."},
          drug_lab: {status: "CANNOT_ASSESS", note: "Unable to verify", evidence: "Evidence not found in local protocol."},
          monitoring: {status: "CANNOT_ASSESS", note: "Unable to verify", evidence: "Evidence not found in local protocol."}
        },
        issues: ["Unable to verify due to missing data or evidence"],
        missing_data_needed: ["age", "weight", "SCr", "labs"].filter(f => !data[f])
      }))
    };
  }
}

// ============================================================
// STAGE 4: Drug Monograph Cards (Protocol Locked)
// ============================================================
async function stage4_drugCards(data, renalResult, medChecks, env) {
  const medList = data.current_meds_list || [];
  
  const system = `You are a clinical pharmacist generating evidence-based drug monograph cards.

For each medication, provide:

- Indication (for this patient)
- Recommended dose range (renal-adjusted if needed, based on CrCl ${renalResult.crcl || "unknown"})
- Monitoring targets and frequency
- Key contraindications and warnings relevant to this patient
- Management pearls

CRITICAL RULES:
- MUST cite LOCAL protocol monograph evidence if available (filename + section)
- If local evidence missing → cite original guideline/drug reference (BNF, Lexicomp, IDSA, ACC/AHA, etc.) with year/section
- NEVER fabricate citations
- If no evidence found → "Evidence not found in local protocol."
- Use patient-specific data where available

Output JSON format:
{
  "drug_cards": [
    {
      "name": "medication name",
      "indication": "specific indication for this patient",
      "dose_range": "recommended dose with renal adjustment if needed",
      "monitoring": {
        "parameters": ["list of parameters"],
        "frequency": "monitoring frequency",
        "targets": "therapeutic targets"
      },
      "contraindications": ["relevant contraindications for this patient"],
      "warnings": ["key warnings"],
      "pearls": ["management pearls"],
      "evidence": {
        "source": "citation with filename/guideline",
        "year": "year",
        "section": "section if available"
      }
    }
  ]
}`;

  const vectorContext = await searchEnhancedVectorStore(
    `drug monograph dosing monitoring ${medList.map(m => m.name).join(" ")}`,
    env
  );

  const userMsg = `Generate drug monograph cards for this patient:

Patient Context:
- Age: ${data.age || "unknown"}
- Weight: ${data.weight_kg || "unknown"} kg
- CrCl: ${renalResult.crcl || "unknown"} mL/min
- Problems: ${data.reason_admission || "unknown"}
- PMH: ${data.pmh || "N/A"}

Medications:
${JSON.stringify(medList, null, 2)}

Previous Medication Checks (for context):
${JSON.stringify(medChecks, null, 2)}

${vectorContext ? `LOCAL PROTOCOL CONTENT (CITE THIS IF RELEVANT):\n${vectorContext}` : "No local protocol files available — use international guidelines."}`;

  const response = await OpenAICall(env, system, userMsg, 1200);
  
  try {
    return JSON.parse(response.replace(/```json|```/g, "").trim());
  } catch {
    return {
      drug_cards: medList.map(med => ({
        name: med.name,
        indication: "Unable to determine",
        dose_range: "Unable to determine",
        monitoring: {
          parameters: ["Unable to determine"],
          frequency: "Unknown",
          targets: "Unknown"
        },
        contraindications: ["Unable to assess"],
        warnings: ["Unable to assess"],
        pearls: ["Insufficient data"],
        evidence: {
          source: "Evidence not found in local protocol.",
          year: "",
          section: ""
        }
      }))
    };
  }
}

// ============================================================
// HELPER: Detect Problems from Extracted Data
// ============================================================
async function detectProblemsFromExtractedData(data, env) {
  const system = `You are a clinical data extractor. Identify ALL problems/diagnoses explicitly mentioned in the case.

STRICT RULES:
- ONLY include problems explicitly stated (reason for admission, PMH, assessment notes)
- Do NOT infer or assume problems
- Return as JSON array: [{"name": "problem name", "context": "where mentioned"}]
- If no problems found, return empty array`;

  const userMsg = `Extract all explicit problems/diagnoses from this data:

Reason for Admission: ${data.reason_admission || "N/A"}
PMH: ${data.pmh || "N/A"}
Current Medications Context: ${data.current_meds_text || "N/A"}`;

  const response = await OpenAICall(env, system, userMsg, 400);
  
  try {
    return JSON.parse(response.replace(/```json|```/g, "").trim());
  } catch {
    return [];
  }
}

// ============================================================
// ENHANCED HELPER: Search OpenAI Vector Store with configurable results
// ============================================================
async function searchEnhancedVectorStore(query, env, maxResults = 8) {
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
    return "";
  }

  try {
    const res = await fetch(
      `https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({ 
          query, 
          max_num_results: maxResults,
          include_metadata: true
        }),
      }
    );

    if (!res.ok) {
      console.warn("Vector store search failed:", res.status);
      return "";
    }

    const data = await res.json();
    if (!data?.data?.length) return "";

    return data.data
      .map((item, i) => {
        const content = extractContent(item);
        const filename = item.filename || item.file_id || `Protocol ${i + 1}`;
        const page = item.metadata?.page || item.metadata?.section || "";
        const pageInfo = page ? ` [Page/Section: ${page}]` : "";
        
        return `--- ${filename}${pageInfo} ---\n${content.substring(0, 500)}`;
      })
      .join("\n\n");

  } catch (err) {
    console.error("Vector store error:", err);
    return "";
  }
}

// ============================================================
// BACKWARD COMPATIBLE: Original vector search (keep for existing calls)
// ============================================================
async function searchVectorStore(query, env) {
  return searchEnhancedVectorStore(query, env, 3); // Default to 3 for backward compatibility
}

// ============================================================
// STEP A — Extract structured data (OPENAI AI) - UNCHANGED
// ============================================================
async function stepA_extract(caseText, env) {
  const system = `You are a clinical data extractor. Extract data from unstructured clinical text.
STRICT RULES:
- NO assumptions. If data is not explicitly stated → set to null.
- Do NOT invent diagnoses, medications, or lab values.
- Return ONLY a valid JSON object. No markdown. No explanation.

JSON schema (use exactly these keys):
{
  "mrn": string|null,
  "age": number|null,
  "sex": "male"|"female"|null,
  "height_raw": string|null,
  "weight_kg": number|null,
  "ward": string|null,
  "reason_admission": string|null,
  "pmh": string|null,
  "allergies": string|null,
  "home_meds": string|null,
  "vitals_text": string|null,
  "labs_text": string|null,
  "scr_umol": number|null,
  "current_meds_text": string|null,
  "current_meds_list": [{"name":string,"dose":string|null,"frequency":string|null,"route":string|null}],
  "imaging": string|null,
  "missing": []
}`;

  const raw = await OpenAICall(
    env,
    system,
    `Extract structured data from this clinical case:\n\n${caseText}`,
    800
  );

  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const data = JSON.parse(clean);

    // Track missing essential fields
    const missing = [];
    if (!data.age)      missing.push("age");
    if (!data.sex)      missing.push("sex");
    if (!data.weight_kg) missing.push("weight");
    if (!data.scr_umol) missing.push("SCr");

    return {
      ...data,
      renal: { scr_umol: data.scr_umol },
      missing,
    };
  } catch {
    // Fallback: return minimal structure
    return {
      mrn: null, age: null, sex: null, height_raw: null, weight_kg: null,
      ward: null, reason_admission: null, pmh: null, allergies: null,
      home_meds: null, vitals_text: null, labs_text: null, scr_umol: null,
      current_meds_text: null, current_meds_list: [],
      imaging: null, renal: { scr_umol: null },
      missing: ["age", "sex", "weight", "SCr"],
    };
  }
}

// ============================================================
// STEP B — Cockcroft-Gault CrCl (PURE CODE — no AI) - UNCHANGED
// ============================================================
function stepB_computeCrCl(data) {
  const result = {
    scr_mgdl: null, ibw: null, abw_adj: null,
    weight_used: null, weight_label: null,
    crcl: null, missing: [],
  };

  if (!data.age)       result.missing.push("age");
  if (!data.sex)       result.missing.push("sex");
  if (!data.weight_kg) result.missing.push("weight");
  if (!data.scr_umol)  result.missing.push("SCr");
  if (result.missing.length > 0) return result;

  // Convert SCr µmol/L → mg/dL
  result.scr_mgdl = parseFloat((data.scr_umol / 88.4).toFixed(3));

  const female = String(data.sex).toLowerCase().startsWith("f");

  // Parse height → cm → inches
  let heightIn = null;
  if (data.height_raw) {
    const s = String(data.height_raw).toLowerCase();
    let cm = null;

    const mCm   = s.match(/(\d+\.?\d*)\s*cm/);
    const mFtIn = s.match(/(\d+)\s*(?:ft|')\s*(\d*)\s*(?:in|")?/);
    const mIn   = s.match(/(\d+\.?\d*)\s*(?:in|")/);
    const mNum  = s.match(/^(\d+\.?\d*)$/);

    if (mCm)    cm = parseFloat(mCm[1]);
    else if (mFtIn) cm = parseInt(mFtIn[1]) * 30.48 + parseInt(mFtIn[2] || 0) * 2.54;
    else if (mIn)   cm = parseFloat(mIn[1]) * 2.54;
    else if (mNum)  cm = parseFloat(mNum[1]) > 100 ? parseFloat(mNum[1]) : parseFloat(mNum[1]) * 2.54;

    if (cm) heightIn = cm / 2.54;
  }

  // IBW (Devine) + ABW_adjusted
  if (heightIn && heightIn > 60) {
    result.ibw     = parseFloat((female ? 45.5 + 2.3 * (heightIn - 60) : 50 + 2.3 * (heightIn - 60)).toFixed(1));
    result.abw_adj = parseFloat((result.ibw + 0.4 * (data.weight_kg - result.ibw)).toFixed(1));
  }

  // Weight selection rule
  if (result.ibw && data.weight_kg >= 1.2 * result.ibw) {
    result.weight_used  = result.abw_adj;
    result.weight_label = "ABW adjusted (obese ≥1.2×IBW)";
  } else if (result.ibw && data.weight_kg <= result.ibw) {
    result.weight_used  = data.weight_kg;
    result.weight_label = "Actual BW (≤IBW)";
  } else {
    result.weight_used  = data.weight_kg;
    result.weight_label = result.ibw ? "Actual BW" : "Actual BW (height missing)";
  }

  // Cockcroft-Gault
  result.crcl = Math.round(
    ((140 - data.age) * result.weight_used * (female ? 0.85 : 1.0)) / (72 * result.scr_mgdl)
  );

  return result;
}

// ============================================================
// STEP C1 — Template-1 SOAP - UNCHANGED
// ============================================================
async function stepC1_template1(data, renalLine, env) {
  const system = `You are a clinical documentation formatter.
Generate EXACTLY this SOAP structure. No markdown, no bold, no extra sections.

STRICT RULES:
- A: section → copy diagnosis/reason VERBATIM from the data. Do NOT interpret or invent.
- If not explicitly stated → write: Primary admission for N/A
- Renal line → copy exactly as provided.
- Missing text fields → N/A  |  Missing numbers → —

Output format (reproduce exactly this structure):

S: Patient (MRN: <mrn or blank>), <age or blank> Y, <weight or blank> kg admitted to <ward or blank>.
Reason for Admission: <text or N/A>
PMH: <text or N/A>
Home Meds: <list or N/A>

O: Vitals: <text or N/A>
Labs: <text or N/A>
Renal: <renal_line>

A: Primary admission for <verbatim reason or N/A>.

P:
Current Medications: <list or N/A>`;

  const ctx = buildContext(data, renalLine);
  return OpenAICall(env, system, `Generate Template-1 SOAP.\n\n${ctx}`, 600);
}

// ============================================================
// STEP C2 — Clinical Analysis - UNCHANGED
// ============================================================
async function stepC2_analysis(data, renalResult, env) {
  const system = `You are a clinical pharmacist performing structured pharmacotherapy analysis.
Use general medical and pharmacological knowledge.

Output exactly these labeled sections (no markdown):

PRIMARY ACUTE CONDITION
Identify the main inpatient problem from documented findings only.

MEDICATION REVIEW
For each medication (home + inpatient) evaluate:
Indication | Dose | Frequency | Duration | Contraindications | Drug interactions | Drug-lab issues | Renal dose adjustment (use the CrCl provided)

CLINICAL FLAGS
Top 3-5 concerns requiring pharmacist attention. Be specific and clinically precise.`;

  const ctx = buildContext(data, renalResult.crcl !== null
    ? `SCr ${data.scr_umol ?? "—"} umol, CrCl ${renalResult.crcl} mL/min`
    : `SCr ${data.scr_umol ?? "—"} umol, CrCl —`);
  return OpenAICall(env, system, `Perform clinical pharmacotherapy analysis.\n\n${ctx}`, 900);
}

// ============================================================
// STEP C3 — Pharmacotherapy Review - UNCHANGED
// ============================================================
async function stepC3_pharmaReview(data, renalResult, clinicalAnalysis, env) {
  const system = `You are a clinical pharmacist. Based on the case data and clinical analysis provided, generate a structured pharmacotherapy review.

For each current medication evaluate:
1. Indication — is it appropriate?
2. Dose — correct for this patient (age/weight/organ function)?
3. Frequency — appropriate?
4. Duration — defined?
5. Drug–drug interactions — any significant?
6. Contraindications — any for this patient?
7. Renal dose adjustment — required based on CrCl?
8. Drug–lab conflicts — any?

Use general clinical knowledge. Be concise and specific.`;

  const crclLine = renalResult.crcl !== null ? `CrCl: ${renalResult.crcl} mL/min` : "CrCl: — (missing data)";
  const ctx = buildContext(data, crclLine);
  return OpenAICall(env, system,
    `Review pharmacotherapy for this case.\n\n${ctx}\n\nClinical Analysis:\n${clinicalAnalysis}`, 900);
}

// ============================================================
// STEP C4 — Protocol-Locked Interventions - ENHANCED with better evidence
// ============================================================
async function stepC4_interventions(data, renalResult, clinicalAnalysis, pharmaReview, env) {
  // Build search query from primary problem + medications
  const primaryProblem = extractPrimaryProblem(clinicalAnalysis);
  const medNames = (data.current_meds_list || []).map(m => m.name).join(", ");

  // --- Enhanced vector store search (configurable results) ---
  let vectorContext = "";
  if (env.OPENAI_API_KEY && env.VECTOR_STORE_ID) {
    vectorContext = await searchEnhancedVectorStore(
      `${primaryProblem} pharmacist interventions dosing renal monitoring ${medNames}`,
      env,
      parseInt(env.TOP_K) || 8
    );
  }

  // --- Generate interventions (protocol-locked prompt) ---
  const system = `You are a clinical pharmacist generating evidence-based interventions.

CRITICAL RULES:
- Every intervention MUST have an Evidence line.
- If local protocol text is provided below — cite it with filename + section.
- If no local protocol → cite recognized international guidelines (Surviving Sepsis Campaign 2021, IDSA CAP 2019, ACC/AHA, ACCP, BNF, etc.) with year and section.
- If genuinely no evidence available → write EXACTLY: "Evidence not found in local protocol."
- NEVER fabricate citations. NEVER invent guideline content.

Format each intervention EXACTLY as:
[N]. Intervention: <specific recommendation>
    Rationale: <clinical reasoning>
    Evidence: <citation — or "Evidence not found in local protocol.">
    Priority: HIGH / MEDIUM / LOW`;

  const crclLine = renalResult.crcl !== null ? `CrCl: ${renalResult.crcl} mL/min` : "CrCl: —";
  const ctx = buildContext(data, crclLine);

  const userMsg = `Generate pharmacist interventions for this case.

${ctx}

Clinical Analysis:
${clinicalAnalysis}

Pharmacotherapy Review:
${pharmaReview}

${vectorContext ? `LOCAL PROTOCOL CONTENT (cite this if relevant):\n${vectorContext}` : "No local protocol files available — use international guidelines."}`;

  return OpenAICall(env, system, userMsg, 900);
}

// ============================================================
// STEP C5 — Template-2 Pharmacist SOAP Note - UNCHANGED
// ============================================================
async function stepC5_template2(data, renalLine, clinicalAnalysis, interventions, env) {
  const system = `You are a clinical pharmacist writing a formal Pharmacist SOAP Note.

Output EXACTLY this structure. No markdown. No bold. No extra sections:

S: Patient (MRN: <mrn>), <age> Y, <weight> kg admitted to <ward>.
Reason for Admission: <text or N/A>
PMH: <text or N/A>
Home Meds: <text or N/A>

O: Vitals: <text or N/A>
Labs: <text or N/A>
Renal: <renal_line>

A: Primary admission for <acute issue from case — if unclear write: acute issues>. Clinical review performed.

P:
Current Medications:
<list each med starting with ->

Pharmacist Intervention:
<copy the interventions exactly as provided>

Follow-up Plan:
<monitoring parameters, targets, frequency>

RULES:
- Evidence lines must be preserved exactly from the interventions provided.
- "Evidence not found in local protocol." must be kept as-is if present.
- Follow-up Plan must include specific monitoring targets and timeframes.`;

  const ctx = buildContext(data, renalLine);
  return OpenAICall(env, system,
    `Generate Template-2 Pharmacist SOAP Note.\n\n${ctx}\n\nInterventions:\n${interventions}`, 900);
}

// ============================================================
// HELPER: Build context block for all prompts - UNCHANGED
// ============================================================
function buildContext(data, renalLine) {
  return `
PATIENT DATA:
MRN: ${data.mrn ?? ""}
Age: ${data.age ?? "—"} Y  |  Sex: ${data.sex ?? "—"}  |  Weight: ${data.weight_kg ?? "—"} kg  |  Height: ${data.height_raw ?? "—"}
Ward: ${data.ward ?? "—"}
Reason for Admission: ${data.reason_admission ?? "N/A"}
PMH: ${data.pmh ?? "N/A"}
Allergies: ${data.allergies ?? "N/A"}
Home Medications: ${data.home_meds ?? "N/A"}
Vitals: ${data.vitals_text ?? "N/A"}
Labs: ${data.labs_text ?? "N/A"}
Imaging: ${data.imaging ?? "N/A"}
Current Medications: ${data.current_meds_text ?? "N/A"}
Renal (pre-calculated): ${renalLine}
`.trim();
}

// ============================================================
// HELPER: Extract primary problem string from analysis text - UNCHANGED
// ============================================================
function extractPrimaryProblem(analysisText) {
  const match = analysisText?.match(/PRIMARY ACUTE CONDITION[\s\S]{0,5}\n([^\n]+)/i);
  return match ? match[1].trim() : "acute inpatient condition";
}

// ============================================================
// HELPER: Extract content from vector store response - UNCHANGED
// ============================================================
function extractContent(item) {
  if (!item.content) return item.text || "";
  if (Array.isArray(item.content)) return item.content.map(c => c.text || c.value || "").join("\n");
  if (typeof item.content === "string") return item.content;
  if (item.content.text) return item.content.text;
  return item.text || "";
}

// ============================================================
// HELPER: OpenAI API call - UNCHANGED
// ============================================================
async function OpenAICall(env, system, userMessage, maxTokens = 800) {
  const model = env.MODEL || "gpt-4-turbo-preview";
  
  console.log(`Calling OpenAI with model: ${model}`);
  
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model,
      max_tokens: maxTokens,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage }
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("OpenAI API error:", err);
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ============================================================
// HELPER: JSON response - UNCHANGED
// ============================================================
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
