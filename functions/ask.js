// File: /functions/api/ask.js
// ENHANCED BACKEND WITH SYSTEM-LEVEL CLINICAL REASONING ENGINE
// ALL EXISTING CONNECTIONS PRESERVED - ENHANCED INTERNAL PROCESSING ONLY

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

    // ========== ENHANCED SYSTEM-LEVEL CLINICAL REASONING ENGINE ==========
    if (body.mode === "case_analysis" && body.case_text) {
      // STEP 1: Parse unstructured case into structured data
      const clinicalData = await parseClinicalCase(body.case_text, env);
      
      // STEP 2: Calculate CrCl if parameters available
      if (clinicalData.patient?.creatinine && clinicalData.patient?.weight && clinicalData.patient?.age) {
        clinicalData.patient.crcl = calculateCrCl(
          clinicalData.patient.age,
          clinicalData.patient.weight,
          clinicalData.patient.creatinine,
          clinicalData.patient.gender || 'unknown'
        );
      }
      
      // STEP 3: Extract all medications with their properties
      clinicalData.medications = await extractMedicationsWithProperties(body.case_text, env);
      
      // STEP 4: Extract diagnoses and conditions
      clinicalData.diagnoses = await extractDiagnoses(body.case_text, env);
      
      // STEP 5: Perform SYSTEM-LEVEL CLINICAL ANALYSIS
      const clinicalFindings = await performSystemLevelAnalysis(clinicalData, env);
      
      // STEP 6: Determine overall safety status
      const safetyStatus = determineOverallSafetyStatus(clinicalFindings);
      
      // STEP 7: Format complete SOAP note with system-level findings
      const soapNote = formatEnhancedSOAPNote(clinicalData, clinicalFindings, safetyStatus);
      
      // STEP 8: Extract missing medications list
      const missingMeds = clinicalData.medications
        .filter(m => m.status === 'NOT_FOUND')
        .map(m => m.name);
      
      // Return enhanced response with system-level analysis
      return new Response(JSON.stringify({
        ok: true,
        verdict: "OK",
        answer: soapNote,
        clinical_findings: clinicalFindings,
        safety_status: safetyStatus,
        missing_medications: missingMeds,
        citations: extractAllCitations(clinicalFindings),
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
    
    // ========== STANDARD Q&A MODE (COMPLETELY UNCHANGED) ==========
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

    // Perform vector search
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
    
    // Extract evidence with metadata
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

    // ========== SOURCE_MODE = "required" ENFORCEMENT ==========
    if (source_mode === "required") {
      // Check if we have any evidence with complete metadata
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

    // ========== OUTPUT_MODE ENFORCEMENT ==========
    let answer = "";
    let citations = [];
    
    switch(output_mode) {
      case "verbatim":
        // Verbatim mode: ONLY direct quotes, no paraphrasing
        if (evidence.length === 0) {
          answer = language === 'ar' 
            ? "لم يتم العثور على نصوص حرفية في المصادر."
            : "No verbatim text found in sources.";
        } else {
          // Build answer from direct quotes only
          const quotes = evidence.map(e => {
            // Extract a clean quote (first 1-2 sentences)
            const sentences = e.excerpt.split(/[.!?]+/).filter(s => s.trim().length > 20);
            const quote = sentences.length > 0 ? sentences[0].trim() + '.' : e.excerpt.substring(0, 150);
            return `"${quote}" — ${e.filename} (Section: ${e.section || 'General'}, Page: ${e.page || 'N/A'})`;
          }).slice(0, 3); // Max 3 quotes for verbatim mode
          
          answer = quotes.join('\n\n');
          
          // Build citations with full metadata
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
        // Short mode: 3-6 bullet points maximum
        if (evidence.length === 0) {
          answer = language === 'ar' 
            ? "لم يتم العثور على معلومات."
            : "No information found.";
        } else {
          // Use GPT to generate concise bullets
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
          
          // Build minimal citations if source_mode="required"
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
        // Hybrid mode: synthesized answer + evidence quotes
        if (evidence.length === 0) {
          answer = language === 'ar' 
            ? "لم يتم العثور على معلومات في المصادر المتاحة."
            : "No information found in available sources.";
        } else {
          // Generate synthesized answer
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
          
          // Always include citations in hybrid mode
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

    // ========== SOURCE_MODE = "off" HANDLING ==========
    if (source_mode === "off") {
      // Omit citations from response
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

    // ========== FINAL RESPONSE WITH CITATIONS ==========
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

// ========== ENHANCED SYSTEM-LEVEL CLINICAL REASONING FUNCTIONS ==========

/**
 * Parse clinical case with enhanced entity extraction
 */
async function parseClinicalCase(caseText, env) {
  const clinicalData = {
    patient: {
      mrn: extractMRN(caseText),
      age: extractAge(caseText),
      weight: extractWeight(caseText),
      gender: extractGender(caseText),
      height: extractHeight(caseText),
      bmi: null,
      creatinine: extractCreatinine(caseText),
      crcl: null
    },
    vitals: extractAllVitals(caseText),
    labs: extractAllLabs(caseText),
    diagnoses: [],
    medications: [],
    conditions: extractConditions(caseText),
    allergies: extractAllergies(caseText)
  };
  
  // Calculate BMI if height and weight available
  if (clinicalData.patient.weight && clinicalData.patient.height) {
    const weightKg = parseFloat(clinicalData.patient.weight);
    const heightM = parseFloat(clinicalData.patient.height) / 100;
    if (!isNaN(weightKg) && !isNaN(heightM) && heightM > 0) {
      clinicalData.patient.bmi = (weightKg / (heightM * heightM)).toFixed(1);
    }
  }
  
  return clinicalData;
}

/**
 * Extract all vitals comprehensively
 */
function extractAllVitals(text) {
  return {
    sbp: extractValue(text, /SBP[:\s]*(\d+)/i) || extractValue(text, /systolic[:\s]*(\d+)/i),
    dbp: extractValue(text, /DBP[:\s]*(\d+)/i) || extractValue(text, /diastolic[:\s]*(\d+)/i),
    hr: extractValue(text, /HR[:\s]*(\d+)/i) || extractValue(text, /heart rate[:\s]*(\d+)/i),
    temp: extractValue(text, /Temp[:\s]*(\d+(?:\.\d+)?)/i),
    spo2: extractValue(text, /SpO2[:\s]*(\d+)/i) || extractValue(text, /O2 sat[:\s]*(\d+)/i),
    rr: extractValue(text, /RR[:\s]*(\d+)/i) || extractValue(text, /respiratory rate[:\s]*(\d+)/i),
    map: extractValue(text, /MAP[:\s]*(\d+)/i)
  };
}

/**
 * Extract all labs comprehensively
 */
function extractAllLabs(text) {
  return {
    wbc: extractValue(text, /WBC[:\s]*(\d+(?:\.\d+)?)/i),
    hgb: extractValue(text, /Hgb[:\s]*(\d+(?:\.\d+)?)/i) || extractValue(text, /hemoglobin[:\s]*(\d+(?:\.\d+)?)/i),
    hct: extractValue(text, /Hct[:\s]*(\d+(?:\.\d+)?)/i),
    plt: extractValue(text, /PLT[:\s]*(\d+)/i) || extractValue(text, /platelet[:\s]*(\d+)/i),
    na: extractValue(text, /Na[:\s]*(\d+)/i),
    k: extractValue(text, /K[:\s]*(\d+(?:\.\d+)?)/i),
    cl: extractValue(text, /Cl[:\s]*(\d+)/i),
    co2: extractValue(text, /CO2[:\s]*(\d+)/i),
    bun: extractValue(text, /BUN[:\s]*(\d+)/i),
    cr: extractValue(text, /Cr[:\s]*(\d+(?:\.\d+)?)/i) || extractValue(text, /creatinine[:\s]*(\d+(?:\.\d+)?)/i),
    glucose: extractValue(text, /glucose[:\s]*(\d+)/i) || extractValue(text, /RBG[:\s]*(\d+)/i),
    inr: extractValue(text, /INR[:\s]*(\d+(?:\.\d+)?)/i),
    ptt: extractValue(text, /PTT[:\s]*(\d+(?:\.\d+)?)/i) || extractValue(text, /aPTT[:\s]*(\d+(?:\.\d+)?)/i),
    alt: extractValue(text, /ALT[:\s]*(\d+)/i),
    ast: extractValue(text, /AST[:\s]*(\d+)/i),
    alp: extractValue(text, /ALP[:\s]*(\d+)/i),
    tbil: extractValue(text, /TBil[:\s]*(\d+(?:\.\d+)?)/i),
    albumin: extractValue(text, /albumin[:\s]*(\d+(?:\.\d+)?)/i),
    troponin: extractValue(text, /troponin[:\s]*(\d+(?:\.\d+)?)/i),
    bnp: extractValue(text, /BNP[:\s]*(\d+)/i),
    lactate: extractValue(text, /lactate[:\s]*(\d+(?:\.\d+)?)/i)
  };
}

/**
 * Extract numeric value from text
 */
function extractValue(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : null;
}

/**
 * Extract height
 */
function extractHeight(text) {
  const heightMatch = text.match(/(\d+(?:\.\d+)?)\s*(cm|centimeters)/i) ||
                      text.match(/height[:\s]*(\d+(?:\.\d+)?)/i);
  return heightMatch ? heightMatch[1] : null;
}

/**
 * Extract creatinine
 */
function extractCreatinine(text) {
  const crMatch = text.match(/SCr[:\s]*(\d+(?:\.\d+)?)/i) || 
                  text.match(/creatinine[:\s]*(\d+(?:\.\d+)?)/i) ||
                  text.match(/Cr[:\s]*(\d+(?:\.\d+)?)/i);
  return crMatch ? crMatch[1] : null;
}

/**
 * Extract conditions (sepsis, AKI, etc.)
 */
function extractConditions(text) {
  const conditions = [];
  const conditionPatterns = {
    'sepsis': /\b(sepsis|septic|septic shock)\b/i,
    'aki': /\b(AKI|acute kidney injury|acute renal failure)\b/i,
    'ckd': /\b(CKD|chronic kidney disease|chronic renal failure)\b/i,
    'dka': /\b(DKA|diabetic ketoacidosis)\b/i,
    'pna': /\b(pneumonia|PNA)\b/i,
    'uti': /\b(UTI|urinary tract infection)\b/i,
    'dvt': /\b(DVT|deep vein thrombosis)\b/i,
    'pe': /\b(PE|pulmonary embolism)\b/i,
    'afib': /\b(atrial fibrillation|AFib)\b/i,
    'hf': /\b(heart failure|HF|CHF)\b/i,
    'mi': /\b(MI|myocardial infarction|heart attack)\b/i,
    'stroke': /\b(stroke|CVA|cerebrovascular accident)\b/i,
    'cirrhosis': /\b(cirrhosis|liver failure)\b/i,
    'pancreatitis': /\b(pancreatitis)\b/i
  };
  
  for (const [condition, pattern] of Object.entries(conditionPatterns)) {
    if (pattern.test(text)) {
      conditions.push(condition);
    }
  }
  
  return conditions;
}

/**
 * Extract allergies
 */
function extractAllergies(text) {
  const allergies = [];
  const allergyMatch = text.match(/allergies?:?\s*([^.]+)/i);
  if (allergyMatch) {
    const allergyText = allergyMatch[1];
    const drugAllergies = allergyText.match(/\b(penicillin|sulfa|aspirin|nsaids|codeine|morphine|contrast)\b/gi);
    if (drugAllergies) {
      allergies.push(...drugAllergies);
    }
  }
  return allergies;
}

/**
 * Extract MRN from text
 */
function extractMRN(text) {
  const mrnMatch = text.match(/MRN[:\s]*(\d+)/i) || 
                   text.match(/medical record[:\s]*(\d+)/i) ||
                   text.match(/mrn[:\s]*#?(\d+)/i);
  return mrnMatch ? mrnMatch[1] : '___';
}

/**
 * Extract age from text
 */
function extractAge(text) {
  const ageMatch = text.match(/(\d+)[-\s]year[-\s]old/i) || 
                   text.match(/age[:\s]*(\d+)/i) ||
                   text.match(/(\d+)\s*y[.\s]*o/i);
  return ageMatch ? ageMatch[1] : '___';
}

/**
 * Extract weight from text
 */
function extractWeight(text) {
  const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms)/i) || 
                      text.match(/weight[:\s]*(\d+(?:\.\d+)?)/i) ||
                      text.match(/wt[:\s]*(\d+(?:\.\d+)?)/i);
  return weightMatch ? weightMatch[1] : '___';
}

/**
 * Extract gender from text
 */
function extractGender(text) {
  if (text.match(/\b(male|man|gentleman)\b/i)) return 'M';
  if (text.match(/\b(female|woman|lady)\b/i)) return 'F';
  return 'U';
}

/**
 * Extract reason for admission
 */
function extractReasonForAdmission(text) {
  const reasonMatch = text.match(/reason for admission[:\s]*([^\n]+)/i) || 
                      text.match(/admitted for[:\s]*([^\n]+)/i) ||
                      text.match(/presenting with[:\s]*([^\n]+)/i) ||
                      text.match(/diagnosis[:\s]*([^\n]+)/i);
  return reasonMatch ? reasonMatch[1].trim() : '___';
}

/**
 * Extract PMH (Past Medical History)
 */
function extractPMH(text) {
  const pmhMatch = text.match(/PMH[:\s]*([^\n]+)/i) || 
                   text.match(/past medical history[:\s]*([^\n]+)/i) ||
                   text.match(/medical history[:\s]*([^\n]+)/i);
  return pmhMatch ? pmhMatch[1].trim() : '___';
}

/**
 * Extract home medications
 */
function extractHomeMeds(text) {
  const homeMedsMatch = text.match(/home meds?[:\s]*([^\n]+)/i) || 
                        text.match(/home medications?[:\s]*([^\n]+)/i) ||
                        text.match(/medications? on admission[:\s]*([^\n]+)/i);
  return homeMedsMatch ? homeMedsMatch[1].trim() : '___';
}

/**
 * Calculate CrCl using Cockcroft-Gault formula
 */
function calculateCrCl(age, weight, creatinine, gender) {
  if (!age || !weight || !creatinine || age === '___' || weight === '___' || creatinine === '___') {
    return 'Unable to calculate (missing parameters)';
  }
  
  const ageNum = parseFloat(age);
  const weightNum = parseFloat(weight);
  const crNum = parseFloat(creatinine);
  
  if (isNaN(ageNum) || isNaN(weightNum) || isNaN(crNum) || crNum === 0) {
    return 'Unable to calculate (invalid parameters)';
  }
  
  // Cockcroft-Gault: (140 - age) * weight / (72 * creatinine)
  // Multiply by 0.85 for females
  let crcl = ((140 - ageNum) * weightNum) / (72 * crNum);
  
  if (gender === 'F') {
    crcl = crcl * 0.85;
  }
  
  return crcl.toFixed(1) + ' mL/min';
}

/**
 * Extract medications with properties from protocol
 */
async function extractMedicationsWithProperties(caseText, env) {
  const medications = [];
  
  // Comprehensive medication list by category with properties
  const medicationPatterns = [
    // Anticoagulants
    { pattern: /\b(warfarin|coumadin)\b/gi, category: 'anticoagulant', class: 'vitamin_k_antagonist', qt_prolonging: false },
    { pattern: /\b(heparin|unfractionated heparin)\b/gi, category: 'anticoagulant', class: 'heparin', qt_prolonging: false },
    { pattern: /\b(enoxaparin|lovenox)\b/gi, category: 'anticoagulant', class: 'lmwh', qt_prolonging: false },
    { pattern: /\b(apixaban|eliquis)\b/gi, category: 'anticoagulant', class: 'direct_factor_xa', qt_prolonging: false },
    { pattern: /\b(rivaroxaban|xarelto)\b/gi, category: 'anticoagulant', class: 'direct_factor_xa', qt_prolonging: false },
    { pattern: /\b(dabigatran|pradaxa)\b/gi, category: 'anticoagulant', class: 'direct_thrombin', qt_prolonging: false },
    
    // Antiplatelets
    { pattern: /\b(aspirin|asa)\b/gi, category: 'antiplatelet', class: 'cox_inhibitor', qt_prolonging: false },
    { pattern: /\b(clopidogrel|plavix)\b/gi, category: 'antiplatelet', class: 'p2y12', qt_prolonging: false },
    { pattern: /\b(ticagrelor|brilinta)\b/gi, category: 'antiplatelet', class: 'p2y12', qt_prolonging: false },
    { pattern: /\b(prasugrel|effient)\b/gi, category: 'antiplatelet', class: 'p2y12', qt_prolonging: false },
    
    // QT-prolonging drugs
    { pattern: /\b(amiodarone|cordarone)\b/gi, category: 'antiarrhythmic', class: 'class_iii', qt_prolonging: true },
    { pattern: /\b(sotalol|betapace)\b/gi, category: 'antiarrhythmic', class: 'class_iii', qt_prolonging: true },
    { pattern: /\b(dofetilide|tikosyn)\b/gi, category: 'antiarrhythmic', class: 'class_iii', qt_prolonging: true },
    { pattern: /\b(ibutilide|corvert)\b/gi, category: 'antiarrhythmic', class: 'class_iii', qt_prolonging: true },
    { pattern: /\b(haloperidol|haldol)\b/gi, category: 'antipsychotic', class: 'typical', qt_prolonging: true },
    { pattern: /\b(quetiapine|seroquel)\b/gi, category: 'antipsychotic', class: 'atypical', qt_prolonging: true },
    { pattern: /\b(risperidone|risperdal)\b/gi, category: 'antipsychotic', class: 'atypical', qt_prolonging: true },
    { pattern: /\b(citalopram|celexa)\b/gi, category: 'antidepressant', class: 'ssri', qt_prolonging: true },
    { pattern: /\b(escitalopram|lexapro)\b/gi, category: 'antidepressant', class: 'ssri', qt_prolonging: true },
    { pattern: /\b(azithromycin|zithromax)\b/gi, category: 'antibiotic', class: 'macrolide', qt_prolonging: true },
    { pattern: /\b(levofloxacin|levaquin)\b/gi, category: 'antibiotic', class: 'fluoroquinolone', qt_prolonging: true },
    { pattern: /\b(moxifloxacin|avelox)\b/gi, category: 'antibiotic', class: 'fluoroquinolone', qt_prolonging: true },
    
    // ACEi/ARBs
    { pattern: /\b(lisinopril|zestril|prinivil)\b/gi, category: 'acei', class: 'ace_inhibitor', qt_prolonging: false },
    { pattern: /\b(enalapril|vasotec)\b/gi, category: 'acei', class: 'ace_inhibitor', qt_prolonging: false },
    { pattern: /\b(ramipril|altace)\b/gi, category: 'acei', class: 'ace_inhibitor', qt_prolonging: false },
    { pattern: /\b(losartan|cozaar)\b/gi, category: 'arb', class: 'angiotensin_blocker', qt_prolonging: false },
    { pattern: /\b(valsartan|diovan)\b/gi, category: 'arb', class: 'angiotensin_blocker', qt_prolonging: false },
    
    // MRAs
    { pattern: /\b(spironolactone|aldactone)\b/gi, category: 'mra', class: 'mineralocorticoid', qt_prolonging: false },
    { pattern: /\b(eplerenone|inspra)\b/gi, category: 'mra', class: 'mineralocorticoid', qt_prolonging: false },
    
    // NSAIDs
    { pattern: /\b(ibuprofen|motrin|advil)\b/gi, category: 'nsaid', class: 'nsaid', qt_prolonging: false },
    { pattern: /\b(naproxen|aleve)\b/gi, category: 'nsaid', class: 'nsaid', qt_prolonging: false },
    { pattern: /\b(ketorolac|toradol)\b/gi, category: 'nsaid', class: 'nsaid', qt_prolonging: false },
    
    // Diuretics
    { pattern: /\b(furosemide|lasix)\b/gi, category: 'diuretic', class: 'loop', qt_prolonging: false },
    { pattern: /\b(hydrochlorothiazide|hctz)\b/gi, category: 'diuretic', class: 'thiazide', qt_prolonging: false },
    
    // Metformin
    { pattern: /\b(metformin|glucophage)\b/gi, category: 'antidiabetic', class: 'biguanide', qt_prolonging: false }
  ];
  
  // First pass: identify medications from text
  const foundMeds = new Set();
  for (const med of medicationPatterns) {
    const matches = caseText.match(med.pattern);
    if (matches) {
      matches.forEach(m => {
        foundMeds.add({
          name: m.toLowerCase(),
          category: med.category,
          class: med.class,
          qt_prolonging: med.qt_prolonging,
          status: 'PENDING'
        });
      });
    }
  }
  
  // Second pass: validate against protocol database
  for (const med of foundMeds) {
    try {
      const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        },
        body: JSON.stringify({
          query: `${med.name} dosing contraindications monitoring interactions`,
          max_num_results: 5
        })
      });
      
      if (searchResponse.ok) {
        const searchData = await searchResponse.json();
        if (searchData.data && searchData.data.length > 0) {
          med.status = 'FOUND';
          med.evidence = searchData.data.map(item => ({
            content: extractContent(item),
            filename: item.file_id || item.filename || 'Protocol'
          }));
          
          // Extract specific properties from evidence
          med.properties = await extractMedicationProperties(med.name, med.evidence);
        } else {
          med.status = 'NOT_FOUND';
          med.properties = {};
        }
      } else {
        med.status = 'ERROR';
        med.properties = {};
      }
    } catch (error) {
      med.status = 'ERROR';
      med.properties = {};
    }
  }
  
  return Array.from(foundMeds);
}

/**
 * Extract content from search result item
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
 * Extract medication properties from evidence
 */
async function extractMedicationProperties(medName, evidence) {
  const properties = {
    renal_cutoff: null,
    hepatic_cutoff: null,
    platelet_cutoff: null,
    inr_cutoff: null,
    k_cutoff: null,
    monitoring: [],
    interactions: [],
    contraindications: []
  };
  
  const allText = evidence.map(e => e.content.toLowerCase()).join(' ');
  
  // Extract renal cutoff
  const renalMatch = allText.match(/(?:crcl|creatinine clearance|renal function).{0,20}(?:<|less than|below)\s*(\d+)/i);
  if (renalMatch) properties.renal_cutoff = parseInt(renalMatch[1]);
  
  // Extract platelet cutoff
  const pltMatch = allText.match(/(?:platelet|plt).{0,20}(?:<|less than|below)\s*(\d+)/i);
  if (pltMatch) properties.platelet_cutoff = parseInt(pltMatch[1]);
  
  // Extract INR cutoff
  const inrMatch = allText.match(/(?:inr).{0,20}(?:>|greater than|above)\s*(\d+(?:\.\d+)?)/i);
  if (inrMatch) properties.inr_cutoff = parseFloat(inrMatch[1]);
  
  // Extract potassium cutoff
  const kMatch = allText.match(/(?:potassium|k\+?).{0,20}(?:>|greater than|above)\s*(\d+(?:\.\d+)?)/i);
  if (kMatch) properties.k_cutoff = parseFloat(kMatch[1]);
  
  // Extract monitoring requirements
  const monitoringIndicators = ['monitor inr', 'monitor platelets', 'monitor crcl', 'monitor renal', 'monitor lfts', 'monitor ecg', 'monitor qtc'];
  for (const indicator of monitoringIndicators) {
    if (allText.includes(indicator)) {
      properties.monitoring.push(indicator.replace('monitor ', ''));
    }
  }
  
  return properties;
}

/**
 * Extract diagnoses from text
 */
async function extractDiagnoses(caseText, env) {
  const diagnoses = [];
  
  const diagnosisPatterns = [
    { pattern: /\b(diabetes|dm|diabetes mellitus)\b/gi, name: 'diabetes' },
    { pattern: /\b(hypertension|htn)\b/gi, name: 'hypertension' },
    { pattern: /\b(hyperlipidemia|dyslipidemia)\b/gi, name: 'hyperlipidemia' },
    { pattern: /\b(heart failure|chf|hf)\b/gi, name: 'heart_failure' },
    { pattern: /\b(atrial fibrillation|afib)\b/gi, name: 'atrial_fibrillation' },
    { pattern: /\b(coronary artery disease|cad)\b/gi, name: 'cad' },
    { pattern: /\b(pneumonia|pna)\b/gi, name: 'pneumonia' },
    { pattern: /\b(uti|urinary tract infection)\b/gi, name: 'uti' },
    { pattern: /\b(sepsis|septic shock)\b/gi, name: 'sepsis' },
    { pattern: /\b(aki|acute kidney injury)\b/gi, name: 'aki' },
    { pattern: /\b(ckd|chronic kidney disease)\b/gi, name: 'ckd' },
    { pattern: /\b(dvt|deep vein thrombosis)\b/gi, name: 'dvt' },
    { pattern: /\b(pe|pulmonary embolism)\b/gi, name: 'pe' },
    { pattern: /\b(copd|chronic obstructive pulmonary disease)\b/gi, name: 'copd' },
    { pattern: /\b(asthma)\b/gi, name: 'asthma' },
    { pattern: /\b(cirrhosis|liver failure)\b/gi, name: 'cirrhosis' }
  ];
  
  for (const dx of diagnosisPatterns) {
    if (dx.pattern.test(caseText)) {
      diagnoses.push({
        name: dx.name,
        status: 'confirmed',
        required_therapies: await getRequiredTherapiesForDiagnosis(dx.name, env)
      });
    }
  }
  
  return diagnoses;
}

/**
 * Get required therapies for a diagnosis from protocol
 */
async function getRequiredTherapiesForDiagnosis(diagnosis, env) {
  try {
    const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        query: `${diagnosis} guideline recommended therapy treatment`,
        max_num_results: 3
      })
    });
    
    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      const requiredTherapies = [];
      
      for (const item of searchData.data || []) {
        const content = extractContent(item).toLowerCase();
        
        // Look for treatment recommendations
        if (content.includes('recommend') || content.includes('should receive') || content.includes('indicated')) {
          const therapyMatches = content.match(/\b(aspirin|clopidogrel|warfarin|ace.?inhibitor|arb|statin|beta.?blocker|metformin|insulin|anticoagulation|antiplatelet)\b/g);
          if (therapyMatches) {
            requiredTherapies.push(...therapyMatches);
          }
        }
      }
      
      return [...new Set(requiredTherapies)];
    }
  } catch (error) {
    console.error('Error getting required therapies:', error);
  }
  
  return [];
}

/**
 * Perform system-level clinical analysis
 */
async function performSystemLevelAnalysis(clinicalData, env) {
  const findings = [];
  
  // ========== CROSS-DRUG INTERACTION CLUSTERS ==========
  
  // Bleeding cluster detection
  const bleedingFindings = await detectBleedingCluster(clinicalData, env);
  findings.push(...bleedingFindings);
  
  // Hyperkalemia cluster detection
  const kFindings = await detectHyperkalemiaCluster(clinicalData, env);
  findings.push(...kFindings);
  
  // Nephrotoxicity cluster detection
  const nephroFindings = await detectNephrotoxicityCluster(clinicalData, env);
  findings.push(...nephroFindings);
  
  // QT prolongation cluster detection
  const qtFindings = await detectQTCluster(clinicalData, env);
  findings.push(...qtFindings);
  
  // Triple therapy risk detection
  const tripleFindings = await detectTripleTherapyRisk(clinicalData, env);
  findings.push(...tripleFindings);
  
  // ========== CROSS-LAB + DRUG CONTRAINDICATIONS ==========
  
  // Lab-based contraindications
  const labFindings = await detectLabContraindications(clinicalData, env);
  findings.push(...labFindings);
  
  // Condition-based contraindications
  const conditionFindings = await detectConditionContraindications(clinicalData, env);
  findings.push(...conditionFindings);
  
  // ========== DISEASE-COVERAGE VALIDATION ==========
  
  // Missing therapy detection
  const missingTherapyFindings = await detectMissingTherapies(clinicalData, env);
  findings.push(...missingTherapyFindings);
  
  return findings;
}

/**
 * Detect bleeding cluster (anticoagulants + antiplatelets + low platelets + high INR)
 */
async function detectBleedingCluster(clinicalData, env) {
  const findings = [];
  
  const anticoagulants = clinicalData.medications.filter(m => m.category === 'anticoagulant' && m.status === 'FOUND');
  const antiplatelets = clinicalData.medications.filter(m => m.category === 'antiplatelet' && m.status === 'FOUND');
  const hasBleedingRisk = anticoagulants.length > 0 || antiplatelets.length > 0;
  
  if (!hasBleedingRisk) return findings;
  
  // Check for low platelets
  if (clinicalData.labs.plt) {
    const pltValue = parseFloat(clinicalData.labs.plt);
    if (!isNaN(pltValue) && pltValue < 50) {
      findings.push({
        severity: 'CRITICAL',
        type: 'BLEEDING_CLUSTER',
        problem: 'Severe thrombocytopenia with antithrombotic therapy',
        correction: `Platelets ${pltValue} < 50 - HOLD anticoagulants/antiplatelets, urgent hematology consult`,
        citations: await getEvidenceForBleedingRisk(env)
      });
    } else if (!isNaN(pltValue) && pltValue < 100) {
      findings.push({
        severity: 'HIGH',
        type: 'BLEEDING_CLUSTER',
        problem: 'Moderate thrombocytopenia with antithrombotic therapy',
        correction: `Platelets ${pltValue} < 100 - consider holding, monitor closely`,
        citations: await getEvidenceForBleedingRisk(env)
      });
    }
  }
  
  // Check for elevated INR
  if (clinicalData.labs.inr) {
    const inrValue = parseFloat(clinicalData.labs.inr);
    if (!isNaN(inrValue) && inrValue > 4.0 && anticoagulants.some(m => m.class === 'vitamin_k_antagonist')) {
      findings.push({
        severity: 'CRITICAL',
        type: 'BLEEDING_CLUSTER',
        problem: 'Supratherapeutic INR with warfarin',
        correction: `INR ${inrValue} > 4.0 - hold warfarin, consider reversal`,
        citations: await getEvidenceForInrRisk(env)
      });
    }
  }
  
  // Triple antithrombotic therapy
  if (anticoagulants.length >= 1 && antiplatelets.length >= 2) {
    findings.push({
      severity: 'HIGH',
      type: 'TRIPLE_THERAPY',
      problem: 'Triple antithrombotic therapy (anticoagulant + dual antiplatelets)',
      correction: 'Significantly increased bleeding risk - reassess indication, limit duration',
      citations: await getEvidenceForTripleTherapy(env)
    });
  }
  
  // Dual antithrombotic with risk factors
  if (anticoagulants.length >= 1 && antiplatelets.length >= 1) {
    if (clinicalData.patient.age && parseInt(clinicalData.patient.age) > 75) {
      findings.push({
        severity: 'HIGH',
        type: 'BLEEDING_CLUSTER',
        problem: 'Dual antithrombotic therapy in elderly',
        correction: 'Age >75 increases bleeding risk - consider PPI, monitor closely',
        citations: await getEvidenceForBleedingRisk(env)
      });
    }
  }
  
  return findings;
}

/**
 * Detect hyperkalemia cluster (high K + ACEi/ARB + MRA + AKI)
 */
async function detectHyperkalemiaCluster(clinicalData, env) {
  const findings = [];
  
  if (!clinicalData.labs.k) return findings;
  
  const kValue = parseFloat(clinicalData.labs.k);
  if (isNaN(kValue)) return findings;
  
  const aceiArb = clinicalData.medications.filter(m => m.category === 'acei' || m.category === 'arb');
  const mra = clinicalData.medications.filter(m => m.category === 'mra');
  const hasAki = clinicalData.conditions.includes('aki');
  const hasCkd = clinicalData.conditions.includes('ckd');
  
  if (kValue > 6.0) {
    findings.push({
      severity: 'CRITICAL',
      type: 'HYPERKALEMIA_CLUSTER',
      problem: 'Severe hyperkalemia',
      correction: `K+ ${kValue} > 6.0 - URGENT: hold K+ increasing drugs, consider Kayexalate/insulin/dextrose`,
      citations: await getEvidenceForHyperkalemia(env)
    });
  } else if (kValue > 5.5) {
    let severity = 'HIGH';
    let correction = `K+ ${kValue} > 5.5 - hold K+ supplements, reduce/hold ACEi/ARB/MRA`;
    
    if (aceiArb.length > 0 || mra.length > 0) {
      findings.push({
        severity: 'HIGH',
        type: 'HYPERKALEMIA_CLUSTER',
        problem: 'Hyperkalemia with RAAS blockade',
        correction: correction,
        citations: await getEvidenceForHyperkalemia(env)
      });
    }
  } else if (kValue > 5.0) {
    if ((aceiArb.length > 0 || mra.length > 0) && (hasAki || hasCkd)) {
      findings.push({
        severity: 'MODERATE',
        type: 'HYPERKALEMIA_CLUSTER',
        problem: 'Borderline hyperkalemia with risk factors',
        correction: `K+ ${kValue} - monitor closely, consider holding if rising`,
        citations: await getEvidenceForHyperkalemia(env)
      });
    }
  }
  
  return findings;
}

/**
 * Detect nephrotoxicity cluster (AKI + nephrotoxic drugs)
 */
async function detectNephrotoxicityCluster(clinicalData, env) {
  const findings = [];
  
  const hasAki = clinicalData.conditions.includes('aki');
  if (!hasAki) return findings;
  
  const nephrotoxicDrugs = clinicalData.medications.filter(m => 
    m.category === 'nsaid' || 
    m.name.includes('gentamicin') || 
    m.name.includes('vancomycin') || 
    m.name.includes('tacrolimus') || 
    m.name.includes('cyclosporine') ||
    m.name.includes('contrast')
  );
  
  if (nephrotoxicDrugs.length > 0) {
    findings.push({
      severity: 'HIGH',
      type: 'NEPHROTOXICITY_CLUSTER',
      problem: 'AKI with nephrotoxic drugs',
      correction: `Hold/avoid: ${nephrotoxicDrugs.map(m => m.name).join(', ')}`,
      citations: await getEvidenceForNephrotoxicity(env)
    });
  }
  
  // Check for triple whammy (ACEi/ARB + diuretic + NSAID)
  const aceiArb = clinicalData.medications.filter(m => m.category === 'acei' || m.category === 'arb');
  const diuretics = clinicalData.medications.filter(m => m.category === 'diuretic');
  const nsaids = clinicalData.medications.filter(m => m.category === 'nsaid');
  
  if (aceiArb.length > 0 && diuretics.length > 0 && nsaids.length > 0) {
    findings.push({
      severity: 'HIGH',
      type: 'NEPHROTOXICITY_CLUSTER',
      problem: 'Triple whammy (ACEi/ARB + diuretic + NSAID)',
      correction: 'Stop NSAID - high risk of AKI',
      citations: await getEvidenceForTripleWhammy(env)
    });
  }
  
  return findings;
}

/**
 * Detect QT prolongation cluster (QTc + QT-prolonging drugs)
 */
async function detectQTCluster(clinicalData, env) {
  const findings = [];
  
  const qtDrugs = clinicalData.medications.filter(m => m.qt_prolonging === true && m.status === 'FOUND');
  
  if (qtDrugs.length === 0) return findings;
  
  // Count QT-prolonging drugs
  if (qtDrugs.length >= 2) {
    findings.push({
      severity: 'HIGH',
      type: 'QT_CLUSTER',
      problem: 'Multiple QT-prolonging drugs',
      correction: `QT risk: ${qtDrugs.map(m => m.name).join(', ')} - obtain ECG, check electrolytes`,
      citations: await getEvidenceForQT(env)
    });
  }
  
  // Check for electrolyte abnormalities
  if (clinicalData.labs.k) {
    const kValue = parseFloat(clinicalData.labs.k);
    if (!isNaN(kValue) && kValue < 3.5) {
      findings.push({
        severity: 'HIGH',
        type: 'QT_CLUSTER',
        problem: 'Hypokalemia with QT-prolonging drugs',
        correction: `K+ ${kValue} < 3.5 - replete potassium, obtain ECG`,
        citations: await getEvidenceForQT(env)
      });
    }
  }
  
  if (clinicalData.labs.albumin) {
    // Check for hypomagnesemia inferred from low albumin/high risk
    // This would need actual magnesium lab in production
  }
  
  return findings;
}

/**
 * Detect triple therapy risk (warfarin + enoxaparin + aspirin, etc.)
 */
async function detectTripleTherapyRisk(clinicalData, env) {
  const findings = [];
  
  const warfarin = clinicalData.medications.some(m => m.name.includes('warfarin'));
  const enoxaparin = clinicalData.medications.some(m => m.name.includes('enoxaparin'));
  const aspirin = clinicalData.medications.some(m => m.name.includes('aspirin'));
  const clopidogrel = clinicalData.medications.some(m => m.name.includes('clopidogrel'));
  
  if (warfarin && enoxaparin) {
    findings.push({
      severity: 'HIGH',
      type: 'TRIPLE_THERAPY',
      problem: 'Concurrent warfarin and enoxaparin',
      correction: 'Indication? If bridging, ensure clear plan and monitor closely',
      citations: await getEvidenceForBridging(env)
    });
  }
  
  if (warfarin && aspirin) {
    findings.push({
      severity: 'MODERATE',
      type: 'TRIPLE_THERAPY',
      problem: 'Warfarin with aspirin',
      correction: 'Increased bleeding risk - reassess need for dual therapy',
      citations: await getEvidenceForBleedingRisk(env)
    });
  }
  
  return findings;
}

/**
 * Detect lab-based contraindications
 */
async function detectLabContraindications(clinicalData, env) {
  const findings = [];
  
  for (const med of clinicalData.medications) {
    if (med.status !== 'FOUND' || !med.properties) continue;
    
    // Check renal cutoffs
    if (med.properties.renal_cutoff && clinicalData.patient.crcl) {
      const crclValue = parseFloat(clinicalData.patient.crcl);
      if (!isNaN(crclValue) && crclValue < med.properties.renal_cutoff) {
        findings.push({
          severity: 'HIGH',
          type: 'RENAL_CONTRAINDICATION',
          problem: `${med.name} contraindicated by renal function`,
          correction: `CrCl ${crclValue} < ${med.properties.renal_cutoff} - hold/avoid`,
          citations: await getEvidenceForDrug(med.name, env)
        });
      }
    }
    
    // Check platelet cutoffs
    if (med.properties.platelet_cutoff && clinicalData.labs.plt) {
      const pltValue = parseFloat(clinicalData.labs.plt);
      if (!isNaN(pltValue) && pltValue < med.properties.platelet_cutoff) {
        findings.push({
          severity: 'HIGH',
          type: 'PLATELET_CONTRAINDICATION',
          problem: `${med.name} contraindicated by thrombocytopenia`,
          correction: `Platelets ${pltValue} < ${med.properties.platelet_cutoff} - hold`,
          citations: await getEvidenceForDrug(med.name, env)
        });
      }
    }
    
    // Check INR cutoffs
    if (med.properties.inr_cutoff && clinicalData.labs.inr) {
      const inrValue = parseFloat(clinicalData.labs.inr);
      if (!isNaN(inrValue) && inrValue > med.properties.inr_cutoff) {
        findings.push({
          severity: 'HIGH',
          type: 'INR_CONTRAINDICATION',
          problem: `${med.name} contraindicated by INR`,
          correction: `INR ${inrValue} > ${med.properties.inr_cutoff} - hold`,
          citations: await getEvidenceForDrug(med.name, env)
        });
      }
    }
    
    // Check potassium cutoffs
    if (med.properties.k_cutoff && clinicalData.labs.k) {
      const kValue = parseFloat(clinicalData.labs.k);
      if (!isNaN(kValue) && kValue > med.properties.k_cutoff) {
        findings.push({
          severity: 'HIGH',
          type: 'POTASSIUM_CONTRAINDICATION',
          problem: `${med.name} contraindicated by hyperkalemia`,
          correction: `K+ ${kValue} > ${med.properties.k_cutoff} - hold/correct K+`,
          citations: await getEvidenceForDrug(med.name, env)
        });
      }
    }
  }
  
  return findings;
}

/**
 * Detect condition-based contraindications
 */
async function detectConditionContraindications(clinicalData, env) {
  const findings = [];
  
  // Sepsis + beta-blockers
  if (clinicalData.conditions.includes('sepsis')) {
    const betaBlockers = clinicalData.medications.filter(m => 
      m.name.includes('metoprolol') || 
      m.name.includes('carvedilol') || 
      m.name.includes('bisoprolol')
    );
    
    if (betaBlockers.length > 0 && clinicalData.vitals.sbp && parseInt(clinicalData.vitals.sbp) < 90) {
      findings.push({
        severity: 'CRITICAL',
        type: 'SEPSIS_CONTRAINDICATION',
        problem: 'Septic shock with beta-blocker',
        correction: 'Hold beta-blockers in shock - risk of worsening hypotension',
        citations: await getEvidenceForSepsis(env)
      });
    }
  }
  
  // DKA + SGLT2 inhibitors
  if (clinicalData.conditions.includes('dka')) {
    const sglt2 = clinicalData.medications.filter(m => 
      m.name.includes('empagliflozin') || 
      m.name.includes('dapagliflozin') || 
      m.name.includes('canagliflozin')
    );
    
    if (sglt2.length > 0) {
      findings.push({
        severity: 'CRITICAL',
        type: 'DKA_CONTRAINDICATION',
        problem: 'DKA with SGLT2 inhibitor use',
        correction: 'Hold SGLT2 inhibitors - may prolong euglycemic DKA',
        citations: await getEvidenceForSGLT2(env)
      });
    }
  }
  
  return findings;
}

/**
 * Detect missing therapies for diagnoses
 */
async function detectMissingTherapies(clinicalData, env) {
  const findings = [];
  
  for (const diagnosis of clinicalData.diagnoses) {
    if (!diagnosis.required_therapies || diagnosis.required_therapies.length === 0) continue;
    
    for (const required of diagnosis.required_therapies) {
      const hasTherapy = clinicalData.medications.some(m => 
        m.name.includes(required) || 
        (required === 'ace inhibitor' && m.category === 'acei') ||
        (required === 'arb' && m.category === 'arb') ||
        (required === 'statin' && m.name.includes('statin')) ||
        (required === 'beta blocker' && m.name.includes('blocker'))
      );
      
      if (!hasTherapy) {
        findings.push({
          severity: 'HIGH',
          type: 'MISSING_THERAPY',
          problem: `Missing guideline-recommended therapy for ${diagnosis.name}`,
          correction: `Consider adding ${required} per protocol`,
          citations: await getEvidenceForDiagnosis(diagnosis.name, env)
        });
      }
    }
  }
  
  // Heart failure with missing GDMT
  if (clinicalData.diagnoses.some(d => d.name === 'heart_failure')) {
    const hasAceiArb = clinicalData.medications.some(m => m.category === 'acei' || m.category === 'arb');
    const hasBetaBlocker = clinicalData.medications.some(m => m.name.includes('carvedilol') || m.name.includes('metoprolol') || m.name.includes('bisoprolol'));
    const hasMra = clinicalData.medications.some(m => m.category === 'mra');
    
    if (!hasAceiArb) {
      findings.push({
        severity: 'HIGH',
        type: 'MISSING_THERAPY',
        problem: 'HFrEF missing ACEi/ARB',
        correction: 'Add ACEi/ARB if no contraindication',
        citations: await getEvidenceForHeartFailure(env)
      });
    }
    
    if (!hasBetaBlocker) {
      findings.push({
        severity: 'HIGH',
        type: 'MISSING_THERAPY',
        problem: 'HFrEF missing evidence-based beta-blocker',
        correction: 'Add carvedilol, metoprolol succinate, or bisoprolol',
        citations: await getEvidenceForHeartFailure(env)
      });
    }
  }
  
  // ACS with missing antiplatelet
  if (clinicalData.diagnoses.some(d => d.name === 'cad' || d.name === 'mi')) {
    const hasAspirin = clinicalData.medications.some(m => m.name.includes('aspirin'));
    const hasP2y12 = clinicalData.medications.some(m => m.class === 'p2y12');
    
    if (!hasAspirin) {
      findings.push({
        severity: 'CRITICAL',
        type: 'MISSING_THERAPY',
        problem: 'ACS without aspirin',
        correction: 'Start aspirin 81-325mg immediately if no contraindication',
        citations: await getEvidenceForACS(env)
      });
    }
    
    if (!hasP2y12) {
      findings.push({
        severity: 'HIGH',
        type: 'MISSING_THERAPY',
        problem: 'ACS without P2Y12 inhibitor',
        correction: 'Add clopidogrel/ticagrelor for dual antiplatelet therapy',
        citations: await getEvidenceForACS(env)
      });
    }
  }
  
  return findings;
}

/**
 * Determine overall safety status based on findings
 */
function determineOverallSafetyStatus(findings) {
  if (findings.some(f => f.severity === 'CRITICAL')) {
    return {
      status: 'CRITICAL',
      color: 'CRITICAL',
      summary: 'Life-threatening issues identified requiring immediate intervention'
    };
  }
  
  if (findings.some(f => f.severity === 'HIGH')) {
    return {
      status: 'HIGH RISK',
      color: 'HIGH',
      summary: 'Significant safety concerns identified - address promptly'
    };
  }
  
  if (findings.some(f => f.severity === 'MODERATE')) {
    return {
      status: 'MODERATE RISK',
      color: 'MODERATE',
      summary: 'Moderate risk factors present - monitor and consider interventions'
    };
  }
  
  if (findings.length > 0) {
    return {
      status: 'LOW RISK',
      color: 'LOW',
      summary: 'Minor issues identified - routine monitoring recommended'
    };
  }
  
  return {
    status: 'SAFE',
    color: 'SAFE',
    summary: 'No protocol-based safety concerns identified'
  };
}

/**
 * Format enhanced SOAP note with system-level findings
 */
function formatEnhancedSOAPNote(clinicalData, findings, safetyStatus) {
  const patient = clinicalData.patient;
  const vitals = clinicalData.vitals;
  const labs = clinicalData.labs;
  
  let soapNote = `S: Patient — (MRN: ${patient.mrn || '___'}), ${patient.age || '___'}Y, ${patient.weight || '___'}kg admitted to ICU.\n`;
  soapNote += `Reason for Admission: ${extractReasonForAdmission(clinicalData.rawText || '') || '___'}\n`;
  soapNote += `PMH: ${extractPMH(clinicalData.rawText || '') || '___'}\n`;
  soapNote += `Home Meds: ${extractHomeMeds(clinicalData.rawText || '') || '___'}\n\n`;
  
  soapNote += `O: Baseline Vitals: SBP ${vitals.sbp || '___'}, DBP ${vitals.dbp || '___'}, HR ${vitals.hr || '___'}, Temp ${vitals.temp || '___'}, SpO2 ${vitals.spo2 || '___'}\n`;
  soapNote += `Baseline Labs: WBC ${labs.wbc || '___'}, Hb ${labs.hgb || '___'}, PLT ${labs.plt || '___'}, Na ${labs.na || '___'}, K ${labs.k || '___'}, INR ${labs.inr || '___'}, ALT ${labs.alt || '___'}, AST ${labs.ast || '___'}\n`;
  soapNote += `Renal: SCr ${labs.cr || '___'}, Calculated CrCl ${patient.crcl || '___'}\n\n`;
  
  soapNote += `A: Clinical pharmacist evaluation completed.\n`;
  soapNote += `Overall Safety Status: ${safetyStatus.status}\n`;
  soapNote += `Safety Summary: ${safetyStatus.summary}\n\n`;
  
  soapNote += `P: Current Medications:\n`;
  soapNote += `—\n`;
  
  for (const med of clinicalData.medications) {
    if (med.status === 'FOUND') {
      soapNote += `• ${med.name} (${med.category}): ${med.evidence ? 'Protocol information available' : ''}\n`;
    } else {
      soapNote += `• ${med.name}: NOT_FOUND in protocol database\n`;
    }
  }
  
  soapNote += `\nPharmacist Intervention:\n`;
  soapNote += `—\n`;
  
  if (findings.length > 0) {
    const critical = findings.filter(f => f.severity === 'CRITICAL');
    const high = findings.filter(f => f.severity === 'HIGH');
    const moderate = findings.filter(f => f.severity === 'MODERATE');
    const low = findings.filter(f => f.severity === 'LOW');
    
    if (critical.length > 0) {
      soapNote += `\n🔴 CRITICAL INTERVENTIONS REQUIRED:\n`;
      critical.forEach(f => {
        soapNote += `• ${f.problem}\n  → ${f.correction}\n`;
      });
    }
    
    if (high.length > 0) {
      soapNote += `\n🟠 HIGH PRIORITY INTERVENTIONS:\n`;
      high.forEach(f => {
        soapNote += `• ${f.problem}\n  → ${f.correction}\n`;
      });
    }
    
    if (moderate.length > 0) {
      soapNote += `\n🟡 MODERATE PRIORITY INTERVENTIONS:\n`;
      moderate.forEach(f => {
        soapNote += `• ${f.problem}\n  → ${f.correction}\n`;
      });
    }
    
    if (low.length > 0) {
      soapNote += `\n🔵 LOW PRIORITY INTERVENTIONS:\n`;
      low.forEach(f => {
        soapNote += `• ${f.problem}\n  → ${f.correction}\n`;
      });
    }
  } else {
    soapNote += `\nNo protocol-based interventions identified.\n`;
  }
  
  soapNote += `\nFollow-up Plan:\n`;
  soapNote += `—\n`;
  
  // Add monitoring recommendations
  const monitoringNeeds = new Set();
  findings.forEach(f => {
    if (f.type === 'MONITORING' && f.correction) {
      const monitor = f.correction.replace('Monitor: ', '');
      monitoringNeeds.add(monitor);
    }
  });
  
  if (monitoringNeeds.size > 0) {
    soapNote += `\nProtocol-required monitoring:\n`;
    monitoringNeeds.forEach(m => soapNote += `• Monitor ${m}\n`);
  } else {
    soapNote += `\nStandard monitoring per protocol.\n`;
  }
  
  return soapNote;
}

/**
 * Extract all citations from findings
 */
function extractAllCitations(findings) {
  const citations = [];
  const seen = new Set();
  
  for (const finding of findings) {
    if (finding.citations && Array.isArray(finding.citations)) {
      for (const citation of finding.citations) {
        const key = `${citation.filename}-${citation.excerpt?.substring(0, 100)}`;
        if (!seen.has(key)) {
          seen.add(key);
          citations.push(citation);
        }
      }
    }
  }
  
  return citations;
}

// ========== EVIDENCE RETRIEVAL FUNCTIONS ==========

async function getEvidenceForBleedingRisk(env) {
  return await searchEvidence('bleeding risk anticoagulation antiplatelet management', env);
}

async function getEvidenceForInrRisk(env) {
  return await searchEvidence('supratherapeutic INR warfarin reversal management', env);
}

async function getEvidenceForTripleTherapy(env) {
  return await searchEvidence('triple antithrombotic therapy bleeding risk management', env);
}

async function getEvidenceForHyperkalemia(env) {
  return await searchEvidence('hyperkalemia management RAAS blockade treatment', env);
}

async function getEvidenceForNephrotoxicity(env) {
  return await searchEvidence('AKI nephrotoxic drugs prevention management', env);
}

async function getEvidenceForTripleWhammy(env) {
  return await searchEvidence('triple whammy ACE inhibitor diuretic NSAID AKI', env);
}

async function getEvidenceForQT(env) {
  return await searchEvidence('QT prolongation drugs electrolytes monitoring', env);
}

async function getEvidenceForBridging(env) {
  return await searchEvidence('warfarin bridging enoxaparin protocol', env);
}

async function getEvidenceForSepsis(env) {
  return await searchEvidence('sepsis septic shock beta blocker management', env);
}

async function getEvidenceForSGLT2(env) {
  return await searchEvidence('SGLT2 inhibitor DKA euglycemic ketoacidosis', env);
}

async function getEvidenceForHeartFailure(env) {
  return await searchEvidence('heart failure GDMT ACE inhibitor beta blocker MRA', env);
}

async function getEvidenceForACS(env) {
  return await searchEvidence('acute coronary syndrome DAPT aspirin P2Y12 guideline', env);
}

async function getEvidenceForDiagnosis(diagnosis, env) {
  return await searchEvidence(`${diagnosis} guideline treatment recommendations`, env);
}

async function getEvidenceForDrug(drug, env) {
  return await searchEvidence(`${drug} contraindications warnings precautions`, env);
}

async function searchEvidence(query, env) {
  try {
    const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        query: query,
        max_num_results: 2
      })
    });
    
    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      return (searchData.data || []).map(item => ({
        filename: item.file_id || item.filename || 'Protocol',
        excerpt: extractContent(item).substring(0, 200)
      }));
    }
  } catch (error) {
    console.error('Error searching evidence:', error);
  }
  
  return [{
    filename: 'Protocol',
    excerpt: 'UNSUPPORTED_BY_PROTOCOL - No evidence found in database'
  }];
}
