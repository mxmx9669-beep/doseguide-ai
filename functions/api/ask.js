// ========== CASE MODE HANDLER (COMPLETE FIX) ==========
async function handleCaseMode(body, env, corsHeaders) {
  try {
    const case_text = body.case_text;
    const question = body.question || "";
    
    // 1. استخراج المعلومات الأساسية من الحالة
    const extracted = extractBasics(case_text);
    const computed = computeCrCl(extracted);
    
    // 2. البحث في Vector Store عن بروتوكولات ذات صلة
    const searchQuery = buildCaseQuery(case_text, extracted, computed);
    
    const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        query: searchQuery,
        max_num_results: 8
      })
    });

    if (!searchResponse.ok) {
      throw new Error("Vector search failed");
    }

    const searchData = await searchResponse.json();
    
    // 3. استخراج الأدلة من نتائج البحث
    const evidence = extractEvidenceFromSearch(searchData);
    
    // 4. بناء التحليل باستخدام GPT
    const analysis = await generateCaseAnalysis(env, {
      case_text,
      question,
      extracted,
      computed,
      evidence
    });
    
    // 5. تجهيز المصادر للـ Frontend
    const sources = evidence.map((e, idx) => ({
      id: `S${idx + 1}`,
      filename: e.filename || "Unknown",
      page: e.page || "N/A",
      excerpt: e.excerpt?.substring(0, 220) || "",
      score: e.score || null
    }));

    return new Response(JSON.stringify({
      ok: true,
      final_note: analysis,  // ✅ التحليل الكامل
      sources: sources        // ✅ المصادر
    }), {
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
    
  } catch (error) {
    console.error("Case mode error:", error);
    return new Response(JSON.stringify({ 
      ok: false,
      error: error.message,
      final_note: "Error analyzing case",
      sources: []
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}

// ========== HELPER FUNCTIONS FOR CASE MODE ==========

function extractBasics(text) {
  const t = text || "";
  
  // استخراج العمر
  const ageMatch = t.match(/\b(\d{1,3})\s*(?:y|yr|year)/i);
  const age = ageMatch ? parseInt(ageMatch[1]) : null;
  
  // استخراج الوزن
  const weightMatch = t.match(/\b(\d{2,3})\s*kg/i);
  const weightKg = weightMatch ? parseFloat(weightMatch[1]) : null;
  
  // استخراج الكرياتينين
  const scrMatch = t.match(/\b(?:s\.?cr|scr|creatinine)\s*:?\s*(\d{2,3})/i);
  const scrUmol = scrMatch ? parseFloat(scrMatch[1]) : null;
  
  // استخراج Hb
  const hbMatch = t.match(/\b(?:hb|hemoglobin|هيموجلوبين)\s*:?\s*(\d{1,2}\.?\d?)/i);
  const hb = hbMatch ? parseFloat(hbMatch[1]) : null;
  
  // استخراج الـ pH
  const phMatch = t.match(/\bph\s*:?\s*(\d{1,2}\.\d{2})/i);
  const ph = phMatch ? parseFloat(phMatch[1]) : null;
  
  // استخراج الـ Lactate
  const lactateMatch = t.match(/\b(lactate|لاكتات)\s*:?\s*(\d{1,2}\.?\d?)/i);
  const lactate = lactateMatch ? parseFloat(lactateMatch[2]) : null;
  
  return { age, weightKg, scrUmol, hb, ph, lactate };
}

function computeCrCl({ age, weightKg, scrUmol }) {
  if (!age || !weightKg || !scrUmol) return null;
  
  const scrMgDl = scrUmol / 88.4;
  if (!scrMgDl || scrMgDl <= 0) return null;
  
  let crcl = ((140 - age) * weightKg) / (72 * scrMgDl);
  return Math.round(crcl);
}

function buildCaseQuery(case_text, extracted, computed) {
  const parts = [
    "clinical case",
    "medication dosing",
    "renal adjustment",
    "protocol guidelines"
  ];
  
  if (computed) parts.push(`CrCl ${computed} mL/min`);
  if (extracted.hb) parts.push(`hemoglobin ${extracted.hb}`);
  if (extracted.ph) parts.push(`pH ${extracted.ph}`);
  
  return parts.join(" ");
}

function extractEvidenceFromSearch(searchData) {
  const evidence = [];
  
  if (searchData.data && Array.isArray(searchData.data)) {
    searchData.data.forEach((item, index) => {
      let content = '';
      let filename = item.file_id || item.filename || `source_${index + 1}`;
      let page = null;
      let score = item.score || null;
      
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
        const pageMatch = content.match(/(?:Page|page|p\.)\s*(\d+)/i);
        if (pageMatch) page = parseInt(pageMatch[1]);
        
        evidence.push({
          id: `E${index + 1}`,
          filename: filename,
          page: page,
          excerpt: content.substring(0, 500),
          score: score
        });
      }
    });
  }
  
  return evidence;
}

async function generateCaseAnalysis(env, { case_text, question, extracted, computed, evidence }) {
  
  const evidenceText = evidence.map(e => 
    `[SOURCE] ${e.filename} (Page: ${e.page || 'N/A'})\n${e.excerpt}`
  ).join('\n\n---\n\n');
  
  const systemPrompt = `You are a clinical pharmacist specialist. Analyze this case and provide:
1. SOAP format (Subjective, Objective, Assessment, Plan)
2. Medication dose checks with recommendations
3. Cite specific sources from the provided evidence

Format your response exactly like this:

SUBJECTIVE:
[summary]

OBJECTIVE:
Vitals: [vitals]
Labs: [key labs]
Imaging: [findings]

ASSESSMENT:
[problem list]

PLAN:
[recommendations]

DOSE CHECKS:
- [Drug]: Current = [dose]; Recommended = [protocol dose]; Source: [filename]

SOURCES:
[list sources used]`;

  const userMessage = `
CASE: ${case_text}
${question ? `\nQUESTION: ${question}` : ''}
${computed ? `\nCalculated CrCl: ${computed} mL/min` : ''}

EVIDENCE FROM PROTOCOLS:
${evidenceText || "No specific protocols found. Use general clinical knowledge."}
`;

  const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 1500
    })
  });

  if (!gptResponse.ok) {
    throw new Error("GPT analysis failed");
  }

  const gptData = await gptResponse.json();
  return gptData.choices?.[0]?.message?.content || "Analysis completed";
}
