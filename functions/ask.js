// File: /functions/api/ask.js
// Cloudflare Pages Function: POST /api/ask - نسخة مبسطة

export async function onRequest(context) {
  const { request, env } = context;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { 
      status: 204,
      headers: corsHeaders 
    });
  }

  // فقط POST مسموح
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  try {
    // قراءة الـ body
    const body = await request.json();
    const question = body.question || body.q || "";
    const language = body.language || "en";
    
    console.log("Received question:", question);

    if (!question) {
      return new Response(JSON.stringify({ error: "Question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // التحقق من المتغيرات البيئية
    if (!env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ 
        error: "OPENAI_API_KEY is not set" 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (!env.VECTOR_STORE_ID) {
      return new Response(JSON.stringify({ 
        error: "VECTOR_STORE_ID is not set" 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 1. البحث في Vector Store
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
    console.log("Search results received");

    // استخراج النصوص من النتائج
    const evidence = [];
    if (searchData.data && Array.isArray(searchData.data)) {
      searchData.data.forEach((item, index) => {
        // محاولة استخراج النص من مصادر مختلفة
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
        
        if (item.text) {
          content = item.text;
        }
        
        if (content && content.trim()) {
          evidence.push({
            id: `E${index + 1}`,
            filename: item.file_id || item.filename || `file_${index + 1}`,
            excerpt: content.substring(0, 1500) // تقييد الطول
          });
        }
      });
    }

    // إذا ما لقينا شيء
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

    // 2. توليد الإجابة باستخدام Chat Completions (الأبسط والأكثر استقراراً)
    const model = env.MODEL || "gpt-3.5-turbo"; // استخدم gpt-3.5-turbo بدلاً من 4
    
    // بناء النص للإرسال إلى GPT
    const evidenceText = evidence.map(e => 
      `[SOURCE ${e.id}] File: ${e.filename}\nContent: ${e.excerpt}`
    ).join('\n\n---\n\n');

    const systemPrompt = language === 'ar' 
      ? "أنت مساعد طبي متخصص. استخدم فقط المعلومات المقدمة في المصادر أعلاه للإجابة على السؤال. إذا طلب المستخدم قائمة بالعناوين، استخرجها من المصادر. أجب باللغة العربية."
      : "You are a medical assistant. Use ONLY the information in the provided sources above to answer the question. If the user asks for headings or lists, extract them from the sources. Answer in English.";

    const userPrompt = `Question: ${question}\n\nSources:\n${evidenceText}\n\nPlease answer the question using ONLY the information in these sources.`;

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
      
      // إذا فشل GPT، نرسل المصادر مباشرة
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

    // 3. إرجاع النتيجة
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
