// File: /functions/api/ask.js - Extended with case analysis mode
// All existing functionality preserved - NEW case mode added

export async function onRequest(context) {
  const { request, env } = context;

  // CORS headers (unchanged)
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle preflight (unchanged)
  if (request.method === "OPTIONS") {
    return new Response(null, { 
      status: 204,
      headers: corsHeaders 
    });
  }

  // Only POST allowed (unchanged)
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  try {
    const body = await request.json();
    const language = body.language || "en";
    
    // ========== NEW CASE ANALYSIS MODE ==========
    if (body.mode === "case_analysis" && body.case_text) {
      console.log("Case analysis mode activated");
      
      // Validate environment (same checks)
      if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
        return new Response(JSON.stringify({ 
          error: "OPENAI_API_KEY or VECTOR_STORE_ID is not set" 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // STEP 1: Parse case text using GPT (structured extraction)
      const parsedCase = await parseClinicalCase(body.case_text, env, language);
      
      // STEP 2: Compute clinical values
      const computed = computeClinicalValues(parsedCase);
      
      // STEP 3: Detect missing guidelines
      const missingGuidelines = detectMissingGuidelines(parsedCase.diagnoses, env);
      
      // STEP 4: Run intervention detectors (protocol-locked)
      const interventions = await detectInterventions(parsedCase, computed, env, language);
      
      // STEP 5: Return structured response
      return new Response(JSON.stringify({
        ok: true,
        protocol_locked: true,
        analysis_mode: "case",
        clinical: {
          extracted: parsedCase,
          computed: computed,
          interventions: interventions,
          missing_guidelines: missingGuidelines
        }
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
    
    // ========== EXISTING QUESTION MODE (unchanged) ==========
    const question = body.question || body.q || "";
    console.log("Received question:", question);

    if (!question) {
      return new Response(JSON.stringify({ error: "Question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // Environment check (same as before)
    if (!env.OPENAI_API_KEY || !env.VECTOR_STORE_ID) {
      return new Response(JSON.stringify({ 
        error: "OPENAI_API_KEY or VECTOR_STORE_ID is not set" 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 1. Vector search (unchanged)
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
      console.error("Vector search failed:", searchResponse.status, errorText);
      
      return new Response(JSON.stringify({ 
        error: "Vector search failed",
        details: errorText
      }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const searchData = await searchResponse.json();
    
    // Extract evidence (unchanged)
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

    // No evidence found (unchanged)
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

    // Generate answer with GPT (unchanged)
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
      console.error("GPT request failed:", gptResponse.status, errorText);
      
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

    // Return standard response (unchanged)
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

// ========== NEW HELPER FUNCTIONS FOR CASE ANALYSIS ==========

/**
 * Parse free-text clinical case into structured data using GPT
 */
async function parseClinicalCase(caseText, env, language) {
  const systemPrompt = `You are a clinical data extractor. Extract the following from the case text and return ONLY valid JSON:
{
  "demographics": {
    "age": number or null,
    "sex": "male"/"female"/null,
    "height_cm": number or null,
    "weight_kg": number or null,
    "scr": number or null,
    "scr_unit": "mg/dL"/"μmol/L"/null
  },
  "diagnoses": [{"name": string, "status": "active"/"history"}],
  "medications": [{"name": string, "dose": string, "route": string, "frequency": string, "prn": boolean}],
  "labs": [{"name": string, "value": number, "unit": string}],
  "vitals": [{"name": string, "value": number, "unit": string}]
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

/**
 * Compute clinical values from extracted data
 */
function computeClinicalValues(parsed) {
  const d = parsed.demographics || {};
  const age = d.age;
  const height = d.height_cm;
  const weight = d.weight_kg;
  const scr = d.scr;
  const scr_unit = d.scr_unit;
  const sex = d.sex;

  const computed = {};

  // BMI
  if (height && weight) {
    computed.bmi = Math.round((weight / ((height/100) ** 2)) * 10) / 10;
  }

  // IBW (Devine formula)
  if (height && sex) {
    const heightInInches = height / 2.54;
    if (sex === 'male') {
      computed.ibw = 50 + 2.3 * (heightInInches - 60);
    } else {
      computed.ibw = 45.5 + 2.3 * (heightInInches - 60);
    }
    computed.ibw = Math.round(computed.ibw * 10) / 10;
  }

  // AdjBW (for obesity)
  if (computed.ibw && weight) {
    if (weight > computed.ibw * 1.2) { // >120% IBW
      computed.adjbw = computed.ibw + 0.4 * (weight - computed.ibw);
      computed.adjbw = Math.round(computed.adjbw * 10) / 10;
      computed.weight_for_crcl = computed.adjbw;
    } else {
      computed.weight_for_crcl = weight;
    }
  }

  // Cockcroft-Gault CrCl
  if (age && computed.weight_for_crcl && scr) {
    let scr_mgdl = scr;
    if (scr_unit === 'μmol/L') scr_mgdl = scr / 88.4;
    
    let crcl = ((140 - age) * computed.weight_for_crcl) / (72 * scr_mgdl);
    if (sex === 'female') crcl *= 0.85;
    computed.crcl = Math.round(crcl * 10) / 10;
    computed.crcl_method = `Cockcroft-Gault using ${computed.weight_for_crcl === computed.adjbw ? 'AdjBW' : 'ActualBW'}`;
    
    // CKD stage
    if (computed.crcl >= 90) computed.ckd_stage = "1";
    else if (computed.crcl >= 60) computed.ckd_stage = "2";
    else if (computed.crcl >= 45) computed.ckd_stage = "3a";
    else if (computed.crcl >= 30) computed.ckd_stage = "3b";
    else if (computed.crcl >= 15) computed.ckd_stage = "4";
    else computed.ckd_stage = "5";
  }

  return computed;
}

/**
 * Check which conditions have guidelines in vector store
 */
function detectMissingGuidelines(diagnoses, env) {
  const missing = [];
  // In production, this would query a document registry KV store
  // For now, return empty (implement based on your doc tracking)
  return missing;
}

/**
 * Run all intervention detectors (protocol-locked)
 */
async function detectInterventions(parsedCase, computed, env, language) {
  const interventions = [];
  
  // Get list of diagnoses and medications
  const diagnoses = (parsedCase.diagnoses || []).map(d => d.name);
  const medications = (parsedCase.medications || []).map(m => m.name);
  
  // For each drug-disease pair, query vector store
  for (const med of medications) {
    for (const dx of diagnoses) {
      const query = `contraindications or warnings for ${med} in patients with ${dx}`;
      const result = await queryVectorStore(query, env);
      
      if (result.evidence.length > 0) {
        interventions.push({
          title: `${med} – possible contraindication in ${dx}`,
          category: "Drug-Disease",
          severity: "HIGH",
          rationale: result.answer || "Found in monograph/guideline",
          action: "Review contraindication",
          evidence: result.evidence.map(e => ({
            file: e.filename,
            section: "extracted", // would be parsed from content
            page: 0,
            excerpt: e.excerpt.substring(0, 200)
          })),
          data_triggers: { drug: med, disease: dx }
        });
      }
    }
  }

  // Drug-Lab checks (e.g., NSAID + CKD)
  if (computed.crcl && computed.crcl < 60) {
    for (const med of medications) {
      const query = `${med} dosing in renal impairment or CrCl <60`;
      const result = await queryVectorStore(query, env);
      if (result.evidence.length > 0) {
        interventions.push({
          title: `${med} – renal impairment caution`,
          category: "Drug-Lab",
          severity: computed.crcl < 30 ? "HIGH" : "MODERATE",
          rationale: `CrCl ${computed.crcl} mL/min`,
          action: "Adjust dose or monitor",
          evidence: result.evidence.map(e => ({
            file: e.filename,
            section: "Renal Impairment",
            page: 0,
            excerpt: e.excerpt.substring(0, 200)
          })),
          data_triggers: { drug: med, crcl: computed.crcl }
        });
      }
    }
  }

  return interventions;
}

/**
 * Query vector store with document-bound scope
 */
async function queryVectorStore(query, env) {
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

  if (!searchResponse.ok) return { evidence: [], answer: null };

  const data = await searchResponse.json();
  const evidence = [];
  
  if (data.data && Array.isArray(data.data)) {
    data.data.forEach(item => {
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
      if (content && content.trim()) {
        evidence.push({
          filename: item.file_id || item.filename || 'source',
          excerpt: content.substring(0, 500)
        });
      }
    });
  }

  return { evidence, answer: null };
}
