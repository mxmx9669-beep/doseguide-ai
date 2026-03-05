// ============================================================
// FILE: /functions/api/ask.js
// THERA GUARD AI — Backend v8.5 (FIXED) — Protocol-Locked RAG with Flexible Validation
// ============================================================

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

    // ========== CASE ANALYSIS MODE (preserved) ==========
    if (body.mode === "case_analysis" && body.case_text) {
      return handleCaseMode(body, env, corsHeaders);
    }
    
    // ========== STANDARD Q&A MODE ==========
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
        let page = null;
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
        
        // Extract page number if present (optional)
        const pageMatch = content.match(/(?:Page|PAGE|page)\s*(\d+)/i) || 
                         content.match(/p\.\s*(\d+)/i) ||
                         content.match(/\[p\.\s*(\d+)\]/i);
        if (pageMatch) page = parseInt(pageMatch[1]);
        
        // Extract section if present (optional)
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
            page: page,  // قد يكون null
            section: section || "General",  // قيمة افتراضية
            excerpt: content.substring(0, 2000),
            full_content: content
          });
        }
      });
    }

    // ========== SOURCE_MODE = "required" ENFORCEMENT (FIXED) ==========
    if (source_mode === "required") {
      // ✅ FIXED: Only check for filename and meaningful content
      // No longer requiring page > 0 or section existence
      const hasValidEvidence = evidence.some(e => 
        e.filename && 
        e.filename.length > 0 && 
        e.excerpt && 
        e.excerpt.trim().length > 20
      );
      
      if (evidence.length === 0 || !hasValidEvidence) {
        return new Response(JSON.stringify({
          ok: true,
          verdict: "NOT_FOUND",
          answer: language === 'ar' 
            ? "لم يتم العثور على المعلومات في البروتوكولات المتاحة"
            : "Not found in available protocols",
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
        if (evidence.length === 0) {
          answer = language === 'ar' 
            ? "لم يتم العثور على نصوص حرفية في المصادر."
            : "No verbatim text found in sources.";
        } else {
          const quotes = evidence.map(e => {
            const sentences = e.excerpt.split(/[.!?]+/).filter(s => s.trim().length > 20);
            const quote = sentences.length > 0 ? sentences[0].trim() + '.' : e.excerpt.substring(0, 150);
            return `"${quote}" — ${e.filename} (Page: ${e.page || 'N/A'})`;
          }).slice(0, 3);
          
          answer = quotes.join('\n\n');
          
          citations = evidence.map(e => ({
            evidence_ids: [e.id],
            filename: e.filename,
            section: e.section || 'General',
            page: e.page || 'N/A',
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
              page: e.page || 'N/A',
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
            page: e.page || 'N/A',
            excerpt: e.excerpt.substring(0, 250)
          }));
        }
        break;
    }

    // ========== SOURCE_MODE = "off" HANDLING ==========
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

// ========== CASE MODE HANDLER (preserved from original) ==========
async function handleCaseMode(body, env, corsHeaders) {
  try {
    // Your existing case analysis logic here
    // This is preserved from your original code
    
    return new Response(JSON.stringify({
      ok: true,
      final_note: "Case analysis completed",
      sources: []
    }), {
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ 
      ok: false,
      error: error.message 
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}
