// netlify/functions/ask.mjs
// Protocol-Locked: answers ONLY from the selected Vector Store (PDF).
// If not found in protocol => "Not found in protocol"

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

async function callOpenAIResponses({ apiKey, model, vectorStoreId, question }) {
  const sys = `
You are DoseGuide AI in STRICT protocol-locked mode.
You MUST answer ONLY using evidence from the provided protocol context (file_search).
Rules:
- If the protocol does NOT contain the answer, reply EXACTLY: Not found in protocol
- If you answer, include a short "Evidence:" section with 1–3 short verbatim quotes (<=25 words each) taken from the protocol context.
- Do NOT use outside knowledge. Do NOT guess.
`.trim();

  const payload = {
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: sys }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: question }],
      },
    ],
    tools: [
      {
        type: "file_search",
        vector_store_ids: [vectorStoreId],
      },
    ],
    // keep output deterministic-ish
    temperature: 0.2,
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const dataText = await r.text();
  let data;
  try {
    data = JSON.parse(dataText);
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${dataText.slice(0, 200)}`);
  }

  if (!r.ok) {
    const msg =
      data?.error?.message ||
      `OpenAI error ${r.status} ${r.statusText}: ${dataText.slice(0, 300)}`;
    throw new Error(msg);
  }

  // Robust extraction of final text
  let out = "";
  if (typeof data?.output_text === "string") out = data.output_text;

  if (!out && Array.isArray(data?.output)) {
    // try to extract from output array (message content)
    for (const item of data.output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string") out += (out ? "\n" : "") + c.text;
          if (typeof c?.content === "string") out += (out ? "\n" : "") + c.content;
        }
      }
    }
  }

  out = (out || "").trim();

  return { raw: data, text: out };
}

export default async function handler(req) {
  try {
    if (req.method === "OPTIONS") return json({ ok: true }, 200);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.VECTOR_STORE_ID;
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!apiKey) return json({ error: "Missing OPENAI_API_KEY" }, 500);
    if (!vectorStoreId) return json({ error: "Missing VECTOR_STORE_ID" }, 500);

    let body = {};
    try {
      body = JSON.parse(req.body || "{}");
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const question =
      (typeof body?.question === "string" && body.question.trim()) ||
      (typeof body?.q === "string" && body.q.trim()) ||
      "";

    if (!question) return json({ error: "Missing question" }, 400);

    const { text } = await callOpenAIResponses({
      apiKey,
      model,
      vectorStoreId,
      question,
    });

    const locked = true;
    const notFound = text === "Not found in protocol";

    return json({
      ok: true,
      locked,
      model,
      verdict: notFound ? "NOT_FOUND" : "FOUND",
      answer: text || "Not found in protocol",
    });
  } catch (e) {
    return json(
      {
        ok: false,
        locked: true,
        error: String(e?.message || e),
      },
      500
    );
  }
}
