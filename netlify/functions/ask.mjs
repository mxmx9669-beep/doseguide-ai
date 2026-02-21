// netlify/functions/ask.mjs
// Protocol-Locked engine: answers ONLY from the selected drug PDF (vector store).
// If the answer isn't in the PDF context => returns "Not found in protocol".

import fs from "node:fs/promises";
import path from "node:path";

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

function getTextFromResponsesAPI(resp) {
  // Robust extraction across response shapes
  // 1) Some SDKs provide output_text; raw API returns output array with message content items.
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text;

  const out = resp?.output;
  if (!Array.isArray(out)) return "";

  let text = "";
  for (const item of out) {
    if (item?.type === "message" && item?.role === "assistant" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        // common: {type:"output_text", text:"..."} or {type:"text", text:"..."}
        if (typeof c?.text === "string") text += c.text;
        if (typeof c?.content === "string") text += c.content;
      }
    }
  }
  return text.trim();
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json({ ok: true }, 200);
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return json({ error: "Missing OPENAI_API_KEY in Netlify environment variables" }, 500);
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const drugKey = String(payload.drugKey || "").trim().toLowerCase();
  const question = String(payload.question || "").trim();
  const lang = String(payload.lang || "auto").trim().toLowerCase(); // auto|ar|en|hi|tl|am
  const answerMode = String(payload.answerMode || "recommended").trim().toLowerCase(); // recommended|detailed|bullet

  if (!drugKey) return json({ error: "drugKey is required" }, 400);
  if (!question) return json({ error: "question is required" }, 400);

  // Load manifests from functions bundle
  const dataDir = path.join(process.cwd(), "netlify", "functions", "data");
  const refsPath = path.join(dataDir, "refs.manifest.json");

  let refs;
  try {
    refs = JSON.parse(await fs.readFile(refsPath, "utf8"));
  } catch (e) {
    return json({ error: "Cannot read refs.manifest.json", details: String(e?.message || e) }, 500);
  }

  const entry = refs?.[drugKey];
  const vectorStoreId = entry?.vector_store_id;

  if (!vectorStoreId) {
    // Protocol-locked behavior: reject unknown drug (not in your list)
    return json({
      ok: true,
      reply:
        "هذا الدواء غير موجود ضمن القائمة المتاحة في النظام (لا يوجد PDF/VectorStore مرتبط به).",
      locked: true,
      drugKey,
    });
  }

  const langHintMap = {
    auto: "اكتب بنفس لغة السؤال تلقائياً (Auto).",
    ar: "اكتب الإجابة باللغة العربية فقط.",
    en: "Write the answer in English only.",
    hi: "उत्तर केवल हिंदी में लिखें।",
    tl: "Isulat ang sagot sa Filipino/Tagalog lamang.",
    am: "መልሱን በአማርኛ ብቻ ጻፍ።",
  };

  const styleHint =
    answerMode === "detailed"
      ? "قدّم شرحاً مفصلاً لكن بدون حشو."
      : answerMode === "bullet"
      ? "أجب بنقاط قصيرة وواضحة."
      : "أجب بإجابة مختصرة عملية (Recommended).";

  const system = `
أنت مساعد صيدلي سريري "Protocol-Locked".
قواعد صارمة جداً:
1) يجب أن تعتمد فقط على محتوى PDF/البروتوكول المُتاح عبر file_search لنفس الدواء المختار.
2) ممنوع استخدام أي معرفة خارجية أو تخمين أو إرشادات عامة غير موجودة في الـPDF.
3) إذا لم تجد المعلومة حرفياً/معنوياً داخل الـPDF، قل بوضوح: "غير موجود في بروتوكول/ملف PDF هذا الدواء" واقترح على المستخدم أن يراجع المصدر أو يرفع نسخة أحدث.
4) لا تغيّر الدواء: لا تجيب عن دواء آخر غير الدواء المختار.
5) ${langHintMap[lang] || langHintMap.auto}
6) أسلوب الإجابة: ${styleHint}
`;

  const user = `
Drug key: ${drugKey}
Question: ${question}
مهم: التزم بالـPDF فقط. إذا لا يوجد دليل داخل الـPDF => قل غير موجود.
`;

  // Call OpenAI Responses API with file_search restricted to this vector store
  const model = process.env.OPENAI_MODEL || "gpt-5.2"; // you can change in Netlify env
  const url = "https://api.openai.com/v1/responses";

  const reqBody = {
    model,
    input: [
      { role: "system", content: [{ type: "text", text: system.trim() }] },
      { role: "user", content: [{ type: "text", text: user.trim() }] },
    ],
    tools: [{ type: "file_search" }],
    tool_resources: {
      file_search: { vector_store_ids: [vectorStoreId] },
    },
    // Keep it deterministic-ish
    temperature: 0.2,
    max_output_tokens: 650,
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    const resp = await r.json();
    if (!r.ok) {
      return json({ error: "OpenAI API error", details: resp }, 500);
    }

    const reply = getTextFromResponsesAPI(resp) || "غير موجود في بروتوكول/ملف PDF هذا الدواء.";

    return json({
      ok: true,
      locked: true,
      drugKey,
      vector_store_id: vectorStoreId,
      reply,
    });
  } catch (e) {
    return json({ error: "Request failed", details: String(e?.message || e) }, 500);
  }
}
