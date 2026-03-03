// File: /functions/api/ask.js
// ENHANCED BACKEND WITH CLINICAL CASE ANALYSIS ENGINE
// ALL EXISTING CONNECTIONS AND VARIABLES PRESERVED

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { 
      status: 204,
      headers: corsHeaders 
    });
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
    
    // ========== EXTRACT OUTPUT CONFIGURATION ==========
    const output_mode = (body.output_mode || "hybrid").toLowerCase();
    const source_mode = (body.source_mode || "off").toLowerCase();
    const answer_style = body.answer_style || "recommended";
    
    // Validate output_mode
    if (!["hybrid", "short", "verbatim"].includes(output_mode)) {
      return new Response(JSON.stringify({ 
        error: "Invalid output_mode. Must be hybrid, short, or verbatim." 
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
    
    // Validate source_mode
    if (!["required", "off"].includes(source_mode)) {
      return new Response(JSON.stringify({ 
        error: "Invalid source_mode. Must be required or off." 
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ========== CLINICAL CASE ANALYSIS MODE ==========
    if (body.mode === "case_analysis" && body.case_text) {
      
      // STEP 1: استخراج جميع البيانات من النص المتلخبط
      const clinicalData = extractClinicalData(body.case_text);
      
      // STEP 2: حساب CrCl إذا توفرت البيانات
      if (clinicalData.patient.creatinine && clinicalData.patient.age) {
        clinicalData.patient.crcl = calculateCrCl(
          clinicalData.patient.age,
          clinicalData.patient.weight || 70, // افتراضي 70kg إذا ما في وزن
          clinicalData.patient.creatinine,
          clinicalData.patient.gender || 'M'
        );
      }
      
      // STEP 3: البحث في قاعدة البروتوكول لكل دواء
      const medicationResults = await validateMedications(clinicalData.medications, env);
      
      // STEP 4: تحليل التفاعلات الدوائية والمخاطر
      const clinicalFindings = analyzeClinicalFindings(clinicalData, medicationResults);
      
      // STEP 5: تحديد حالة الأمان العامة
      const safetyStatus = determineSafetyStatus(clinicalFindings);
      
      // STEP 6: توليد SOAP Note المنظم
      const soapNote = generateSOAPNote(clinicalData, medicationResults, clinicalFindings, safetyStatus);
      
      // STEP 7: استخراج الأدوية المفقودة
      const missingMeds = medicationResults
        .filter(m => m.status === 'NOT_FOUND')
        .map(m => m.name);
      
      // Return enhanced response
      return new Response(JSON.stringify({
        ok: true,
        verdict: "OK",
        answer: soapNote,
        clinical_findings: clinicalFindings,
        safety_status: safetyStatus,
        missing_medications: missingMeds,
        citations: extractCitations(clinicalFindings),
        applied_output: {
          output_mode,
          source_mode,
          answer_style,
          mode: "case_analysis"
        }
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
    
    // ========== STANDARD Q&A MODE (ORIGINAL - UNCHANGED) ==========
    const question = body.question || body.q || "";
    
    if (!question) {
      return new Response(JSON.stringify({ error: "Question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
      return new Response(JSON.stringify({ 
        error: "OPENAI_API_KEY or VECTOR_STORE_ID is not set" 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // Perform vector search (ORIGINAL CODE)
    const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        query: question,
        max_num_results: 10
      })
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      return new Response(JSON.stringify({ 
        error: "Vector search failed",
        details: errorText
      }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const searchData = await searchResponse.json();
    
    // Extract evidence with metadata (ORIGINAL CODE)
    const evidence = [];
    if (searchData.data && Array.isArray(searchData.data)) {
      searchData.data.forEach((item, index) => {
        let content = '';
        let filename = item.file_id || item.filename || `source_${index + 1}`;
        let page = 0;
        let section = '';
        
        // Extract content
        if (item.content) {
          if (Array.isArray(item.content)) {
            content = item.content
              .map(c => c.text || c.value || '')
              .filter(t => t)
              .join('\n');
          } else if (typeof item.content === 'string') {
            content = item.content;
          } else if (item.content.text) {
            content = item.content.text;
          }
        }
        if (item.text) content = item.text;
        
        // Extract page number if present
        const pageMatch = content.match(/(?:Page|PAGE|page)\s*(\d+)/i) || 
                         content.match(/p\.\s*(\d+)/i) ||
                         content.match(/\[p\.\s*(\d+)\]/i);
        if (pageMatch) page = parseInt(pageMatch[1]);
        
        // Extract section if present
        const sectionMatch = content.match(/(?:Section|SECTION|section)\s+(\d+(?:\.\d+)*)\s*[–—-]?\s*([^\n]+)/i) ||
                            content.match(/##+\s*([^\n]+)/) ||
                            content.match(/^\d+\.\d+\s+([^\n]+)/m);
        if (sectionMatch) {
          section = (sectionMatch[2] || sectionMatch[1]).trim();
        }
        
        if (content && content.trim()) {
          evidence.push({
            id: `E${index + 1}`,
            filename: filename,
            page: page,
            section: section,
            excerpt: content.substring(0, 2000),
            full_content: content
          });
        }
      });
    }

    // ========== SOURCE_MODE = "required" ENFORCEMENT (ORIGINAL) ==========
    if (source_mode === "required") {
      const hasValidEvidence = evidence.some(e => 
        e.filename && 
        e.filename.length > 0 && 
        e.page > 0 && 
        e.section && 
        e.section.length > 0
      );
      
      if (evidence.length === 0 || !hasValidEvidence) {
        return new Response(JSON.stringify({
          ok: true,
          verdict: "NOT_FOUND",
          answer: "Not found in protocol",
          citations: [],
          applied_output: {
            output_mode,
            source_mode,
            answer_style
          }
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // ========== OUTPUT_MODE ENFORCEMENT (ORIGINAL) ==========
    let answer = "";
    let citations = [];
    
    switch(output_mode) {
      case "verbatim":
        if (evidence.length === 0) {
          answer = language === 'ar' 
            ? "لم يتم العثور على نصوص حرفية في المصادر."
            : "No verbatim text found in sources.";
        } else {
          const quotes = evidence.map(e => {
            const sentences = e.excerpt.split(/[.!?]+/).filter(s => s.trim().length > 20);
            const quote = sentences.length > 0 ? sentences[0].trim() + '.' : e.excerpt.substring(0, 150);
            return `"${quote}" — ${e.filename} (Section: ${e.section || 'General'}, Page: ${e.page || 'N/A'})`;
          }).slice(0, 3);
          
          answer = quotes.join('\n\n');
          
          citations = evidence.map(e => ({
            evidence_ids: [e.id],
            filename: e.filename,
            section: e.section || 'General',
            page: e.page || 0,
            excerpt: e.excerpt.substring(0, 250)
          }));
        }
        break;
        
      case "short":
        if (evidence.length === 0) {
          answer = language === 'ar' 
            ? "لم يتم العثور على معلومات."
            : "No information found.";
        } else {
          const evidenceText = evidence.map(e => 
            `[SOURCE] ${e.filename}\nContent: ${e.excerpt}`
          ).join('\n\n---\n\n');
          
          const bulletPrompt = `Generate 3-6 bullet points answering the question. Each bullet must be one line, start with •, and be concise. Use ONLY the provided sources.`;
          
          const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: "gpt-3.5-turbo",
              messages: [
                { role: 'system', content: bulletPrompt },
                { role: 'user', content: `Question: ${question}\n\nSources:\n${evidenceText}` }
              ],
              temperature: 0.3,
              max_tokens: 300
            })
          });
          
          const gptData = await gptResponse.json();
          answer = gptData.choices?.[0]?.message?.content || "• No concise answer available";
          
          if (source_mode === "required") {
            citations = evidence.map(e => ({
              evidence_ids: [e.id],
              filename: e.filename,
              section: e.section || 'General',
              page: e.page || 0,
              excerpt: e.excerpt.substring(0, 150)
            }));
          }
        }
        break;
        
      case "hybrid":
      default:
        if (evidence.length === 0) {
          answer = language === 'ar' 
            ? "لم يتم العثور على معلومات في المصادر المتاحة."
            : "No information found in available sources.";
        } else {
          const evidenceText = evidence.map(e => 
            `[SOURCE ${e.id}] File: ${e.filename}\nContent: ${e.excerpt}`
          ).join('\n\n---\n\n');
          
          const hybridPrompt = `Provide a brief synthesized answer to the question, then below it include 2-3 relevant direct quotes from the sources. Format: ANSWER: ... then QUOTES: ...`;
          
          const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: "gpt-3.5-turbo",
              messages: [
                { role: 'system', content: hybridPrompt },
                { role: 'user', content: `Question: ${question}\n\nSources:\n${evidenceText}` }
              ],
              temperature: 0.3,
              max_tokens: 600
            })
          });
          
          const gptData = await gptResponse.json();
          answer = gptData.choices?.[0]?.message?.content || "No answer generated";
          
          citations = evidence.map(e => ({
            evidence_ids: [e.id],
            filename: e.filename,
            section: e.section || 'General',
            page: e.page || 0,
            excerpt: e.excerpt.substring(0, 250)
          }));
        }
        break;
    }

    // ========== SOURCE_MODE = "off" HANDLING (ORIGINAL) ==========
    if (source_mode === "off") {
      return new Response(JSON.stringify({
        ok: true,
        verdict: "OK",
        answer: answer,
        applied_output: {
          output_mode,
          source_mode,
          answer_style
        }
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ========== FINAL RESPONSE WITH CITATIONS (ORIGINAL) ==========
    return new Response(JSON.stringify({
      ok: true,
      verdict: "OK",
      answer: answer,
      citations: citations,
      applied_output: {
        output_mode,
        source_mode,
        answer_style
      }
    }), {
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });

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

// ========== CLINICAL CASE ANALYSIS FUNCTIONS ==========

/**
 * استخراج جميع البيانات من النص المتلخبط
 */
function extractClinicalData(text) {
  const data = {
    patient: {
      age: extractAge(text),
      weight: extractWeight(text),
      gender: extractGender(text),
      creatinine: extractCreatinine(text),
      crcl: null,
      mrn: extractMRN(text)
    },
    vitals: extractVitals(text),
    labs: extractLabs(text),
    diagnoses: extractDiagnoses(text),
    medications: extractMedications(text),
    pmh: extractPMH(text),
    homeMeds: extractHomeMeds(text),
    reasonForAdmission: extractReasonForAdmission(text),
    rawText: text
  };
  
  return data;
}

/**
 * استخراج العمر
 */
function extractAge(text) {
  const ageMatch = text.match(/(\d+)[-\s]year[-\s]old/i) || 
                   text.match(/age[:\s]*(\d+)/i) ||
                   text.match(/(\d+)\s*y[.\s]*o/i) ||
                   text.match(/(\d+)[-\s]YEAR/i);
  return ageMatch ? parseInt(ageMatch[1]) : null;
}

/**
 * استخراج الوزن
 */
function extractWeight(text) {
  const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms)/i) || 
                      text.match(/weight[:\s]*(\d+(?:\.\d+)?)/i) ||
                      text.match(/wt[:\s]*(\d+(?:\.\d+)?)/i);
  return weightMatch ? parseFloat(weightMatch[1]) : null;
}

/**
 * استخراج الجنس
 */
function extractGender(text) {
  if (text.match(/\b(male|man|gentleman)\b/i)) return 'M';
  if (text.match(/\b(female|woman|lady)\b/i)) return 'F';
  return 'U';
}

/**
 * استخراج الكرياتينين
 */
function extractCreatinine(text) {
  // البحث في التحاليل المنظمة
  const crMatch = text.match(/Creatinine[:\s]*(\d+)/i) || 
                  text.match(/CREAT[:\s]*(\d+)/i) ||
                  text.match(/Cr[:\s]*(\d+)/i) ||
                  text.match(/كرياتينين[:\s]*(\d+)/i);
  
  if (crMatch) return parseInt(crMatch[1]);
  
  // البحث في النص الحر
  const freeMatch = text.match(/CREAT[:\s]*:?\s*(\d+)/i) || 
                    text.match(/كرياتينين[:\s]*(\d+)/i);
  return freeMatch ? parseInt(freeMatch[1]) : null;
}

/**
 * استخراج MRN
 */
function extractMRN(text) {
  const mrnMatch = text.match(/MRN[:\s]*(\d+)/i) || 
                   text.match(/medical record[:\s]*(\d+)/i);
  return mrnMatch ? mrnMatch[1] : '';
}

/**
 * استخراج العلامات الحيوية
 */
function extractVitals(text) {
  const vitals = {
    sbp: null,
    dbp: null,
    hr: null,
    temp: null,
    spo2: null,
    rr: null
  };
  
  const bpMatch = text.match(/BP[:\s]*(\d+)[\/\s]*(\d+)/i) || 
                  text.match(/blood pressure[:\s]*(\d+)[\/\s]*(\d+)/i);
  if (bpMatch) {
    vitals.sbp = parseInt(bpMatch[1]);
    vitals.dbp = parseInt(bpMatch[2]);
  }
  
  const hrMatch = text.match(/HR[:\s]*(\d+)/i) || 
                  text.match(/heart rate[:\s]*(\d+)/i);
  if (hrMatch) vitals.hr = parseInt(hrMatch[1]);
  
  const spo2Match = text.match(/SpO2[:\s]*(\d+)/i) || 
                    text.match(/O2 sat[:\s]*(\d+)/i);
  if (spo2Match) vitals.spo2 = parseInt(spo2Match[1]);
  
  const rrMatch = text.match(/RR[:\s]*(\d+)/i) || 
                  text.match(/respiratory rate[:\s]*(\d+)/i);
  if (rrMatch) vitals.rr = parseInt(rrMatch[1]);
  
  return vitals;
}

/**
 * استخراج جميع التحاليل
 */
function extractLabs(text) {
  const labs = {
    wbc: null, hb: null, plt: null,
    na: null, k: null, inr: null,
    alt: null, ast: null, alp: null,
    bun: null, creatinine: null,
    glucose: null, hba1c: null,
    pt: null, aptt: null, ldh: null
  };
  
  // WBC
  const wbcMatch = text.match(/W\.?B\.?C\.?[:\s]*(\d+(?:\.\d+)?)/i) || 
                   text.match(/white blood[:\s]*(\d+(?:\.\d+)?)/i);
  if (wbcMatch) labs.wbc = parseFloat(wbcMatch[1]);
  
  // HB/Hemoglobin
  const hbMatch = text.match(/Hb[:\s]*(\d+(?:\.\d+)?)/i) || 
                  text.match(/hemoglobin[:\s]*(\d+(?:\.\d+)?)/i);
  if (hbMatch) labs.hb = parseFloat(hbMatch[1]);
  
  // PLT/Platelets
  const pltMatch = text.match(/PLT[:\s]*(\d+)/i) || 
                   text.match(/platelet[:\s]*(\d+)/i);
  if (pltMatch) labs.plt = parseInt(pltMatch[1]);
  
  // Sodium
  const naMatch = text.match(/Na[:\s]*(\d+)/i) || 
                  text.match(/sodium[:\s]*(\d+)/i);
  if (naMatch) labs.na = parseInt(naMatch[1]);
  
  // Potassium
  const kMatch = text.match(/K[:\s]*(\d+(?:\.\d+)?)/i) || 
                 text.match(/potassium[:\s]*(\d+(?:\.\d+)?)/i);
  if (kMatch) labs.k = parseFloat(kMatch[1]);
  
  // INR
  const inrMatch = text.match(/INR[:\s]*(\d+(?:\.\d+)?)/i);
  if (inrMatch) labs.inr = parseFloat(inrMatch[1]);
  
  // ALT
  const altMatch = text.match(/ALT[:\s]*(\d+)/i) || 
                   text.match(/alanine[:\s]*(\d+)/i);
  if (altMatch) labs.alt = parseInt(altMatch[1]);
  
  // AST
  const astMatch = text.match(/AST[:\s]*(\d+)/i) || 
                   text.match(/aspartate[:\s]*(\d+)/i);
  if (astMatch) labs.ast = parseInt(astMatch[1]);
  
  // Creatinine (already extracted but also in labs)
  const crMatch = extractCreatinine(text);
  if (crMatch) labs.creatinine = crMatch;
  
  // BUN
  const bunMatch = text.match(/BUN[:\s]*(\d+(?:\.\d+)?)/i);
  if (bunMatch) labs.bun = parseFloat(bunMatch[1]);
  
  // Glucose
  const gluMatch = text.match(/glucose[:\s]*(\d+(?:\.\d+)?)/i) || 
                   text.match(/RBG[:\s]*(\d+(?:\.\d+)?)/i);
  if (gluMatch) labs.glucose = parseFloat(gluMatch[1]);
  
  // HbA1c
  const hba1cMatch = text.match(/HbA1c[:\s]*(\d+(?:\.\d+)?)/i) || 
                     text.match(/A1c[:\s]*(\d+(?:\.\d+)?)/i);
  if (hba1cMatch) labs.hba1c = parseFloat(hba1cMatch[1]);
  
  // PT
  const ptMatch = text.match(/PT[:\s]*(\d+(?:\.\d+)?)/i);
  if (ptMatch) labs.pt = parseFloat(ptMatch[1]);
  
  // aPTT
  const apttMatch = text.match(/aPTT[:\s]*(\d+(?:\.\d+)?)/i);
  if (apttMatch) labs.aptt = parseFloat(apttMatch[1]);
  
  // LDH
  const ldhMatch = text.match(/LDH[:\s]*(\d+)/i);
  if (ldhMatch) labs.ldh = parseInt(ldhMatch[1]);
  
  return labs;
}

/**
 * استخراج التشخيصات
 */
function extractDiagnoses(text) {
  const diagnoses = [];
  
  const diagnosisPatterns = [
    { pattern: /DM|diabetes|diabetic/i, name: 'Diabetes Mellitus' },
    { pattern: /HTN|hypertension/i, name: 'Hypertension' },
    { pattern: /CKD|chronic kidney disease/i, name: 'CKD' },
    { pattern: /AKI|acute kidney injury/i, name: 'AKI' },
    { pattern: /ACS|NSTEMI|MI|myocardial infarction/i, name: 'ACS' },
    { pattern: /anemia/i, name: 'Anemia' },
    { pattern: /sepsis|septic/i, name: 'Sepsis' },
    { pattern: /pneumonia|PNA/i, name: 'Pneumonia' },
    { pattern: /HF|heart failure|CHF/i, name: 'Heart Failure' },
    { pattern: /AF|atrial fibrillation|AFib/i, name: 'Atrial Fibrillation' },
    { pattern: /DVT|deep vein thrombosis/i, name: 'DVT' },
    { pattern: /PE|pulmonary embolism/i, name: 'PE' }
  ];
  
  for (const dx of diagnosisPatterns) {
    if (dx.pattern.test(text)) {
      diagnoses.push(dx.name);
    }
  }
  
  return diagnoses;
}

/**
 * استخراج جميع الأدوية من النص
 */
function extractMedications(text) {
  const medications = [];
  
  const medicationPatterns = [
    // Antiplatelets/Anticoagulants
    { pattern: /acetylsalicylic acid|aspirin|asa/gi, category: 'antiplatelet' },
    { pattern: /clopidogrel|plavix/gi, category: 'antiplatelet' },
    { pattern: /warfarin|coumadin/gi, category: 'anticoagulant' },
    { pattern: /enoxaparin|lovenox/gi, category: 'anticoagulant' },
    { pattern: /heparin/gi, category: 'anticoagulant' },
    
    // Cardiac medications
    { pattern: /bisoprolol/gi, category: 'beta_blocker' },
    { pattern: /metoprolol|lopressor/gi, category: 'beta_blocker' },
    { pattern: /carvedilol|coreg/gi, category: 'beta_blocker' },
    { pattern: /furosemide|lasix/gi, category: 'diuretic' },
    { pattern: /nifedipine/gi, category: 'ccb' },
    { pattern: /amlodipine|norvasc/gi, category: 'ccb' },
    { pattern: /lisinopril|zestril/gi, category: 'acei' },
    { pattern: /losartan|cozaar/gi, category: 'arb' },
    { pattern: /rosuvastatin|crestor/gi, category: 'statin' },
    { pattern: /atorvastatin|lipitor/gi, category: 'statin' },
    
    // Diabetes medications
    { pattern: /metformin|glucophage/gi, category: 'antidiabetic' },
    { pattern: /empagliflozin|jardiance/gi, category: 'sglt2' },
    { pattern: /ozempic|semaglutide/gi, category: 'glp1' },
    { pattern: /insulin/gi, category: 'insulin' },
    
    // Antibiotics
    { pattern: /piperacillin|tazobactam/gi, category: 'antibiotic' },
    { pattern: /meropenem/gi, category: 'antibiotic' },
    { pattern: /vancomycin/gi, category: 'antibiotic' },
    
    // Others
    { pattern: /paracetamol|acetaminophen/gi, category: 'analgesic' },
    { pattern: /esomeprazole|nexium/gi, category: 'ppi' },
    { pattern: /noradrenaline|norepinephrine/gi, category: 'vasopressor' }
  ];
  
  const found = new Set();
  
  for (const med of medicationPatterns) {
    const matches = text.match(med.pattern);
    if (matches) {
      matches.forEach(m => {
        const name = m.toLowerCase();
        if (!found.has(name)) {
          found.add(name);
          medications.push({
            name: name,
            category: med.category,
            dose: extractDose(text, name),
            status: 'PENDING'
          });
        }
      });
    }
  }
  
  return medications;
}

/**
 * استخراج الجرعة لدواء معين
 */
function extractDose(text, medicationName) {
  const dosePattern = new RegExp(`${medicationName}[\\s\\S]{0,30}?(\\d+)\\s*(mg|mcg|g|ml|unit)`, 'i');
  const match = text.match(dosePattern);
  return match ? `${match[1]} ${match[2]}` : null;
}

/**
 * استخراج التاريخ المرضي السابق
 */
function extractPMH(text) {
  const pmhMatch = text.match(/PMH[:\s]*([^\n]+)/i) || 
                   text.match(/past medical history[:\s]*([^\n]+)/i) ||
                   text.match(/K\/C OF[:\s]*([^\n]+)/i);
  return pmhMatch ? pmhMatch[1].trim() : '';
}

/**
 * استخراج أدوية المنزل
 */
function extractHomeMeds(text) {
  const homeMedsMatch = text.match(/home meds?[:\s]*([^\n]+)/i) || 
                        text.match(/PATIENT ON[:\s]*([^\n]+)/i);
  return homeMedsMatch ? homeMedsMatch[1].trim() : '';
}

/**
 * استخراج سبب الدخول
 */
function extractReasonForAdmission(text) {
  const reasonMatch = text.match(/CAME WITH[:\s]*([^\n]+)/i) || 
                      text.match(/reason for admission[:\s]*([^\n]+)/i) ||
                      text.match(/presenting with[:\s]*([^\n]+)/i);
  return reasonMatch ? reasonMatch[1].trim() : '';
}

/**
 * حساب CrCl باستخدام Cockcroft-Gault
 */
function calculateCrCl(age, weight, creatinine, gender) {
  if (!age || !weight || !creatinine) return null;
  
  const ageNum = age;
  const weightNum = weight;
  const crNum = creatinine / 88.4; // تحويل من µmol/L إلى mg/dL
  
  let crcl = ((140 - ageNum) * weightNum) / (72 * crNum);
  
  if (gender === 'F') {
    crcl = crcl * 0.85;
  }
  
  return Math.round(crcl * 10) / 10; // تقريب لرقم عشري واحد
}

/**
 * التحقق من الأدوية في قاعدة البروتوكول
 */
async function validateMedications(medications, env) {
  if (!medications || medications.length === 0) return [];
  
  const results = [];
  
  for (const med of medications) {
    try {
      const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        },
        body: JSON.stringify({
          query: `${med.name} dosing contraindications monitoring`,
          max_num_results: 3
        })
      });
      
      if (searchResponse.ok) {
        const searchData = await searchResponse.json();
        if (searchData.data && searchData.data.length > 0) {
          med.status = 'FOUND';
          med.evidence = searchData.data.map(item => ({
            content: extractContent(item),
            filename: item.file_id || 'Protocol'
          }));
        } else {
          med.status = 'NOT_FOUND';
        }
      } else {
        med.status = 'ERROR';
      }
    } catch (error) {
      med.status = 'ERROR';
    }
    
    results.push(med);
  }
  
  return results;
}

/**
 * استخراج المحتوى من نتيجة البحث
 */
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

/**
 * تحليل النتائج السريرية واكتشاف المشاكل
 */
function analyzeClinicalFindings(clinicalData, medications) {
  const findings = [];
  
  // التحقق من مشاكل النزيف
  if (clinicalData.labs.inr && clinicalData.labs.inr > 2.0) {
    const antiplatelets = medications.filter(m => 
      m.category === 'antiplatelet' && m.status === 'FOUND'
    );
    
    if (antiplatelets.length > 0) {
      findings.push({
        severity: 'CRITICAL',
        type: 'BLEEDING_RISK',
        problem: 'INR مرتفع مع مضادات صفيحات - خطر نزيف حاد',
        correction: 'إيقاف مضادات الصفيحات مؤقتاً، مراقبة علامات النزيف، قياس INR بعد 6 ساعات',
        citations: []
      });
    }
  }
  
  // التحقق من فرط بوتاسيوم الدم
  if (clinicalData.labs.k && clinicalData.labs.k > 5.5) {
    findings.push({
      severity: 'HIGH',
      type: 'ELECTROLYTE_IMBALANCE',
      problem: `فرط بوتاسيوم الدم (K ${clinicalData.labs.k})`,
      correction: 'إيقاف مكملات البوتاسيوم، مراقبة ECG، النظر في كاي إكسالات إذا استمر الارتفاع',
      citations: []
    });
  }
  
  // التحقق من نقص صوديوم الدم
  if (clinicalData.labs.na && clinicalData.labs.na < 130) {
    findings.push({
      severity: 'HIGH',
      type: 'ELECTROLYTE_IMBALANCE',
      problem: `نقص صوديوم الدم الشديد (Na ${clinicalData.labs.na})`,
      correction: 'تقييد السوائل، مراقبة الوعي، النظر في محلول ملحي ٣٪ إذا ظهرت أعراض عصبية',
      citations: []
    });
  }
  
  // التحقق من الفشل الكلوي الحاد
  if (clinicalData.patient.creatinine && clinicalData.patient.creatinine > 200) {
    const nephrotoxic = medications.filter(m => 
      ['nsaid', 'aminoglycoside', 'vancomycin'].includes(m.category) && 
      m.status === 'FOUND'
    );
    
    if (nephrotoxic.length > 0) {
      findings.push({
        severity: 'HIGH',
        type: 'NEPHROTOXICITY',
        problem: 'فشل كلوي حاد مع أدوية سامة للكلية',
        correction: `إيقاف/تجنب: ${nephrotoxic.map(m => m.name).join(', ')}، مراجعة الجرعات`,
        citations: []
      });
    }
  }
  
  // التحقق من تلف الكبد
  if (clinicalData.labs.ast && clinicalData.labs.ast > 1000) {
    findings.push({
      severity: 'HIGH',
      type: 'HEPATOTOXICITY',
      problem: `ارتفاع شديد في AST (${clinicalData.labs.ast}) - تلف كبدي حاد`,
      correction: 'إيقاف الأدوية السامة للكبد، مراقبة LFTs، استشارة كبد',
      citations: []
    });
  }
  
  // التحقق من نقص الأكسجة
  if (clinicalData.vitals.spo2 && clinicalData.vitals.spo2 < 90) {
    findings.push({
      severity: 'CRITICAL',
      type: 'HYPOXEMIA',
      problem: `نقص أكسجة حاد (SpO2 ${clinicalData.vitals.spo2}%)`,
      correction: 'زيادة FiO2، تحسين التهوية، البحث عن السبب',
      citations: []
    });
  }
  
  return findings;
}

/**
 * تحديد حالة الأمان العامة
 */
function determineSafetyStatus(findings) {
  if (findings.some(f => f.severity === 'CRITICAL')) {
    return {
      status: 'CRITICAL',
      color: 'CRITICAL',
      summary: 'حالة حرجة - تدخل عاجل مطلوب'
    };
  }
  
  if (findings.some(f => f.severity === 'HIGH')) {
    return {
      status: 'HIGH RISK',
      color: 'HIGH',
      summary: 'مخاطر عالية - تحتاج تدخل سريع'
    };
  }
  
  if (findings.length > 0) {
    return {
      status: 'MODERATE RISK',
      color: 'MODERATE',
      summary: 'مخاطر متوسطة - متابعة ومراقبة'
    };
  }
  
  return {
    status: 'STABLE',
    color: 'SAFE',
    summary: 'الحالة مستقرة - لا توجد تدخلات عاجلة'
  };
}

/**
 * توليد SOAP Note المنظم
 */
function generateSOAPNote(clinicalData, medications, findings, safetyStatus) {
  const patient = clinicalData.patient;
  const vitals = clinicalData.vitals;
  const labs = clinicalData.labs;
  
  let soap = `S: Patient — (MRN: ${patient.mrn || ''}), ${patient.age || '__'}Y, ${patient.weight || '__'}kg admitted to ICU.\n`;
  soap += `Reason for Admission: ${clinicalData.reasonForAdmission || 'N/A'}\n`;
  soap += `PMH: ${clinicalData.pmh || 'N/A'}\n`;
  soap += `Home Meds: ${clinicalData.homeMeds || 'N/A'}\n\n`;
  
  soap += `O: Vitals: SBP ${vitals.sbp || '___'}, DBP ${vitals.dbp || '___'}, HR ${vitals.hr || '___'}, SpO2 ${vitals.spo2 || '___'}\n`;
  soap += `Labs: WBC ${labs.wbc || '___'}, Hb ${labs.hb || '___'}, PLT ${labs.plt || '___'}, `;
  soap += `Na ${labs.na || '___'}, K ${labs.k || '___'}, INR ${labs.inr || '___'}, AST ${labs.ast || '___'}\n`;
  soap += `Renal: SCr ${patient.creatinine || '___'} µmol, Calculated CrCl ${patient.crcl ? patient.crcl + ' mL/min' : '___'}\n\n`;
  
  soap += `A: Primary admission for acute issues. Clinical review performed.\n`;
  soap += `Safety Status: ${safetyStatus.status}\n`;
  soap += `Summary: ${safetyStatus.summary}\n\n`;
  
  soap += `P:\nCurrent Medications:\n`;
  
  if (medications.length > 0) {
    medications.forEach(med => {
      if (med.status === 'FOUND') {
        soap += `- ${med.name} (${med.category})${med.dose ? ' ' + med.dose : ''}\n`;
      } else if (med.status === 'NOT_FOUND') {
        soap += `- ${med.name}: NOT_FOUND in protocol database\n`;
      }
    });
  } else {
    soap += `- No medications identified\n`;
  }
  
  soap += `\nPharmacist Intervention:\n`;
  
  if (findings.length > 0) {
    const critical = findings.filter(f => f.severity === 'CRITICAL');
    const high = findings.filter(f => f.severity === 'HIGH');
    const moderate = findings.filter(f => f.severity === 'MODERATE');
    
    if (critical.length > 0) {
      soap += `\n🔴 CRITICAL:\n`;
      critical.forEach(f => soap += `- ${f.problem}\n  → ${f.correction}\n`);
    }
    
    if (high.length > 0) {
      soap += `\n🟠 HIGH:\n`;
      high.forEach(f => soap += `- ${f.problem}\n  → ${f.correction}\n`);
    }
    
    if (moderate.length > 0) {
      soap += `\n🟡 MODERATE:\n`;
      moderate.forEach(f => soap += `- ${f.problem}\n  → ${f.correction}\n`);
    }
  } else {
    soap += `Patient reviewed; no interventions at this time.\n`;
  }
  
  soap += `\nFollow-up Plan:\n`;
  soap += `- Repeat labs in 6-12 hours\n`;
  soap += `- Monitor vital signs closely\n`;
  soap += `- Nephrology/Cardiology consult as needed\n`;
  
  return soap;
}

/**
 * استخراج جميع الاستشهادات من النتائج
 */
function extractCitations(findings) {
  const citations = [];
  
  findings.forEach(f => {
    if (f.citations && f.citations.length > 0) {
      citations.push(...f.citations);
    }
  });
  
  return citations;
}
