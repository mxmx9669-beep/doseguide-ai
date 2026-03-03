// File: /functions/api/ask.js
// ENHANCED BACKEND WITH CLINICAL PHARMACIST VALIDATION ENGINE
// ALL EXISTING CONNECTIONS PRESERVED - INTERNAL PROCESSING ONLY

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

    // ========== ENHANCED CLINICAL PHARMACIST VALIDATION ENGINE ==========
    if (body.mode === "case_analysis" && body.case_text) {
      // STEP 1: Parse unstructured case into structured SOAP format
      const soapData = parseCaseToSOAP(body.case_text);
      
      // STEP 2: Calculate CrCl if parameters available
      if (soapData.Renal?.SCr && soapData.Patient?.weight && soapData.Patient?.age) {
        soapData.Renal.CalculatedCrCl = calculateCrCl(
          soapData.Patient.age,
          soapData.Patient.weight,
          soapData.Renal.SCr,
          soapData.Patient.gender || 'unknown'
        );
      } else {
        soapData.Renal.CalculatedCrCl = '___ (insufficient data)';
      }
      
      // STEP 3: Extract all medications from the case
      const medications = extractAllMedications(body.case_text);
      
      // STEP 4: Validate medications against protocol database
      const medicationValidation = await validateMedicationsWithProtocol(medications, env);
      
      // STEP 5: Generate clinical findings based on protocol evidence
      const clinicalFindings = await generateClinicalFindings(soapData, medicationValidation, env);
      
      // STEP 6: Format complete SOAP note with findings
      const soapNote = formatCompleteSOAPNote(soapData, medicationValidation, clinicalFindings);
      
      // STEP 7: Extract missing medications list
      const missingMeds = medicationValidation
        .filter(m => m.status === 'NOT_FOUND')
        .map(m => m.name);
      
      // Return enhanced response with same structure but richer content
      return new Response(JSON.stringify({
        ok: true,
        verdict: "OK",
        answer: soapNote,
        clinical_findings: clinicalFindings,
        missing_medications: missingMeds,
        citations: clinicalFindings.flatMap(f => f.citations || []),
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

// ========== ENHANCED CLINICAL PARSING FUNCTIONS ==========

/**
 * Parse unstructured clinical text into structured SOAP data
 */
function parseCaseToSOAP(caseText) {
  const soapData = {
    Patient: {
      MRN: extractMRN(caseText),
      age: extractAge(caseText),
      weight: extractWeight(caseText),
      gender: extractGender(caseText)
    },
    ReasonForAdmission: extractReasonForAdmission(caseText),
    PMH: extractPMH(caseText),
    HomeMeds: extractHomeMeds(caseText),
    Vitals: extractVitals(caseText),
    Labs: extractLabs(caseText),
    Renal: extractRenal(caseText),
    Diabetes: extractDiabetes(caseText),
    Lipid: extractLipid(caseText),
    Coagulation: extractCoagulation(caseText)
  };
  
  return soapData;
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
 * Extract vitals
 */
function extractVitals(text) {
  const vitals = {
    SBP: '___',
    DBP: '___',
    HR: '___',
    Temp: '___',
    SpO2: '___'
  };
  
  const sbpMatch = text.match(/SBP[:\s]*(\d+)/i) || text.match(/systolic[:\s]*(\d+)/i);
  if (sbpMatch) vitals.SBP = sbpMatch[1];
  
  const dbpMatch = text.match(/DBP[:\s]*(\d+)/i) || text.match(/diastolic[:\s]*(\d+)/i);
  if (dbpMatch) vitals.DBP = dbpMatch[1];
  
  const hrMatch = text.match(/HR[:\s]*(\d+)/i) || text.match(/heart rate[:\s]*(\d+)/i) || text.match(/pulse[:\s]*(\d+)/i);
  if (hrMatch) vitals.HR = hrMatch[1];
  
  const tempMatch = text.match(/Temp[:\s]*(\d+(?:\.\d+)?)/i) || text.match(/temperature[:\s]*(\d+(?:\.\d+)?)/i);
  if (tempMatch) vitals.Temp = tempMatch[1];
  
  const spo2Match = text.match(/SpO2[:\s]*(\d+)/i) || text.match(/O2 sat[:\s]*(\d+)/i) || text.match(/oxygen saturation[:\s]*(\d+)/i);
  if (spo2Match) vitals.SpO2 = spo2Match[1];
  
  return vitals;
}

/**
 * Extract labs
 */
function extractLabs(text) {
  const labs = {
    WBC: '___',
    Hb: '___',
    PLT: '___',
    Na: '___',
    K: '___',
    INR: '___',
    ALT: '___',
    AST: '___'
  };
  
  const wbcMatch = text.match(/WBC[:\s]*(\d+(?:\.\d+)?)/i) || text.match(/white blood[:\s]*(\d+(?:\.\d+)?)/i);
  if (wbcMatch) labs.WBC = wbcMatch[1];
  
  const hbMatch = text.match(/Hb[:\s]*(\d+(?:\.\d+)?)/i) || text.match(/hemoglobin[:\s]*(\d+(?:\.\d+)?)/i);
  if (hbMatch) labs.Hb = hbMatch[1];
  
  const pltMatch = text.match(/PLT[:\s]*(\d+)/i) || text.match(/platelet[:\s]*(\d+)/i);
  if (pltMatch) labs.PLT = pltMatch[1];
  
  const naMatch = text.match(/Na[:\s]*(\d+)/i) || text.match(/sodium[:\s]*(\d+)/i);
  if (naMatch) labs.Na = naMatch[1];
  
  const kMatch = text.match(/K[:\s]*(\d+(?:\.\d+)?)/i) || text.match(/potassium[:\s]*(\d+(?:\.\d+)?)/i);
  if (kMatch) labs.K = kMatch[1];
  
  const inrMatch = text.match(/INR[:\s]*(\d+(?:\.\d+)?)/i);
  if (inrMatch) labs.INR = inrMatch[1];
  
  const altMatch = text.match(/ALT[:\s]*(\d+)/i) || text.match(/alanine[:\s]*(\d+)/i);
  if (altMatch) labs.ALT = altMatch[1];
  
  const astMatch = text.match(/AST[:\s]*(\d+)/i) || text.match(/aspartate[:\s]*(\d+)/i);
  if (astMatch) labs.AST = astMatch[1];
  
  return labs;
}

/**
 * Extract renal function data
 */
function extractRenal(text) {
  const renal = {
    SCr: '___',
    CalculatedCrCl: '___'
  };
  
  const scrMatch = text.match(/SCr[:\s]*(\d+(?:\.\d+)?)/i) || 
                   text.match(/creatinine[:\s]*(\d+(?:\.\d+)?)/i) ||
                   text.match(/Cr[:\s]*(\d+(?:\.\d+)?)/i);
  if (scrMatch) renal.SCr = scrMatch[1];
  
  return renal;
}

/**
 * Extract diabetes profile
 */
function extractDiabetes(text) {
  const diabetes = {
    RBG: '___',
    FBG: '___',
    HbA1c: '___'
  };
  
  const rbgMatch = text.match(/RBG[:\s]*(\d+)/i) || text.match(/random blood glucose[:\s]*(\d+)/i);
  if (rbgMatch) diabetes.RBG = rbgMatch[1];
  
  const fbgMatch = text.match(/FBG[:\s]*(\d+)/i) || text.match(/fasting blood glucose[:\s]*(\d+)/i);
  if (fbgMatch) diabetes.FBG = fbgMatch[1];
  
  const hba1cMatch = text.match(/HbA1c[:\s]*(\d+(?:\.\d+)?)/i) || text.match(/A1c[:\s]*(\d+(?:\.\d+)?)/i);
  if (hba1cMatch) diabetes.HbA1c = hba1cMatch[1];
  
  return diabetes;
}

/**
 * Extract lipid profile
 */
function extractLipid(text) {
  const lipid = {
    LDL: '___'
  };
  
  const ldlMatch = text.match(/LDL[:\s]*(\d+)/i) || text.match(/low-density[:\s]*(\d+)/i);
  if (ldlMatch) lipid.LDL = ldlMatch[1];
  
  return lipid;
}

/**
 * Extract coagulation profile
 */
function extractCoagulation(text) {
  const coag = {
    PT: '___',
    aPTT: '___'
  };
  
  const ptMatch = text.match(/PT[:\s]*(\d+(?:\.\d+)?)/i) || text.match(/prothrombin[:\s]*(\d+(?:\.\d+)?)/i);
  if (ptMatch) coag.PT = ptMatch[1];
  
  const apttMatch = text.match(/aPTT[:\s]*(\d+(?:\.\d+)?)/i) || text.match(/partial thromboplastin[:\s]*(\d+(?:\.\d+)?)/i);
  if (apttMatch) coag.aPTT = apttMatch[1];
  
  return coag;
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
 * Extract all medications from text comprehensively
 */
function extractAllMedications(text) {
  const medications = new Set();
  
  // Comprehensive medication list by category
  const medicationPatterns = [
    // Anticoagulants
    /\b(warfarin|coumadin|heparin|enoxaparin|lovenox|apixaban|eliquis|rivaroxaban|xarelto|dabigatran|pradaxa|edoxaban|savaysa|fondaparinux|arixtra)\b/gi,
    
    // Antiplatelets
    /\b(aspirin|asa|clopidogrel|plavix|ticagrelor|brilinta|prasugrel|effient|dipyridamole|aggrenox|ticlopidine)\b/gi,
    
    // Diabetes medications
    /\b(insulin|metformin|glucophage|glipizide|glyburide|glimepiride|amaryl|sitagliptin|januvia|saxagliptin|onglyza|linagliptin|tradjenta|empagliflozin|jardiance|dapagliflozin|farxiga|canagliflozin|invokana|pioglitazone|actos|rosiglitazone|avandia|repaglinide|prandin|nateglinide|starlix|exenatide|byetta|liraglutide|victoza|dulaglutide|trulicity|semaglutide|ozempic)\b/gi,
    
    // Antihypertensives
    /\b(amlodipine|norvasc|nifedipine|procardia|felodipine|plendil|lisinopril|zestril|prinivil|enalapril|vasotec|ramipril|altace|quinapril|accupril|perindopril|aceon|trandolapril|mavik|losartan|cozaar|valsartan|diovan|irbesartan|avapro|candesartan|atacand|telmisartan|micardis|olmesartan|benicar|metoprolol|lopressor|toprol|atenolol|tenormin|propranolol|inderal|carvedilol|coreg|bisoprolol|nebivolol|bystolic|hydrochlorothiazide|hctz|furosemide|lasix|bumetanide|torsemide|demadex|spironolactone|aldactone|eplerenone|inspra)\b/gi,
    
    // Statins/Lipid agents
    /\b(atorvastatin|lipitor|rosuvastatin|crestor|simvastatin|zocor|pravastatin|pravachol|fluvastatin|lescol|pitavastatin|livalo|ezetimibe|zetia|fenofibrate|tricor|gemfibrozil|lopid)\b/gi,
    
    // Thyroid medications
    /\b(levothyroxine|synthroid|levoxyl|unithroid|liothyronine|cytomel|methimazole|tapazole|propylthiouracil|ptu)\b/gi,
    
    // Antibiotics
    /\b(amoxicillin|augmentin|ampicillin|penicillin|cephalexin|keflex|cefazolin|ceftriaxone|cefepime|ciprofloxacin|cipro|levofloxacin|levaquin|moxifloxacin|azithromycin|zithromax|clarithromycin|biaxin|doxycycline|vibramycin|minocycline|sulfamethoxazole|bactrim|tmp-smx|vancomycin|metronidazole|flagyl|clindamycin|gentamicin|tobramycin)\b/gi,
    
    // Antifungals
    /\b(fluconazole|diflucan|voriconazole|vfend|posaconazole|noxafil|isavuconazole|cresemba|amphotericin|fungizone|caspofungin|cancidas|micafungin|mycamine)\b/gi,
    
    // Antivirals
    /\b(acyclovir|zovirax|valacyclovir|valtrex|famciclovir|oseltamivir|tamiflu|remdesivir|nirmatrelvir|ritonavir|paxlovid)\b/gi,
    
    // Immunosuppressants
    /\b(tacrolimus|prograf|cyclosporine|neoral|sandimmune|mycophenolate|cellcept|azathioprine|imuran|methotrexate|prednisone|methylprednisolone|hydrocortisone|dexamethasone)\b/gi,
    
    // Pain medications
    /\b(morphine|ms contin|hydromorphone|dilaudid|fentanyl|duragesic|oxycodone|percocet|oxymorphone|opana|codeine|tramadol|ultram|hydrocodone|norco|vicodin|methadone|buprenorphine|suboxone|acetaminophen|tylenol|ibuprofen|motrin|advil|naproxen|aleve|meloxicam|mobic|celecoxib|celebrex)\b/gi,
    
    // Psychiatric medications
    /\b(escitalopram|lexapro|sertraline|zoloft|fluoxetine|prozac|citalopram|celexa|paroxetine|paxil|venlafaxine|effexor|duloxetine|cymbalta|bupropion|wellbutrin|mirtazapine|remeron|trazodone|olanzapine|zyprexa|quetiapine|seroquel|risperidone|risperdal|aripiprazole|abilify|haloperidol|haldol|lorazepam|ativan|alprazolam|xanax|clonazepam|klonopin|diazepam|valium)\b/gi,
    
    // GI medications
    /\b(omeprazole|prilosec|pantoprazole|protonix|esomeprazole|nexium|lansoprazole|prevacid|rabeprazole|aciphex|famotidine|pepcid|ranitidine|zantac|cimetidine|tagamet|metoclopramide|reglan|ondansetron|zofran|promethazine|phenergan)\b/gi,
    
    // Respiratory medications
    /\b(albuterol|ventolin|proair|levalbuterol|xopenex|ipratropium|atrovent|tiotropium|spiriva|umeclidinium|incruse|fluticasone|flovent|budesonide|pulmicort|mometasone|asmanex|beclomethasone|qvar|salmeterol|serevent|formoterol|foradil|montelukast|singulair)\b/gi
  ];
  
  for (const pattern of medicationPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(m => medications.add(m.toLowerCase()));
    }
  }
  
  return Array.from(medications);
}

/**
 * Validate medications against protocol database with comprehensive search
 */
async function validateMedicationsWithProtocol(medications, env) {
  if (!medications || medications.length === 0) {
    return [];
  }
  
  const validated = [];
  
  for (const med of medications) {
    try {
      // Search vector store for this medication with comprehensive queries
      const queries = [
        med,
        `${med} dosing`,
        `${med} renal adjustment`,
        `${med} contraindications`,
        `${med} monitoring`,
        `${med} drug interactions`
      ];
      
      let allEvidence = [];
      
      for (const query of queries.slice(0, 3)) { // Limit to 3 queries per med
        const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          },
          body: JSON.stringify({
            query: query,
            max_num_results: 5
          })
        });
        
        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          if (searchData.data && searchData.data.length > 0) {
            allEvidence = allEvidence.concat(searchData.data);
          }
        }
      }
      
      // Deduplicate evidence by content
      const uniqueEvidence = [];
      const seenContent = new Set();
      
      for (const item of allEvidence) {
        let content = '';
        if (item.content) {
          if (Array.isArray(item.content)) {
            content = item.content.map(c => c.text || c.value || '').join('\n');
          } else if (typeof item.content === 'string') {
            content = item.content;
          } else if (item.content.text) {
            content = item.content.text;
          }
        }
        
        const contentHash = content.substring(0, 200);
        if (!seenContent.has(contentHash) && content.trim().length > 50) {
          seenContent.add(contentHash);
          uniqueEvidence.push({
            content: content.substring(0, 500),
            filename: item.file_id || item.filename || 'Protocol document'
          });
        }
      }
      
      if (uniqueEvidence.length > 0) {
        validated.push({
          name: med,
          status: 'FOUND',
          evidence: uniqueEvidence.slice(0, 3), // Keep top 3 most relevant
          protocol_info: uniqueEvidence[0]?.content || 'Protocol information available'
        });
      } else {
        validated.push({
          name: med,
          status: 'NOT_FOUND',
          protocol_info: 'NOT_FOUND in protocol database'
        });
      }
    } catch (error) {
      validated.push({
        name: med,
        status: 'ERROR',
        protocol_info: 'Validation error'
      });
    }
  }
  
  return validated;
}

/**
 * Generate clinical findings based on protocol evidence
 */
async function generateClinicalFindings(soapData, medicationValidation, env) {
  const findings = [];
  
  // Check each found medication for dosing issues, contraindications, etc.
  for (const med of medicationValidation) {
    if (med.status !== 'FOUND' || !med.evidence) continue;
    
    const medFindings = [];
    
    // Check renal dosing if CrCl available
    if (soapData.Renal.CalculatedCrCl && soapData.Renal.CalculatedCrCl !== '___' && 
        !soapData.Renal.CalculatedCrCl.includes('Unable')) {
      
      const crclValue = parseFloat(soapData.Renal.CalculatedCrCl);
      if (!isNaN(crclValue)) {
        // Search for renal dosing information
        for (const evidence of med.evidence) {
          const content = evidence.content.toLowerCase();
          
          if (content.includes('renal') || content.includes('crcl') || content.includes('creatinine clearance')) {
            // Check for cutoffs
            const cutoffMatches = content.match(/(?:crcl|creatinine clearance|renal function).{0,20}(?:<|less than|below)\s*(\d+)/gi);
            
            if (cutoffMatches) {
              for (const match of cutoffMatches) {
                const cutoff = parseInt(match.match(/\d+/)?.[0]);
                if (cutoff && crclValue < cutoff) {
                  medFindings.push({
                    severity: 'HIGH',
                    type: 'DOSE_ERROR',
                    problem: `${med.name} may require renal dose adjustment`,
                    correction: `CrCl ${crclValue} mL/min is below renal dosing threshold`,
                    citations: [{
                      filename: evidence.filename,
                      excerpt: evidence.content.substring(0, 200)
                    }]
                  });
                }
              }
            }
          }
        }
      }
    }
    
    // Check for lab-based contraindications
    if (soapData.Labs) {
      for (const evidence of med.evidence) {
        const content = evidence.content.toLowerCase();
        
        // Check INR
        if (content.includes('inr') && soapData.Labs.INR !== '___') {
          const inrValue = parseFloat(soapData.Labs.INR);
          if (!isNaN(inrValue)) {
            const inrCutoff = content.match(/inr.{0,10}(?:>|greater than|above)\s*(\d+(?:\.\d+)?)/i);
            if (inrCutoff && inrValue > parseFloat(inrCutoff[1])) {
              medFindings.push({
                severity: 'HIGH',
                type: 'LAB_CUTOFF',
                problem: `${med.name} contraindicated with INR ${inrValue}`,
                correction: `INR exceeds cutoff of ${inrCutoff[1]}`,
                citations: [{
                  filename: evidence.filename,
                  excerpt: evidence.content.substring(0, 200)
                }]
              });
            }
          }
        }
        
        // Check platelets
        if (content.includes('platelet') && soapData.Labs.PLT !== '___') {
          const pltValue = parseFloat(soapData.Labs.PLT);
          if (!isNaN(pltValue)) {
            const pltCutoff = content.match(/platelet.{0,10}(?:<|less than|below)\s*(\d+)/i);
            if (pltCutoff && pltValue < parseFloat(pltCutoff[1])) {
              medFindings.push({
                severity: 'HIGH',
                type: 'LAB_CUTOFF',
                problem: `${med.name} risk with platelets ${pltValue}`,
                correction: `Hold if platelets < ${pltCutoff[1]}`,
                citations: [{
                  filename: evidence.filename,
                  excerpt: evidence.content.substring(0, 200)
                }]
              });
            }
          }
        }
        
        // Check potassium
        if (content.includes('potassium') && soapData.Labs.K !== '___') {
          const kValue = parseFloat(soapData.Labs.K);
          if (!isNaN(kValue)) {
            if (content.includes('hyperkalemia') && kValue > 5.2) {
              medFindings.push({
                severity: 'MED',
                type: 'LAB_CUTOFF',
                problem: `${med.name} may increase potassium risk`,
                correction: `Current K+ ${kValue} - monitor closely`,
                citations: [{
                  filename: evidence.filename,
                  excerpt: evidence.content.substring(0, 200)
                }]
              });
            }
          }
        }
      }
    }
    
    // Check for monitoring requirements
    for (const evidence of med.evidence) {
      const content = evidence.content.toLowerCase();
      
      if (content.includes('monitor') || content.includes('monitoring')) {
        const monitoring = [];
        
        if (content.includes('inr')) monitoring.push('INR');
        if (content.includes('platelet') || content.includes('plt')) monitoring.push('platelets');
        if (content.includes('aPTT') || content.includes('ptt')) monitoring.push('aPTT');
        if (content.includes('ecg') || content.includes('qtc') || content.includes('qt interval')) monitoring.push('ECG/QTc');
        if (content.includes('creatinine') || content.includes('renal')) monitoring.push('renal function');
        if (content.includes('potassium') || content.includes('k+')) monitoring.push('potassium');
        if (content.includes('liver') || content.includes('alt') || content.includes('ast')) monitoring.push('LFTs');
        
        if (monitoring.length > 0) {
          medFindings.push({
            severity: 'MED',
            type: 'MONITORING',
            problem: `${med.name} requires monitoring`,
            correction: `Monitor: ${monitoring.join(', ')}`,
            citations: [{
              filename: evidence.filename,
              excerpt: evidence.content.substring(0, 200)
            }]
          });
        }
      }
    }
    
    // Add unique findings for this medication
    const uniqueFindings = medFindings.filter((f, index, self) => 
      index === self.findIndex(t => t.problem === f.problem)
    );
    
    findings.push(...uniqueFindings);
  }
  
  return findings;
}

/**
 * Format complete SOAP note with all findings
 */
function formatCompleteSOAPNote(soapData, medicationValidation, clinicalFindings) {
  const patient = soapData.Patient;
  const vitals = soapData.Vitals;
  const labs = soapData.Labs;
  const renal = soapData.Renal;
  const diabetes = soapData.Diabetes;
  const lipid = soapData.Lipid;
  const coag = soapData.Coagulation;
  
  let soapNote = `S: Patient — (MRN: ${patient.MRN || '___'}), ${patient.age || '___'}Y, ${patient.weight || '___'}kg admitted to ICU.\n`;
  soapNote += `Reason for Admission: ${soapData.ReasonForAdmission || '___'}\n`;
  soapNote += `PMH: ${soapData.PMH || '___'}\n`;
  soapNote += `Home Meds: ${soapData.HomeMeds || '___'}\n\n`;
  
  soapNote += `O: Baseline Vitals: SBP ${vitals.SBP}, DBP ${vitals.DBP}, HR ${vitals.HR}, Temp ${vitals.Temp}, SpO2 ${vitals.SpO2}\n`;
  soapNote += `Baseline Labs: WBC ${labs.WBC}, Hb ${labs.Hb}, PLT ${labs.PLT}, Na ${labs.Na}, K ${labs.K}, INR ${labs.INR}, ALT ${labs.ALT}, AST ${labs.AST}\n`;
  soapNote += `C Profile: PT ${coag.PT}, aPTT ${coag.aPTT}\n`;
  soapNote += `Lipid Profile: LDL ${lipid.LDL}\n`;
  soapNote += `Diabetes Profile: RBG ${diabetes.RBG}, FBG ${diabetes.FBG}, HbA1c ${diabetes.HbA1c}\n`;
  soapNote += `Renal: SCr ${renal.SCr}, Calculated CrCl ${renal.CalculatedCrCl}\n\n`;
  
  soapNote += `A: Clinical pharmacist evaluation completed.\n\n`;
  
  soapNote += `P: Current Medications:\n`;
  soapNote += `—\n`;
  
  for (const med of medicationValidation) {
    if (med.status === 'FOUND') {
      soapNote += `• ${med.name}: ${med.protocol_info.substring(0, 100)}...\n`;
    } else {
      soapNote += `• ${med.name}: ${med.protocol_info}\n`;
    }
  }
  
  soapNote += `\nPharmacist Intervention:\n`;
  soapNote += `—\n`;
  
  if (clinicalFindings.length > 0) {
    const highSeverity = clinicalFindings.filter(f => f.severity === 'HIGH');
    const medSeverity = clinicalFindings.filter(f => f.severity === 'MED');
    const lowSeverity = clinicalFindings.filter(f => f.severity === 'LOW');
    
    if (highSeverity.length > 0) {
      soapNote += `\nHIGH PRIORITY ISSUES:\n`;
      highSeverity.forEach(f => {
        soapNote += `• ${f.problem} - ${f.correction}\n`;
      });
    }
    
    if (medSeverity.length > 0) {
      soapNote += `\nMEDIUM PRIORITY ISSUES:\n`;
      medSeverity.forEach(f => {
        soapNote += `• ${f.problem} - ${f.correction}\n`;
      });
    }
    
    if (lowSeverity.length > 0) {
      soapNote += `\nLOW PRIORITY ISSUES:\n`;
      lowSeverity.forEach(f => {
        soapNote += `• ${f.problem} - ${f.correction}\n`;
      });
    }
  } else {
    soapNote += `\nNo protocol-based interventions identified.\n`;
  }
  
  soapNote += `\nFollow-up Plan:\n`;
  soapNote += `—\n`;
  
  // Add monitoring recommendations
  const monitoringNeeds = clinicalFindings
    .filter(f => f.type === 'MONITORING')
    .map(f => f.correction.replace('Monitor: ', ''));
  
  if (monitoringNeeds.length > 0) {
    soapNote += `\nMonitoring required: ${[...new Set(monitoringNeeds)].join(', ')}\n`;
  } else {
    soapNote += `\nStandard monitoring per protocol.\n`;
  }
  
  return soapNote;
}
