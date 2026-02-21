export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Missing OPENAI_API_KEY in Netlify environment variables" }),
      };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const message = (body.message || body.question || "").toString().trim();
    const drugKey = (body.drugKey || body.drug || "").toString().trim();
    const mode = (body.mode || "concise").toString();

    if (!message) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "No message provided (expected: message or question)" }),
      };
    }

    // System prompt بسيط
    const system = [
      "You are a helpful clinical pharmacy assistant.",
      "Be safe: if the question is missing key patient info, ask for clarifying details.",
      "If user requests dosing, include assumptions and cautionary notes.",
      drugKey ? `Context drug key: ${drugKey}` : "",
      mode === "concise" ? "Answer concisely in bullet points when helpful." : "Answer with more detail and rationale.",
    ].filter(Boolean).join("\n");

    // استخدم Chat Completions (مستقر وشائع)
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: message },
        ],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      const err = data?.error?.message || JSON.stringify(data);
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: err }) };
    }

    const reply = data?.choices?.[0]?.message?.content || "";
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message || "Unknown error" }),
    };
  }
}
