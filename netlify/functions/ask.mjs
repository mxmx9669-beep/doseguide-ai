// netlify/functions/ask.mjs
import fs from "fs/promises";
import path from "path";

function isArabic(text = "") {
  return /[\u0600-\u06FF]/.test(text);
}

function safeJsonParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function pickOutputText(resp) {
  // Responses API غالبًا يرجع output_text
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text.trim();

  // fallback: حاول تجمع أي نصوص
  const out = resp?.output;
  if (Array.isArray(out)) {
    let all = "";
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") all += c.text;
          if (c?.type === "text" && typeof c?.text === "string") all += c.text;
        }
      }
    }
    if (all.trim()) return all.trim();
  }
  return "";
}

async function loadVectorstoresMap() {
  // function path عادة: /var/task/netlify/functions
  const root = path.resolve(process.cwd()); // Netlify sets cwd to repo root غالبًا
  const p1 = path.join(root, "vectorstores.json");
  const raw = await fs.readFile(p1, "utf8");
  const json = JSON.parse(raw);

  // نتوقع شكلين محتملين:
  // 1) { "vancomycin": "vs_..." , "ciprofloxacin": "vs_..." }
  // 2) { "stores": { "vancomycin": { "id":"vs_..." } } }
  const map = {};

  if (json && typeof json === "object") {
    for (const [k, v] of Object.entries(json)) {
      if (typeof v === "string") map[k.toLowerCase()] = v;
    }
    if (json.stores && typeof json.stores === "object") {
      for (const [k, v] of Object.entries(json.stores)) {
        if (typeof v === "string") map[k.toLowerCase()] = v;
        if (v && typeof v === "object" && typeof v.id === "string") map[k.toLowerCase()] = v.id;
      }
    }
  }
  return map;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY in Netlify environment variables" }) };
    }

    const body = safeJsonParse(event.body, {});
    const drugKeyRaw = (body.drugKey || "").toString().trim();
    const questionRaw = (body.question || "").toString().trim();
    const mode = (body.mode || "brief").toString(); // brief | detailed
    const lang = (body.lang || "auto").toString();  // auto | ar | en

    if (!drugKeyRaw || !questionRaw) {
      return { statusCode: 400, body: JSON.stringify({ error: "drugKey and question are required" }) };
    }

    const drugKey = drugKeyRaw.toLowerCase();
    const question = questionRaw;

    const vsMap = await loadVectorstoresMap();
    const vectorStoreId = vsMap[drugKey];

    // ✅ قفل الدواء: لو مو موجود بالقائمة — ممنوع
    if (!vectorStoreId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Drug not supported (not in vectorstores.json)",
          supportedDrugKeys: Object.keys(vsMap).sort(),
        }),
      };
    }

    // تحديد لغة الرد
    const finalLang =
      lang === "ar" ? "ar" :
      lang === "en" ? "en" :
      (isArabic(question) ? "ar" : "en");

    const system = finalLang === "ar"
      ? `أنت مساعد صيدلة سريرية "مقيد بالبروتوكول" بالكامل.
- يجب أن تعتمد فقط على المعلومات التي تأتيك من أداة file_search المرتبطة بهذا الدواء.
- ممنوع استخدام معرفة عامة أو تخمين.
- إذا لم تجد معلومة كافية داخل البروتوكول: قل حرفيًا "غير موجود في البروتوكول" ثم اطلب ما يلزم (مثل indication/renal function) بدون اختراع.
- اجعل الإجابة ${mode === "detailed" ? "تفصيلية" : "مختصرة"} وواضحة.`
      : `You are a protocol-locked clinical pharmacy assistant.
- You MUST rely ONLY on information returned by the file_search tool for this drug.
- Do NOT use general medical knowledge or guess.
- If the protocol does not contain enough info, reply exactly: "Not found in protocol" and ask what’s missing (e.g., indication/renal function), without inventing.
- Keep the answer ${mode === "detailed" ? "detailed" : "brief"} and clear.`;

    const user = finalLang === "ar"
      ? `Drug key: ${drugKey}\nالسؤال: ${question}`
      : `Drug key: ${drugKey}\nQuestion: ${question}`;

    // ✅ Responses API + File Search على نفس الـ vector store
    // (حسب توثيق OpenAI: Responses API + أدوات مثل file_search عبر vector_store_ids) :contentReference[oaicite:0]{index=0}
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          { type: "file_search", vector_store_ids: [vectorStoreId] },
        ],
        temperature: 0.2,
        max_output_tokens: mode === "detailed" ? 900 : 450,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { statusCode: resp.status, body: JSON.stringify({ error: data?.error || data }) };
    }

    const reply = pickOutputText(data) || (finalLang === "ar" ? "غير موجود في البروتوكول" : "Not found in protocol");

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        drugKey,
        lang: finalLang,
        mode,
        reply,
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || String(e) }) };
  }
}
