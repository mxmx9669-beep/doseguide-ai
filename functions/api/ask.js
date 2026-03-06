// File: /functions/api/ask.js
// TheraGuard AI — Clinical Audit Engine v2
// Architecture: 9-Layer Clinical Reasoning Pipeline
//
// PIPELINE OVERVIEW:
//   L1  Case Normalization        — parse raw text into structured object
//   L2  Clinical Entity Extraction — organize meds, labs, vitals, diagnoses
//   L3  Derived Clinical State    — compute CrCl, risk flags, safety signals
//   L4  Med-by-Med Review         — per-drug indication/dose/safety analysis
//   L5  Deterministic Safety Rules — rule engine fires before retrieval
//   L6  Targeted RAG Query Gen    — issue-specific multi-query strategy
//   L7  Evidence Matching         — per-issue chunk retrieval + validation
//   L8  Issue Prioritization      — severity ranking (Critical→Minor)
//   L9  Final Report Generation   — SOAP + Interventions + Adjustments + Citations

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
    return jsonResponse({ ok: false, error: error?.message || "Internal server error" }, 500, corsHeaders);
  }
}

/* =========================================================
   REFERENCE DATA
   All lab ranges, safety rules, and clinical thresholds live
   here so the rule engine is data-driven, not hardcoded.
========================================================= */

const LAB_RANGES = {
  hb:           { label: "Hb",               unit: "g/dL",    low: 12,   high: 17.5, section: "cbc",        drugRelated: ["anticoagulants","iron","ESA"] },
  wbc:          { label: "WBC",              unit: "×10⁹/L",  low: 4,    high: 11,   section: "cbc",        drugRelated: ["antibiotics","immunosuppressants"] },
  plt:          { label: "Platelets",        unit: "×10⁹/L",  low: 150,  high: 400,  section: "cbc",        drugRelated: ["anticoagulants","heparin","antiplatelet"] },
  neutrophil:   { label: "Neutrophils",      unit: "×10⁹/L",  low: 1.8,  high: 7.5,  section: "cbc",        drugRelated: ["G-CSF","immunosuppressants"] },
  scr_umol:     { label: "SCr",              unit: "µmol/L",  low: null, high: 106,  section: "renal",      drugRelated: ["renal dosing","nephrotoxins"] },
  scr_mgdl:     { label: "SCr",              unit: "mg/dL",   low: null, high: 1.2,  section: "renal",      drugRelated: ["renal dosing","nephrotoxins"] },
  urea:         { label: "Urea",             unit: "mmol/L",  low: null, high: 7.1,  section: "renal",      drugRelated: [] },
  bun:          { label: "BUN",              unit: "mmol/L",  low: null, high: 7.1,  section: "renal",      drugRelated: [] },
  na:           { label: "Na",               unit: "mmol/L",  low: 136,  high: 145,  section: "electrolytes", drugRelated: ["IV fluids","diuretics"] },
  k:            { label: "K",                unit: "mmol/L",  low: 3.5,  high: 5.0,  section: "electrolytes", drugRelated: ["diuretics","ACEi/ARB","insulin","antiarrhythmics"] },
  cl:           { label: "Cl",               unit: "mmol/L",  low: 98,   high: 107,  section: "electrolytes", drugRelated: [] },
  bicarb:       { label: "HCO3",             unit: "mmol/L",  low: 22,   high: 29,   section: "electrolytes", drugRelated: ["diuretics"] },
  ca:           { label: "Ca",               unit: "mmol/L",  low: 2.12, high: 2.62, section: "electrolytes", drugRelated: ["calcium therapy","digoxin"] },
  mg:           { label: "Mg",               unit: "mmol/L",  low: 0.74, high: 1.03, section: "electrolytes", drugRelated: ["aminoglycosides","diuretics","PPIs"] },
  phos:         { label: "Phos",             unit: "mmol/L",  low: 0.81, high: 1.45, section: "electrolytes", drugRelated: ["phosphate binders"] },
  alt:          { label: "ALT",              unit: "U/L",     low: null, high: 56,   section: "liver",      drugRelated: ["hepatotoxic drugs","paracetamol","statins"] },
  ast:          { label: "AST",              unit: "U/L",     low: null, high: 40,   section: "liver",      drugRelated: ["hepatotoxic drugs","statins"] },
  alp:          { label: "ALP",              unit: "U/L",     low: null, high: 120,  section: "liver",      drugRelated: [] },
  bili_t:       { label: "Total Bilirubin",  unit: "µmol/L",  low: null, high: 21,   section: "liver",      drugRelated: ["hepatotoxic drugs"] },
  albumin:      { label: "Albumin",          unit: "g/L",     low: 35,   high: 50,   section: "liver",      drugRelated: ["warfarin","phenytoin","protein binding"] },
  inr:          { label: "INR",              unit: "",        low: null, high: 1.2,  section: "coagulation", drugRelated: ["warfarin","bleeding risk"] },
  pt:           { label: "PT",               unit: "sec",     low: null, high: 13.5, section: "coagulation", drugRelated: ["warfarin"] },
  aptt:         { label: "aPTT",             unit: "sec",     low: null, high: 35,   section: "coagulation", drugRelated: ["heparin"] },
  fibrinogen:   { label: "Fibrinogen",       unit: "g/L",     low: 2,    high: 4,    section: "coagulation", drugRelated: [] },
  crp:          { label: "CRP",              unit: "mg/L",    low: null, high: 10,   section: "infection",  drugRelated: ["antibiotics"] },
  procalc:      { label: "PCT",              unit: "µg/L",    low: null, high: 0.5,  section: "infection",  drugRelated: ["antibiotics"] },
  lactate:      { label: "Lactate",          unit: "mmol/L",  low: null, high: 2.0,  section: "infection",  drugRelated: ["sepsis","metformin"] },
  glucose:      { label: "Glucose",          unit: "mmol/L",  low: 3.9,  high: 7.8,  section: "metabolic",  drugRelated: ["insulin","steroids"] },
  vanc_trough:  { label: "Vancomycin Trough",unit: "mg/L",    low: 10,   high: 20,   section: "tdm",        drugRelated: ["vancomycin"] },
  vanc_auc:     { label: "Vancomycin AUC",   unit: "mg·h/L",  low: 400,  high: 600,  section: "tdm",        drugRelated: ["vancomycin"] },
  genta_trough: { label: "Gentamicin Trough",unit: "mg/L",    low: null, high: 2,    section: "tdm",        drugRelated: ["gentamicin"] },
  tobra_trough: { label: "Tobramycin Trough",unit: "mg/L",    low: null, high: 2,    section: "tdm",        drugRelated: ["tobramycin"] },
  digoxin:      { label: "Digoxin",          unit: "µg/L",    low: 0.5,  high: 2,    section: "tdm",        drugRelated: ["digoxin"] },
  phenytoin:    { label: "Phenytoin",        unit: "mg/L",    low: 10,   high: 20,   section: "tdm",        drugRelated: ["phenytoin"] },
  valproate:    { label: "Valproate",        unit: "mg/L",    low: 50,   high: 100,  section: "tdm",        drugRelated: ["valproate"] },
  tacro:        { label: "Tacrolimus",       unit: "µg/L",    low: 5,    high: 15,   section: "tdm",        drugRelated: ["tacrolimus"] },
  cyclo:        { label: "Cyclosporine",     unit: "µg/L",    low: 100,  high: 400,  section: "tdm",        drugRelated: ["cyclosporine"] },
};

const BORDERLINE_MARGIN = 0.15;

const LAB_SECTION_ORDER = ["renal","cbc","electrolytes","liver","coagulation","infection","metabolic","tdm"];
const SECTION_TITLES = {
  renal: "Renal", cbc: "CBC", electrolytes: "Electrolytes",
  liver: "Liver Function", coagulation: "Coagulation",
  infection: "Infection / Sepsis Profile", metabolic: "Glucose / Metabolic",
  tdm: "Drug Monitoring / TDM",
};

// ─── L5: Deterministic Safety Rules ───────────────────────────────────────────
// Each rule is a pure function: (clinicalState) → issue | null
// Add new rules here without touching any other logic.
// Pattern: { id, severity, test(state), problem, recommendation, queries[] }

const SAFETY_RULES = [

  // ── Renal dosing ──────────────────────────────────────────────────────────
  {
    id: "RENAL_METFORMIN",
    severity: "Critical",
    test: (s) => s.renalFlag && s.crcl && s.crcl.value < 30 && s.hasDrug(["metformin"]),
    problem: "Metformin use with CrCl <30 mL/min — lactic acidosis risk",
    recommendation: "Discontinue metformin immediately. CrCl <30 mL/min is an absolute contraindication.",
    queries: (s) => ["metformin contraindication renal impairment", "metformin lactic acidosis CrCl threshold"],
  },
  {
    id: "RENAL_METFORMIN_LACTATE",
    severity: "Critical",
    test: (s) => s.hasDrug(["metformin"]) && s.labs.lactate && s.labs.lactate > 2.0,
    problem: "Metformin + elevated lactate — high risk of metformin-associated lactic acidosis (MALA)",
    recommendation: "Stop metformin. Investigate lactic acidosis etiology. Consider ICU-level monitoring.",
    queries: () => ["metformin lactic acidosis MALA", "metformin elevated lactate management"],
  },
  {
    id: "RENAL_NSAID",
    severity: "Major",
    test: (s) => s.renalFlag && s.hasDrug(["ibuprofen","naproxen","diclofenac","ketorolac","celecoxib","indomethacin"]),
    problem: "NSAID use with renal impairment — risk of AKI worsening",
    recommendation: "Avoid NSAIDs. Consider alternative analgesia (paracetamol, weak opioids).",
    queries: () => ["NSAID renal impairment contraindication","NSAID AKI risk"],
  },
  {
    id: "RENAL_AMINOGLYCOSIDE",
    severity: "Major",
    test: (s) => s.renalFlag && s.hasDrug(["gentamicin","tobramycin","amikacin","streptomycin"]),
    problem: "Aminoglycoside with renal impairment — nephrotoxicity + ototoxicity risk",
    recommendation: "Extend dosing interval per CrCl. Monitor drug levels and renal function.",
    queries: (s) => [
      `aminoglycoside renal dose adjustment CrCl ${Math.round(s.crcl?.value || 0)}`,
      "aminoglycoside nephrotoxicity monitoring",
    ],
  },
  {
    id: "RENAL_VANCOMYCIN",
    severity: "Major",
    test: (s) => s.renalFlag && s.hasDrug(["vancomycin"]),
    problem: "Vancomycin with renal impairment — requires dose/interval adjustment",
    recommendation: "Adjust vancomycin dose/frequency based on CrCl. Target AUC/MIC 400–600 mg·h/L.",
    queries: (s) => [
      `vancomycin renal dose adjustment CrCl ${Math.round(s.crcl?.value || 0)}`,
      "vancomycin AUC monitoring renal impairment",
    ],
  },
  {
    id: "RENAL_DIGOXIN",
    severity: "Major",
    test: (s) => s.renalFlag && s.hasDrug(["digoxin"]),
    problem: "Digoxin with renal impairment — reduced clearance, toxicity risk",
    recommendation: "Reduce digoxin dose. Monitor serum levels and signs of toxicity.",
    queries: () => ["digoxin renal impairment dose","digoxin toxicity monitoring"],
  },
  {
    id: "RENAL_ACEI_ARB",
    severity: "Moderate",
    test: (s) => s.renalFlag && s.hasDrug(["lisinopril","enalapril","ramipril","captopril","perindopril","losartan","valsartan","irbesartan","candesartan","telmisartan"]),
    problem: "ACEi/ARB with renal impairment — worsening renal function risk",
    recommendation: "Monitor SCr and potassium closely. Consider dose reduction or temporary hold if AKI.",
    queries: () => ["ACE inhibitor ARB renal impairment monitoring","ACEi ARB AKI worsening"],
  },
  {
    id: "RENAL_SPIRO",
    severity: "Moderate",
    test: (s) => s.crcl && s.crcl.value < 30 && s.hasDrug(["spironolactone","eplerenone"]),
    problem: "Spironolactone/eplerenone with CrCl <30 — severe hyperkalemia risk",
    recommendation: "Avoid spironolactone if CrCl <30 mL/min. High risk of life-threatening hyperkalemia.",
    queries: () => ["spironolactone contraindication renal failure","spironolactone hyperkalemia CrCl"],
  },

  // ── Hyperkalemia compound rules ────────────────────────────────────────────
  {
    id: "HYPERK_ACEI_SPIRO",
    severity: "Critical",
    test: (s) =>
      s.labs.k && s.labs.k > 5.5 &&
      s.hasDrug(["spironolactone","eplerenone"]) &&
      s.hasDrug(["lisinopril","enalapril","ramipril","captopril","perindopril","losartan","valsartan","irbesartan","candesartan","telmisartan"]),
    problem: "Hyperkalemia + ACEi/ARB + potassium-sparing diuretic — life-threatening K⁺ elevation",
    recommendation: "Hold potassium-sparing diuretic and ACEi/ARB. Treat hyperkalemia immediately. Cardiac monitoring.",
    queries: () => ["hyperkalemia ACE inhibitor spironolactone management","dangerous hyperkalemia triple combination"],
  },
  {
    id: "HYPERK_SINGLE",
    severity: "Major",
    test: (s) =>
      s.labs.k && s.labs.k > 5.5 &&
      (s.hasDrug(["spironolactone","eplerenone"]) || s.hasDrug(["lisinopril","enalapril","ramipril","captopril","perindopril","losartan","valsartan","irbesartan","candesartan","telmisartan"])),
    problem: "Hyperkalemia with potassium-elevating drug",
    recommendation: "Review and potentially hold offending drug. Monitor K⁺ closely.",
    queries: () => ["hyperkalemia drug-induced management","potassium-elevating drugs monitoring"],
  },

  // ── Thrombocytopenia + anticoagulation ────────────────────────────────────
  {
    id: "THROMBO_ANTICOAG",
    severity: "Critical",
    test: (s) => s.labs.plt && s.labs.plt < 50 && s.hasDrug(["heparin","enoxaparin","dalteparin","fondaparinux","warfarin","rivaroxaban","apixaban","dabigatran","edoxaban"]),
    problem: "Severe thrombocytopenia (PLT <50) with anticoagulant — critical bleeding risk",
    recommendation: "Reassess anticoagulant indication urgently. Risk/benefit must be weighed. Consider dose reduction or hold.",
    queries: () => ["anticoagulation thrombocytopenia management","anticoagulation PLT threshold bleeding risk"],
  },
  {
    id: "THROMBO_ANTIPLATELET",
    severity: "Major",
    test: (s) => s.labs.plt && s.labs.plt < 100 && s.hasDrug(["aspirin","clopidogrel","ticagrelor","prasugrel"]),
    problem: "Thrombocytopenia with antiplatelet agent — increased bleeding risk",
    recommendation: "Review antiplatelet indication. Consider holding if PLT <50 unless stent/ACS indication overrides.",
    queries: () => ["antiplatelet thrombocytopenia PLT threshold","aspirin clopidogrel low platelet management"],
  },
  {
    id: "HIT_HEPARIN",
    severity: "Critical",
    test: (s) => s.labs.plt && s.labs.plt < 100 && s.hasDrug(["heparin"]) && s.hasCondition(["hit","heparin-induced"]),
    problem: "Suspected HIT — heparin contraindicated",
    recommendation: "Stop all heparin products immediately. Switch to argatroban or fondaparinux.",
    queries: () => ["heparin-induced thrombocytopenia HIT management","HIT alternative anticoagulation"],
  },

  // ── Sepsis / infection ────────────────────────────────────────────────────
  {
    id: "SEPSIS_METFORMIN",
    severity: "Critical",
    test: (s) => s.septicFlag && s.hasDrug(["metformin"]),
    problem: "Metformin during sepsis — high lactic acidosis risk (impaired renal perfusion)",
    recommendation: "Hold metformin during acute sepsis. Restart only after haemodynamic stabilisation and confirmed adequate renal function.",
    queries: () => ["metformin sepsis lactic acidosis contraindication","metformin hold criteria acute illness"],
  },
  {
    id: "SEPSIS_AMINOGLYCOSIDE_MONITOR",
    severity: "Major",
    test: (s) => s.septicFlag && s.hasDrug(["gentamicin","tobramycin","amikacin"]),
    problem: "Aminoglycoside use in sepsis — high nephrotoxicity risk with haemodynamic instability",
    recommendation: "Monitor drug levels, SCr daily. Extended interval dosing preferred. Re-evaluate need.",
    queries: () => ["aminoglycoside sepsis monitoring","aminoglycoside extended interval dosing"],
  },

  // ── Hepatic ───────────────────────────────────────────────────────────────
  {
    id: "HEPATIC_PARACETAMOL",
    severity: "Major",
    test: (s) => s.hepaticFlag && s.hasDrug(["paracetamol","acetaminophen"]),
    problem: "Paracetamol with elevated liver enzymes — hepatotoxicity risk",
    recommendation: "Limit paracetamol ≤2 g/day. Avoid if ALT/AST >3× ULN. Monitor LFTs.",
    queries: () => ["paracetamol liver disease dose limit","acetaminophen hepatotoxicity threshold"],
  },
  {
    id: "HEPATIC_STATIN",
    severity: "Moderate",
    test: (s) => s.hepaticFlag && s.hasDrug(["atorvastatin","rosuvastatin","simvastatin","pravastatin","fluvastatin"]),
    problem: "Statin with active liver disease — hepatotoxicity risk",
    recommendation: "Hold statin if ALT/AST >3× ULN. Reassess on LFT improvement.",
    queries: () => ["statin liver disease contraindication","statin ALT AST monitoring"],
  },

  // ── Anticoagulation ───────────────────────────────────────────────────────
  {
    id: "HIGH_INR_WARFARIN",
    severity: "Critical",
    test: (s) => s.labs.inr && s.labs.inr > 4.0 && s.hasDrug(["warfarin"]),
    problem: "Supratherapeutic INR (>4.0) on warfarin — high bleeding risk",
    recommendation: "Hold warfarin. Assess bleeding. Consider vitamin K administration per protocol.",
    queries: () => ["warfarin supratherapeutic INR management","warfarin over-anticoagulation vitamin K"],
  },
  {
    id: "DOUBLE_ANTICOAG",
    severity: "Major",
    test: (s) => {
      const anticoagCount = [
        ["warfarin"],
        ["rivaroxaban","apixaban","dabigatran","edoxaban"],
        ["heparin","unfractionated heparin","UFH"],
        ["enoxaparin","dalteparin","fondaparinux"],
      ].filter(group => s.hasDrug(group)).length;
      return anticoagCount >= 2;
    },
    problem: "Dual anticoagulation detected — bleeding risk",
    recommendation: "Review intent. Ensure bridging period is appropriate. Avoid unintended combination.",
    queries: () => ["dual anticoagulation bleeding risk","bridging therapy anticoagulation guideline"],
  },

  // ── TDM / drug levels ─────────────────────────────────────────────────────
  {
    id: "VANC_TROUGH_LOW",
    severity: "Major",
    test: (s) => s.labs.vanc_trough && s.labs.vanc_trough < 10,
    problem: "Vancomycin trough sub-therapeutic (<10 mg/L) — treatment failure risk",
    recommendation: "Increase vancomycin dose or reduce dosing interval. Recheck levels.",
    queries: () => ["vancomycin sub-therapeutic trough dose adjustment","vancomycin AUC guided dosing"],
  },
  {
    id: "VANC_TROUGH_HIGH",
    severity: "Major",
    test: (s) => s.labs.vanc_trough && s.labs.vanc_trough > 20,
    problem: "Vancomycin trough supra-therapeutic (>20 mg/L) — nephrotoxicity risk",
    recommendation: "Hold or reduce vancomycin. Recheck trough and renal function.",
    queries: () => ["vancomycin supra-therapeutic toxicity","vancomycin nephrotoxicity management"],
  },
  {
    id: "DIGOXIN_TOXIC",
    severity: "Critical",
    test: (s) => s.labs.digoxin && s.labs.digoxin > 2.0,
    problem: "Digoxin level above therapeutic range — toxicity risk",
    recommendation: "Hold digoxin. Check electrolytes (K⁺, Mg²⁺). Cardiac monitoring. Consider Digibind if toxicity confirmed.",
    queries: () => ["digoxin toxicity management","digoxin supratherapeutic level intervention"],
  },
  {
    id: "GENTA_TROUGH_HIGH",
    severity: "Major",
    test: (s) => s.labs.genta_trough && s.labs.genta_trough > 2,
    problem: "Gentamicin trough elevated (>2 mg/L) — nephrotoxicity/ototoxicity risk",
    recommendation: "Extend dosing interval. Recheck trough before next dose.",
    queries: () => ["gentamicin trough high dosing adjustment","aminoglycoside trough monitoring"],
  },

  // ── Electrolytes / metabolic ──────────────────────────────────────────────
  {
    id: "HYPOKALEMIA_DIGOXIN",
    severity: "Major",
    test: (s) => s.labs.k && s.labs.k < 3.5 && s.hasDrug(["digoxin"]),
    problem: "Hypokalemia + digoxin — potentiates digoxin toxicity",
    recommendation: "Correct potassium before continuing digoxin. Target K⁺ ≥3.5 mmol/L.",
    queries: () => ["hypokalemia digoxin toxicity potentiation","potassium correction before digoxin"],
  },
  {
    id: "HYPOKALEMIA_DIURETIC",
    severity: "Moderate",
    test: (s) => s.labs.k && s.labs.k < 3.5 && s.hasDrug(["furosemide","bumetanide","torsemide","hydrochlorothiazide","chlorthalidone"]),
    problem: "Hypokalemia in patient on loop/thiazide diuretic",
    recommendation: "Replace potassium. Consider adding potassium-sparing agent. Monitor K⁺.",
    queries: () => ["loop diuretic hypokalemia management","potassium replacement thiazide diuretic"],
  },
  {
    id: "HYPOMAGNESEMIA_DRUG",
    severity: "Moderate",
    test: (s) => s.labs.mg && s.labs.mg < 0.74 && s.hasDrug(["furosemide","bumetanide","omeprazole","esomeprazole","lansoprazole","pantoprazole","gentamicin","tobramycin","amikacin"]),
    problem: "Hypomagnesaemia with drug likely causing it",
    recommendation: "Replace magnesium IV or PO. Review offending drug necessity.",
    queries: () => ["drug-induced hypomagnesaemia management","magnesium replacement protocol"],
  },
  {
    id: "GLUCOSE_INSULIN_STEROID",
    severity: "Moderate",
    test: (s) => s.labs.glucose && s.labs.glucose > 10 && s.hasDrug(["dexamethasone","prednisolone","methylprednisolone","hydrocortisone"]),
    problem: "Hyperglycaemia with corticosteroid — steroid-induced hyperglycaemia",
    recommendation: "Initiate or intensify blood glucose monitoring. Consider sliding scale or insulin adjustment.",
    queries: () => ["steroid-induced hyperglycemia management","corticosteroid glucose monitoring protocol"],
  },
  {
    id: "LACTIC_ACIDOSIS_METFORMIN",
    severity: "Critical",
    test: (s) => s.labs.lactate && s.labs.lactate > 5.0 && s.hasDrug(["metformin"]),
    problem: "Severe hyperlactataemia + metformin — MALA (Metformin-Associated Lactic Acidosis)",
    recommendation: "STOP metformin IMMEDIATELY. Urgent metabolic assessment. Consider haemodialysis for metformin removal.",
    queries: () => ["MALA metformin associated lactic acidosis treatment","metformin severe lactic acidosis dialysis"],
  },

  // ── Allergy rules ─────────────────────────────────────────────────────────
  {
    id: "ALLERGY_PENICILLIN_BETALACTAM",
    severity: "Major",
    test: (s) =>
      s.hasAllergy(["penicillin","amoxicillin","ampicillin"]) &&
      s.hasDrug(["amoxicillin","ampicillin","piperacillin","piperacillin-tazobactam","co-amoxiclav","flucloxacillin","dicloxacillin"]),
    problem: "Documented penicillin allergy — patient receiving penicillin-class antibiotic",
    recommendation: "STOP drug immediately. Switch to an alternative based on indication and allergy type.",
    queries: () => ["penicillin allergy management alternatives","beta-lactam cross-reactivity penicillin"],
  },
  {
    id: "ALLERGY_PENICILLIN_CEPHALOSPORIN",
    severity: "Moderate",
    test: (s) =>
      s.hasAllergy(["penicillin","amoxicillin","ampicillin"]) &&
      s.hasDrug(["cefazolin","ceftriaxone","cefuroxime","cefalexin","cephalexin","cefepime","ceftazidime"]),
    problem: "Penicillin allergy with cephalosporin — cross-reactivity risk (<2–10%)",
    recommendation: "Review nature of penicillin allergy. If IgE-mediated anaphylaxis, avoid cephalosporins with same R1 side chain.",
    queries: () => ["penicillin allergy cephalosporin cross-reactivity","beta-lactam allergy risk stratification"],
  },
  {
    id: "ALLERGY_NSAID",
    severity: "Major",
    test: (s) =>
      s.hasAllergy(["nsaid","aspirin","ibuprofen","diclofenac"]) &&
      s.hasDrug(["ibuprofen","naproxen","diclofenac","ketorolac","celecoxib","aspirin","indomethacin"]),
    problem: "NSAID allergy — patient receiving NSAID",
    recommendation: "Stop NSAID. Switch to paracetamol or opioid as appropriate.",
    queries: () => ["NSAID allergy cross-reactivity management","aspirin intolerance NSAID alternative"],
  },

  // ── Duplicate therapy ─────────────────────────────────────────────────────
  {
    id: "DUPLICATE_PPI",
    severity: "Minor",
    test: (s) => {
      const ppis = ["omeprazole","esomeprazole","lansoprazole","pantoprazole","rabeprazole"];
      return ppis.filter(d => s.hasDrug([d])).length >= 2;
    },
    problem: "Duplicate PPI therapy detected",
    recommendation: "Rationalise to a single PPI. No benefit to dual PPI use.",
    queries: () => ["duplicate proton pump inhibitor use"],
  },
  {
    id: "DUPLICATE_ANTICOAGULANT",
    severity: "Major",
    test: (s) => {
      const doacs = ["rivaroxaban","apixaban","dabigatran","edoxaban"];
      return s.hasDrug(["warfarin"]) && s.hasDrug(doacs);
    },
    problem: "Warfarin co-prescribed with DOAC — duplication",
    recommendation: "Review intent. Avoid concurrent use unless transitioning. Ensure clear bridging protocol.",
    queries: () => ["warfarin DOAC concurrent use transition","anticoagulant duplication management"],
  },

  // ── Monitoring rules ──────────────────────────────────────────────────────
  {
    id: "MONITOR_VANC_NOLEVELS",
    severity: "Moderate",
    test: (s) => s.hasDrug(["vancomycin"]) && s.labs.vanc_trough === null && s.labs.vanc_auc === null,
    problem: "Vancomycin prescribed without documented drug level monitoring",
    recommendation: "Order vancomycin trough or AUC-guided monitoring. Target AUC 400–600 mg·h/L.",
    queries: () => ["vancomycin therapeutic drug monitoring protocol","vancomycin AUC MIC monitoring"],
  },
  {
    id: "MONITOR_GENTA_NOLEVELS",
    severity: "Moderate",
    test: (s) => s.hasDrug(["gentamicin"]) && s.labs.genta_trough === null,
    problem: "Gentamicin prescribed without trough monitoring",
    recommendation: "Check gentamicin trough level before 3rd or 4th dose (or per protocol).",
    queries: () => ["gentamicin trough monitoring protocol"],
  },
  {
    id: "MONITOR_WARFARIN_INR",
    severity: "Moderate",
    test: (s) => s.hasDrug(["warfarin"]) && s.labs.inr === null,
    problem: "Warfarin prescribed without documented INR",
    recommendation: "Obtain INR. Adjust warfarin dose to maintain therapeutic range.",
    queries: () => ["warfarin INR monitoring protocol"],
  },
];

/* =========================================================
   MAIN HANDLERS (unchanged signatures)
========================================================= */

async function handleAsk(body, env, corsHeaders, language) {
  const question = body.question || body.q || "";
  const output_mode = (body.output_mode || "hybrid").toLowerCase();
  const source_mode = (body.source_mode || "off").toLowerCase();

  if (!question) return jsonResponse({ ok: false, error: "Question is required" }, 400, corsHeaders);
  requireApiCredentials(env);

  const evidence = await vectorSearch(env, question, 10);

  if (source_mode === "required" && evidence.length === 0) {
    return jsonResponse({ ok: true, verdict: "NOT_FOUND",
      answer: language === "ar" ? "لم يتم العثور على إجابة في البروتوكول." : "Not found in protocol.",
      citations: [], applied_output: { output_mode, source_mode } }, 200, corsHeaders);
  }

  if (evidence.length === 0) {
    return jsonResponse({ ok: true, verdict: "NOT_FOUND",
      answer: language === "ar" ? "لا توجد معلومات في المصادر المتاحة." : "No information found in available sources.",
      citations: source_mode === "off" ? undefined : [],
      applied_output: { output_mode, source_mode } }, 200, corsHeaders);
  }

  const evidenceText = formatEvidenceText(evidence);
  let answer = "";

  if (output_mode === "verbatim") {
    answer = buildVerbatimAnswer(evidence);
  } else if (output_mode === "short") {
    answer = (await callGPT(env.OPENAI_API_KEY, {
      system: "You are a clinical pharmacist AI. Answer using ONLY the provided sources. Return 3-6 concise bullet points, each beginning with • . No preamble.",
      user: `Question: ${question}\n\nSources:\n${evidenceText}`,
      max_tokens: 350,
    })) || "• No concise answer available";
  } else {
    answer = (await callGPT(env.OPENAI_API_KEY, {
      system: "You are a clinical pharmacist AI. Use ONLY the provided sources.\nFormat:\nANSWER: [2-4 sentence answer]\n\nKEY EVIDENCE:\n• ... — [filename, page if available]\nDo not add unsupported information.",
      user: `Question: ${question}\n\nSources:\n${evidenceText}`,
      max_tokens: 700,
    })) || "No answer generated.";
  }

  const response = { ok: true, verdict: "OK", answer, applied_output: { output_mode, source_mode } };
  if (source_mode !== "off") response.citations = buildCitations(evidence, 250);
  return jsonResponse(response, 200, corsHeaders);
}

async function handleMonograph(body, env, corsHeaders, language) {
  const drug_name = body.drug_name || body.drug || "";
  const patient_context = body.patient_context || "";
  if (!drug_name) return jsonResponse({ ok: false, error: "drug_name is required" }, 400, corsHeaders);
  requireApiCredentials(env);

  const evidence = await vectorSearch(env, `${drug_name} dosing indications renal warnings contraindications`, 8);
  const evidenceText = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";

  const monograph = (await callGPT(env.OPENAI_API_KEY, {
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

  return jsonResponse({ ok: true, drug_name, monograph, citations: buildCitations(evidence, 220) }, 200, corsHeaders);
}

async function handleAntibiogram(body, env, corsHeaders, language) {
  const organism = body.organism || "";
  const antibiotic = body.antibiotic || "";
  const site_of_infection = body.site_of_infection || "";
  const patient_context = body.patient_context || "";

  if (!organism && !antibiotic) return jsonResponse({ ok: false, error: "organism or antibiotic is required" }, 400, corsHeaders);
  requireApiCredentials(env);

  const query = [organism, antibiotic, site_of_infection, "susceptibility resistance empiric therapy"].filter(Boolean).join(" ");
  const evidence = await vectorSearch(env, query, 8);
  const evidenceText = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";

  const analysis = (await callGPT(env.OPENAI_API_KEY, {
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

  return jsonResponse({
    ok: true, organism: organism || null, antibiotic: antibiotic || null,
    site_of_infection: site_of_infection || null, analysis, citations: buildCitations(evidence, 220),
  }, 200, corsHeaders);
}

/* =========================================================
   MAIN: CASE ANALYSIS — 9-LAYER PIPELINE
========================================================= */

async function handleCaseAnalysis(body, env, corsHeaders, language) {
  const case_text = body.case_text || "";
  const question = body.question || "";
  if (!case_text) return jsonResponse({ ok: false, error: "case_text is required" }, 400, corsHeaders);
  requireApiCredentials(env);

  // ─── L1 + L2: Normalize + Entity Extraction ────────────────────────────────
  const extracted  = await extractCaseJson(env, case_text);
  const normalized = normalizeExtractedCase(extracted);

  // ─── L3: Derived Clinical State ────────────────────────────────────────────
  const crcl = calcCrCl(
    normalized.age,
    normalized.weight_kg,
    normalized.labs?.scr_umol || (normalized.labs?.scr_mgdl ? normalized.labs.scr_mgdl * 88.42 : null),
    normalized.sex
  );
  const classifiedLabs = classifyLabs(normalized.labs || {});
  const clinicalState  = buildClinicalState(normalized, crcl);

  // ─── L5: Deterministic Safety Rules ───────────────────────────────────────
  const ruleFindings = runSafetyRules(clinicalState);

  // ─── L6: Targeted RAG Query Generation ────────────────────────────────────
  const targetedQueries = buildTargetedQueries(normalized, clinicalState, ruleFindings, question);

  // ─── L7: Evidence Retrieval per-issue ─────────────────────────────────────
  const allEvidence = await retrieveTargetedEvidence(env, targetedQueries);

  // Deduplicate by filename+excerpt prefix
  const evidenceMap = new Map();
  for (const e of allEvidence) {
    const dedupeKey = `${e.filename}::${e.excerpt.substring(0, 80)}`;
    if (!evidenceMap.has(dedupeKey)) evidenceMap.set(dedupeKey, e);
  }
  const dedupedEvidence = Array.from(evidenceMap.values()).slice(0, 15);

  // Re-index IDs after dedup
  dedupedEvidence.forEach((e, i) => { e.id = `E${i + 1}`; });

  // ─── L4 + L8 + L9: Med-by-Med Review → Final GPT Report ──────────────────
  const hiddenReasoning = await runClinicalReasoningGPT({
    env, normalized, classifiedLabs, crcl, clinicalState, ruleFindings,
    evidence: dedupedEvidence, question, language,
  });

  // ─── L9: Merge rule findings into GPT interventions ───────────────────────
  const mergedInterventions = mergeInterventions(ruleFindings, hiddenReasoning.interventions);
  const mergedAdjustments   = hiddenReasoning.medication_adjustments || [];

  // ─── SOAP Build ───────────────────────────────────────────────────────────
  const soapNote = buildSoapNote({
    patient: normalized, classifiedLabs, crcl,
    assessment: hiddenReasoning.assessment,
    interventionsSummary: hiddenReasoning.interventions_summary,
    followupPlan: hiddenReasoning.followup_plan,
  });

  return jsonResponse({
    ok: true,
    soap_note: soapNote,
    pharmacist_interventions: mergedInterventions,
    medication_adjustments: mergedAdjustments,
    citations: buildCitations(dedupedEvidence, 250),
  }, 200, corsHeaders);
}

/* =========================================================
   L3 — BUILD CLINICAL STATE OBJECT
   Single source of truth passed to rules and GPT.
========================================================= */

function buildClinicalState(normalized, crcl) {
  const labs = normalized.labs || {};
  const meds = (normalized.medications || []).map(m => (m.name || "").toLowerCase().trim());
  const allergies = (normalized.allergies || []).map(a => a.toLowerCase().trim());
  const diagnosis = (normalized.diagnosis || "").toLowerCase();
  const pmh       = (normalized.pmh || "").toLowerCase();
  const combined  = diagnosis + " " + pmh + " " + (normalized.reason_admission || "").toLowerCase();

  const renalFlag  = crcl ? crcl.value < 60 : false;
  const hepaticFlag = (labs.alt && labs.alt > 56 * 3) || (labs.ast && labs.ast > 40 * 3) || (labs.bili_t && labs.bili_t > 21 * 2);
  const septicFlag  = combined.includes("sepsis") || combined.includes("septic") ||
                      (labs.procalc && labs.procalc > 2) || (labs.lactate && labs.lactate > 2);

  return {
    labs,
    crcl,
    renalFlag,
    hepaticFlag,
    septicFlag,
    meds,
    allergies,
    diagnosis,
    // Helper: case-insensitive drug match against any alias list
    hasDrug: (names) => names.some(n => meds.some(m => m.includes(n.toLowerCase()))),
    // Helper: condition in diagnosis/PMH/admission reason
    hasCondition: (terms) => terms.some(t => combined.includes(t.toLowerCase())),
    // Helper: allergy match
    hasAllergy: (terms) => terms.some(t => allergies.some(a => a.includes(t.toLowerCase()))),
  };
}

/* =========================================================
   L5 — DETERMINISTIC SAFETY RULE ENGINE
========================================================= */

function runSafetyRules(clinicalState) {
  const triggered = [];
  for (const rule of SAFETY_RULES) {
    try {
      if (rule.test(clinicalState)) {
        triggered.push({
          id: rule.id,
          severity: rule.severity,
          problem: rule.problem,
          recommendation: rule.recommendation,
          queries: typeof rule.queries === "function" ? rule.queries(clinicalState) : [],
          source: "rule_engine",
          reference: "Pending evidence retrieval",
        });
      }
    } catch (_) { /* rule evaluation errors are silent */ }
  }
  return triggered;
}

/* =========================================================
   L6 — TARGETED RAG QUERY GENERATION
   Produces a flat, deduplicated list of specific queries.
========================================================= */

function buildTargetedQueries(normalized, clinicalState, ruleFindings, question) {
  const queries = new Set();

  // Per-drug queries
  for (const med of (normalized.medications || [])) {
    const name = (med.name || "").trim();
    if (!name) continue;
    queries.add(`${name} dosing`);
    queries.add(`${name} renal dose adjustment`);
    queries.add(`${name} contraindications`);
    queries.add(`${name} monitoring parameters`);
    if (clinicalState.renalFlag) queries.add(`${name} CrCl ${Math.round(clinicalState.crcl?.value || 0)} dosing`);
    if (clinicalState.hepaticFlag) queries.add(`${name} hepatic impairment dose`);
  }

  // Per-rule targeted queries
  for (const finding of ruleFindings) {
    for (const q of (finding.queries || [])) queries.add(q);
  }

  // Lab-specific queries
  const labs = normalized.labs || {};
  if (labs.k && labs.k > 5.5) queries.add("hyperkalaemia management drug-induced");
  if (labs.k && labs.k < 3.5) queries.add("hypokalaemia replacement protocol");
  if (labs.mg && labs.mg < 0.74) queries.add("hypomagnesaemia management");
  if (labs.plt && labs.plt < 100) queries.add("thrombocytopenia anticoagulation threshold");
  if (labs.lactate && labs.lactate > 2) queries.add("lactic acidosis drug causes management");

  // Diagnosis-level queries
  const dx = normalized.diagnosis || "";
  if (dx) queries.add(`${dx} treatment protocol`);
  if (dx) queries.add(`${dx} empiric antimicrobial therapy`);

  // Allergies
  for (const allergy of (normalized.allergies || [])) {
    queries.add(`${allergy} allergy cross-reactivity management`);
  }

  // User question
  if (question) queries.add(question);

  return Array.from(queries).filter(Boolean).slice(0, 20); // cap to 20 queries
}

/* =========================================================
   L7 — TARGETED EVIDENCE RETRIEVAL
   Runs parallel vector searches for each focused query.
========================================================= */

async function retrieveTargetedEvidence(env, queries) {
  const resultsPerQuery = 4;
  const fetches = queries.map(q => vectorSearch(env, q, resultsPerQuery));
  const results = await Promise.allSettled(fetches);
  const all = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  return all;
}

/* =========================================================
   L4 + L8 — CLINICAL REASONING (GPT, hidden)
   GPT now receives: structured patient, rule findings, and
   targeted evidence — producing only pharmacist-grade output.
========================================================= */

async function runClinicalReasoningGPT({ env, normalized, classifiedLabs, crcl, clinicalState, ruleFindings, evidence, question, language }) {
  const medsText = (normalized.medications || [])
    .map(m => `${m.name || ""} ${m.dose || ""} ${m.route || ""} ${m.frequency || ""}`.trim()).join(" | ") || "None documented";

  const labSummary = classifiedLabs
    .map(l => `${l.label} ${l.value}${l.unit ? ` ${l.unit}` : ""} ${l.arrow}`).join(", ") || "No significant labs";

  const evidenceText = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";

  const ruleText = ruleFindings.length
    ? ruleFindings.map(r => `[${r.severity}] ${r.problem} → ${r.recommendation}`).join("\n")
    : "No deterministic rules triggered.";

  const prompt = `You are a senior clinical pharmacist performing a structured medication audit.
DO NOT reveal reasoning steps. Return ONLY valid JSON.

═══ PATIENT SUMMARY ═══
Name: ${normalized.patient_name || "N/A"}
Age/Sex/Weight: ${normalized.age || "N/A"}Y / ${normalized.sex || "N/A"} / ${normalized.weight_kg || "N/A"} kg
Setting: ${normalized.care_setting || "N/A"}
Diagnosis: ${normalized.diagnosis || "N/A"}
Admission reason: ${normalized.reason_admission || "N/A"}
PMH: ${normalized.pmh || "N/A"}
Allergies: ${(normalized.allergies || []).join(", ") || "None"}
Home meds: ${normalized.home_medications || "N/A"}
Active meds: ${medsText}
CrCl: ${crcl ? `${crcl.value} mL/min (${crcl.category})` : "Unable to calculate"}
Renal flag: ${clinicalState.renalFlag ? "YES" : "No"}
Hepatic flag: ${clinicalState.hepaticFlag ? "YES" : "No"}
Sepsis flag: ${clinicalState.septicFlag ? "YES" : "No"}
Labs: ${labSummary}
${question ? `Clinician question: ${question}` : ""}

═══ PRE-DETECTED SAFETY ISSUES (from rule engine) ═══
${ruleText}

═══ RETRIEVED PROTOCOL EVIDENCE ═══
${evidenceText}

═══ YOUR TASK ═══
1. Perform a drug-by-drug review of ALL active medications:
   - indication, dose appropriateness, renal/hepatic adjustment, contraindications,
     allergy conflicts, lab conflicts, drug-drug interactions, duplicate therapy, monitoring.
2. Integrate the pre-detected safety issues above into your assessment.
3. Use ONLY the provided protocol sources for evidence-backed recommendations.
4. If no protocol source supports a recommendation, state: "Not clearly specified in available protocol".
5. Classify each intervention: Critical | Major | Moderate | Minor.
6. Sort interventions: Critical first.

Return exactly this JSON structure (no markdown, no extra text):
{
  "assessment": "2-4 sentence pharmacist assessment",
  "interventions_summary": "1-2 sentence overview",
  "followup_plan": "concise follow-up",
  "interventions": [
    {
      "severity": "Critical|Major|Moderate|Minor",
      "problem": "clear problem statement",
      "recommendation": "specific actionable recommendation",
      "reference": "filename+page, or 'Not clearly specified in available protocol'"
    }
  ],
  "medication_adjustments": [
    {
      "drug": "name",
      "ordered": "current order",
      "recommended": "recommended action or corrected order",
      "verdict": "CORRECT|ADJUST|STOP|MONITOR|NOT_IN_PROTOCOL",
      "reason": "brief explanation",
      "reference": "filename+page, or 'Not clearly specified in available protocol'"
    }
  ]
}`;

  try {
    const raw = await callGPT(env.OPENAI_API_KEY, {
      system: "You are a clinical pharmacist. Return only valid JSON with no markdown.",
      user: prompt,
      max_tokens: 2000,
    });

    const parsed = JSON.parse(stripCodeFences(raw || "{}"));
    return {
      assessment:             parsed.assessment             || "Clinical pharmacist review performed.",
      interventions_summary:  parsed.interventions_summary  || "Medication review completed.",
      followup_plan:          parsed.followup_plan          || "Follow-up as clinically indicated.",
      interventions:          Array.isArray(parsed.interventions)          ? parsed.interventions          : [],
      medication_adjustments: Array.isArray(parsed.medication_adjustments) ? parsed.medication_adjustments : [],
    };
  } catch (e) {
    console.error("runClinicalReasoningGPT error:", e);
    return {
      assessment: "Clinical pharmacist review performed based on available patient data.",
      interventions_summary: "Please review medication appropriateness, dosing, and monitoring.",
      followup_plan: "Reassess medications, renal function, and clinical response.",
      interventions: [],
      medication_adjustments: [],
    };
  }
}

/* =========================================================
   L8 — MERGE + DEDUPLICATE INTERVENTIONS
   Rule-engine findings and GPT findings are merged, with
   Critical items first. Duplicates suppressed by problem text.
========================================================= */

function mergeInterventions(ruleFindings, gptInterventions) {
  const severityOrder = { Critical: 0, Major: 1, Moderate: 2, Minor: 3 };

  // Build combined list; rule-engine entries marked distinctly
  const combined = [
    ...ruleFindings.map(r => ({
      severity: r.severity,
      problem: r.problem,
      recommendation: r.recommendation,
      reference: r.reference || "Pending protocol confirmation",
    })),
    ...(gptInterventions || []),
  ];

  // Deduplicate by normalized problem text
  const seen = new Set();
  const deduped = [];
  for (const item of combined) {
    const key = (item.problem || "").toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 50);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  // Sort by severity
  return deduped.sort((a, b) =>
    (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99)
  );
}

/* =========================================================
   CASE EXTRACTION + NORMALIZATION (L1 + L2)
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
  "vitals": { "bp": null, "hr": null, "rr": null, "temp": null, "spo2": null, "gcs": null },
  "labs": {
    "hb": null, "wbc": null, "plt": null, "neutrophil": null,
    "scr_umol": null, "scr_mgdl": null, "urea": null, "bun": null,
    "na": null, "k": null, "cl": null, "bicarb": null, "ca": null, "mg": null, "phos": null,
    "alt": null, "ast": null, "alp": null, "bili_t": null, "albumin": null,
    "inr": null, "pt": null, "aptt": null, "fibrinogen": null,
    "glucose": null, "crp": null, "procalc": null, "lactate": null,
    "vanc_trough": null, "vanc_auc": null, "genta_trough": null, "tobra_trough": null,
    "digoxin": null, "phenytoin": null, "valproate": null, "tacro": null, "cyclo": null
  },
  "medications": [
    { "name": "", "dose": "", "route": "", "frequency": "", "indication": null }
  ]
}`;

  try {
    const raw = await callGPT(env.OPENAI_API_KEY, {
      system: "You extract clinical case data. Return only valid JSON.",
      user: prompt,
      max_tokens: 1400,
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
    ...base, ...extracted,
    vitals:      { ...base.vitals,      ...(extracted?.vitals      || {}) },
    labs:        { ...base.labs,        ...(extracted?.labs        || {}) },
    medications: Array.isArray(extracted?.medications) ? extracted.medications : [],
    allergies:   Array.isArray(extracted?.allergies)   ? extracted.allergies   : [],
  };
  merged.age        = toNumberOrNull(merged.age);
  merged.weight_kg  = toNumberOrNull(merged.weight_kg);
  merged.height_cm  = toNumberOrNull(merged.height_cm);
  for (const key of Object.keys(merged.labs)) merged.labs[key] = toNumberOrNull(merged.labs[key]);
  return merged;
}

/* =========================================================
   LAB CLASSIFICATION
========================================================= */

function classifyLabs(labs) {
  const out = [];
  for (const [key, value] of Object.entries(labs || {})) {
    if (value === null || value === undefined || value === "") continue;
    const ref = LAB_RANGES[key];
    if (!ref) continue;
    const num = Number(value);
    if (Number.isNaN(num)) continue;

    let status = "normal", arrow = "";
    if (ref.high !== null && num > ref.high) {
      const pct = (num - ref.high) / ref.high;
      status = pct > BORDERLINE_MARGIN ? "high" : "borderline-high"; arrow = "↑";
    } else if (ref.low !== null && num < ref.low) {
      const pct = (ref.low - num) / ref.low;
      status = pct > BORDERLINE_MARGIN ? "low" : "borderline-low"; arrow = "↓";
    }

    out.push({
      key, label: ref.label, value: num, unit: ref.unit, section: ref.section,
      status, arrow,
      isAbnormal:   status === "high"            || status === "low",
      isBorderline: status === "borderline-high" || status === "borderline-low",
      drugRelated:   ref.drugRelated || [],
      isDrugRelevant: Array.isArray(ref.drugRelated) && ref.drugRelated.length > 0,
    });
  }

  return out.sort((a, b) => {
    const sr = (x) => (x.isAbnormal ? 0 : x.isBorderline ? 1 : 2);
    const sa = LAB_SECTION_ORDER.indexOf(a.section || "");
    const sb = LAB_SECTION_ORDER.indexOf(b.section || "");
    if (sr(a) !== sr(b)) return sr(a) - sr(b);
    if (sa !== sb) return sa - sb;
    return a.label.localeCompare(b.label);
  });
}

/* =========================================================
   SOAP NOTE BUILDER
========================================================= */

function buildSoapNote({ patient, classifiedLabs, crcl, assessment, interventionsSummary, followupPlan }) {
  const carePlace  = patient.care_setting || "ICU";
  const weightStr  = patient.weight_kg != null ? `${patient.weight_kg} kg` : "— kg";
  const ageStr     = patient.age != null ? `${patient.age}Y` : "Y";
  const mrnStr     = patient.mrn || "";
  const reason     = patient.reason_admission || "N/A";
  const pmh        = patient.pmh || "N/A";
  const homeMeds   = patient.home_medications || "N/A";
  const vitalsLines = buildVitalsLines(patient.vitals || {});
  const labsBlock   = buildClassifiedLabsBlock(classifiedLabs, crcl);

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
  if (!classifiedLabs.length && !crcl) return `- No clinically significant abnormalities detected.`;

  const bySection = {};
  for (const sec of LAB_SECTION_ORDER) bySection[sec] = [];
  for (const lab of classifiedLabs) {
    const include = lab.isAbnormal || lab.isBorderline || lab.isDrugRelevant || lab.section === "renal";
    if (!include) continue;
    if (!bySection[lab.section]) bySection[lab.section] = [];
    bySection[lab.section].push(lab);
  }

  const blocks = [];

  if (crcl || (bySection.renal && bySection.renal.length)) {
    const renalLines = [];
    const scr  = (bySection.renal || []).find(x => x.key === "scr_umol" || x.key === "scr_mgdl");
    const urea = (bySection.renal || []).find(x => x.key === "urea" || x.key === "bun");
    if (scr)  renalLines.push(`- ${scr.label}: ${scr.value} ${scr.unit}${scr.arrow ? ` ${scr.arrow}` : ""}`);
    if (urea) renalLines.push(`- ${urea.label}: ${urea.value} ${urea.unit}${urea.arrow ? ` ${urea.arrow}` : ""}`);
    if (crcl) renalLines.push(`- Calculated CrCl: ${crcl.value} mL/min (${crcl.category})`);
    if (!renalLines.length) renalLines.push(`- Calculated CrCl: ${crcl ? `${crcl.value} mL/min (${crcl.category})` : "—"}`);
    blocks.push(`Renal:\n${renalLines.join("\n")}`);
  }

  for (const section of LAB_SECTION_ORDER.filter(s => s !== "renal")) {
    const lines = (bySection[section] || []).map(l =>
      `- ${l.label}: ${l.value} ${l.unit}${l.arrow ? ` ${l.arrow}` : ""}${l.isDrugRelevant ? " [drug-relevant]" : ""}`
    );
    if (lines.length) blocks.push(`${SECTION_TITLES[section]}:\n${lines.join("\n")}`);
  }

  return blocks.length ? blocks.join("\n\n") : `- No clinically significant abnormalities detected.`;
}

/* =========================================================
   VECTOR SEARCH + CITATIONS
========================================================= */

async function vectorSearch(env, query, maxResults = 6) {
  try {
    const res = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({ query, max_num_results: maxResults }),
    });

    if (!res.ok) { console.error("vectorSearch failed:", await res.text()); return []; }

    const data = await res.json();
    const evidence = [];

    for (let i = 0; i < (data.data || []).length; i++) {
      const item = data.data[i];
      let content = "";
      const filename = item.attributes?.filename || item.attributes?.file_name ||
                       item.filename || item.file_name || item.file_id || `source_${i + 1}`;

      if (item.content) {
        if (Array.isArray(item.content)) content = item.content.map(c => c.text || c.value || "").join("\n");
        else if (typeof item.content === "string") content = item.content;
        else if (item.content?.text) content = item.content.text;
      }
      if (!content && item.text) content = item.text;
      if (!content && Array.isArray(item.chunks)) content = item.chunks.map(c => c.text || "").join("\n");
      if (!content || !content.trim()) continue;

      let page = 0;
      const pm = content.match(/(?:Page|PAGE|page)\s*[:\-]?\s*(\d+)/i) ||
                 content.match(/\bp\.?\s*(\d+)\b/i) || content.match(/\[p\.\s*(\d+)\]/i);
      if (pm) page = parseInt(pm[1], 10);
      if (!page && item.attributes?.page) page = parseInt(item.attributes.page, 10) || 0;
      if (!page && item.metadata?.page)   page = parseInt(item.metadata.page, 10)   || 0;

      let section = "";
      const sm = content.match(/(?:Section|SECTION)\s+(\d+(?:\.\d+)*)\s*[–—\-]?\s*([^\n]+)/i) ||
                 content.match(/^#{1,3}\s+([^\n]+)/m) || content.match(/^\d+\.\d+\s+([^\n]+)/m);
      if (sm) section = (sm[2] || sm[1] || "").trim().substring(0, 80);

      evidence.push({
        id: `E${i + 1}`, filename, page, section,
        score: item.score ?? item.similarity ?? null,
        excerpt: content.substring(0, 2000),
      });
    }
    return evidence;
  } catch (e) {
    console.error("vectorSearch exception:", e);
    return [];
  }
}

function formatEvidenceText(evidence) {
  return evidence.map(e =>
    `[SOURCE ${e.id}] File: ${e.filename}${e.page ? ` | Page: ${e.page}` : ""}${e.section ? ` | Section: ${e.section}` : ""}\nContent: ${e.excerpt}`
  ).join("\n\n---\n\n");
}

function buildCitations(evidence, excerptLen = 250) {
  return evidence.map(e => ({
    evidence_ids: [e.id], filename: e.filename, section: e.section || "",
    page: e.page || 0, score: e.score, excerpt: e.excerpt.substring(0, excerptLen),
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
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user   },
      ],
    }),
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || null;
}

/* =========================================================
   CALCULATORS + UTILITIES
========================================================= */

function calcCrCl(age, weightKg, scrUmol, sex) {
  if (!age || !weightKg || !scrUmol || !sex) return null;
  const scrMgDl   = scrUmol / 88.42;
  const sexFactor = String(sex).toLowerCase().startsWith("f") ? 0.85 : 1;
  const value     = ((140 - age) * weightKg * sexFactor) / (72 * scrMgDl);
  const rounded   = Math.round(value * 10) / 10;
  let category = "Unknown";
  if      (rounded >= 90) category = "Normal (≥90)";
  else if (rounded >= 60) category = "Mild impairment (60–89)";
  else if (rounded >= 30) category = "Moderate impairment (30–59)";
  else if (rounded >= 15) category = "Severe impairment (15–29)";
  else                    category = "Kidney failure (<15)";
  return { value: rounded, category };
}

function emptyExtractedCase() {
  return {
    mrn: null, patient_name: null, age: null, sex: null,
    weight_kg: null, height_cm: null, care_setting: null,
    reason_admission: null, pmh: null, home_medications: null,
    diagnosis: null, allergies: [],
    vitals: { bp: null, hr: null, rr: null, temp: null, spo2: null, gcs: null },
    labs: {
      hb: null, wbc: null, plt: null, neutrophil: null,
      scr_umol: null, scr_mgdl: null, urea: null, bun: null,
      na: null, k: null, cl: null, bicarb: null, ca: null, mg: null, phos: null,
      alt: null, ast: null, alp: null, bili_t: null, albumin: null,
      inr: null, pt: null, aptt: null, fibrinogen: null,
      glucose: null, crp: null, procalc: null, lactate: null,
      vanc_trough: null, vanc_auc: null, genta_trough: null, tobra_trough: null,
      digoxin: null, phenytoin: null, valproate: null, tacro: null, cyclo: null,
    },
    medications: [],
  };
}

function requireApiCredentials(env) {
  if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) throw new Error("OPENAI_API_KEY or VECTOR_STORE_ID is not set");
}

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function stripCodeFences(text) { return String(text || "").replace(/```json|```/gi, "").trim(); }
function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v); return Number.isNaN(n) ? null : n;
}
