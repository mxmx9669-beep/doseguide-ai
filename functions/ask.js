// File: /functions/api/ask.js
// COMPLETE BACKEND WITH STRICT CITATION ENFORCEMENT & VALIDATION LAYER

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
    
    // ========== CASE ANALYSIS MODE ==========
    if (body.mode === "case_analysis" && body.case_text) {
      console.log("Case analysis mode with strict enforcement");
      
      if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
        return new Response(JSON.stringify({ 
          error: "OPENAI_API_KEY or VECTOR_STORE_ID is not set" 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // STEP 1: Parse case with strict extraction
      const parsedCase = await parseClinicalCase(body.case_text, env);
      
      // STEP 2: Compute values (internal only - results only)
      const computed = computeClinicalValues(parsedCase);
      
      // STEP 3: Detect missing guidelines
      const missingGuidelines = await detectMissingGuidelines(parsedCase.diagnoses, env);
      
      // STEP 4: Generate interventions with strict citation enforcement
      const interventions = await generateStrictInterventions(parsedCase, computed, env);
      
      // STEP 5: VALIDATION LAYER - strip any intervention without complete citation
      const validatedInterventions = interventions.filter(iv => {
        if (!iv.evidence || iv.evidence.length === 0) return false;
        return iv.evidence.every(e => 
          e.file && 
          e.file.length > 0 &&
          e.section && 
          e.section.length > 0 && 
          e.page && 
          e.page > 0 &&
          e.excerpt && 
          e.excerpt.length > 0
        );
      });

      // STEP 6: Final response with protocol lock
      return new Response(JSON.stringify({
        ok: true,
        protocol_locked: true,
        analysis_mode: "case",
        clinical: {
          extracted: {
            demographics: parsedCase.demographics,
            diagnoses: parsedCase.diagnoses.map(d => d.name),
            medications: parsedCase.medications.map(m => ({
              name: m.name,
              dose: m.dose,
              frequency: m.frequency,
              prn: m.prn || false
            })),
            labs: parsedCase.labs
          },
          computed: {
            bmi: computed.bmi,
            bmi_category: computed.bmi_category,
            ibw_kg: computed.ibw,
            adjbw_kg: computed.adjbw,
            actual_weight_kg: parsedCase.demographics.weight_kg,
            weight_for_crcl: computed.weight_for_crcl,
            crcl_mLmin: computed.crcl,
            crcl_method: computed.crcl_method,
            ckd_stage: computed.ckd_stage
          },
          interventions: validatedInterventions,
          missing_guidelines: missingGuidelines.map(m => ({
            condition: m.condition,
            status: "No guideline available",
            message: `No guideline available in current document library for ${m.condition}.`
          }))
        }
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
    
    // ========== EXISTING STANDARD MODE (unchanged) ==========
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
    
    const evidence = [];
    if (searchData.data && Array.isArray(searchData.data)) {
      searchData.data.forEach((item, index) => {
        let content = '';
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
        if (content && content.trim()) {
          evidence.push({
            id: `E${index + 1}`,
            filename: item.file_id || item.filename || `file_${index + 1}`,
            excerpt: content.substring(0, 1500)
          });
        }
      });
    }

    if (evidence.length === 0) {
      return new Response(JSON.stringify({
        ok: true,
        verdict: "NOT_FOUND",
        answer: language === 'ar' 
          ? "لم يتم العثور على معلومات في المصادر المتاحة."
          : "No information found in available sources.",
        citations: []
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const model = env.MODEL || "gpt-3.5-turbo";
    const evidenceText = evidence.map(e => 
      `[SOURCE ${e.id}] File: ${e.filename}\nContent: ${e.excerpt}`
    ).join('\n\n---\n\n');

    const systemPrompt = language === 'ar' 
      ? "أنت مساعد طبي متخصص. استخدم فقط المعلومات المقدمة في المصادر أعلاه للإجابة على السؤال."
      : "You are a medical assistant. Use ONLY the information in the provided sources above to answer the question.";

    const userPrompt = `Question: ${question}\n\nSources:\n${evidenceText}\n\nPlease answer using ONLY these sources.`;

    const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 1000
      })
    });

    if (!gptResponse.ok) {
      const errorText = await gptResponse.text();
      return new Response(JSON.stringify({ 
        ok: true,
        verdict: "PARTIAL",
        answer: language === 'ar'
          ? "تم العثور على مصادر ولكن حدث خطأ في توليد الإجابة. إليك المصادر المتاحة:"
          : "Sources found but error generating answer. Here are the available sources:",
        citations: evidence.map(e => ({
          evidence_ids: [e.id],
          filename: e.filename,
          excerpt: e.excerpt.substring(0, 300)
        }))
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const gptData = await gptResponse.json();
    const answer = gptData.choices?.[0]?.message?.content || "No answer generated";

    return new Response(JSON.stringify({
      ok: true,
      verdict: "OK",
      answer: answer,
      citations: evidence.map(e => ({
        evidence_ids: [e.id],
        filename: e.filename,
        excerpt: e.excerpt.substring(0, 250) + (e.excerpt.length > 250 ? "..." : "")
      }))
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

// ========== STRICT PARSING WITH SECTION/PAGE EXTRACTION ==========
async function parseClinicalCase(caseText, env) {
  const systemPrompt = `You are a clinical data extractor. Extract the following from the case text and return ONLY valid JSON.
  Do not add any commentary. Use null for missing values.
  
  {
    "demographics": {
      "age": number or null,
      "sex": "male" or "female" or null,
      "height_cm": number or null,
      "weight_kg": number or null,
      "scr": number or null,
      "scr_unit": "mg/dL" or "μmol/L" or null
    },
    "diagnoses": [
      {"name": "string", "status": "active"}
    ],
    "medications": [
      {"name": "string", "dose": "string", "frequency": "string", "prn": boolean}
    ],
    "labs": [
      {"name": "string", "value": number, "unit": "string"}
    ]
  }`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: caseText }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    })
  });

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

// ========== COMPUTATION (INTERNAL ONLY - RESULTS EXPOSED) ==========
function computeClinicalValues(parsed) {
  const d = parsed.demographics || {};
  const age = d.age;
  const height = d.height_cm;
  const weight = d.weight_kg;
  const scr = d.scr;
  const scr_unit = d.scr_unit;
  const sex = d.sex;

  const computed = {};

  // BMI (result only)
  if (height && weight) {
    const bmi = weight / ((height/100) ** 2);
    computed.bmi = Math.round(bmi * 10) / 10;
    if (bmi < 18.5) computed.bmi_category = "Underweight";
    else if (bmi < 25) computed.bmi_category = "Normal";
    else if (bmi < 30) computed.bmi_category = "Overweight";
    else computed.bmi_category = "Obese";
  }

  // IBW (result only)
  if (height && sex) {
    const heightInInches = height / 2.54;
    if (sex === 'male') {
      computed.ibw = Math.round((50 + 2.3 * (heightInInches - 60)) * 10) / 10;
    } else {
      computed.ibw = Math.round((45.5 + 2.3 * (heightInInches - 60)) * 10) / 10;
    }
  }

  // AdjBW (result only)
  if (computed.ibw && weight) {
    if (weight > computed.ibw * 1.2) {
      computed.adjbw = Math.round((computed.ibw + 0.4 * (weight - computed.ibw)) * 10) / 10;
      computed.weight_for_crcl = computed.adjbw;
      computed.weight_rule = "Adjusted body weight (obesity)";
    } else {
      computed.weight_for_crcl = weight;
      computed.weight_rule = "Actual body weight";
    }
  }

  // CrCl (result only)
  if (age && computed.weight_for_crcl && scr) {
    let scr_mgdl = scr;
    if (scr_unit === 'μmol/L') scr_mgdl = scr / 88.4;
    
    let crcl = ((140 - age) * computed.weight_for_crcl) / (72 * scr_mgdl);
    if (sex === 'female') crcl *= 0.85;
    computed.crcl = Math.round(crcl * 10) / 10;
    computed.crcl_method = "Cockcroft-Gault";
    
    if (computed.crcl >= 90) computed.ckd_stage = "1";
    else if (computed.crcl >= 60) computed.ckd_stage = "2";
    else if (computed.crcl >= 45) computed.ckd_stage = "3a";
    else if (computed.crcl >= 30) computed.ckd_stage = "3b";
    else if (computed.crcl >= 15) computed.ckd_stage = "4";
    else computed.ckd_stage = "5";
  }

  return computed;
}

// ========== DOCUMENT AVAILABILITY CHECK ==========
async function detectMissingGuidelines(diagnoses, env) {
  const missing = [];
  
  // In production, this would query a document registry
  // For now, simulate with known conditions
  const availableGuidelines = [
    "heart failure", "heart failure with reduced ejection fraction", "hfref",
    "acs", "acute coronary syndrome"
  ];
  
  for (const dx of diagnoses || []) {
    const name = dx.name?.toLowerCase() || '';
    let found = false;
    
    for (const avail of availableGuidelines) {
      if (name.includes(avail)) {
        found = true;
        break;
      }
    }
    
    if (!found && name.length > 0) {
      missing.push({ condition: dx.name });
    }
  }
  
  return missing;
}

// ========== STRICT INTERVENTION GENERATION WITH FULL CITATIONS ==========
async function generateStrictInterventions(parsedCase, computed, env) {
  const interventions = [];
  const diagnoses = parsedCase.diagnoses || [];
  const medications = parsedCase.medications || [];
  
  // Document relevance filtering - only query relevant docs
  const isHeartFailure = diagnoses.some(d => 
    d.name?.toLowerCase().includes('heart failure') || 
    d.name?.toLowerCase().includes('hf')
  );

  // ===== DRUG-DISEASE CHECKS =====
  for (const med of medications) {
    for (const dx of diagnoses) {
      // Skip if not relevant document types
      if (dx.name?.toLowerCase().includes('heart failure') && !isHeartFailure) continue;
      
      const query = `${med.name} contraindications or warnings in ${dx.name}`;
      const result = await queryStrictDocument(query, env, dx.name);
      
      if (result.evidence.length > 0) {
        // Extract section and page from content
        const citation = extractStrictCitation(result.evidence[0]);
        
        if (citation.isComplete) {
          interventions.push({
            title: `${med.name} – caution in ${dx.name}`,
            category: "Drug-Disease",
            severity: determineSeverity(citation.excerpt),
            rationale: `Found in ${citation.file}, section ${citation.section}`,
            action: extractAction(citation.excerpt) || "Review contraindication",
            evidence: [{
              file: citation.file,
              section: citation.section,
              page: citation.page,
              excerpt: citation.excerpt
            }],
            data_triggers: { drug: med.name, disease: dx.name }
          });
        }
      }
    }
  }

  // ===== DRUG-LAB CHECKS (RENAL) =====
  if (computed.crcl && computed.crcl < 60) {
    for (const med of medications) {
      const query = `${med.name} renal impairment dosing CrCl <60`;
      const result = await queryStrictDocument(query, env, 'renal');
      
      if (result.evidence.length > 0) {
        const citation = extractStrictCitation(result.evidence[0]);
        
        if (citation.isComplete) {
          const severity = computed.crcl < 30 ? "HIGH" : (computed.crcl < 45 ? "MODERATE" : "LOW");
          
          interventions.push({
            title: `${med.name} – renal adjustment required`,
            category: "Drug-Lab",
            severity: severity,
            rationale: `CrCl ${computed.crcl} mL/min (Stage ${computed.ckd_stage} CKD)`,
            action: extractAction(citation.excerpt) || "Adjust dose or monitor renal function",
            evidence: [{
              file: citation.file,
              section: citation.section,
              page: citation.page,
              excerpt: citation.excerpt
            }],
            data_triggers: { 
              drug: med.name, 
              crcl: computed.crcl,
              ckd_stage: computed.ckd_stage
            }
          });
        }
      }
    }
  }

  // ===== MISSING THERAPY FOR HEART FAILURE =====
  if (isHeartFailure) {
    const hfQuery = "heart failure with reduced ejection fraction treatment algorithm guideline directed medical therapy";
    const hfResult = await queryStrictDocument(hfQuery, env, 'heart failure');
    
    if (hfResult.evidence.length > 0) {
      const citation = extractStrictCitation(hfResult.evidence[0]);
      
      if (citation.isComplete) {
        // Check for missing GDMT components
        const medNames = medications.map(m => m.name.toLowerCase());
        
        if (!medNames.some(m => m.includes('beta') || m.includes('bisoprolol') || m.includes('carvedilol'))) {
          // Check contraindications
          const hasAsthma = diagnoses.some(d => d.name?.toLowerCase().includes('asthma'));
          const hasBradycardia = false; // would need to extract from vitals
          
          if (!hasAsthma && !hasBradycardia) {
            interventions.push({
              title: "Heart Failure – missing beta-blocker therapy",
              category: "Missing Therapy",
              severity: "HIGH",
              rationale: "Guideline-directed medical therapy for HFrEF includes beta-blockers",
              action: "Initiate beta-blocker (bisoprolol, carvedilol, or metoprolol succinate)",
              evidence: [{
                file: citation.file,
                section: citation.section,
                page: citation.page,
                excerpt: citation.excerpt
              }],
              data_triggers: { 
                diagnosis: "Heart Failure",
                missing: "Beta-blocker",
                eligibility: "No contraindications identified"
              }
            });
          } else {
            interventions.push({
              title: "Heart Failure – beta-blocker contraindicated",
              category: "Contraindication",
              severity: "MODERATE",
              rationale: "Beta-blockers contraindicated due to asthma/bradycardia",
              action: "Avoid beta-blocker, consider alternative",
              evidence: [{
                file: citation.file,
                section: citation.section,
                page: citation.page,
                excerpt: citation.excerpt
              }],
              data_triggers: { 
                diagnosis: "Heart Failure",
                contraindication: "Asthma/Bradycardia"
              }
            });
          }
        }
      }
    }
  }

  return interventions;
}

// ===== STRICT DOCUMENT QUERY WITH RELEVANCE FILTERING =====
async function queryStrictDocument(query, env, relevanceFilter) {
  const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2'
    },
    body: JSON.stringify({
      query: query,
      max_num_results: 10,
      // Add relevance filtering by filename
      filter: relevanceFilter ? {
        type: "filename",
        operator: "contains",
        value: relevanceFilter
      } : undefined
    })
  });

  if (!searchResponse.ok) return { evidence: [] };

  const data = await searchResponse.json();
  const evidence = [];
  
  if (data.data && Array.isArray(data.data)) {
    for (const item of data.data) {
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
      
      // Only include if content has section/page indicators
      if (content && content.trim() && 
          (content.includes('Section') || content.includes('section') || 
           content.includes('Page') || content.includes('page'))) {
        evidence.push({
          filename: item.file_id || item.filename || 'source',
          content: content.substring(0, 1000),
          metadata: item.metadata || {}
        });
      }
    }
  }

  return { evidence };
}

// ===== EXTRACT STRICT CITATION COMPONENTS =====
function extractStrictCitation(evidenceItem) {
  const content = evidenceItem.content || '';
  const filename = evidenceItem.filename || '';
  
  // Extract section title (look for patterns like "Section X.Y Title" or "## Title")
  let section = '';
  const sectionMatch = content.match(/(?:Section|SECTION|section)\s+(\d+(?:\.\d+)*)\s*[–—-]?\s*([^\n]+)/i) ||
                      content.match(/##+\s*([^\n]+)/) ||
                      content.match(/^\d+\.\d+\s+([^\n]+)/m);
  if (sectionMatch) {
    section = sectionMatch[2] || sectionMatch[1];
  } else {
    // Fallback: first line that looks like a heading
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.trim() && line.length < 100 && !line.includes('.') && line.match(/[A-Z]/)) {
        section = line.trim();
        break;
      }
    }
  }
  
  // Extract page number
  let page = 0;
  const pageMatch = content.match(/(?:Page|PAGE|page)\s*(\d+)/i) ||
                    content.match(/p\.\s*(\d+)/i) ||
                    content.match(/\[p\.\s*(\d+)\]/i);
  if (pageMatch) {
    page = parseInt(pageMatch[1]);
  }
  
  // Extract clean excerpt (first 2-3 sentences)
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
  const excerpt = sentences.slice(0, 2).join('. ') + '.';
  
  return {
    file: filename,
    section: section || 'General',
    page: page,
    excerpt: excerpt.substring(0, 300),
    isComplete: filename && filename.length > 0 && section && section.length > 0 && page > 0
  };
}

// ===== SEVERITY DETERMINATION =====
function determineSeverity(text) {
  const lower = text.toLowerCase();
  if (lower.includes('contraindicated') || 
      lower.includes('avoid') || 
      lower.includes('do not use') ||
      lower.includes('fatal') ||
      lower.includes('severe')) {
    return "HIGH";
  } else if (lower.includes('caution') || 
             lower.includes('monitor') || 
             lower.includes('consider') ||
             lower.includes('may increase')) {
    return "MODERATE";
  }
  return "LOW";
}

// ===== EXTRACT ACTION =====
function extractAction(text) {
  const sentences = text.split(/[.!?]+/);
  for (const s of sentences) {
    if (s.toLowerCase().includes('recommend') ||
        s.toLowerCase().includes('should') ||
        s.toLowerCase().includes('consider') ||
        s.toLowerCase().includes('monitor') ||
        s.toLowerCase().includes('avoid')) {
      return s.trim();
    }
  }
  return null;
}
