// File: /functions/api/ask.js
// CLINICAL PHARMACIST AI PLATFORM
// SYSTEM LOGIC SPECIFICATION v1.0

export async function onRequest(context) {
  const { request, env } = context;
  
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // ========== CORS PREFLIGHT ==========
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
    // ✅ التعديل هنا - إضافة mode إلى المتغيرات المستقبلة
    const { case_text, mode, language = "en" } = body;

    if (!case_text) {
      return new Response(JSON.stringify({ error: "Missing case_text" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ✅ إضافة دعم mode - للتوافق مع الإصدارات السابقة
    if (mode && mode === "case_analysis") {
      console.log("✅ Case analysis mode detected");
    }

    // ========== PIPELINE EXECUTION ==========
    // Step A: Extract structured data from unstructured case
    const extractedData = extractStructuredData(case_text);
    
    // Step B: Calculate CrCl using Cockcroft-Gault
    const crclResult = calculateCrCl(extractedData);
    extractedData.renal.crcl = crclResult.value;
    extractedData.renal.crcl_status = crclResult.status;
    
    // Step C1: Generate Template-1 SOAP (Formatter)
    const template1SOAP = generateTemplate1SOAP(extractedData);
    
    // Step C2: Clinical Analysis (free medical reasoning)
    const clinicalAnalysis = performClinicalAnalysis(extractedData);
    
    // Step C3: Pharmacotherapy Review
    const pharmacotherapyReview = reviewPharmacotherapy(extractedData, clinicalAnalysis);
    
    // Step C4: Pharmacist Interventions (protocol-locked)
    const interventions = await generateInterventions(extractedData, pharmacotherapyReview, env);
    
    // Step C5: Generate Template-2 Pharmacist SOAP Note
    const template2SOAP = generateTemplate2SOAP(extractedData, clinicalAnalysis, interventions);
    
    // ========== FINAL RESPONSE ==========
    return new Response(JSON.stringify({
      ok: true,
      template1_soap: template1SOAP,
      clinical_analysis: clinicalAnalysis,
      pharmacotherapy_review: pharmacotherapyReview,
      interventions: interventions,
      template2_soap: template2SOAP,
      renal: extractedData.renal,
      missing_data: extractedData.missing
    }), { headers: { "Content-Type": "application/json", ...corsHeaders } });

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

// ========== STEP A: EXTRACT STRUCTURED DATA ==========
function extractStructuredData(text) {
  console.log("🔍 Step A: Extracting structured data...");
  
  // No assumptions - if missing, set to null or N/A
  const data = {
    patient: {
      mrn: extractValue(text, /MRN[:\s]*(\d+)/i) || extractValue(text, /medical record[:\s]*(\d+)/i) || null,
      age: extractAge(text),
      sex: extractSex(text),
      height: extractHeight(text),
      weight: extractWeight(text),
      ward: extractWard(text)
    },
    admission: {
      reason: extractReasonForAdmission(text) || null,
      date: extractDate(text, /admitted (?:on )?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
    },
    history: {
      pmh: extractPMH(text) || null,
      home_meds: extractHomeMeds(text) || null
    },
    vitals: extractVitals(text),
    labs: extractLabs(text),
    renal: {
      scr_umol: extractCreatinine(text),
      crcl: null,
      crcl_status: 'not_calculated'
    },
    current_meds: extractCurrentMedications(text),
    imaging: extractImaging(text),
    notes: extractNotes(text),
    missing: []
  };
  
  // Track missing essential fields
  if (!data.patient.age) data.missing.push('age');
  if (!data.patient.weight) data.missing.push('weight');
  if (!data.patient.sex) data.missing.push('sex');
  if (!data.renal.scr_umol) data.missing.push('creatinine');
  
  return data;
}

// ========== EXTRACTION HELPER FUNCTIONS ==========
function extractValue(text, pattern, group = 1) {
  const match = text.match(pattern);
  return match ? match[group] : null;
}

function extractAge(text) {
  // Look for age in various formats
  const patterns = [
    /(\d+)[-\s]year[-\s]old/i,
    /age[:\s]*(\d+)/i,
    /(\d+)\s*y[.\s]*o/i,
    /(\d+)[-\s]YEAR/i,
    /^(\d+)[-\s]yr/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseInt(match[1]);
  }
  return null;
}

function extractSex(text) {
  if (/\b(male|man|gentleman)\b/i.test(text)) return 'M';
  if (/\b(female|woman|lady)\b/i.test(text)) return 'F';
  return null;
}

function extractHeight(text) {
  // Try cm first
  let match = text.match(/(\d+(?:\.\d+)?)\s*(cm|centimeters)/i);
  if (match) return { value: parseFloat(match[1]), unit: 'cm' };
  
  // Try inches
  match = text.match(/(\d+(?:\.\d+)?)\s*(in|inches|")/i);
  if (match) return { value: parseFloat(match[1]), unit: 'in' };
  
  // Try feet/inches format (e.g., 5'11")
  match = text.match(/(\d+)'(\d+)(?:"|'')?/);
  if (match) {
    const feet = parseInt(match[1]);
    const inches = parseInt(match[2]);
    return { value: (feet * 12) + inches, unit: 'in' };
  }
  
  return null;
}

function extractWeight(text) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms|lbs|pounds)/i);
  if (!match) return null;
  
  return {
    value: parseFloat(match[1]),
    unit: match[2].toLowerCase().startsWith('kg') ? 'kg' : 'lbs'
  };
}

function extractWard(text) {
  const match = text.match(/admitted to (?:the )?([A-Za-z\s]+)(?: ward| unit| ICU| CCU)/i) ||
                text.match(/(ICU|CCU|MICU|SICU|wards? \d+)/i);
  return match ? match[1].trim() : null;
}

function extractReasonForAdmission(text) {
  const patterns = [
    /reason for admission[:\s]*([^\n]+)/i,
    /admitted (?:for|with) ([^\n]+)/i,
    /presenting with ([^\n]+)/i,
    /chief complaint[:\s]*([^\n]+)/i,
    /CAME WITH ([^\n]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function extractDate(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : null;
}

function extractPMH(text) {
  const patterns = [
    /PMH[:\s]*([^\n]+)/i,
    /past medical history[:\s]*([^\n]+)/i,
    /medical history[:\s]*([^\n]+)/i,
    /K\/C OF[:\s]*([^\n]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function extractHomeMeds(text) {
  const patterns = [
    /home meds?[:\s]*([^\n]+)/i,
    /home medications?[:\s]*([^\n]+)/i,
    /PATIENT ON[:\s]*([^\n]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function extractVitals(text) {
  const vitals = {
    bp_sbp: null,
    bp_dbp: null,
    hr: null,
    temp: null,
    rr: null,
    spo2: null,
    text: null
  };
  
  // Extract BP
  const bpMatch = text.match(/BP[:\s]*(\d+)[\/\s]*(\d+)/i) || 
                  text.match(/blood pressure[:\s]*(\d+)[\/\s]*(\d+)/i);
  if (bpMatch) {
    vitals.bp_sbp = parseInt(bpMatch[1]);
    vitals.bp_dbp = parseInt(bpMatch[2]);
  }
  
  // Extract HR
  const hrMatch = text.match(/HR[:\s]*(\d+)/i) || 
                  text.match(/heart rate[:\s]*(\d+)/i) ||
                  text.match(/pulse[:\s]*(\d+)/i);
  if (hrMatch) vitals.hr = parseInt(hrMatch[1]);
  
  // Extract Temperature
  const tempMatch = text.match(/Temp[:\s]*(\d+(?:\.\d+)?)/i) || 
                    text.match(/temperature[:\s]*(\d+(?:\.\d+)?)/i);
  if (tempMatch) vitals.temp = parseFloat(tempMatch[1]);
  
  // Extract RR
  const rrMatch = text.match(/RR[:\s]*(\d+)/i) || 
                  text.match(/respiratory rate[:\s]*(\d+)/i);
  if (rrMatch) vitals.rr = parseInt(rrMatch[1]);
  
  // Extract SpO2
  const spo2Match = text.match(/SpO2[:\s]*(\d+)/i) || 
                    text.match(/O2 sat[:\s]*(\d+)/i) ||
                    text.match(/oxygen saturation[:\s]*(\d+)/i);
  if (spo2Match) vitals.spo2 = parseInt(spo2Match[1]);
  
  // Store raw text if available
  const vitalsSection = text.match(/Vitals?:?\s*([^\n]+(?:[^\n]*\n){0,3})/i);
  if (vitalsSection) vitals.text = vitalsSection[1].trim();
  
  return vitals;
}

function extractLabs(text) {
  const labs = {
    wbc: null, hb: null, plt: null,
    na: null, k: null, cl: null,
    bun: null, creatinine: null,
    glucose: null, hba1c: null,
    inr: null, ptt: null,
    alt: null, ast: null, alp: null,
    tbil: null, dbil: null,
    lactate: null, troponin: null,
    ph: null, pco2: null, po2: null, hco3: null,
    text: null
  };
  
  // Common lab patterns
  const labPatterns = [
    { key: 'wbc', patterns: [/WBC[:\s]*(\d+(?:\.\d+)?)/i, /white blood[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'hb', patterns: [/HB[:\s]*(\d+(?:\.\d+)?)/i, /hemoglobin[:\s]*(\d+(?:\.\d+)?)/i, /Hgb[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'plt', patterns: [/PLT[:\s]*(\d+)/i, /platelet[:\s]*(\d+)/i] },
    { key: 'na', patterns: [/NA[:\s]*(\d+)/i, /sodium[:\s]*(\d+)/i] },
    { key: 'k', patterns: [/K[:\s]*(\d+(?:\.\d+)?)/i, /potassium[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'cl', patterns: [/CL[:\s]*(\d+)/i, /chloride[:\s]*(\d+)/i] },
    { key: 'bun', patterns: [/BUN[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'creatinine', patterns: [/CREAT[:\s]*(\d+)/i, /creatinine[:\s]*(\d+)/i, /Cr[:\s]*(\d+)/i] },
    { key: 'glucose', patterns: [/glucose[:\s]*(\d+)/i, /RBG[:\s]*(\d+)/i, /FBG[:\s]*(\d+)/i] },
    { key: 'hba1c', patterns: [/HbA1c[:\s]*(\d+(?:\.\d+)?)/i, /A1c[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'inr', patterns: [/INR[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'ptt', patterns: [/PTT[:\s]*(\d+(?:\.\d+)?)/i, /aPTT[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'alt', patterns: [/ALT[:\s]*(\d+)/i] },
    { key: 'ast', patterns: [/AST[:\s]*(\d+)/i] },
    { key: 'alp', patterns: [/ALP[:\s]*(\d+)/i, /alkaline phosphatase[:\s]*(\d+)/i] },
    { key: 'tbil', patterns: [/total bilirubin[:\s]*(\d+(?:\.\d+)?)/i, /TBil[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'dbil', patterns: [/direct bilirubin[:\s]*(\d+(?:\.\d+)?)/i, /DBil[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'lactate', patterns: [/lactate[:\s]*(\d+(?:\.\d+)?)/i, /LAC[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'troponin', patterns: [/troponin[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'ph', patterns: [/pH[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'pco2', patterns: [/pCO2[:\s]*(\d+(?:\.\d+)?)/i, /CO2[:\s]*(\d+(?:\.\d+)?)/i] },
    { key: 'po2', patterns: [/pO2[:\s]*(\d+)/i] },
    { key: 'hco3', patterns: [/HCO3[:\s]*(\d+(?:\.\d+)?)/i, /bicarbonate[:\s]*(\d+(?:\.\d+)?)/i] }
  ];
  
  for (const lab of labPatterns) {
    for (const pattern of lab.patterns) {
      const match = text.match(pattern);
      if (match) {
        labs[lab.key] = isNaN(parseFloat(match[1])) ? null : parseFloat(match[1]);
        break;
      }
    }
  }
  
  // Store raw labs text
  const labsSection = text.match(/(?:Labs?|Laboratory|Investigations?):?\s*([^\n]+(?:[^\n]*\n){0,10})/i);
  if (labsSection) labs.text = labsSection[1].trim();
  
  return labs;
}

function extractCreatinine(text) {
  const match = text.match(/CREAT[:\s]*(\d+)/i) || 
                text.match(/creatinine[:\s]*(\d+)/i) ||
                text.match(/Cr[:\s]*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function extractCurrentMedications(text) {
  const medications = [];
  
  // Look for medication list sections
  const medSections = [
    text.match(/Current Medications?:?\s*([^\n]+(?:[^\n]*\n){0,20})/i),
    text.match(/Medications?:?\s*([^\n]+(?:[^\n]*\n){0,10})/i),
    text.match(/PATIENT ON:?\s*([^\n]+)/i)
  ];
  
  let medText = '';
  for (const section of medSections) {
    if (section) {
      medText = section[1];
      break;
    }
  }
  
  if (!medText) return [];
  
  // Simple parsing - split by lines and commas
  const lines = medText.split(/\n|\.|\,/);
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 3 && !trimmed.match(/^(N\/A|none|nil)$/i)) {
      // Try to extract drug name and dose
      const drugMatch = trimmed.match(/([A-Za-z\s]+?)\s*(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|unit)/i);
      if (drugMatch) {
        medications.push({
          name: drugMatch[1].trim(),
          dose: drugMatch[2] + ' ' + drugMatch[3],
          full_text: trimmed
        });
      } else {
        medications.push({
          name: trimmed.split(' ')[0],
          dose: null,
          full_text: trimmed
        });
      }
    }
  }
  
  return medications;
}

function extractImaging(text) {
  const imaging = [];
  
  const imagingTypes = [
    { pattern: /(CXR|chest x-ray|chest radiograph).*?([^\n]+)/i, type: 'CXR' },
    { pattern: /(CT|computed tomography).*?([^\n]+)/i, type: 'CT' },
    { pattern: /(MRI|magnetic resonance).*?([^\n]+)/i, type: 'MRI' },
    { pattern: /(ultrasound|US|echocardiogram|echo).*?([^\n]+)/i, type: 'Ultrasound' },
    { pattern: /(ECHO|echocardiography).*?([^\n]+)/i, type: 'ECHO' }
  ];
  
  for (const img of imagingTypes) {
    const matches = [...text.matchAll(new RegExp(img.pattern, 'gi'))];
    for (const match of matches) {
      imaging.push({
        type: img.type,
        finding: match[2]?.trim() || match[0].trim()
      });
    }
  }
  
  return imaging;
}

function extractNotes(text) {
  const notes = [];
  
  const noteSections = [
    text.match(/Notes?:?\s*([^\n]+(?:[^\n]*\n){0,10})/i),
    text.match(/Comments?:?\s*([^\n]+(?:[^\n]*\n){0,10})/i),
    text.match(/Assessment:?\s*([^\n]+(?:[^\n]*\n){0,10})/i)
  ];
  
  for (const section of noteSections) {
    if (section) notes.push(section[1].trim());
  }
  
  return notes;
}

// ========== STEP B: CALCULATE CrCl (Cockcroft-Gault) ==========
function calculateCrCl(data) {
  console.log("🧮 Step B: Calculating CrCl...");
  
  const patient = data.patient;
  const renal = data.renal;
  
  // Check if we have required data
  if (!patient.age || !renal.scr_umol) {
    return {
      value: null,
      status: 'missing_data',
      message: 'Cannot calculate CrCl: missing age or creatinine'
    };
  }
  
  // Convert SCr from umol/L to mg/dL
  const scr_mgdl = renal.scr_umol / 88.4;
  
  // Determine weight for calculation
  let weight_kg = null;
  let weight_status = '';
  
  if (patient.weight) {
    // Convert to kg if in lbs
    if (patient.weight.unit === 'lbs') {
      weight_kg = patient.weight.value * 0.453592;
    } else {
      weight_kg = patient.weight.value;
    }
    
    // If we have height, calculate IBW and adjusted weight for obesity
    if (patient.height && patient.sex) {
      // Convert height to inches if in cm
      let height_in;
      if (patient.height.unit === 'cm') {
        height_in = patient.height.value / 2.54;
      } else {
        height_in = patient.height.value;
      }
      
      // Calculate IBW (Devine formula)
      let ibw;
      if (patient.sex === 'M') {
        ibw = 50 + 2.3 * (height_in - 60);
      } else {
        ibw = 45.5 + 2.3 * (height_in - 60);
      }
      
      // Check if obese (ActualBW >= 1.2 * IBW)
      if (weight_kg >= 1.2 * ibw) {
        // Use adjusted body weight for obese patients
        const abw_adjusted = ibw + 0.4 * (weight_kg - ibw);
        weight_kg = abw_adjusted;
        weight_status = 'adjusted_for_obesity';
      } else {
        weight_status = 'actual_weight';
      }
    } else {
      weight_status = 'actual_weight_no_height';
    }
  } else {
    return {
      value: null,
      status: 'missing_weight',
      message: 'Cannot calculate CrCl: missing weight'
    };
  }
  
  // Cockcroft-Gault formula
  let crcl = ((140 - patient.age) * weight_kg) / (72 * scr_mgdl);
  
  // Adjust for female sex
  if (patient.sex === 'F') {
    crcl = crcl * 0.85;
  }
  
  // Round to nearest whole number
  crcl = Math.round(crcl);
  
  return {
    value: crcl,
    status: 'calculated',
    weight_used: weight_kg,
    weight_status: weight_status,
    formula: 'Cockcroft-Gault',
    message: `CrCl = ${crcl} mL/min`
  };
}

// ========== STEP C1: GENERATE TEMPLATE-1 SOAP (FORMATTER) ==========
function generateTemplate1SOAP(data) {
  console.log("📝 Step C1: Generating Template-1 SOAP...");
  
  const patient = data.patient;
  const renal = data.renal;
  
  // Format patient string with strict N/A for missing
  const mrnStr = patient.mrn || '';
  const ageStr = patient.age || '';
  const weightStr = patient.weight ? patient.weight.value + (patient.weight.unit === 'kg' ? 'kg' : 'lbs') : '';
  const wardStr = patient.ward || 'ICU';
  
  const patientLine = `S: Patient — (MRN: ${mrnStr}), ${ageStr}Y, ${weightStr} admitted to ${wardStr}.`;
  
  // Reason for admission - strict N/A if missing
  const reasonStr = data.admission.reason || 'N/A';
  
  // PMH - strict N/A if missing
  const pmhStr = data.history.pmh || 'N/A';
  
  // Home Meds - strict N/A if missing
  const homeMedsStr = data.history.home_meds || 'N/A';
  
  // Vitals - format as text or N/A
  let vitalsStr = 'N/A';
  if (data.vitals.text) {
    vitalsStr = data.vitals.text;
  } else if (data.vitals.bp_sbp && data.vitals.bp_dbp) {
    vitalsStr = `BP ${data.vitals.bp_sbp}/${data.vitals.bp_dbp}`;
    if (data.vitals.hr) vitalsStr += `, HR ${data.vitals.hr}`;
    if (data.vitals.temp) vitalsStr += `, Temp ${data.vitals.temp}°C`;
    if (data.vitals.spo2) vitalsStr += `, SpO2 ${data.vitals.spo2}%`;
  }
  
  // Labs - format as text or N/A
  let labsStr = 'N/A';
  if (data.labs.text) {
    labsStr = data.labs.text;
  } else {
    const labValues = [];
    if (data.labs.wbc) labValues.push(`WBC ${data.labs.wbc}`);
    if (data.labs.hb) labValues.push(`Hb ${data.labs.hb}`);
    if (data.labs.plt) labValues.push(`PLT ${data.labs.plt}`);
    if (data.labs.na) labValues.push(`Na ${data.labs.na}`);
    if (data.labs.k) labValues.push(`K ${data.labs.k}`);
    if (data.labs.inr) labValues.push(`INR ${data.labs.inr}`);
    if (labValues.length > 0) labsStr = labValues.join(', ');
  }
  
  // Renal
  const scrStr = renal.scr_umol || '___';
  const crclStr = renal.crcl ? `${renal.crcl} mL/min` : '—';
  
  // Assessment - must be derived from explicit wording
  let assessmentStr = 'N/A';
  if (data.admission.reason) {
    // Use reason for admission as primary assessment
    assessmentStr = `Primary admission for ${data.admission.reason}.`;
  } else {
    // Look for diagnosis in notes
    const diagnosisMatch = data.notes.find(n => n.match(/diagnos(is|ed)/i));
    if (diagnosisMatch) {
      assessmentStr = `Primary admission for ${diagnosisMatch}.`;
    }
  }
  
  // Current Medications
  let medsStr = 'N/A';
  if (data.current_meds.length > 0) {
    medsStr = data.current_meds.map(m => `- ${m.full_text}`).join('\n');
  }
  
  // Build Template-1 SOAP
  const soap = `${patientLine}
Reason for Admission: ${reasonStr}
PMH: ${pmhStr}
Home Meds: ${homeMedsStr}

O: Vitals: ${vitalsStr}
Labs: ${labsStr}
Renal: SCr ${scrStr} umol, Calculated CrCl ${crclStr}

A: ${assessmentStr}

P:
Current Medications:
${medsStr}`;

  return soap;
}

// ========== STEP C2: CLINICAL ANALYSIS (free reasoning) ==========
function performClinicalAnalysis(data) {
  console.log("🔬 Step C2: Performing clinical analysis...");
  
  const analysis = {
    primary_problem: null,
    secondary_problems: [],
    organ_systems_involved: [],
    severity: null,
    guidelines_available: [],
    analysis_text: ''
  };
  
  // Use available data to identify primary problem
  // This section uses free medical reasoning, not protocol-locked
  
  const problems = [];
  
  // Check for sepsis/SIRS criteria
  if (data.labs.wbc && (data.labs.wbc > 12 || data.labs.wbc < 4)) {
    problems.push('Leukocytosis/Leukopenia suggesting infection');
  }
  if (data.vitals.temp && (data.vitals.temp > 38 || data.vitals.temp < 36)) {
    problems.push('Fever/Hypothermia');
  }
  if (data.vitals.hr && data.vitals.hr > 90) {
    problems.push('Tachycardia');
  }
  if (data.vitals.rr && data.vitals.rr > 20) {
    problems.push('Tachypnea');
  }
  
  if (problems.length >= 2) {
    analysis.primary_problem = 'Sepsis/SIRS';
    analysis.severity = 'SUSPECTED';
  }
  
  // Check for AKI
  if (data.renal.scr_umol && data.renal.scr_umol > 110) {
    analysis.secondary_problems.push('Acute Kidney Injury (AKI)');
    analysis.organ_systems_involved.push('Renal');
  }
  
  // Check for electrolyte imbalances
  if (data.labs.na) {
    if (data.labs.na < 135) analysis.secondary_problems.push('Hyponatremia');
    if (data.labs.na > 145) analysis.secondary_problems.push('Hypernatremia');
  }
  
  if (data.labs.k) {
    if (data.labs.k < 3.5) analysis.secondary_problems.push('Hypokalemia');
    if (data.labs.k > 5.1) analysis.secondary_problems.push('Hyperkalemia');
  }
  
  // Check for anemia
  if (data.labs.hb && data.labs.hb < 12) {
    analysis.secondary_problems.push('Anemia');
  }
  
  // Check for thrombocytopenia
  if (data.labs.plt && data.labs.plt < 150) {
    analysis.secondary_problems.push('Thrombocytopenia');
  }
  
  // Check for acidosis
  if (data.labs.ph && data.labs.ph < 7.35) {
    analysis.secondary_problems.push('Acidosis');
  }
  
  // Check for liver injury
  if ((data.labs.alt && data.labs.alt > 50) || (data.labs.ast && data.labs.ast > 50)) {
    analysis.secondary_problems.push('Liver enzyme elevation');
    analysis.organ_systems_involved.push('Hepatic');
  }
  
  // Generate analysis text
  let analysisText = '';
  if (analysis.primary_problem) {
    analysisText += `Primary problem: ${analysis.primary_problem}\n`;
  }
  if (analysis.secondary_problems.length > 0) {
    analysisText += `Secondary problems: ${analysis.secondary_problems.join(', ')}\n`;
  }
  if (analysis.organ_systems_involved.length > 0) {
    analysisText += `Organ systems involved: ${analysis.organ_systems_involved.join(', ')}\n`;
  }
  
  analysis.analysis_text = analysisText || 'No specific clinical problems identified from available data.';
  
  return analysis;
}

// ========== STEP C3: PHARMACOTHERAPY REVIEW ==========
function reviewPharmacotherapy(data, clinicalAnalysis) {
  console.log("💊 Step C3: Reviewing pharmacotherapy...");
  
  const review = {
    medications: [],
    renal_considerations: null,
    interactions: [],
    summary: ''
  };
  
  // Add renal considerations
  if (data.renal.crcl) {
    review.renal_considerations = {
      crcl: data.renal.crcl,
      classification: data.renal.crcl > 60 ? 'Normal' : 
                       data.renal.crcl > 30 ? 'Moderate impairment' : 
                       data.renal.crcl > 15 ? 'Severe impairment' : 'ESRD',
      dose_adjustments_needed: data.renal.crcl < 60
    };
  }
  
  // Review each medication
  for (const med of data.current_meds) {
    const medReview = {
      name: med.name,
      dose: med.dose,
      indication: null,
      dose_appropriate: null,
      frequency_appropriate: null,
      contraindications: [],
      renal_adjustment_needed: null,
      notes: []
    };
    
    // Check for indication based on clinical problems
    if (clinicalAnalysis.primary_problem) {
      // This is simplified - in real implementation would have mapping
      if (med.name.match(/antibiotic|cef|penicillin|vanco|meropenem|piperacillin/i) && 
          clinicalAnalysis.primary_problem.includes('Sepsis')) {
        medReview.indication = 'Appropriate for sepsis';
      }
    }
    
    // Check renal adjustment need based on CrCl
    if (data.renal.crcl && data.renal.crcl < 60) {
      const renalDrugs = ['vancomycin', 'gentamicin', 'meropenem', 'piperacillin', 'enalapril', 'lisinopril', 'spironolactone'];
      if (renalDrugs.some(drug => med.name.toLowerCase().includes(drug))) {
        medReview.renal_adjustment_needed = true;
        medReview.notes.push('Consider renal dose adjustment');
      }
    }
    
    review.medications.push(medReview);
  }
  
  // Generate summary
  review.summary = `Reviewed ${review.medications.length} medications. `;
  if (review.renal_considerations?.dose_adjustments_needed) {
    review.summary += `Renal dose adjustments needed based on CrCl ${data.renal.crcl} mL/min. `;
  }
  
  return review;
}

// ========== STEP C4: PHARMACIST INTERVENTIONS (protocol-locked) ==========
async function generateInterventions(data, pharmacotherapyReview, env) {
  console.log("⚠️ Step C4: Generating protocol-locked interventions...");
  
  const interventions = [];
  
  // For each medication, search vector store for evidence
  for (const med of data.current_meds) {
    
    // Search for medication in protocol database
    const searchQueries = [
      `${med.name} dosing renal adjustment`,
      `${med.name} contraindications warnings`,
      `${med.name} drug interactions monitoring`
    ];
    
    let foundEvidence = false;
    let evidenceResults = [];
    
    for (const query of searchQueries) {
      try {
        const response = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          },
          body: JSON.stringify({
            query,
            max_num_results: 2
          })
        });
        
        if (response.ok) {
          const searchData = await response.json();
          if (searchData.data && searchData.data.length > 0) {
            foundEvidence = true;
            for (const item of searchData.data) {
              evidenceResults.push({
                filename: item.file_id || 'Protocol',
                excerpt: extractContent(item).substring(0, 200)
              });
            }
          }
        }
      } catch (error) {
        console.error(`Search error for ${med.name}:`, error);
      }
    }
    
    // Generate intervention based on evidence found
    if (foundEvidence) {
      // Check renal adjustment need
      if (data.renal.crcl && data.renal.crcl < 60) {
        interventions.push({
          medication: med.name,
          recommendation: 'Consider renal dose adjustment',
          rationale: `CrCl is ${data.renal.crcl} mL/min, below normal range`,
          evidence: evidenceResults,
          severity: 'MODERATE'
        });
      }
      
      // Check for contraindications based on labs
      if (data.labs.k && data.labs.k > 5.5) {
        if (med.name.match(/spironolactone|enalapril|lisinopril|ace|arb/i)) {
          interventions.push({
            medication: med.name,
            recommendation: 'Hold medication due to hyperkalemia',
            rationale: `K+ is ${data.labs.k}, above normal range`,
            evidence: evidenceResults,
            severity: 'HIGH'
          });
        }
      }
      
      // Check for platelet contraindications
      if (data.labs.plt && data.labs.plt < 50) {
        if (med.name.match(/aspirin|clopidogrel|warfarin|heparin|enoxaparin/i)) {
          interventions.push({
            medication: med.name,
            recommendation: 'Hold antithrombotic medication due to thrombocytopenia',
            rationale: `Platelets are ${data.labs.plt}, below safe threshold`,
            evidence: evidenceResults,
            severity: 'CRITICAL'
          });
        }
      }
      
      // Check for INR contraindications
      if (data.labs.inr && data.labs.inr > 3.0) {
        if (med.name.match(/warfarin/i)) {
          interventions.push({
            medication: med.name,
            recommendation: 'Hold warfarin, consider reversal if bleeding',
            rationale: `INR is ${data.labs.inr}, above therapeutic range`,
            evidence: evidenceResults,
            severity: 'CRITICAL'
          });
        }
      }
      
    } else {
      // No evidence found in protocol
      interventions.push({
        medication: med.name,
        recommendation: 'Review medication',
        rationale: 'No specific protocol guidance found',
        evidence: [{ filename: 'Protocol', excerpt: 'Evidence not found in local protocol.' }],
        severity: 'INFO',
        no_evidence: true
      });
    }
  }
  
  return interventions;
}

// ========== STEP C5: GENERATE TEMPLATE-2 PHARMACIST SOAP NOTE ==========
function generateTemplate2SOAP(data, clinicalAnalysis, interventions) {
  console.log("📋 Step C5: Generating Template-2 Pharmacist SOAP Note...");
  
  const patient = data.patient;
  const renal = data.renal;
  
  // Format patient string
  const mrnStr = patient.mrn || '';
  const ageStr = patient.age || '';
  const weightStr = patient.weight ? patient.weight.value + (patient.weight.unit === 'kg' ? 'kg' : 'lbs') : '';
  const wardStr = patient.ward || 'ICU';
  
  const patientLine = `S: Patient (MRN: ${mrnStr}), ${ageStr}Y, ${weightStr} admitted to ${wardStr}.`;
  
  // Reason for admission
  const reasonStr = data.admission.reason || 'N/A';
  
  // PMH
  const pmhStr = data.history.pmh || 'N/A';
  
  // Home Meds
  const homeMedsStr = data.history.home_meds || 'N/A';
  
  // Vitals
  let vitalsStr = 'N/A';
  if (data.vitals.bp_sbp && data.vitals.bp_dbp) {
    vitalsStr = `BP ${data.vitals.bp_sbp}/${data.vitals.bp_dbp}`;
    if (data.vitals.hr) vitalsStr += `, HR ${data.vitals.hr}`;
    if (data.vitals.temp) vitalsStr += `, Temp ${data.vitals.temp}°C`;
    if (data.vitals.spo2) vitalsStr += `, SpO2 ${data.vitals.spo2}%`;
  }
  
  // Labs
  const labValues = [];
  if (data.labs.wbc) labValues.push(`WBC ${data.labs.wbc}`);
  if (data.labs.hb) labValues.push(`Hb ${data.labs.hb}`);
  if (data.labs.plt) labValues.push(`PLT ${data.labs.plt}`);
  if (data.labs.na) labValues.push(`Na ${data.labs.na}`);
  if (data.labs.k) labValues.push(`K ${data.labs.k}`);
  if (data.labs.inr) labValues.push(`INR ${data.labs.inr}`);
  const labsStr = labValues.length > 0 ? labValues.join(', ') : 'N/A';
  
  // Renal
  const scrStr = renal.scr_umol || '___';
  const crclStr = renal.crcl ? `${renal.crcl} mL/min` : '—';
  
  // Assessment
  const assessmentStr = clinicalAnalysis.primary_problem ? 
    `Primary admission for ${clinicalAnalysis.primary_problem}. Clinical review performed.` :
    'Primary admission for acute issues. Clinical review performed.';
  
  // Current Medications list
  let medsList = '';
  if (data.current_meds.length > 0) {
    medsList = data.current_meds.map(m => `- ${m.full_text}`).join('\n');
  } else {
    medsList = '- No medications started';
  }
  
  // Pharmacist Interventions list
  let interventionsList = '';
  if (interventions.length > 0) {
    // Group by severity
    const critical = interventions.filter(i => i.severity === 'CRITICAL');
    const high = interventions.filter(i => i.severity === 'HIGH');
    const moderate = interventions.filter(i => i.severity === 'MODERATE');
    const info = interventions.filter(i => i.severity === 'INFO');
    
    if (critical.length > 0) {
      interventionsList += '\n🔴 CRITICAL:\n';
      critical.forEach(i => {
        interventionsList += `- ${i.medication}: ${i.recommendation}\n  → ${i.rationale}\n`;
        if (i.evidence && i.evidence.length > 0) {
          interventionsList += `  📚 Source: ${i.evidence[0].filename}\n`;
        }
      });
    }
    
    if (high.length > 0) {
      interventionsList += '\n🟠 HIGH:\n';
      high.forEach(i => {
        interventionsList += `- ${i.medication}: ${i.recommendation}\n  → ${i.rationale}\n`;
        if (i.evidence && i.evidence.length > 0) {
          interventionsList += `  📚 Source: ${i.evidence[0].filename}\n`;
        }
      });
    }
    
    if (moderate.length > 0) {
      interventionsList += '\n🟡 MODERATE:\n';
      moderate.forEach(i => {
        interventionsList += `- ${i.medication}: ${i.recommendation}\n  → ${i.rationale}\n`;
        if (i.evidence && i.evidence.length > 0) {
          interventionsList += `  📚 Source: ${i.evidence[0].filename}\n`;
        }
      });
    }
    
    if (info.length > 0) {
      interventionsList += '\nℹ️ INFO:\n';
      info.forEach(i => {
        interventionsList += `- ${i.medication}: ${i.recommendation}\n  → ${i.rationale}\n`;
        if (i.no_evidence) {
          interventionsList += `  ⚠️ Evidence not found in local protocol.\n`;
        }
      });
    }
  } else {
    interventionsList = '- No interventions identified.';
  }
  
  // Follow-up Plan
  let followupPlan = '- Monitor renal function and electrolytes\n';
  followupPlan += '- Repeat relevant labs in 24 hours\n';
  followupPlan += '- Adjust medications based on clinical response';
  
  if (data.renal.crcl && data.renal.crcl < 60) {
    followupPlan += '\n- Monitor for signs of drug toxicity (renal elimination)';
  }
  
  // Build Template-2 SOAP
  const soap = `${patientLine}
Reason for Admission: ${reasonStr}
PMH: ${pmhStr}
Home Meds: ${homeMedsStr}

O: Vitals: ${vitalsStr}
Labs: ${labsStr}
Renal: SCr ${scrStr} umol, Calculated CrCl ${crclStr}

A: ${assessmentStr}

P:
Current Medications:
${medsList}

Pharmacist Intervention:
${interventionsList}

Follow-up Plan:
${followupPlan}`;

  return soap;
}

// ========== HELPER: Extract content from search result ==========
function extractContent(item) {
  if (item.content) {
    if (Array.isArray(item.content)) {
      return item.content.map(c => c.text || c.value || '').join('\n');
    } else if (typeof item.content === 'string') {
      return item.content;
    } else if (item.content.text) {
      return item.content.text;
    }
  }
  return item.text || '';
}
