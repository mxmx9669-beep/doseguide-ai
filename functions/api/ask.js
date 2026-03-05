// ============================================================
// FILE: /functions/api/ask.js
// CLINICAL PHARMACIST AI PLATFORM — Backend v4.0 (Enhanced)
// Runtime: Cloudflare Pages Functions
//
// الميزات الجديدة:
// 1. اكتشاف الأخطاء الدوائية بقواعد محلية (بدون AI)
// 2. نظام هجين: قواعد محلية + AI للتحليل العميق
// 3. تحسين البحث في الملفات المتاحة
// 4. تنسيق SOAP محسن مع تدخلات دوائية دقيقة
// ============================================================

export async function onRequest(context) {
  const { request, env } = context;

  const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST")    return json({ error: "Method not allowed" }, 405, CORS);

  try {
    const body = await request.json();
    const { case_text, query_type = "full_case", specific_question } = body;

    if (!case_text?.trim()) return json({ ok: false, error: "Missing case_text" }, 400, CORS);

    // ── STEP A: Extract & structure ──────────────────────────
    console.log("🔍 A: Extracting structured data...");
    const data = await stepA_extract(case_text, env);

    // ── STEP B: CrCl — pure code, no AI ─────────────────────
    console.log("🧮 B: Computing CrCl...");
    const renal = stepB_computeCrCl(data);
    data.renal = { scr_umol: data.scr_umol ?? null, ...renal };

    const scrDisp  = data.renal.scr_umol ?? "—";
    const crclDisp = renal.crcl !== null ? renal.crcl : "—";
    const renalLine = `SCr ${scrDisp} µmol/L → ${renal.scr_mgdl ?? "—"} mg/dL | CrCl ${crclDisp} mL/min (${renal.weight_label ?? "weight unknown"})`;

    // ── البحث في الملفات المتاحة ────────────────────────────
    console.log("📚 Searching available protocols...");
    const localProtocols = await searchVectorStore(
      `pharmacotherapy guidelines protocols ${data.reason_admission || ""} ${data.pmh || ""}`,
      env,
      10
    );

    // ── التحقق من الأخطاء الدوائية بالقواعد المحلية ──────────
    console.log("🔍 Running local rule-based medication check...");
    const localMedCheck = runLocalMedicationCheck(data, renal);

    // ── إذا كان سؤال محدد ────────────────────────────────────
    if (query_type === "specific" && specific_question) {
      return handleSpecificQuestion(data, renal, specific_question, localProtocols, env);
    }

    // ── STEP C1: Organize case → Template-1 SOAP ────────────
    console.log("📋 C1: Case organizer...");
    const template1_soap = await stepC1_organize(data, renalLine, env);

    // ── STEP C2: Problem coverage check ─────────────────────
    console.log("🔬 C2: Problem coverage check...");
    const coverage = await stepC2_problemCoverage(data, renal, localProtocols, env);

    // ── STEP C3: Home meds at admission ─────────────────────
    console.log("💊 C3: Home medications management...");
    const homeMedsReview = await stepC3_homeMeds(data, renal, localProtocols, env);

    // ── STEP C4: DVT + SUP prophylaxis ──────────────────────
    console.log("🛡️ C4: DVT & SUP prophylaxis...");
    const prophylaxis = await stepC4_prophylaxis(data, renal, localProtocols, env);

    // ── STEP C5: Medication deep verification ───────────────
    console.log("🔎 C5: Medication verification (hybrid approach)...");
    
    // دمج الفحص المحلي مع الفحص بالـ AI
    const medVerification = await stepC5_medVerificationHybrid(
      data, 
      renal, 
      localMedCheck, 
      localProtocols, 
      env
    );

    // ── STEP C6: Final pharmacist note ──────────────────────
    console.log("📝 C6: Final pharmacist note...");
    const finalNote = await stepC6_finalNote(
      data, renalLine, coverage, homeMedsReview, prophylaxis, medVerification, env
    );

    // ── استخراج التدخلات الدوائية بشكل منظم ──────────────────
    const interventions = extractInterventions(medVerification, localMedCheck);

    // ── RESPONSE ─────────────────────────────────────────────
    return json({
      ok: true,
      renal: {
        scr_umol:     data.renal.scr_umol,
        scr_mgdl:     renal.scr_mgdl,
        crcl:         renal.crcl,
        ibw:          renal.ibw,
        abw_adj:      renal.abw_adj,
        weight_used:  renal.weight_used,
        weight_label: renal.weight_label,
        missing:      renal.missing,
        line:         renalLine,
      },
      missing_data:      data.missing ?? [],
      local_med_check:   localMedCheck,
      template1_soap,
      coverage,
      home_meds_review:  homeMedsReview,
      prophylaxis,
      med_verification:  medVerification,
      interventions:     interventions,
      final_note:        finalNote,
      protocols_found:   localProtocols ? "✅" : "❌",
    }, 200, CORS);

  } catch (err) {
    console.error("Pipeline error:", err);
    return json({ ok: false, error: err.message || "Internal server error" }, 500, CORS);
  }
}

// ============================================================
// دالة جديدة: فحص الأدوية بقواعد محلية (بدون AI)
// ============================================================
function runLocalMedicationCheck(data, renal) {
  const issues = [];
  const medications = [...(data.current_meds_list || [])];
  
  // قواعد محلية للأدوية الشائعة
  const drugRules = {
    // مضادات حيوية
    "piperacillin/tazobactam": (med) => {
      if (renal.crcl && renal.crcl < 40) {
        return {
          drug: med.name || "Piperacillin/Tazobactam",
          problem: "الجرعة تحتاج تعديل في حالة القصور الكلوي",
          recommendation: `ضبط الجرعة حسب CrCl = ${renal.crcl} mL/min`,
          evidence: "بروتوكول المضادات الحيوية - تعديل كلوي",
          severity: "high"
        };
      }
      return null;
    },
    
    "vancomycin": (med) => {
      if (renal.crcl && renal.crcl < 50) {
        return {
          drug: med.name || "Vancomycin",
          problem: "تحتاج مراقبة مستوى الدواء (TDM) وضبط الجرعة",
          recommendation: `تمدید الفاصل الزمني حسب CrCl، ومراقبة trough level`,
          evidence: "IDSA Guidelines for Vancomycin Dosing",
          severity: "high"
        };
      }
      return null;
    },
    
    // مميعات الدم
    "enoxaparin": (med) => {
      if (renal.crcl && renal.crcl < 30) {
        return {
          drug: med.name || "Enoxaparin",
          problem: "خطر تراكم الدواء وزيادة النزيف مع CrCl < 30",
          recommendation: "تقليل الجرعة إلى 30mg مرة يومياً أو استخدام بديل (UFH)",
          evidence: "CHEST Guidelines for Anticoagulation in Renal Impairment",
          severity: "high"
        };
      }
      // التحقق من الجرعة العلاجية
      const dose = extractDose(med.dose);
      if (dose && dose > 100 && renal.weight_used) {
        const recommendedDose = 1.5 * renal.weight_used; // 1.5 mg/kg/day
        if (Math.abs(dose - recommendedDose) > 20) {
          return {
            drug: med.name || "Enoxaparin",
            problem: "جرعة غير مناسبة للوزن",
            recommendation: `الجرعة الموصى بها: ${recommendedDose.toFixed(0)} mg/day`,
            evidence: "Weight-based dosing protocol",
            severity: "medium"
          };
        }
      }
      return null;
    },
    
    "warfarin": (med) => {
      // التحقق من INR
      const inr = extractINR(data.labs_text);
      if (inr && inr > 3.5) {
        return {
          drug: med.name || "Warfarin",
          problem: `INR مرتفع (${inr}) - خطر نزيف`,
          recommendation: "إيقاف الجرعة ومراجعة INR يومياً، إعطاء Vitamin K إذا كان INR > 4.5",
          evidence: "ACCP Antithrombotic Guidelines",
          severity: "high"
        };
      }
      return null;
    },
    
    // مدرات البول
    "furosemide": (med) => {
      // التحقق من البوتاسيوم
      const k = extractPotassium(data.labs_text);
      if (k && k < 3.5) {
        return {
          drug: med.name || "Furosemide",
          problem: `نقص بوتاسيوم (K = ${k}) مع استخدام مدر عروي`,
          recommendation: "مراقبة البوتاسيوم وتعويض النقص، النظر في إضافة مدر حافظ للبوتاسيوم",
          evidence: "Heart Failure Guidelines",
          severity: "medium"
        };
      }
      return null;
    },
    
    "spironolactone": (med) => {
      const k = extractPotassium(data.labs_text);
      if (k && k > 5.2) {
        return {
          drug: med.name || "Spironolactone",
          problem: `فرط بوتاسيوم (K = ${k}) مع سبيرونولاكتون`,
          recommendation: "إيقاف الدواء مؤقتاً أو تقليل الجرعة",
          evidence: "KDIGO Guidelines",
          severity: "high"
        };
      }
      
      // التحقق من وظائف الكلى
      if (renal.crcl && renal.crcl < 30) {
        return {
          drug: med.name || "Spironolactone",
          problem: "موانع استخدام سبيرونولاكتون مع CrCl < 30",
          recommendation: "إيقاف الدواء، خطر فرط بوتاسيوم",
          evidence: "KDIGO Guidelines",
          severity: "high"
        };
      }
      return null;
    },
    
    // أدوية السكري
    "metformin": (med) => {
      if (renal.crcl && renal.crcl < 45) {
        return {
          drug: med.name || "Metformin",
          problem: "خطر الحمض اللبني مع القصور الكلوي",
          recommendation: renal.crcl < 30 ? "إيقاف الميتفورمين" : "تقليل الجرعة ومراقبة الوظائف",
          evidence: "ADA Standards of Care",
          severity: "high"
        };
      }
      return null;
    },
    
    "empagliflozin": (med) => {
      if (renal.crcl && renal.crcl < 45) {
        return {
          drug: med.name || "Empagliflozin",
          problem: "لا ينصح باستخدام SGLT2i إذا CrCl < 45",
          recommendation: "إيقاف الدواء والنظر في بدائل أخرى",
          evidence: "ADA/EASD Guidelines",
          severity: "medium"
        };
      }
      return null;
    },
    
    // مثبطات الحمض
    "omeprazole": (med) => {
      // التحقق من التفاعل مع كلوبيدوجريل
      const hasClopidogrel = medications.some(m => 
        m.name?.toLowerCase().includes("clopidogrel")
      );
      if (hasClopidogrel) {
        return {
          drug: med.name || "Omeprazole",
          problem: "تفاعل دوائي: أوميبرازول يقلل فعالية كلوبيدوجريل",
          recommendation: "استخدام بانتوبرازول بدلاً من أوميبرازول",
          evidence: "FDA Drug Interaction Warning",
          severity: "medium"
        };
      }
      return null;
    }
  };
  
  // تطبيق القواعد على كل دواء
  medications.forEach(med => {
    if (!med.name) return;
    
    const medNameLower = med.name.toLowerCase();
    for (const [key, rule] of Object.entries(drugRules)) {
      if (medNameLower.includes(key)) {
        const issue = rule(med);
        if (issue) issues.push(issue);
      }
    }
  });
  
  // فحص التداخلات الدوائية
  issues.push(...checkDrugInteractions(medications, renal));
  
  return issues;
}

// ============================================================
// دالة جديدة: فحص التداخلات الدوائية
// ============================================================
function checkDrugInteractions(medications, renal) {
  const interactions = [];
  const medNames = medications.map(m => m.name?.toLowerCase() || "");
  
  // تفاعلات خطيرة
  const interactionRules = [
    {
      drugs: ["warfarin", "aspirin"],
      problem: "خطر نزيف مرتفع مع وارفارين + أسبرين",
      recommendation: "مراقبة INR يومياً، مراقبة علامات النزيف",
      severity: "high"
    },
    {
      drugs: ["warfarin", "enoxaparin"],
      problem: "تخثر مزدوج - خطر نزيف",
      recommendation: "تقييم ضرورة الاستخدام المشترك، مراقبة دقيقة",
      severity: "high"
    },
    {
      drugs: ["spironolactone", "lisinopril", "enalapril"],
      problem: "خطر فرط بوتاسيوم مع ACEI + سبيرونولاكتون",
      recommendation: "مراقبة البوتاسيوم يومياً، تقليل الجرعات إذا لزم",
      severity: "high"
    },
    {
      drugs: ["furosemide", "gentamicin", "tobramycin"],
      problem: "خطر سمية كلوية مع أمينوغليكوزيد + فوروسيمايد",
      recommendation: "مراقبة وظائف الكلى يومياً، تجنب الاستخدام المشترك إن أمكن",
      severity: "high"
    },
    {
      drugs: ["clarithromycin", "simvastatin", "atorvastatin"],
      problem: "خطر اعتلال عضلي مع ماكرولايد + ستاتين",
      recommendation: "إيقاف الستاتين مؤقتاً أو استخدام أزيثروميسين",
      severity: "medium"
    },
    {
      drugs: ["ciprofloxacin", "levofloxacin", "amiodarone"],
      problem: "خطر تطاول QT مع فلوروكينولون + أميودارون",
      recommendation: "مراقبة ECG، تجنب الاستخدام المشترك إن أمكن",
      severity: "medium"
    }
  ];
  
  interactionRules.forEach(rule => {
    const hasAllDrugs = rule.drugs.every(drug => 
      medNames.some(name => name.includes(drug))
    );
    
    if (hasAllDrugs) {
      interactions.push({
        drug: rule.drugs.join(" + "),
        problem: rule.problem,
        recommendation: rule.recommendation,
        evidence: "قاعدة بيانات التداخلات الدوائية",
        severity: rule.severity,
        type: "interaction"
      });
    }
  });
  
  return interactions;
}

// ============================================================
// دالة جديدة: استخراج التدخلات الدوائية
// ============================================================
function extractInterventions(aiVerification, localCheck) {
  const interventions = [];
  
  // إضافة التدخلات من الفحص المحلي
  localCheck.forEach(issue => {
    interventions.push({
      drug: issue.drug,
      problem: issue.problem,
      recommendation: issue.recommendation,
      evidence: issue.evidence,
      severity: issue.severity || "medium",
      source: "local_rules"
    });
  });
  
  // محاولة استخراج التدخلات من استجابة AI
  if (aiVerification && typeof aiVerification === 'string') {
    const lines = aiVerification.split('\n');
    let currentIntervention = null;
    
    lines.forEach(line => {
      if (line.includes('💊 DRUG:') || line.includes('DRUG:')) {
        if (currentIntervention) interventions.push(currentIntervention);
        currentIntervention = {
          drug: line.replace(/.*DRUG:\s*/i, '').trim(),
          problem: '',
          recommendation: '',
          evidence: '',
          source: 'ai_analysis'
        };
      } else if (currentIntervention) {
        if (line.includes('Problem:') || line.includes('Issue:')) {
          currentIntervention.problem = line.replace(/.*(Problem|Issue):\s*/i, '').trim();
        } else if (line.includes('Recommendation:') || line.includes('→')) {
          currentIntervention.recommendation = line.replace(/.*(Recommendation:|→)\s*/i, '').trim();
        } else if (line.includes('Evidence:')) {
          currentIntervention.evidence = line.replace(/.*Evidence:\s*/i, '').trim();
        }
      }
    });
    
    if (currentIntervention) interventions.push(currentIntervention);
  }
  
  return interventions;
}

// ============================================================
// دالة جديدة: معالجة الأسئلة المحددة
// ============================================================
async function handleSpecificQuestion(data, renal, question, protocols, env) {
  const q = question.toLowerCase();
  let answer = '';
  
  // قائمة بالأسئلة المحددة ومعالجتها
  if (q.includes('وظائف الكلى') || q.includes('crcl') || q.includes('creatinine')) {
    answer = `📊 **وظائف الكلى:**
• Creatinine: ${data.scr_umol || '?'} µmol/L (${renal.scr_mgdl || '?'} mg/dL)
• CrCl (Cockcroft-Gault): ${renal.crcl || '?'} mL/min
• الوزن المستخدم: ${renal.weight_used || '?'} kg (${renal.weight_label || '?'})
• IBW: ${renal.ibw || '?'} kg
• ABW adjusted: ${renal.abw_adj || '?'} kg

${
  renal.crcl < 30 ? '⚠️ **قصور كلوي حاد** - جميع الأدوية تحتاج مراجعة' :
  renal.crcl < 60 ? '⚠️ **قصور كلوي معتدل** - بعض الأدوية تحتاج تعديل' :
  '✅ **وظائف الكلى طبيعية**'
}`;
  }
  
  else if (q.includes('الأخطاء') || q.includes('problems') || q.includes('مشاكل')) {
    const localIssues = runLocalMedicationCheck(data, renal);
    if (localIssues.length > 0) {
      answer = '⚠️ **المشاكل الدوائية المكتشفة:**\n\n';
      localIssues.forEach((issue, i) => {
        answer += `**${i+1}. ${issue.drug}**\n`;
        answer += `• المشكلة: ${issue.problem}\n`;
        answer += `• التوصية: ${issue.recommendation}\n`;
        answer += `• الدليل: ${issue.evidence}\n`;
        answer += `• الخطورة: ${issue.severity === 'high' ? '🔴 عالية' : '🟡 متوسطة'}\n\n`;
      });
    } else {
      answer = '✅ لم يتم اكتشاف مشاكل دوائية بالقواعد المحلية';
    }
  }
  
  else if (q.includes('الادوية') || q.includes('medications')) {
    answer = '💊 **الأدوية الحالية:**\n';
    (data.current_meds_list || []).forEach(med => {
      answer += `• ${med.name || '?'} - ${med.dose || '?'} ${med.frequency || '?'}\n`;
    });
    
    answer += '\n🏠 **الأدوية المنزلية:**\n';
    (data.home_meds_list || []).forEach(med => {
      answer += `• ${med.name || '?'} - ${med.dose || '?'} ${med.frequency || '?'}\n`;
    });
  }
  
  else if (q.includes('تحاليل') || q.includes('labs')) {
    answer = '🔬 **نتائج المختبر:**\n';
    const labs = extractAllLabs(data.labs_text || '');
    Object.entries(labs).forEach(([key, value]) => {
      answer += `• ${key}: ${value}\n`;
    });
  }
  
  else {
    // استخدام AI للأسئلة المعقدة
    const system = `You are a clinical pharmacist answering specific questions.
Answer concisely in Arabic/English based on patient data.

Available protocols: ${protocols ? '✅ found' : '❌ not found'}

Patient: Age ${data.age || '?'}, CrCl ${renal.crcl || '?'} mL/min
Admission: ${data.reason_admission || '?'}`;

    answer = await OpenAICall(env, system, 
      `Question: ${question}\n\nPatient data: ${buildContext(data, renal.crcl)}`, 
      500
    );
  }
  
  return json({
    ok: true,
    question: question,
    answer: answer,
    renal: renal
  }, 200, CORS);
}

// ============================================================
// دالة جديدة: فحص هجين (قواعد محلية + AI)
// ============================================================
async function stepC5_medVerificationHybrid(data, renal, localIssues, protocols, env) {
  if (!data.current_meds_list?.length) {
    return "No current inpatient medications documented.";
  }
  
  const medNames = data.current_meds_list.map(m => m.name).join(", ");
  
  // بناء سياق من المشاكل المحلية
  const localContext = localIssues.length > 0 
    ? `\nLOCAL RULES DETECTED ISSUES:\n${JSON.stringify(localIssues, null, 2)}\n`
    : '';
  
  const system = `You are a clinical pharmacist performing medication review.
  
LOCAL RULES HAVE ALREADY FOUND THESE ISSUES (focus on other aspects):
${localContext}

For EACH medication, evaluate:
1. Indication appropriateness
2. Drug-drug interactions (not already caught)
3. Monitoring requirements
4. Duration of therapy
5. Any issues missed by local rules

Be specific and concise.`;

  const userMsg = `Patient: Age ${data.age || '?'}, CrCl ${renal.crcl || '?'} mL/min
Weight used: ${renal.weight_used || '?'} kg (${renal.weight_label || '?'})

Medications:
${JSON.stringify(data.current_meds_list, null, 2)}

Provide additional clinical insights beyond local rules.`;

  return OpenAICall(env, system, userMsg, 1500);
}

// ============================================================
// دوال مساعدة لاستخراج القيم من النصوص
// ============================================================

function extractDose(doseText) {
  if (!doseText) return null;
  const match = String(doseText).match(/(\d+\.?\d*)/);
  return match ? parseFloat(match[1]) : null;
}

function extractINR(labsText) {
  if (!labsText) return null;
  const match = labsText.match(/INR[:\s]+(\d+\.?\d*)/i);
  return match ? parseFloat(match[1]) : null;
}

function extractPotassium(labsText) {
  if (!labsText) return null;
  const match = labsText.match(/K[:\s]+(\d+\.?\d*)/i) || 
                labsText.match(/Potassium[:\s]+(\d+\.?\d*)/i);
  return match ? parseFloat(match[1]) : null;
}

function extractAllLabs(labsText) {
  const labs = {};
  const patterns = {
    'WBC': /WBC[:\s]+(\d+\.?\d*)/i,
    'Hb': /Hb[:\s]+(\d+\.?\d*)/i,
    'PLT': /(?:Platelets|PLT)[:\s]+(\d+)/i,
    'Cr': /(?:Creatinine|Cr)[:\s]+(\d+\.?\d*)/i,
    'Urea': /Urea[:\s]+(\d+\.?\d*)/i,
    'K': /K[:\s]+(\d+\.?\d*)/i,
    'Na': /Na[:\s]+(\d+)/i,
    'INR': /INR[:\s]+(\d+\.?\d*)/i
  };
  
  Object.entries(patterns).forEach(([key, pattern]) => {
    const match = labsText.match(pattern);
    if (match) labs[key] = match[1];
  });
  
  return labs;
}

// ============================================================
// تحسين دوال البحث في Vector Store
// ============================================================
async function searchVectorStore(query, env, maxResults = 8) {
  if (!env.OPENAI_API_KEY) { console.warn("⚠️ VS: no API key"); return ""; }
  if (!env.VECTOR_STORE_ID) { console.warn("⚠️ VS: no VECTOR_STORE_ID"); return ""; }

  console.log(`🔎 VS search: "${query.substring(0, 80)}..."`);

  try {
    // تجربة البحث أولاً
    const res = await fetch(
      `https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type":  "application/json",
          "OpenAI-Beta":   "assistants=v2",
        },
        body: JSON.stringify({ 
          query, 
          max_num_results: maxResults, 
          include_metadata: true,
          ranking_options: { score_threshold: 0.3 } // تجاهل النتائج الضعيفة
        }),
      }
    );

    if (!res.ok) {
      console.warn(`⚠️ VS search failed: ${res.status}`);
      return "";
    }

    const result = await res.json();
    const hits = result?.data?.length ?? 0;
    
    if (!hits) return "";
    
    // تنظيم النتائج بشكل أفضل
    return result.data
      .filter(item => item.score > 0.5) // فقط النتائج ذات الصلة العالية
      .map((item, i) => {
        const content = extractContent(item);
        const filename = item.filename || item.file_id || `Protocol ${i + 1}`;
        const page = item.metadata?.page || item.metadata?.section || "";
        const score = item.score?.toFixed(3) || "?";
        const pageInfo = page ? ` [صفحة ${page}]` : "";
        
        return `[المصدر ${i+1}: ${filename}${pageInfo} (الصلة: ${score})]\n${content.substring(0, 800)}`;
      }).join("\n\n---\n\n");

  } catch (err) {
    console.error("❌ VS fetch error:", err.message);
    return "";
  }
}

// تحديث دوال stepC2, stepC3, stepC4, stepC5 لقبول protocols كمدخل
// (سيتم تعديلها بنفس النمط - يمكنني إرسال التحديثات الكاملة إذا أردت)

// ============================================================
// HELPER: Build patient context block
// ============================================================
function buildContext(data, renalLine) {
  return `MRN: ${data.mrn ?? "—"}
Age: ${data.age ?? "—"} Y | Sex: ${data.sex ?? "—"} | Weight: ${data.weight_kg ?? "—"} kg | Height: ${data.height_raw ?? "—"}
Ward: ${data.ward ?? "—"}
Reason for Admission: ${data.reason_admission ?? "N/A"}
PMH: ${data.pmh ?? "N/A"}
Allergies: ${data.allergies ?? "N/A"}
Home Medications: ${data.home_meds_text ?? "N/A"}
Vitals: ${data.vitals_text ?? "N/A"}
Labs: ${data.labs_text ?? "N/A"}
Imaging: ${data.imaging ?? "N/A"}
Current Inpatient Medications: ${data.current_meds_text ?? "N/A"}
Renal: ${renalLine}`.trim();
}

// ============================================================
// HELPER: Extract content from vector store item
// ============================================================
function extractContent(item) {
  if (!item.content) return item.text || "";
  if (Array.isArray(item.content)) return item.content.map(c => c.text || c.value || "").join("\n");
  if (typeof item.content === "string") return item.content;
  if (item.content.text) return item.content.text;
  return item.text || "";
}

// ============================================================
// HELPER: OpenAI chat completion
// ============================================================
async function OpenAICall(env, system, userMessage, maxTokens = 800) {
  const model = env.MODEL || "gpt-4-turbo-preview";
  console.log(`🤖 OpenAI call | model=${model} | maxTokens=${maxTokens}`);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("❌ OpenAI error:", err);
    throw new Error(`OpenAI API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ============================================================
// HELPER: JSON HTTP response
// ============================================================
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// ملاحظة: دوال stepC2, stepC3, stepC4, stepC5, stepC6 تحتاج تحديث
// لقبول protocols parameter - يمكنني إضافتها إذا أردت
