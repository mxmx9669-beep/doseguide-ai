// ============================================================
// FILE: /functions/api/ask.js
// CLINICAL PHARMACIST AI PLATFORM — Backend v5.1
// Runtime: Cloudflare Pages Functions
// ============================================================

export async function onRequest(context) {
  const { request, env } = context;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };

  // Handle preflight requests
  if (request.method === "OPTIONS") {
    return new Response(null, { 
      status: 204, 
      headers: corsHeaders 
    });
  }

  // Only allow POST
  if (request.method !== "POST") {
    return jsonResponse({ 
      ok: false, 
      error: "Method not allowed. Use POST." 
    }, 405, corsHeaders);
  }

  try {
    // Parse request body
    const body = await request.json().catch(() => ({}));
    const { case_text } = body;

    // Validate input
    if (!case_text || typeof case_text !== 'string' || !case_text.trim()) {
      return jsonResponse({ 
        ok: false, 
        error: "Missing or invalid case_text in request body" 
      }, 400, corsHeaders);
    }

    // Check for API key
    if (!env.OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return jsonResponse({ 
        ok: false, 
        error: "Server configuration error: API key missing" 
      }, 500, corsHeaders);
    }

    // Call OpenAI to generate SOAP note
    console.log("Generating SOAP note for case...");
    const soapNote = await generateSOAPNote(env, case_text.trim());
    
    // Call for medication review
    console.log("Generating medication review...");
    const medReview = await generateMedReview(env, case_text.trim());

    // Return combined response
    return jsonResponse({
      ok: true,
      template1_soap: soapNote,
      final_note: `CLINICAL PHARMACIST CONSULTATION NOTE\n\n${soapNote}\n\nMEDICATION REVIEW:\n${medReview}`,
      soap_note: soapNote,
      med_review: medReview,
      timestamp: new Date().toISOString()
    }, 200, corsHeaders);

  } catch (error) {
    console.error("Pipeline error:", error.message, error.stack);
    
    return jsonResponse({ 
      ok: false, 
      error: error.message || "Internal server error",
      details: error.toString()
    }, 500, corsHeaders);
  }
}

/**
 * Generate SOAP note using OpenAI
 */
async function generateSOAPNote(env, caseText) {
  const systemPrompt = `You are a clinical pharmacist creating a structured SOAP note.
Use this exact format:

SUBJECTIVE
• Chief complaint: [brief]
• History of present illness: [brief]
• Past medical history: [bullet points]
• Home medications: [list with doses]

OBJECTIVE
• Vital signs: [most recent]
• Relevant labs: [with flags ↑↓]
• Renal function: [CrCl calculation]
• Other findings: [as relevant]

ASSESSMENT
• Primary problem: [statement]
• Active issues: [bullet points]

PLAN
• Medication changes: [specific recommendations]
• Monitoring: [required labs/parameters]
• Follow-up: [timeline]

Be concise and professional.`;

  return await callOpenAI(env, systemPrompt, caseText, 1000);
}

/**
 * Generate medication review using OpenAI
 */
async function generateMedReview(env, caseText) {
  const systemPrompt = `You are a clinical pharmacist reviewing medications.
For each medication, assess:
1. Indication appropriateness
2. Dose adjustment needed (renal/hepatic)
3. Drug interactions
4. Monitoring requirements

Format as:
💊 [Drug Name] [Dose] [Route]
   Indication: ✅/⚠️/❌ [reason]
   Dose check: ✅/⚠️ [reason if adjusted]
   Interactions: [list if any]
   Monitoring: [required]
   → Recommendation: [action]`;

  return await callOpenAI(env, systemPrompt, caseText, 800);
}

/**
 * Call OpenAI API with error handling
 */
async function callOpenAI(env, systemPrompt, userMessage, maxTokens = 1000) {
  const model = env.MODEL || "gpt-4o-mini"; // استخدام نموذج أسرع وأرخص للاختبار
  
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        max_tokens: maxTokens,
        temperature: 0.3, // أقل قليلاً للدقة
        presence_penalty: 0.1,
        frequency_penalty: 0.1
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI API error:", response.status, errorText);
      
      // محاولة فهم الخطأ
      let errorMessage = `OpenAI API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorMessage;
      } catch {
        // إذا لم يكن JSON، نستخدم النص كامل
        if (errorText.length < 200) errorMessage += ` - ${errorText}`;
      }
      
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error("Invalid response format from OpenAI");
    }

    return data.choices[0].message.content.trim();

  } catch (error) {
    console.error("OpenAI call failed:", error);
    throw new Error(`AI service error: ${error.message}`);
  }
}

/**
 * Helper to create JSON responses
 */
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}
