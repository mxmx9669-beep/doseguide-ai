// File: /functions/api/ask.js
// TheraGuard AI — Clinical Pharmacist Engine v3
//
// PIPELINE (case_analysis mode):
//   Stage 1  — Raw case → structured JSON (L1+L2)
//   Stage 2  — Extract active diseases / clinical problems (L2+)
//   Stage 3  — Disease-by-disease pharmacotherapy retrieval (L6+L7)
//   Stage 4  — Medication-by-medication deep review (L4+L5+L8)
//   Stage 5  — Final pharmacist note (L9)
//
// OUTPUT PANELS:
//   panel1  — Case Structurer (clean SOAP)
//   panel2  — Disease Scanner (disease → protocol pharmacotherapy)
//   panel3  — Medication Scanner (per-drug deep review)
//   panel4  — Final Pharmacist Note (decisive intervention note)
//
// OTHER MODES (unchanged):
//   ask       — Protocol Search with page-aware retrieval
//   monograph — Drug monograph
//   antibiogram — Antimicrobial interpretation

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);

  try {
    const body     = await request.json();
    const mode     = (body.mode || "ask").toLowerCase();
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
   REFERENCE DATA — Lab Ranges
========================================================= */
const LAB_RANGES = {
  hb:           { label:"Hb",               unit:"g/dL",    low:12,   high:17.5, section:"cbc",         drugRelated:["anticoagulants","iron","ESA"] },
  wbc:          { label:"WBC",              unit:"×10⁹/L",  low:4,    high:11,   section:"cbc",         drugRelated:["antibiotics","immunosuppressants"] },
  plt:          { label:"Platelets",        unit:"×10⁹/L",  low:150,  high:400,  section:"cbc",         drugRelated:["anticoagulants","heparin","antiplatelet"] },
  neutrophil:   { label:"Neutrophils",      unit:"×10⁹/L",  low:1.8,  high:7.5,  section:"cbc",         drugRelated:["G-CSF","immunosuppressants"] },
  scr_umol:     { label:"SCr",              unit:"µmol/L",  low:null, high:106,  section:"renal",       drugRelated:["renal dosing","nephrotoxins"] },
  scr_mgdl:     { label:"SCr",              unit:"mg/dL",   low:null, high:1.2,  section:"renal",       drugRelated:["renal dosing","nephrotoxins"] },
  urea:         { label:"Urea",             unit:"mmol/L",  low:null, high:7.1,  section:"renal",       drugRelated:[] },
  bun:          { label:"BUN",              unit:"mmol/L",  low:null, high:7.1,  section:"renal",       drugRelated:[] },
  na:           { label:"Na",               unit:"mmol/L",  low:136,  high:145,  section:"electrolytes",drugRelated:["IV fluids","diuretics"] },
  k:            { label:"K",                unit:"mmol/L",  low:3.5,  high:5.0,  section:"electrolytes",drugRelated:["diuretics","ACEi/ARB","insulin","antiarrhythmics"] },
  cl:           { label:"Cl",               unit:"mmol/L",  low:98,   high:107,  section:"electrolytes",drugRelated:[] },
  bicarb:       { label:"HCO3",             unit:"mmol/L",  low:22,   high:29,   section:"electrolytes",drugRelated:["diuretics"] },
  ca:           { label:"Ca",               unit:"mmol/L",  low:2.12, high:2.62, section:"electrolytes",drugRelated:["calcium therapy","digoxin"] },
  mg:           { label:"Mg",               unit:"mmol/L",  low:0.74, high:1.03, section:"electrolytes",drugRelated:["aminoglycosides","diuretics","PPIs"] },
  phos:         { label:"Phos",             unit:"mmol/L",  low:0.81, high:1.45, section:"electrolytes",drugRelated:["phosphate binders"] },
  alt:          { label:"ALT",              unit:"U/L",     low:null, high:56,   section:"liver",       drugRelated:["hepatotoxic drugs","paracetamol","statins"] },
  ast:          { label:"AST",              unit:"U/L",     low:null, high:40,   section:"liver",       drugRelated:["hepatotoxic drugs","statins"] },
  alp:          { label:"ALP",              unit:"U/L",     low:null, high:120,  section:"liver",       drugRelated:[] },
  bili_t:       { label:"Total Bilirubin",  unit:"µmol/L",  low:null, high:21,   section:"liver",       drugRelated:["hepatotoxic drugs"] },
  albumin:      { label:"Albumin",          unit:"g/L",     low:35,   high:50,   section:"liver",       drugRelated:["warfarin","phenytoin","protein binding"] },
  inr:          { label:"INR",              unit:"",        low:null, high:1.2,  section:"coagulation", drugRelated:["warfarin","bleeding risk"] },
  pt:           { label:"PT",               unit:"sec",     low:null, high:13.5, section:"coagulation", drugRelated:["warfarin"] },
  aptt:         { label:"aPTT",             unit:"sec",     low:null, high:35,   section:"coagulation", drugRelated:["heparin"] },
  fibrinogen:   { label:"Fibrinogen",       unit:"g/L",     low:2,    high:4,    section:"coagulation", drugRelated:[] },
  crp:          { label:"CRP",              unit:"mg/L",    low:null, high:10,   section:"infection",   drugRelated:["antibiotics"] },
  procalc:      { label:"PCT",              unit:"µg/L",    low:null, high:0.5,  section:"infection",   drugRelated:["antibiotics"] },
  lactate:      { label:"Lactate",          unit:"mmol/L",  low:null, high:2.0,  section:"infection",   drugRelated:["sepsis","metformin"] },
  glucose:      { label:"Glucose",          unit:"mmol/L",  low:3.9,  high:7.8,  section:"metabolic",   drugRelated:["insulin","steroids"] },
  vanc_trough:  { label:"Vancomycin Trough",unit:"mg/L",    low:10,   high:20,   section:"tdm",         drugRelated:["vancomycin"] },
  vanc_auc:     { label:"Vancomycin AUC",   unit:"mg·h/L",  low:400,  high:600,  section:"tdm",         drugRelated:["vancomycin"] },
  genta_trough: { label:"Gentamicin Trough",unit:"mg/L",    low:null, high:2,    section:"tdm",         drugRelated:["gentamicin"] },
  tobra_trough: { label:"Tobramycin Trough",unit:"mg/L",    low:null, high:2,    section:"tdm",         drugRelated:["tobramycin"] },
  digoxin:      { label:"Digoxin",          unit:"µg/L",    low:0.5,  high:2,    section:"tdm",         drugRelated:["digoxin"] },
  phenytoin:    { label:"Phenytoin",        unit:"mg/L",    low:10,   high:20,   section:"tdm",         drugRelated:["phenytoin"] },
  valproate:    { label:"Valproate",        unit:"mg/L",    low:50,   high:100,  section:"tdm",         drugRelated:["valproate"] },
  tacro:        { label:"Tacrolimus",       unit:"µg/L",    low:5,    high:15,   section:"tdm",         drugRelated:["tacrolimus"] },
  cyclo:        { label:"Cyclosporine",     unit:"µg/L",    low:100,  high:400,  section:"tdm",         drugRelated:["cyclosporine"] },
};

const BORDERLINE_MARGIN = 0.15;
const LAB_SECTION_ORDER = ["renal","cbc","electrolytes","liver","coagulation","infection","metabolic","tdm"];
const SECTION_TITLES = {
  renal:"Renal", cbc:"CBC", electrolytes:"Electrolytes", liver:"Liver Function",
  coagulation:"Coagulation", infection:"Infection / Sepsis Profile",
  metabolic:"Glucose / Metabolic", tdm:"Drug Monitoring / TDM",
};

/* =========================================================
   DETERMINISTIC SAFETY RULES (L5)
========================================================= */
const SAFETY_RULES = [
  { id:"RENAL_METFORMIN",         severity:"Critical",
    test:(s)=>s.renalFlag&&s.crcl&&s.crcl.value<30&&s.hasDrug(["metformin"]),
    problem:"Metformin use with CrCl <30 mL/min — lactic acidosis risk",
    recommendation:"Discontinue metformin immediately. CrCl <30 mL/min is an absolute contraindication.",
    queries:()=>["metformin contraindication renal impairment","metformin lactic acidosis CrCl threshold"] },
  { id:"RENAL_METFORMIN_LACTATE", severity:"Critical",
    test:(s)=>s.hasDrug(["metformin"])&&s.labs.lactate&&s.labs.lactate>2.0,
    problem:"Metformin + elevated lactate — high risk of MALA",
    recommendation:"Stop metformin. Investigate lactic acidosis. ICU-level monitoring.",
    queries:()=>["metformin lactic acidosis MALA","metformin elevated lactate management"] },
  { id:"SEPSIS_METFORMIN",        severity:"Critical",
    test:(s)=>s.septicFlag&&s.hasDrug(["metformin"]),
    problem:"Metformin during sepsis — lactic acidosis risk",
    recommendation:"Hold metformin during acute sepsis. Restart only after haemodynamic stabilisation.",
    queries:()=>["metformin sepsis lactic acidosis contraindication"] },
  { id:"LACTIC_ACIDOSIS_METFORMIN",severity:"Critical",
    test:(s)=>s.labs.lactate&&s.labs.lactate>5.0&&s.hasDrug(["metformin"]),
    problem:"Severe hyperlactataemia + metformin — MALA",
    recommendation:"STOP metformin IMMEDIATELY. Consider haemodialysis for metformin removal.",
    queries:()=>["MALA metformin associated lactic acidosis treatment"] },
  { id:"RENAL_NSAID",             severity:"Major",
    test:(s)=>s.renalFlag&&s.hasDrug(["ibuprofen","naproxen","diclofenac","ketorolac","celecoxib","indomethacin"]),
    problem:"NSAID with renal impairment — AKI worsening risk",
    recommendation:"Avoid NSAIDs. Use paracetamol or weak opioids.",
    queries:()=>["NSAID renal impairment contraindication"] },
  { id:"RENAL_AMINOGLYCOSIDE",    severity:"Major",
    test:(s)=>s.renalFlag&&s.hasDrug(["gentamicin","tobramycin","amikacin","streptomycin"]),
    problem:"Aminoglycoside with renal impairment — nephrotoxicity + ototoxicity risk",
    recommendation:"Extend dosing interval per CrCl. Monitor drug levels and renal function.",
    queries:(s)=>[`aminoglycoside renal dose adjustment CrCl ${Math.round(s.crcl?.value||0)}`,"aminoglycoside nephrotoxicity monitoring"] },
  { id:"RENAL_VANCOMYCIN",        severity:"Major",
    test:(s)=>s.renalFlag&&s.hasDrug(["vancomycin"]),
    problem:"Vancomycin with renal impairment — dose/interval adjustment required",
    recommendation:"Adjust vancomycin per CrCl. Target AUC/MIC 400–600 mg·h/L.",
    queries:(s)=>[`vancomycin renal dose CrCl ${Math.round(s.crcl?.value||0)}`,"vancomycin AUC monitoring renal"] },
  { id:"RENAL_DIGOXIN",           severity:"Major",
    test:(s)=>s.renalFlag&&s.hasDrug(["digoxin"]),
    problem:"Digoxin with renal impairment — toxicity risk",
    recommendation:"Reduce digoxin dose. Monitor serum levels.",
    queries:()=>["digoxin renal impairment dose","digoxin toxicity monitoring"] },
  { id:"RENAL_ACEI_ARB",          severity:"Moderate",
    test:(s)=>s.renalFlag&&s.hasDrug(["lisinopril","enalapril","ramipril","captopril","perindopril","losartan","valsartan","irbesartan","candesartan","telmisartan"]),
    problem:"ACEi/ARB with renal impairment — worsening renal function risk",
    recommendation:"Monitor SCr and K⁺ closely. Consider temporary hold if AKI.",
    queries:()=>["ACE inhibitor ARB renal impairment monitoring"] },
  { id:"RENAL_SPIRO",             severity:"Moderate",
    test:(s)=>s.crcl&&s.crcl.value<30&&s.hasDrug(["spironolactone","eplerenone"]),
    problem:"Spironolactone with CrCl <30 — severe hyperkalemia risk",
    recommendation:"Avoid spironolactone if CrCl <30 mL/min.",
    queries:()=>["spironolactone contraindication renal failure"] },
  { id:"HYPERK_ACEI_SPIRO",       severity:"Critical",
    test:(s)=>s.labs.k&&s.labs.k>5.5&&s.hasDrug(["spironolactone","eplerenone"])&&s.hasDrug(["lisinopril","enalapril","ramipril","captopril","perindopril","losartan","valsartan","irbesartan","candesartan","telmisartan"]),
    problem:"Hyperkalemia + ACEi/ARB + K-sparing diuretic — life-threatening K⁺ elevation",
    recommendation:"Hold K-sparing diuretic and ACEi/ARB. Treat hyperkalemia. Cardiac monitoring.",
    queries:()=>["hyperkalemia ACE inhibitor spironolactone management"] },
  { id:"HYPERK_SINGLE",           severity:"Major",
    test:(s)=>s.labs.k&&s.labs.k>5.5&&(s.hasDrug(["spironolactone","eplerenone"])||s.hasDrug(["lisinopril","enalapril","ramipril","captopril","perindopril","losartan","valsartan","irbesartan","candesartan","telmisartan"])),
    problem:"Hyperkalemia with potassium-elevating drug",
    recommendation:"Review and potentially hold offending drug. Monitor K⁺.",
    queries:()=>["hyperkalemia drug-induced management"] },
  { id:"THROMBO_ANTICOAG",        severity:"Critical",
    test:(s)=>s.labs.plt&&s.labs.plt<50&&s.hasDrug(["heparin","enoxaparin","dalteparin","fondaparinux","warfarin","rivaroxaban","apixaban","dabigatran","edoxaban"]),
    problem:"Severe thrombocytopenia (PLT <50) + anticoagulant — critical bleeding risk",
    recommendation:"Reassess anticoagulant indication urgently. Risk/benefit assessment required.",
    queries:()=>["anticoagulation thrombocytopenia management","anticoagulation PLT threshold"] },
  { id:"THROMBO_ANTIPLATELET",    severity:"Major",
    test:(s)=>s.labs.plt&&s.labs.plt<100&&s.hasDrug(["aspirin","clopidogrel","ticagrelor","prasugrel"]),
    problem:"Thrombocytopenia with antiplatelet — increased bleeding risk",
    recommendation:"Review antiplatelet. Consider hold if PLT <50 unless stent/ACS indication overrides.",
    queries:()=>["antiplatelet thrombocytopenia PLT threshold"] },
  { id:"HIGH_INR_WARFARIN",       severity:"Critical",
    test:(s)=>s.labs.inr&&s.labs.inr>4.0&&s.hasDrug(["warfarin"]),
    problem:"Supratherapeutic INR (>4.0) on warfarin — high bleeding risk",
    recommendation:"Hold warfarin. Assess bleeding. Consider vitamin K per protocol.",
    queries:()=>["warfarin supratherapeutic INR management","warfarin vitamin K reversal"] },
  { id:"DOUBLE_ANTICOAG",         severity:"Major",
    test:(s)=>[["warfarin"],["rivaroxaban","apixaban","dabigatran","edoxaban"],["heparin"],["enoxaparin","dalteparin","fondaparinux"]].filter(g=>s.hasDrug(g)).length>=2,
    problem:"Dual anticoagulation detected — bleeding risk",
    recommendation:"Review intent. Ensure bridging protocol is appropriate.",
    queries:()=>["dual anticoagulation bleeding risk"] },
  { id:"VANC_TROUGH_LOW",         severity:"Major",
    test:(s)=>s.labs.vanc_trough&&s.labs.vanc_trough<10,
    problem:"Vancomycin trough sub-therapeutic (<10 mg/L) — treatment failure risk",
    recommendation:"Increase vancomycin dose or reduce interval. Recheck levels.",
    queries:()=>["vancomycin sub-therapeutic trough","vancomycin AUC guided dosing"] },
  { id:"VANC_TROUGH_HIGH",        severity:"Major",
    test:(s)=>s.labs.vanc_trough&&s.labs.vanc_trough>20,
    problem:"Vancomycin trough supra-therapeutic (>20 mg/L) — nephrotoxicity risk",
    recommendation:"Hold or reduce vancomycin. Recheck trough and renal function.",
    queries:()=>["vancomycin supra-therapeutic toxicity"] },
  { id:"DIGOXIN_TOXIC",           severity:"Critical",
    test:(s)=>s.labs.digoxin&&s.labs.digoxin>2.0,
    problem:"Digoxin level above therapeutic range — toxicity risk",
    recommendation:"Hold digoxin. Check K⁺/Mg²⁺. Cardiac monitoring. Consider Digibind.",
    queries:()=>["digoxin toxicity management"] },
  { id:"GENTA_TROUGH_HIGH",       severity:"Major",
    test:(s)=>s.labs.genta_trough&&s.labs.genta_trough>2,
    problem:"Gentamicin trough elevated (>2 mg/L) — nephrotoxicity/ototoxicity risk",
    recommendation:"Extend dosing interval. Recheck trough before next dose.",
    queries:()=>["gentamicin trough monitoring"] },
  { id:"HYPOKALEMIA_DIGOXIN",     severity:"Major",
    test:(s)=>s.labs.k&&s.labs.k<3.5&&s.hasDrug(["digoxin"]),
    problem:"Hypokalemia + digoxin — potentiates toxicity",
    recommendation:"Correct K⁺ before continuing digoxin. Target K⁺ ≥3.5 mmol/L.",
    queries:()=>["hypokalemia digoxin toxicity"] },
  { id:"HYPOKALEMIA_DIURETIC",    severity:"Moderate",
    test:(s)=>s.labs.k&&s.labs.k<3.5&&s.hasDrug(["furosemide","bumetanide","torsemide","hydrochlorothiazide","chlorthalidone"]),
    problem:"Hypokalemia on loop/thiazide diuretic",
    recommendation:"Replace potassium. Consider adding K-sparing agent.",
    queries:()=>["loop diuretic hypokalemia management"] },
  { id:"HYPOMAGNESEMIA_DRUG",     severity:"Moderate",
    test:(s)=>s.labs.mg&&s.labs.mg<0.74&&s.hasDrug(["furosemide","bumetanide","omeprazole","esomeprazole","lansoprazole","pantoprazole","gentamicin","tobramycin","amikacin"]),
    problem:"Hypomagnesaemia with offending drug",
    recommendation:"Replace magnesium IV or PO. Review offending drug.",
    queries:()=>["drug-induced hypomagnesaemia management"] },
  { id:"GLUCOSE_STEROID",         severity:"Moderate",
    test:(s)=>s.labs.glucose&&s.labs.glucose>10&&s.hasDrug(["dexamethasone","prednisolone","methylprednisolone","hydrocortisone"]),
    problem:"Hyperglycaemia with corticosteroid — steroid-induced hyperglycaemia",
    recommendation:"Intensify glucose monitoring. Consider insulin adjustment.",
    queries:()=>["steroid-induced hyperglycemia management"] },
  { id:"ALLERGY_PENICILLIN",      severity:"Critical",
    test:(s)=>s.hasAllergy(["penicillin","amoxicillin","ampicillin"])&&s.hasDrug(["amoxicillin","ampicillin","piperacillin","piperacillin-tazobactam","co-amoxiclav","flucloxacillin"]),
    problem:"Documented penicillin allergy — patient receiving penicillin-class antibiotic",
    recommendation:"STOP drug immediately. Switch to alternative per allergy type.",
    queries:()=>["penicillin allergy alternatives","beta-lactam cross-reactivity"] },
  { id:"ALLERGY_PENICILLIN_CEPH", severity:"Moderate",
    test:(s)=>s.hasAllergy(["penicillin","amoxicillin","ampicillin"])&&s.hasDrug(["cefazolin","ceftriaxone","cefuroxime","cefalexin","cephalexin","cefepime","ceftazidime"]),
    problem:"Penicillin allergy + cephalosporin — cross-reactivity risk",
    recommendation:"Review allergy nature. If anaphylaxis, avoid cephalosporins with same R1 side chain.",
    queries:()=>["penicillin allergy cephalosporin cross-reactivity"] },
  { id:"ALLERGY_NSAID",           severity:"Major",
    test:(s)=>s.hasAllergy(["nsaid","aspirin","ibuprofen","diclofenac"])&&s.hasDrug(["ibuprofen","naproxen","diclofenac","ketorolac","celecoxib","aspirin","indomethacin"]),
    problem:"NSAID allergy — patient receiving NSAID",
    recommendation:"Stop NSAID. Switch to paracetamol or opioid.",
    queries:()=>["NSAID allergy cross-reactivity"] },
  { id:"HEPATIC_PARACETAMOL",     severity:"Major",
    test:(s)=>s.hepaticFlag&&s.hasDrug(["paracetamol","acetaminophen"]),
    problem:"Paracetamol with elevated liver enzymes — hepatotoxicity risk",
    recommendation:"Limit paracetamol ≤2 g/day. Avoid if ALT/AST >3× ULN.",
    queries:()=>["paracetamol liver disease dose limit"] },
  { id:"HEPATIC_STATIN",          severity:"Moderate",
    test:(s)=>s.hepaticFlag&&s.hasDrug(["atorvastatin","rosuvastatin","simvastatin","pravastatin","fluvastatin"]),
    problem:"Statin with active liver disease — hepatotoxicity risk",
    recommendation:"Hold statin if ALT/AST >3× ULN.",
    queries:()=>["statin liver disease contraindication"] },
  { id:"MONITOR_VANC_NOLEVELS",   severity:"Moderate",
    test:(s)=>s.hasDrug(["vancomycin"])&&s.labs.vanc_trough===null&&s.labs.vanc_auc===null,
    problem:"Vancomycin without documented drug level monitoring",
    recommendation:"Order vancomycin trough or AUC monitoring. Target AUC 400–600 mg·h/L.",
    queries:()=>["vancomycin therapeutic drug monitoring protocol"] },
  { id:"MONITOR_GENTA_NOLEVELS",  severity:"Moderate",
    test:(s)=>s.hasDrug(["gentamicin"])&&s.labs.genta_trough===null,
    problem:"Gentamicin without trough monitoring",
    recommendation:"Check gentamicin trough before 3rd/4th dose.",
    queries:()=>["gentamicin trough monitoring protocol"] },
  { id:"MONITOR_WARFARIN_INR",    severity:"Moderate",
    test:(s)=>s.hasDrug(["warfarin"])&&s.labs.inr===null,
    problem:"Warfarin without documented INR",
    recommendation:"Obtain INR. Adjust warfarin to therapeutic range.",
    queries:()=>["warfarin INR monitoring protocol"] },
];

/* =========================================================
   DRUG → PROTOCOL FILE HINTS
========================================================= */
const DRUG_FILE_HINTS = {
  "vancomycin":              ["vancomycin TDM protocol","vancomycin AUC monitoring trough","MOH vancomycin TDM"],
  "warfarin":                ["warfarin protocol INR target","MOH warfarin anticoagulation","warfarin dose adjustment bleeding"],
  "metformin":               ["metformin renal contraindication lactic acidosis","diabetes medication renal impairment","endocrine metabolic CKD"],
  "gentamicin":              ["gentamicin aminoglycoside trough monitoring","aminoglycoside extended interval renal"],
  "tobramycin":              ["tobramycin aminoglycoside trough monitoring"],
  "amikacin":                ["amikacin aminoglycoside renal dosing"],
  "spironolactone":          ["spironolactone hyperkalemia renal failure","potassium sparing diuretic CKD"],
  "lisinopril":              ["ACE inhibitor renal impairment potassium","nephrology ACEi ARB monitoring"],
  "enalapril":               ["ACE inhibitor renal impairment potassium"],
  "ramipril":                ["ACE inhibitor renal impairment potassium"],
  "furosemide":              ["loop diuretic hypokalemia electrolyte","furosemide heart failure dosing"],
  "norepinephrine":          ["vasopressor septic shock management","sepsis norepinephrine protocol"],
  "dexamethasone":           ["steroid hyperglycemia corticosteroid glucose","dexamethasone septic shock"],
  "prednisolone":            ["steroid hyperglycemia corticosteroid glucose"],
  "piperacillin":            ["piperacillin tazobactam penicillin allergy","beta-lactam allergy antimicrobial"],
  "piperacillin-tazobactam": ["piperacillin tazobactam penicillin allergy HAP","adult antimicrobial guidelines HAP"],
  "paracetamol":             ["paracetamol hepatotoxicity liver enzymes ALT"],
  "acetaminophen":           ["paracetamol hepatotoxicity liver enzymes ALT"],
  "omeprazole":              ["proton pump inhibitor stress ulcer prophylaxis ICU"],
  "esomeprazole":            ["proton pump inhibitor stress ulcer prophylaxis ICU"],
  "heparin":                 ["heparin anticoagulation protocol thrombocytopenia HIT"],
  "enoxaparin":              ["enoxaparin renal dose adjustment anticoagulation","low molecular weight heparin CrCl"],
  "aspirin":                 ["aspirin ACS antiplatelet protocol","aspirin dose secondary prevention"],
  "clopidogrel":             ["clopidogrel antiplatelet ACS protocol"],
  "atorvastatin":            ["statin liver enzymes monitoring","atorvastatin high-intensity statin ACS"],
  "rosuvastatin":            ["rosuvastatin statin monitoring"],
  "digoxin":                 ["digoxin toxicity monitoring","digoxin renal impairment dose"],
  "insulin":                 ["insulin ICU glucose protocol","insulin sliding scale hyperglycemia"],
  "meropenem":               ["meropenem renal dose adjustment","meropenem HAP severe infection"],
  "ciprofloxacin":           ["ciprofloxacin renal dose","ciprofloxacin drug interaction"],
  "levofloxacin":            ["levofloxacin renal dose","levofloxacin QT prolongation"],
  "colistin":                ["colistin renal toxicity protocol","colistin loading dose"],
};

/* =========================================================
   MODE: ASK — PROTOCOL SEARCH WITH PAGE-AWARE RETRIEVAL
========================================================= */
async function handleAsk(body, env, corsHeaders, language) {
  const question    = body.question || body.q || "";
  const output_mode = (body.output_mode || "hybrid").toLowerCase();
  const source_mode = (body.source_mode || "off").toLowerCase();
  if (!question) return jsonResponse({ ok:false, error:"Question is required" }, 400, corsHeaders);
  requireApiCredentials(env);

  // ── PAGE INTENT DETECTION ───────────────────────────────────────────────────
  const pageIntent = detectPageIntent(question);

  // ── FILE INTENT DETECTION ───────────────────────────────────────────────────
  const fileIntent = detectFileIntent(question);

  // ── RETRIEVAL ───────────────────────────────────────────────────────────────
  let evidence;
  if (pageIntent) {
    evidence = await vectorSearchPageAware(env, question, pageIntent, fileIntent, 8);
  } else {
    evidence = await vectorSearch(env, question, 10);
    if (fileIntent) {
      // Re-rank: put matching file first
      evidence.sort((a,b) => {
        const aMatch = a.filename.toLowerCase().includes(fileIntent.toLowerCase()) ? 0 : 1;
        const bMatch = b.filename.toLowerCase().includes(fileIntent.toLowerCase()) ? 0 : 1;
        return aMatch - bMatch;
      });
    }
  }

  // ── QUALITY FILTER ─────────────────────────────────────────────────────────
  evidence = filterAndDeduplicateEvidence(evidence, fileIntent);

  if (source_mode === "required" && evidence.length === 0) {
    return jsonResponse({ ok:true, verdict:"NOT_FOUND",
      answer: language==="ar" ? "لم يتم العثور على إجابة في البروتوكول." : "Not found in protocol.",
      citations:[], applied_output:{ output_mode, source_mode } }, 200, corsHeaders);
  }
  if (evidence.length === 0) {
    return jsonResponse({ ok:true, verdict:"NOT_FOUND",
      answer: language==="ar" ? "لا توجد معلومات في المصادر المتاحة." : "No information found in available sources.",
      citations: source_mode==="off" ? undefined : [],
      applied_output:{ output_mode, source_mode } }, 200, corsHeaders);
  }

  const evidenceText = formatEvidenceText(evidence);
  let answer = "";

  // ── PAGE-SPECIFIC VERBATIM MODE ────────────────────────────────────────────
  if (pageIntent && output_mode === "verbatim") {
    const pageChunks = evidence.filter(e => e.page === pageIntent.page);
    if (pageChunks.length === 0) {
      answer = `I could not retrieve the requested page-specific text (page ${pageIntent.page}) from the indexed source. The page may not be indexed or the content was not split at that boundary.`;
    } else {
      // Reconstruct page order from chunk_index
      pageChunks.sort((a,b) => (a.chunk_index||0)-(b.chunk_index||0));
      answer = pageChunks.map(c => c.excerpt).join("\n\n");
    }
  } else if (output_mode === "verbatim") {
    answer = buildVerbatimAnswer(evidence);
  } else if (output_mode === "short") {
    const systemMsg = pageIntent
      ? `You are a clinical pharmacist AI. The user is asking about specific page content. Answer using ONLY the provided sources. If the exact page text is available, quote it. If not available, say so clearly. Return 3-6 bullet points starting with •.`
      : `You are a clinical pharmacist AI. Answer using ONLY the provided sources. Return 3-6 concise bullet points, each beginning with •. No preamble.`;
    answer = (await callGPT(env.OPENAI_API_KEY, {
      system: systemMsg,
      user: `Question: ${question}\n\nSources:\n${evidenceText}`,
      max_tokens: 400,
    })) || "• No concise answer available";
  } else {
    const systemMsg = pageIntent
      ? `You are a clinical pharmacist AI. The user requested specific page content. Use ONLY the provided sources. If page-specific content is available, quote it precisely. If the exact page is not available in sources, state clearly: "I could not retrieve page-specific text for the requested page." Do not hallucinate page content.\nFormat:\nANSWER: [answer]\n\nSOURCE:\n• [filename, page number]`
      : `You are a clinical pharmacist AI. Use ONLY the provided sources.\nFormat:\nANSWER: [2-4 sentence answer]\n\nKEY EVIDENCE:\n• ... — [filename, page if available]\nDo not add unsupported information.`;
    answer = (await callGPT(env.OPENAI_API_KEY, {
      system: systemMsg,
      user: `Question: ${question}\n\nSources:\n${evidenceText}`,
      max_tokens: 700,
    })) || "No answer generated.";
  }

  const response = { ok:true, verdict:"OK", answer, applied_output:{ output_mode, source_mode } };
  if (source_mode !== "off") response.citations = buildCitations(evidence, 280);
  return jsonResponse(response, 200, corsHeaders);
}

/* =========================================================
   MODE: MONOGRAPH
========================================================= */
async function handleMonograph(body, env, corsHeaders, language) {
  const drug_name      = body.drug_name || body.drug || "";
  const patient_context = body.patient_context || "";
  if (!drug_name) return jsonResponse({ ok:false, error:"drug_name is required" }, 400, corsHeaders);
  requireApiCredentials(env);
  const evidence    = await vectorSearch(env, `${drug_name} dosing indications renal warnings contraindications`, 8);
  const evidenceText = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";
  const monograph   = (await callGPT(env.OPENAI_API_KEY, {
    system: "You are a clinical pharmacist generating a concise protocol-based monograph.",
    user: `Generate a concise clinical monograph for ${drug_name}.\n${patient_context ? `Patient context: ${patient_context}\n` : ""}Use ONLY the provided sources.\nStructure:\n## Drug\n## Key Indications\n## Standard Dosing\n## Renal Adjustment\n## Major Warnings / Contraindications\n## Monitoring\n## Important Notes\n\nSources:\n${evidenceText}`,
    max_tokens: 900,
  })) || "Could not generate monograph.";
  return jsonResponse({ ok:true, drug_name, monograph, citations:buildCitations(evidence,220) }, 200, corsHeaders);
}

/* =========================================================
   MODE: ANTIBIOGRAM
========================================================= */
async function handleAntibiogram(body, env, corsHeaders, language) {
  const organism         = body.organism || "";
  const antibiotic       = body.antibiotic || "";
  const site_of_infection = body.site_of_infection || "";
  const patient_context  = body.patient_context || "";
  if (!organism && !antibiotic) return jsonResponse({ ok:false, error:"organism or antibiotic is required" }, 400, corsHeaders);
  requireApiCredentials(env);
  const query    = [organism, antibiotic, site_of_infection, "susceptibility resistance empiric therapy"].filter(Boolean).join(" ");
  const evidence = await vectorSearch(env, query, 8);
  const evidenceText = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";
  const analysis = (await callGPT(env.OPENAI_API_KEY, {
    system: "You are an infectious disease pharmacist. Use only provided sources.",
    user: `Organism: ${organism||"N/A"}\nAntibiotic: ${antibiotic||"N/A"}\nSite: ${site_of_infection||"N/A"}\nPatient: ${patient_context||"N/A"}\nFormat:\n## Interpretation\n## Empiric / Targeted Considerations\n## Key Risks / Notes\nSources:\n${evidenceText}`,
    max_tokens: 900,
  })) || "Could not generate analysis.";
  return jsonResponse({ ok:true, organism:organism||null, antibiotic:antibiotic||null, site_of_infection:site_of_infection||null, analysis, citations:buildCitations(evidence,220) }, 200, corsHeaders);
}

/* =========================================================
   MODE: CASE ANALYSIS — 4-PANEL PIPELINE
========================================================= */
async function handleCaseAnalysis(body, env, corsHeaders, language) {
  const case_text = body.case_text || "";
  const question  = body.question  || "";
  if (!case_text) return jsonResponse({ ok:false, error:"case_text is required" }, 400, corsHeaders);
  requireApiCredentials(env);

  // ── STAGE 1: Parse raw case ────────────────────────────────────────────────
  const extracted  = await extractCaseJson(env, case_text);
  const normalized = normalizeExtractedCase(extracted);

  // ── STAGE 1b: Derived clinical state ──────────────────────────────────────
  const crcl         = calcCrCl(normalized.age, normalized.weight_kg,
    normalized.labs?.scr_umol || (normalized.labs?.scr_mgdl ? normalized.labs.scr_mgdl*88.42 : null), normalized.sex);
  const classifiedLabs = classifyLabs(normalized.labs || {});
  const clinicalState  = buildClinicalState(normalized, crcl);

  // ── PANEL 1: Case Structurer ───────────────────────────────────────────────
  const panel1_soap = buildSoapNote({ patient:normalized, classifiedLabs, crcl,
    assessment:"See Panel 4 — Final Pharmacist Note for full assessment.",
    interventionsSummary:"See Panel 3 — Medication Scanner.",
    followupPlan:"See Panel 4."
  });

  // ── STAGE 2: Extract active diseases ──────────────────────────────────────
  const diseases = await extractDiseases(env, normalized, case_text);

  // ── STAGE 3: Disease pharmacotherapy retrieval ────────────────────────────
  const panel2_diseases = await runDiseaseScannerGPT({ env, normalized, crcl, clinicalState, diseases });

  // ── STAGE 4: Medication scanner ───────────────────────────────────────────
  const ruleFindings  = runSafetyRules(clinicalState);
  const medQueries    = buildTargetedQueries(normalized, clinicalState, ruleFindings, question);
  const rawEvidence   = await retrieveTargetedEvidence(env, medQueries);
  const allEvidence   = deduplicateEvidence(rawEvidence, 20);

  const panel3_meds = await runMedicationScannerGPT({ env, normalized, crcl, clinicalState, ruleFindings, evidence:allEvidence, question, language });

  // ── STAGE 5: Final pharmacist note ────────────────────────────────────────
  const panel4_note = await buildFinalPharmacistNote({ env, normalized, classifiedLabs, crcl, clinicalState,
    ruleFindings, medScanResult:panel3_meds, diseaseResult:panel2_diseases, evidence:allEvidence, question, language });

  // ── Merge interventions for legacy compatibility ───────────────────────────
  const mergedInterventions = mergeInterventions(ruleFindings, panel3_meds.interventions || []);

  return jsonResponse({
    ok: true,
    // 4-panel output
    panel1: { soap_note: panel1_soap },
    panel2: { diseases: panel2_diseases.diseases || [] },
    panel3: { drug_reviews: panel3_meds.drug_reviews || [] },
    panel4: { final_note: panel4_note.note, followup: panel4_note.followup },
    // Legacy fields (keep UI compatibility)
    soap_note: panel1_soap,
    pharmacist_interventions: mergedInterventions,
    medication_adjustments: panel3_meds.medication_adjustments || [],
    citations: buildCitations(allEvidence, 280),
  }, 200, corsHeaders);
}

/* =========================================================
   PANEL 1 HELPERS — SOAP NOTE BUILDER
========================================================= */
function buildSoapNote({ patient, classifiedLabs, crcl, assessment, interventionsSummary, followupPlan }) {
  const carePlace  = patient.care_setting || "ICU";
  const weightStr  = patient.weight_kg != null ? `${patient.weight_kg} kg` : "—";
  const ageStr     = patient.age != null ? `${patient.age}Y` : "—";
  const mrnStr     = patient.mrn || "—";
  const homeMeds   = Array.isArray(patient.home_medications)
    ? patient.home_medications.map(m => typeof m==="string" ? m : [m.name,m.dose,m.route,m.frequency].filter(Boolean).join(" ")).join(", ")
    : String(patient.home_medications || "N/A");

  const vitalsLines = buildVitalsLines(patient.vitals || {});
  const labsBlock   = buildClassifiedLabsBlock(classifiedLabs, crcl);
  const currentMeds = Array.isArray(patient.medications) && patient.medications.length
    ? patient.medications.map(m => {
        const parts = [m.name, m.dose, m.route, m.frequency].filter(Boolean);
        return `- ${parts.join(" ").replace(/\s+/g," ").trim()}`;
      }).join("\n")
    : "- No medications documented";

  return [
    `S:`,
    `Patient (MRN: ${mrnStr}), ${ageStr}, ${weightStr} — ${carePlace}`,
    `Reason for Admission: ${patient.reason_admission || "N/A"}`,
    `PMH: ${patient.pmh || "N/A"}`,
    `Allergies: ${(patient.allergies||[]).join(", ") || "None documented"}`,
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
    assessment || "Clinical pharmacist review performed.",
    ``,
    `P:`,
    `Current Medications:`,
    currentMeds,
    ``,
    `Pharmacist Intervention Summary:`,
    interventionsSummary || "Medication review completed.",
    ``,
    `Follow-up Plan:`,
    `- ${followupPlan || "Reassess as clinically indicated."}`,
  ].join("\n").replace(/\n{3,}/g,"\n\n").trim();
}

function buildVitalsLines(v) {
  const out = [];
  if (v.bp)   out.push(`- BP: ${v.bp}`);
  if (v.hr)   out.push(`- HR: ${v.hr}`);
  if (v.rr)   out.push(`- RR: ${v.rr}`);
  if (v.temp) out.push(`- Temp: ${v.temp}`);
  if (v.spo2) out.push(`- SpO2: ${v.spo2}`);
  if (v.gcs)  out.push(`- GCS: ${v.gcs}`);
  return out.join("\n");
}

function buildClassifiedLabsBlock(classifiedLabs, crcl) {
  if (!classifiedLabs.length && !crcl) return `- No clinically significant abnormalities detected.`;
  const bySection = {};
  for (const sec of LAB_SECTION_ORDER) bySection[sec] = [];
  for (const lab of classifiedLabs) {
    const include = lab.isAbnormal || lab.isBorderline || lab.isDrugRelevant || lab.section==="renal";
    if (!include) continue;
    (bySection[lab.section] = bySection[lab.section]||[]).push(lab);
  }
  const blocks = [];
  if (crcl || bySection.renal?.length) {
    const lines = [];
    const scr  = bySection.renal?.find(x=>x.key==="scr_umol"||x.key==="scr_mgdl");
    const urea = bySection.renal?.find(x=>x.key==="urea"||x.key==="bun");
    if (scr)  lines.push(`- ${scr.label}: ${scr.value} ${scr.unit}${scr.arrow?` ${scr.arrow}`:""}`);
    if (urea) lines.push(`- ${urea.label}: ${urea.value} ${urea.unit}${urea.arrow?` ${urea.arrow}`:""}`);
    if (crcl) lines.push(`- Calculated CrCl: ${crcl.value} mL/min (${crcl.category})`);
    if (!lines.length) lines.push(`- CrCl: ${crcl?`${crcl.value} mL/min (${crcl.category})`:"—"}`);
    blocks.push(`Renal:\n${lines.join("\n")}`);
  }
  for (const section of LAB_SECTION_ORDER.filter(s=>s!=="renal")) {
    const lines = (bySection[section]||[]).map(l=>`- ${l.label}: ${l.value} ${l.unit}${l.arrow?` ${l.arrow}`:""}${l.isDrugRelevant?" [drug-relevant]":""}`);
    if (lines.length) blocks.push(`${SECTION_TITLES[section]}:\n${lines.join("\n")}`);
  }
  return blocks.length ? blocks.join("\n\n") : "- No clinically significant abnormalities detected.";
}

/* =========================================================
   PANEL 2 — DISEASE SCANNER
========================================================= */
async function extractDiseases(env, normalized, caseText) {
  const dx      = String(normalized.diagnosis || "");
  const pmh     = String(normalized.pmh       || "");
  const reason  = String(normalized.reason_admission || "");
  const prompt  = `From the clinical case below, extract ALL active diseases, conditions, and clinical problems the patient has.
Include: primary diagnosis, comorbidities, active clinical problems (AKI, electrolyte disorders, sepsis, VTE risk, etc.).
Return ONLY valid JSON array: ["Disease1","Disease2",...]
No markdown. No extra text.

Context:
Diagnosis: ${dx}
PMH: ${pmh}
Admission reason: ${reason}
Case excerpt: ${caseText.substring(0,600)}`;

  try {
    const raw = await callGPT(env.OPENAI_API_KEY, {
      system: "Extract diseases. Return only valid JSON array.",
      user: prompt, max_tokens: 400,
    });
    const parsed = safeParseJSON(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return [dx, pmh].filter(Boolean); }
}

async function runDiseaseScannerGPT({ env, normalized, crcl, clinicalState, diseases }) {
  if (!diseases.length) return { diseases:[] };

  // Retrieve evidence for all diseases in parallel
  const diseaseEvidenceMap = {};
  const fetches = diseases.map(async (disease) => {
    const queries = [
      `${disease} treatment protocol`,
      `${disease} pharmacotherapy guidelines`,
      `${disease} drug therapy management`,
    ];
    const results = await Promise.allSettled(queries.map(q => vectorSearch(env, q, 3)));
    const chunks  = [];
    for (const r of results) if (r.status==="fulfilled") chunks.push(...r.value);
    diseaseEvidenceMap[disease] = deduplicateEvidence(chunks, 6);
  });
  await Promise.all(fetches);

  const crclStr = crcl ? `${crcl.value} mL/min (${crcl.category})` : "Unable to calculate";
  const allergies = (normalized.allergies||[]).join(", ") || "None";
  const currentMedNames = (normalized.medications||[]).map(m=>m.name).filter(Boolean).join(", ");

  // Build evidence text per disease
  const diseaseSections = diseases.map(disease => {
    const ev = diseaseEvidenceMap[disease] || [];
    const evText = ev.length ? ev.map(e=>`[${e.filename}${e.page?` p.${e.page}`:""}]: ${e.excerpt.substring(0,500)}`).join("\n---\n") : "No specific protocol found for this disease.";
    return `=== DISEASE: ${disease} ===\nEvidence:\n${evText}`;
  }).join("\n\n");

  const prompt = `You are a clinical pharmacist performing a protocol-based disease scanner.

Patient:
- Age: ${normalized.age||"N/A"} | Sex: ${normalized.sex||"N/A"} | Weight: ${normalized.weight_kg||"N/A"} kg
- CrCl: ${crclStr}
- Allergies: ${allergies}
- Diagnosis: ${normalized.diagnosis||"N/A"}
- PMH: ${normalized.pmh||"N/A"}
- Current medications: ${currentMedNames||"None"}
- Renal flag: ${clinicalState.renalFlag?"YES":"No"} | Sepsis flag: ${clinicalState.septicFlag?"YES":"No"}

Diseases to scan: ${diseases.join(", ")}

${diseaseSections}

For EACH disease, using the provided protocol evidence:
1. Identify the recommended pharmacotherapy for THIS specific patient
2. List specific drugs, doses, and key pharmacotherapy points
3. Flag any missing required medications
4. Note any protocol-specific considerations for this patient's renal/hepatic/allergy status

Return ONLY valid JSON — no markdown:
{
  "diseases": [
    {
      "name": "Disease name",
      "status": "Active|Chronic|Suspected",
      "recommended_pharmacotherapy": ["drug 1 — dose — note", "drug 2 — dose — note"],
      "missing_from_current_meds": ["missing drug 1", "missing drug 2"],
      "key_points": "Brief protocol-specific note for this patient",
      "reference": "filename if found, else Not specified in available protocol"
    }
  ]
}`;

  try {
    const raw    = await callGPT(env.OPENAI_API_KEY, { system:"Clinical pharmacist disease scanner. Return only valid JSON.", user:prompt, max_tokens:2500, model:"gpt-4o" });
    const parsed = safeParseJSON(raw || "{}");
    return { diseases: Array.isArray(parsed.diseases) ? parsed.diseases : [] };
  } catch (e) {
    console.error("runDiseaseScannerGPT error:", e);
    return { diseases: diseases.map(d => ({ name:d, status:"Active", recommended_pharmacotherapy:[], missing_from_current_meds:[], key_points:"Review against uploaded protocol.", reference:"Not specified" })) };
  }
}

/* =========================================================
   PANEL 3 — MEDICATION SCANNER (DEEP DRUG REVIEW)
========================================================= */
async function runMedicationScannerGPT({ env, normalized, crcl, clinicalState, ruleFindings, evidence, question, language }) {
  const meds = normalized.medications || [];
  if (!meds.length) return { drug_reviews:[], interventions:[], medication_adjustments:[] };

  const labSummary     = classifyLabs(normalized.labs||{}).map(l=>`${l.label} ${l.value}${l.unit?` ${l.unit}`:""} ${l.arrow}`).join(", ") || "No significant labs";
  const evidenceText   = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";
  const ruleText       = ruleFindings.length ? ruleFindings.map(r=>`[${r.severity}] ${r.problem} → ${r.recommendation}`).join("\n") : "None triggered.";
  const medsList       = meds.map(m=>`${m.name||""} ${m.dose||""} ${m.route||""} ${m.frequency||""}`.trim()).join("\n");
  const crclStr        = crcl ? `${crcl.value} mL/min (${crcl.category})` : "Unable to calculate";

  const prompt = `You are a senior clinical pharmacist performing a deep medication audit.
Return ONLY valid JSON — no markdown.

PATIENT:
Age: ${normalized.age||"N/A"}Y | Sex: ${normalized.sex||"N/A"} | Weight: ${normalized.weight_kg||"N/A"} kg
Setting: ${normalized.care_setting||"N/A"} | CrCl: ${crclStr}
Diagnosis: ${normalized.diagnosis||"N/A"} | PMH: ${normalized.pmh||"N/A"}
Allergies: ${(normalized.allergies||[]).join(", ")||"None"}
Labs: ${labSummary}
Renal flag: ${clinicalState.renalFlag?"YES":"No"} | Hepatic flag: ${clinicalState.hepaticFlag?"YES":"No"} | Sepsis flag: ${clinicalState.septicFlag?"YES":"No"}

CURRENT MEDICATIONS:
${medsList}

PRE-DETECTED SAFETY ISSUES:
${ruleText}

PROTOCOL EVIDENCE:
${evidenceText}

For EACH medication listed, perform a complete pharmacist review covering:
1. Indication — Is this drug indicated for the patient's condition?
2. Appropriateness — Does it fit the current clinical state?
3. Dose — Is dose correct for age, weight, renal function, indication?
4. Frequency — Is the frequency appropriate?
5. Route — Is the route appropriate?
6. Drug-Lab Links — Which labs are relevant? Are there concerning values?
7. Contraindications/Precautions — Any active contraindications?
8. Monitoring — What needs to be monitored?
9. Verdict — ONE of: ALLOWED | BORDERLINE | NOT APPROPRIATE
10. Action — ONE decisive action: Continue | Stop | Hold | Reduce dose | Increase dose | Change frequency | Replace with [specific alternative] | Add monitoring

IMPORTANT: Do NOT use vague language. State the exact correction.
Example:
- NOT "consider adjustment" → USE "Reduce dose to 500mg Q24H based on CrCl 30 mL/min"
- NOT "monitor closely" → USE "Check SCr and K+ every 48h; hold if SCr rises >30% from baseline"

Return:
{
  "drug_reviews": [
    {
      "drug": "name",
      "dose_ordered": "current order",
      "indication": "stated indication",
      "appropriateness": "brief statement",
      "dose_assessment": "correct or specific correction",
      "frequency_assessment": "correct or correction",
      "route_assessment": "correct or correction",
      "drug_lab_links": ["lab1 — value — concern", "lab2 — value — concern"],
      "contraindications": "none or specific concern",
      "monitoring": "specific monitoring parameters",
      "verdict": "ALLOWED|BORDERLINE|NOT APPROPRIATE",
      "action": "exact decisive action",
      "reference": "filename+page or Not clearly specified in available protocol"
    }
  ],
  "interventions": [
    {
      "severity": "Critical|Major|Moderate|Minor",
      "problem": "clear problem",
      "recommendation": "specific action",
      "reference": "source"
    }
  ],
  "medication_adjustments": [
    {
      "drug": "name",
      "ordered": "current order",
      "recommended": "corrected order",
      "verdict": "CORRECT|ADJUST|STOP|MONITOR|NOT_IN_PROTOCOL",
      "reason": "brief explanation",
      "reference": "source"
    }
  ],
  "assessment": "2-4 sentence pharmacist assessment",
  "interventions_summary": "1-2 sentence overview",
  "followup_plan": "specific follow-up parameters"
}`;

  try {
    const raw    = await callGPT(env.OPENAI_API_KEY, { system:"Clinical pharmacist. Return only valid JSON. Be decisive, not vague.", user:prompt, max_tokens:3500, model:"gpt-4o" });
    const parsed = safeParseJSON(raw || "{}");
    return {
      drug_reviews:           Array.isArray(parsed.drug_reviews)          ? parsed.drug_reviews          : [],
      interventions:          Array.isArray(parsed.interventions)          ? parsed.interventions          : [],
      medication_adjustments: Array.isArray(parsed.medication_adjustments) ? parsed.medication_adjustments : [],
      assessment:             parsed.assessment             || "Clinical pharmacist review performed.",
      interventions_summary:  parsed.interventions_summary  || "Medication review completed.",
      followup_plan:          parsed.followup_plan          || "Follow-up as clinically indicated.",
    };
  } catch (e) {
    console.error("runMedicationScannerGPT error:", e);
    return { drug_reviews:[], interventions:[], medication_adjustments:[], assessment:"Review error.", interventions_summary:"", followup_plan:"" };
  }
}

/* =========================================================
   PANEL 4 — FINAL PHARMACIST NOTE
========================================================= */
async function buildFinalPharmacistNote({ env, normalized, classifiedLabs, crcl, clinicalState, ruleFindings, medScanResult, diseaseResult, evidence, question, language }) {
  const evidenceText = evidence.length ? formatEvidenceText(evidence) : "No protocol sources found.";
  const allProblems  = [
    ...ruleFindings.map(r=>`[${r.severity}] ${r.problem}`),
    ...(medScanResult.interventions||[]).filter(i=>i.severity==="Critical"||i.severity==="Major").map(i=>`[${i.severity}] ${i.problem}`),
  ].join("\n") || "No critical issues detected.";

  const drugActions = (medScanResult.drug_reviews||[]).map(d=>`${d.drug}: Verdict=${d.verdict}, Action=${d.action}`).join("\n") || "None";
  const missingMeds = (diseaseResult.diseases||[]).flatMap(d=>d.missing_from_current_meds||[]).filter(Boolean);

  const prompt = `You are a senior clinical pharmacist writing the final decisive pharmacist note.
Be specific. Be decisive. State exact corrections. Do not use vague language.

PATIENT:
${normalized.age||"N/A"}Y ${normalized.sex||"N/A"} | ${normalized.weight_kg||"N/A"}kg | CrCl: ${crcl?`${crcl.value} mL/min (${crcl.category})`:"Unable"}
Diagnosis: ${normalized.diagnosis||"N/A"} | Admission: ${normalized.reason_admission||"N/A"}
PMH: ${normalized.pmh||"N/A"} | Allergies: ${(normalized.allergies||[]).join(", ")||"None"}

IDENTIFIED PROBLEMS:
${allProblems}

DRUG ACTIONS DETERMINED:
${drugActions}

MISSING MEDICATIONS FLAGGED:
${missingMeds.join(", ") || "None identified"}

PROTOCOL EVIDENCE:
${evidenceText}

Write the final pharmacist note in this exact format:

A:
[Clinical pharmacist assessment covering: main admission problem, comorbidities, medication-related problems detected, missing therapies, wrong doses, contraindicated drugs, renal issues, lab-drug risks]

P — PHARMACIST INTERVENTIONS:
[For each issue: Drug name → exact problem → exact correction with specific dose/frequency]

MISSING THERAPIES:
[List any recommended drugs not currently prescribed per protocol]

FOLLOW-UP PLAN:
[Specific monitoring parameters, lab targets, reassessment timeline]

Return ONLY valid JSON:
{
  "note": "full formatted pharmacist note text",
  "followup": "specific monitoring plan text"
}`;

  try {
    const raw    = await callGPT(env.OPENAI_API_KEY, { system:"Senior clinical pharmacist writing final note. Decisive, specific, no vague language. Return only valid JSON.", user:prompt, max_tokens:2000, model:"gpt-4o" });
    const parsed = safeParseJSON(raw || "{}");
    return {
      note:     parsed.note     || buildFallbackNote(normalized, classifiedLabs, crcl, medScanResult),
      followup: parsed.followup || medScanResult.followup_plan || "Reassess medications and labs as clinically indicated.",
    };
  } catch (e) {
    console.error("buildFinalPharmacistNote error:", e);
    return { note: buildFallbackNote(normalized, classifiedLabs, crcl, medScanResult), followup: "Reassess as clinically indicated." };
  }
}

function buildFallbackNote(normalized, classifiedLabs, crcl, medScanResult) {
  return buildSoapNote({
    patient: normalized, classifiedLabs, crcl,
    assessment:           medScanResult.assessment || "Clinical review performed.",
    interventionsSummary: medScanResult.interventions_summary || "See interventions list.",
    followupPlan:         medScanResult.followup_plan || "Follow-up as clinically indicated.",
  });
}

/* =========================================================
   CLINICAL STATE (L3)
========================================================= */
function buildClinicalState(normalized, crcl) {
  const labs      = normalized.labs || {};
  const meds      = (normalized.medications||[]).map(m=>(m.name||"").toString().toLowerCase().trim());
  const allergies = (normalized.allergies||[]).map(a=>String(a||"").toLowerCase().trim());
  const diagnosis = String(normalized.diagnosis||"").toLowerCase();
  const pmh       = String(normalized.pmh||"").toLowerCase();
  const combined  = `${diagnosis} ${pmh} ${String(normalized.reason_admission||"").toLowerCase()}`;
  const renalFlag  = crcl ? crcl.value < 60 : false;
  const hepaticFlag = (labs.alt&&labs.alt>56*3)||(labs.ast&&labs.ast>40*3)||(labs.bili_t&&labs.bili_t>21*2);
  const septicFlag  = combined.includes("sepsis")||combined.includes("septic")||(labs.procalc&&labs.procalc>2)||(labs.lactate&&labs.lactate>2);
  return {
    labs, crcl, renalFlag, hepaticFlag, septicFlag, meds, allergies, diagnosis,
    hasDrug:     (names)=>names.some(n=>meds.some(m=>m.includes(n.toLowerCase()))),
    hasCondition:(terms)=>terms.some(t=>combined.includes(t.toLowerCase())),
    hasAllergy:  (terms)=>terms.some(t=>allergies.some(a=>a.includes(t.toLowerCase()))),
  };
}

/* =========================================================
   SAFETY RULE ENGINE (L5)
========================================================= */
function runSafetyRules(cs) {
  const triggered = [];
  for (const rule of SAFETY_RULES) {
    try {
      if (rule.test(cs)) triggered.push({
        id: rule.id, severity: rule.severity, problem: rule.problem,
        recommendation: rule.recommendation,
        queries: typeof rule.queries==="function" ? rule.queries(cs) : [],
        source: "rule_engine", reference: "Pending evidence retrieval",
      });
    } catch(_) {}
  }
  return triggered;
}

/* =========================================================
   TARGETED QUERY GENERATION (L6)
========================================================= */
function buildTargetedQueries(normalized, clinicalState, ruleFindings, question) {
  const queries = new Set();
  const labs    = normalized.labs || {};

  for (const med of (normalized.medications||[])) {
    const rawName  = (med.name||"").trim();
    if (!rawName) continue;
    const nameLower = rawName.toLowerCase();
    for (const [keyword, hints] of Object.entries(DRUG_FILE_HINTS)) {
      if (nameLower.includes(keyword)) { hints.forEach(q=>queries.add(q)); break; }
    }
    queries.add(`${rawName} dosing adult`);
    queries.add(`${rawName} contraindications warnings`);
    if (clinicalState.renalFlag)  queries.add(`${rawName} renal impairment CrCl dose`);
    if (clinicalState.hepaticFlag) queries.add(`${rawName} hepatic impairment`);
    if (clinicalState.septicFlag)  queries.add(`${rawName} sepsis critical illness`);
  }

  for (const f of ruleFindings) for (const q of (f.queries||[])) queries.add(q);

  if (labs.k&&labs.k>5.5)     queries.add("hyperkalemia management protocol treatment");
  if (labs.k&&labs.k<3.5)     queries.add("hypokalemia potassium replacement protocol");
  if (labs.plt&&labs.plt<100) queries.add("thrombocytopenia anticoagulation threshold");
  if (labs.lactate&&labs.lactate>2) queries.add("lactic acidosis sepsis management");
  if (labs.inr&&labs.inr>3)   queries.add("supratherapeutic INR warfarin vitamin K");
  if (labs.glucose&&labs.glucose>10) queries.add("hyperglycemia ICU steroid insulin");
  if (labs.alt&&labs.alt>120) queries.add("elevated liver enzymes hepatotoxicity");

  const dx = String(normalized.diagnosis||"").trim();
  if (dx) { queries.add(`${dx} treatment protocol`); queries.add(`${dx} empiric antimicrobial`); }
  if (clinicalState.septicFlag) {
    queries.add("septic shock antibiotic protocol adult guidelines");
    queries.add("hospital acquired pneumonia HAP empiric treatment");
    queries.add("sepsis bundle management ICU");
  }

  for (const allergy of (normalized.allergies||[])) {
    const a = String(allergy).toLowerCase();
    queries.add(`${allergy} allergy cross-reactivity alternative`);
    if (a.includes("penicillin")||a.includes("amoxicillin")) {
      queries.add("penicillin allergy beta-lactam cross-reactivity cephalosporin");
      queries.add("penicillin allergy antimicrobial alternative");
    }
  }

  if (clinicalState.renalFlag&&clinicalState.crcl) {
    queries.add(`renal dose adjustment CrCl ${Math.round(clinicalState.crcl.value)}`);
    queries.add("CKD drug dosing nephrology protocol");
    queries.add("nephrotoxic drug avoidance renal impairment");
  }

  if (clinicalState.hasDrug(["warfarin","heparin","enoxaparin","rivaroxaban","apixaban"])) {
    queries.add("anticoagulation protocol bleeding risk monitoring");
    queries.add("anticoagulation thrombocytopenia platelet threshold");
  }

  if (question) queries.add(question);
  return Array.from(queries).filter(Boolean).slice(0, 25);
}

/* =========================================================
   EVIDENCE RETRIEVAL (L7)
========================================================= */
async function retrieveTargetedEvidence(env, queries) {
  const fetches = queries.map(q=>vectorSearch(env, q, 3));
  const results = await Promise.allSettled(fetches);
  const all = [];
  for (const r of results) if (r.status==="fulfilled") all.push(...r.value);
  return all;
}

function deduplicateEvidence(evidence, limit=20) {
  const map = new Map();
  for (const e of evidence) {
    const key = `${e.filename}::${e.excerpt.substring(0,80)}`;
    if (!map.has(key)) map.set(key,e);
  }
  const deduped = Array.from(map.values()).slice(0, limit);
  deduped.forEach((e,i)=>{ e.id=`E${i+1}`; });
  return deduped;
}

/* =========================================================
   MERGE INTERVENTIONS (L8)
========================================================= */
function mergeInterventions(ruleFindings, gptInterventions) {
  const order = { Critical:0, Major:1, Moderate:2, Minor:3 };
  const combined = [
    ...ruleFindings.map(r=>({ severity:r.severity, problem:r.problem, recommendation:r.recommendation, reference:r.reference||"Pending protocol confirmation" })),
    ...(gptInterventions||[]),
  ];
  const seen = new Set();
  const deduped = [];
  for (const item of combined) {
    const key = (item.problem||"").toLowerCase().replace(/[^a-z0-9]/g,"").substring(0,50);
    if (!seen.has(key)) { seen.add(key); deduped.push(item); }
  }
  return deduped.sort((a,b)=>(order[a.severity]??99)-(order[b.severity]??99));
}

/* =========================================================
   CASE EXTRACTION (L1+L2)
========================================================= */
async function extractCaseJson(env, caseText) {
  const prompt = `Extract structured patient data from the case below.
Return ONLY valid JSON with no markdown.

Case:
${caseText}

Schema:
{
  "mrn": null, "patient_name": null, "age": null, "sex": null,
  "weight_kg": null, "height_cm": null, "care_setting": null,
  "reason_admission": null, "pmh": null, "home_medications": null,
  "diagnosis": null, "allergies": [],
  "vitals": { "bp":null,"hr":null,"rr":null,"temp":null,"spo2":null,"gcs":null },
  "labs": {
    "hb":null,"wbc":null,"plt":null,"neutrophil":null,
    "scr_umol":null,"scr_mgdl":null,"urea":null,"bun":null,
    "na":null,"k":null,"cl":null,"bicarb":null,"ca":null,"mg":null,"phos":null,
    "alt":null,"ast":null,"alp":null,"bili_t":null,"albumin":null,
    "inr":null,"pt":null,"aptt":null,"fibrinogen":null,
    "glucose":null,"crp":null,"procalc":null,"lactate":null,
    "vanc_trough":null,"vanc_auc":null,"genta_trough":null,"tobra_trough":null,
    "digoxin":null,"phenytoin":null,"valproate":null,"tacro":null,"cyclo":null
  },
  "medications": [{ "name":"","dose":"","route":"","frequency":"","indication":null }]
}`;
  try {
    const raw = await callGPT(env.OPENAI_API_KEY, { system:"Extract clinical case data. Return only valid JSON.", user:prompt, max_tokens:1400 });
    if (!raw) return emptyExtractedCase();
    return safeParseJSON(raw) || emptyExtractedCase();
  } catch(e) { console.error("extractCaseJson:",e); return emptyExtractedCase(); }
}

function normalizeExtractedCase(extracted) {
  const base   = emptyExtractedCase();
  const merged = {
    ...base, ...extracted,
    vitals:      { ...base.vitals,      ...(extracted?.vitals      ||{}) },
    labs:        { ...base.labs,        ...(extracted?.labs        ||{}) },
    medications: Array.isArray(extracted?.medications) ? extracted.medications : [],
    allergies:   Array.isArray(extracted?.allergies)   ? extracted.allergies   : [],
  };
  merged.age       = toNumberOrNull(merged.age);
  merged.weight_kg = toNumberOrNull(merged.weight_kg);
  merged.height_cm = toNumberOrNull(merged.height_cm);
  for (const key of Object.keys(merged.labs)) merged.labs[key] = toNumberOrNull(merged.labs[key]);

  for (const field of ["patient_name","mrn","care_setting","reason_admission","pmh","diagnosis","sex"]) {
    const v = merged[field];
    if (v!=null) merged[field] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  if (Array.isArray(merged.home_medications)) {
    merged.home_medications = merged.home_medications.map(m=>typeof m==="string" ? m : [m.name,m.dose,m.route,m.frequency].filter(Boolean).join(" ").trim()||String(m)).join(", ");
  } else if (merged.home_medications!=null) {
    merged.home_medications = String(merged.home_medications);
  }
  if (!Array.isArray(merged.allergies)) merged.allergies = merged.allergies ? [String(merged.allergies)] : [];
  merged.allergies   = merged.allergies.map(a=>String(a||""));
  merged.medications = merged.medications.map(m=>({ ...m, name:String(m.name||"") }));
  return merged;
}

function classifyLabs(labs) {
  const out = [];
  for (const [key,value] of Object.entries(labs||{})) {
    if (value===null||value===undefined||value==="") continue;
    const ref = LAB_RANGES[key]; if (!ref) continue;
    const num = Number(value); if (Number.isNaN(num)) continue;
    let status="normal",arrow="";
    if (ref.high!==null&&num>ref.high)      { const p=(num-ref.high)/ref.high; status=p>BORDERLINE_MARGIN?"high":"borderline-high"; arrow="↑"; }
    else if (ref.low!==null&&num<ref.low)   { const p=(ref.low-num)/ref.low;   status=p>BORDERLINE_MARGIN?"low":"borderline-low";   arrow="↓"; }
    out.push({ key, label:ref.label, value:num, unit:ref.unit, section:ref.section, status, arrow,
      isAbnormal:   status==="high"||status==="low",
      isBorderline: status==="borderline-high"||status==="borderline-low",
      drugRelated:  ref.drugRelated||[],
      isDrugRelevant: Array.isArray(ref.drugRelated)&&ref.drugRelated.length>0,
    });
  }
  return out.sort((a,b)=>{
    const sr=x=>x.isAbnormal?0:x.isBorderline?1:2;
    const sa=LAB_SECTION_ORDER.indexOf(a.section||""), sb=LAB_SECTION_ORDER.indexOf(b.section||"");
    if (sr(a)!==sr(b)) return sr(a)-sr(b);
    if (sa!==sb) return sa-sb;
    return a.label.localeCompare(b.label);
  });
}

/* =========================================================
   VECTOR SEARCH + PAGE-AWARE RETRIEVAL
========================================================= */
async function vectorSearch(env, query, maxResults=6) {
  try {
    const res = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${env.OPENAI_API_KEY}`, "Content-Type":"application/json", "OpenAI-Beta":"assistants=v2" },
      body: JSON.stringify({ query, max_num_results: maxResults }),
    });
    if (!res.ok) { console.error("vectorSearch failed:", await res.text()); return []; }
    const data = await res.json();
    const evidence = [];
    for (let i=0; i<(data.data||[]).length; i++) {
      const item     = data.data[i];
      const filename = item.attributes?.filename||item.attributes?.file_name||item.filename||item.file_name||item.file_id||`source_${i+1}`;
      let content    = "";
      if (item.content) {
        if (Array.isArray(item.content)) content=item.content.map(c=>c.text||c.value||"").join("\n");
        else if (typeof item.content==="string") content=item.content;
        else if (item.content?.text) content=item.content.text;
      }
      if (!content&&item.text) content=item.text;
      if (!content&&Array.isArray(item.chunks)) content=item.chunks.map(c=>c.text||"").join("\n");
      if (!content||!content.trim()) continue;

      // Page extraction — check metadata first, then text patterns
      let page = 0;
      if (item.attributes?.page)   page = parseInt(item.attributes.page, 10)||0;
      if (!page&&item.metadata?.page) page = parseInt(item.metadata.page, 10)||0;
      if (!page) {
        const pm = content.match(/(?:Page|PAGE|page)\s*[:\-]?\s*(\d+)/i)||content.match(/\bp\.?\s*(\d+)\b/i)||content.match(/\[p\.\s*(\d+)\]/i);
        if (pm) page = parseInt(pm[1],10);
      }
      const chunk_index = item.attributes?.chunk_index ?? item.metadata?.chunk_index ?? 0;

      let section="";
      const sm = content.match(/(?:Section|SECTION)\s+(\d+(?:\.\d+)*)\s*[–—\-]?\s*([^\n]+)/i)||content.match(/^#{1,3}\s+([^\n]+)/m)||content.match(/^\d+\.\d+\s+([^\n]+)/m);
      if (sm) section=(sm[2]||sm[1]||"").trim().substring(0,80);

      // Clean excerpt — start at sentence boundary
      const rawExcerpt = content.substring(0,2000);
      const cleanExcerpt = cleanExcerptText(rawExcerpt);

      evidence.push({ id:`E${i+1}`, filename, page, chunk_index, section, score:item.score??item.similarity??null, excerpt:cleanExcerpt });
    }
    return evidence;
  } catch(e) { console.error("vectorSearch exception:",e); return []; }
}

// Page-aware search: retrieve then filter/prioritize by page
async function vectorSearchPageAware(env, query, pageIntent, fileIntent, maxResults=10) {
  const evidence = await vectorSearch(env, query, maxResults);

  // If we have a specific file+page request, filter strictly
  if (fileIntent && pageIntent.page) {
    const fileMatch = evidence.filter(e => e.filename.toLowerCase().includes(fileIntent.toLowerCase()) && e.page===pageIntent.page);
    if (fileMatch.length) return fileMatch;
    // Fall back to file match without page filter
    const fileFallback = evidence.filter(e => e.filename.toLowerCase().includes(fileIntent.toLowerCase()));
    if (fileFallback.length) return fileFallback;
  }
  if (pageIntent.page) {
    const pageMatch = evidence.filter(e => e.page===pageIntent.page);
    if (pageMatch.length) return pageMatch;
  }
  return evidence;
}

// Detect explicit page requests
function detectPageIntent(query) {
  const q = query.toLowerCase();
  const patterns = [
    /\bpage\s+(\d+)\b/i,
    /\bp\.?\s*(\d+)\b/i,
    /\bon\s+page\s+(\d+)\b/i,
    /\bfrom\s+page\s+(\d+)\b/i,
    /\bexact(?:ly)?\s+(?:from\s+)?page\s+(\d+)\b/i,
  ];
  for (const pat of patterns) {
    const m = query.match(pat);
    if (m) return { page: parseInt(m[1],10), raw: m[0] };
  }
  return null;
}

// Detect explicit file name in query
function detectFileIntent(query) {
  const knownFiles = [
    "Piperacillin_Tazobactam","MOH_Vanco_TDM","MOH_Warfarin","Vancomycin","Warfarin","Meropenem",
    "Ciprofloxacin","Levofloxacin","colistin","Amiodarone","ANTICOAGULATION PROTOCOL","ANTIBIOGRAM",
    "ADULT GUIDELINES FOR ANTIMICROBIAL","Ambulatory Board","Geriatrics","Nephrology","Endocrine",
    "Gastroenterology","Pulmonology","Epilepsy","GINA","Adalimumab","Trimethoprim","Procainamide",
    "MS-CCU","POST-CATHETERIZATION","ACUTE CORONARY","VASCULAR ACCESS","PROTOCOL FOR MANAGING",
  ];
  const qLower = query.toLowerCase();
  for (const f of knownFiles) {
    if (qLower.includes(f.toLowerCase())) return f;
  }
  return null;
}

// Filter evidence: min score, dedup, max per file, clean excerpts
function filterAndDeduplicateEvidence(evidence, fileIntent) {
  const uniqueFiles = new Set(evidence.map(e=>e.filename));
  const hasMulti    = uniqueFiles.size > 1;

  // Strict file filter if user named a file
  let filtered = evidence;
  if (fileIntent) {
    const strict = evidence.filter(e=>e.filename.toLowerCase().includes(fileIntent.toLowerCase()));
    if (strict.length >= 2) filtered = strict;
  }

  // Score threshold
  filtered = filtered.filter(e=>!hasMulti||e.score===null||e.score>=0.68);

  // Dedup
  const seen     = new Set();
  const deduped  = [];
  for (const e of filtered) {
    const key = `${e.filename}::${e.excerpt.substring(0,60)}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(e); }
  }

  // Max 2 per file, max 6 total
  const fileCount = {};
  return deduped.filter(e=>{
    fileCount[e.filename] = (fileCount[e.filename]||0)+1;
    return fileCount[e.filename] <= 2;
  }).slice(0,6);
}

// Clean excerpt to start/end at sentence boundary
function cleanExcerptText(text) {
  const cleaned = text.replace(/\s+/g," ").trim();
  // Try to start at first capital letter after the first 20 chars
  const firstSentence = cleaned.search(/(?<=[.!?]\s)[A-Z]/);
  const started = firstSentence > 0 && firstSentence < 100 ? cleaned.substring(firstSentence) : cleaned;
  // End at sentence boundary
  const lastSentence = started.lastIndexOf(". ");
  if (lastSentence > 100) return started.substring(0, lastSentence+1);
  return started;
}

/* =========================================================
   CITATION BUILDER
========================================================= */
function formatEvidenceText(evidence) {
  return evidence.map(e=>`[SOURCE ${e.id}] File: ${e.filename}${e.page?` | Page: ${e.page}`:""}${e.section?` | Section: ${e.section}`:""}\nContent: ${e.excerpt}`).join("\n\n---\n\n");
}

function buildCitations(evidence, excerptLen=280) {
  const fileCount = {};
  const uniqueFiles = new Set(evidence.map(e=>e.filename));
  const hasMulti = uniqueFiles.size > 1;

  return evidence
    .filter(e=>!hasMulti||e.score===null||e.score>=0.68)
    .filter(e=>{ fileCount[e.filename]=(fileCount[e.filename]||0)+1; return fileCount[e.filename]<=2; })
    .map(e=>({
      evidence_ids: [e.id],
      filename:     e.filename,
      section:      e.section||"",
      page:         e.page||0,
      chunk_index:  e.chunk_index||0,
      score:        e.score,
      excerpt:      cleanExcerptText(e.excerpt).substring(0, excerptLen),
    }));
}

function buildVerbatimAnswer(evidence) {
  return evidence.slice(0,3).map(e=>{
    const sentences = e.excerpt.split(/[.!?]+/).map(s=>s.trim()).filter(Boolean);
    const first     = sentences.find(s=>s.length>20) || e.excerpt.substring(0,150);
    return `"${first.endsWith(".")?first:`${first}.`}"\n— ${e.filename}${e.page?` (p. ${e.page})`:""}`;
  }).join("\n\n");
}

/* =========================================================
   GPT HELPER
========================================================= */
async function callGPT(apiKey, { system, user, max_tokens=600, model="gpt-4o-mini" }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model, temperature:0.2, max_tokens, messages:[{ role:"system",content:system },{ role:"user",content:user }] }),
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || null;
}

/* =========================================================
   UTILITIES
========================================================= */
function calcCrCl(age, weightKg, scrUmol, sex) {
  if (!age||!weightKg||!scrUmol||!sex) return null;
  const scrMgDl   = scrUmol/88.42;
  const sexFactor = String(sex).toLowerCase().startsWith("f") ? 0.85 : 1;
  const value     = ((140-age)*weightKg*sexFactor)/(72*scrMgDl);
  const rounded   = Math.round(value*10)/10;
  let category = "Unknown";
  if      (rounded>=90) category="Normal (≥90)";
  else if (rounded>=60) category="Mild impairment (60–89)";
  else if (rounded>=30) category="Moderate impairment (30–59)";
  else if (rounded>=15) category="Severe impairment (15–29)";
  else                  category="Kidney failure (<15)";
  return { value:rounded, category };
}

function emptyExtractedCase() {
  return {
    mrn:null,patient_name:null,age:null,sex:null,weight_kg:null,height_cm:null,
    care_setting:null,reason_admission:null,pmh:null,home_medications:null,
    diagnosis:null,allergies:[],
    vitals:{ bp:null,hr:null,rr:null,temp:null,spo2:null,gcs:null },
    labs:{ hb:null,wbc:null,plt:null,neutrophil:null,scr_umol:null,scr_mgdl:null,urea:null,bun:null,na:null,k:null,cl:null,bicarb:null,ca:null,mg:null,phos:null,alt:null,ast:null,alp:null,bili_t:null,albumin:null,inr:null,pt:null,aptt:null,fibrinogen:null,glucose:null,crp:null,procalc:null,lactate:null,vanc_trough:null,vanc_auc:null,genta_trough:null,tobra_trough:null,digoxin:null,phenytoin:null,valproate:null,tacro:null,cyclo:null },
    medications:[],
  };
}

function requireApiCredentials(env) {
  if (!env.OPENAI_API_KEY||!env.VECTOR_STORE_ID) throw new Error("OPENAI_API_KEY or VECTOR_STORE_ID is not set");
}

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), { status, headers:{ "Content-Type":"application/json", ...corsHeaders } });
}

function safeParseJSON(raw) {
  const cleaned = String(raw||"").replace(/```json|```/gi,"").trim();
  try { return JSON.parse(cleaned); } catch(_) {}
  let depth=0, start=-1;
  for (let i=0; i<cleaned.length; i++) {
    if (cleaned[i]==="{") { if (start===-1) start=i; depth++; }
    else if (cleaned[i]==="}") { depth--; if (depth===0&&start!==-1) { try { return JSON.parse(cleaned.substring(start,i+1)); } catch(_) { break; } } }
  }
  try {
    const arrStart = cleaned.indexOf("[");
    if (arrStart !== -1) return JSON.parse(cleaned.substring(arrStart));
  } catch(_) {}
  console.error("safeParseJSON: failed, raw length:", raw?.length);
  return {};
}

function stripCodeFences(text) { return String(text||"").replace(/```json|```/gi,"").trim(); }
function toNumberOrNull(v) { if (v===null||v===undefined||v==="") return null; const n=Number(v); return Number.isNaN(n)?null:n; }
