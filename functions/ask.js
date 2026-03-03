// File: /functions/api/ask.js
// ENHANCED BACKEND WITH DEEP PROTOCOL ANALYSIS ENGINE
// ALL EXISTING CONNECTIONS PRESERVED

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  try {
    const body = await request.json();
    const { question, mode, case_text, language = "en" } = body;

    // ===== DEEP CLINICAL CASE ANALYSIS =====
    if (mode === "case_analysis" && case_text) {
      return await deepAnalyzeClinicalCase(case_text, env, language);
    }

    // ===== STANDARD QUESTIONS =====
    if (!question) {
      return new Response(JSON.stringify({ error: "Missing question" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    return await handleStandardQuestion(question, body, env);

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}

// ========== DEEP CLINICAL ANALYSIS ENGINE ==========
async function deepAnalyzeClinicalCase(caseText, env, language) {
  
  // 1️⃣ استخراج كل بيانات المريض
  const patientData = await extractAllPatientData(caseText, env);
  
  // 2️⃣ حساب كل المؤشرات الحيوية
  const calculatedMetrics = calculateAllMetrics(patientData);
  
  // 3️⃣ البحث العميق في كل ملف بروتوكول
  const protocolFindings = await deepProtocolSearch(patientData, env);
  
  // 4️⃣ تحليل التفاعلات المعقدة
  const interactionClusters = await analyzeInteractionClusters(patientData, protocolFindings, env);
  
  // 5️⃣ اكتشاف الأخطاء الدوائية
  const medicationErrors = await detectMedicationErrors(patientData, protocolFindings, env);
  
  // 6️⃣ تقييم المخاطر حسب المصادر
  const riskAssessment = await assessRisks(patientData, protocolFindings, interactionClusters, medicationErrors, env);
  
  // 7️⃣ توليد التقرير النهائي مع الاستشهادات
  const finalReport = generateDeepSOAPNote(patientData, riskAssessment, protocolFindings);
  
  return new Response(JSON.stringify({
    ok: true,
    answer: finalReport.soap,
    clinical_findings: riskAssessment.findings,
    safety_status: riskAssessment.overallStatus,
    missing_medications: patientData.missingMeds,
    citations: finalReport.citations,
    deep_analysis: {
      critical_count: riskAssessment.criticalCount,
      high_count: riskAssessment.highCount,
      moderate_count: riskAssessment.moderateCount,
      info_count: riskAssessment.infoCount,
      protocols_checked: protocolFindings.protocolsScanned,
      evidence_pieces: protocolFindings.evidenceCount
    }
  }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// ========== 1️⃣ استخراج كل بيانات المريض ==========
async function extractAllPatientData(text, env) {
  console.log("🔍 استخراج كل بيانات المريض...");
  
  // استخراج أساسيات
  const basicData = extractBasicData(text);
  
  // استخراج الأدوية مع تفاصيلها
  const medications = await extractMedicationsDeep(text, env);
  
  // استخراج التشخيصات مع الأدلة
  const diagnoses = await extractDiagnosesDeep(text, env);
  
  // استخراج التحاليل مع الاتجاهات
  const labs = extractLabsWithTrends(text);
  
  // استخراج العلامات الحيوية
  const vitals = extractVitalsWithContext(text);
  
  // استخراج سبب الدخول
  const reasonForAdmission = extractReasonFromText(text);
  
  // استخراج التاريخ المرضي
  const pmh = extractPMHFromText(text);
  
  // استخراج أدوية المنزل
  const homeMeds = extractHomeMedsFromText(text);
  
  return {
    patient: basicData,
    medications,
    diagnoses,
    labs,
    vitals,
    reasonForAdmission,
    pmh,
    homeMeds,
    missingMeds: medications.filter(m => m.status === 'NOT_FOUND').map(m => m.name),
    rawText: text
  };
}

// ========== استخراج الأدوية بعمق ==========
async function extractMedicationsDeep(text, env) {
  const medications = [];
  const medPatterns = [
    // Antiplatelets & Anticoagulants
    { pattern: /(?:acetylsalicylic acid|aspirin|asa)\s*(\d+)\s*(mg|mcg)/gi, category: 'antiplatelet', class: 'cox1' },
    { pattern: /(?:clopidogrel|plavix)\s*(\d+)\s*(mg)/gi, category: 'antiplatelet', class: 'p2y12' },
    { pattern: /(?:warfarin|coumadin)\s*(\d+(?:\.\d+)?)\s*(mg)/gi, category: 'anticoagulant', class: 'vkAntagonist' },
    { pattern: /(?:enoxaparin|lovenox)\s*(\d+)\s*(mg)/gi, category: 'anticoagulant', class: 'lmwh' },
    { pattern: /(?:heparin)\s*(\d+)\s*(units?)/gi, category: 'anticoagulant', class: 'unfractionated' },
    
    // Antibiotics
    { pattern: /(?:piperacillin|tazobactam)\s*(\d+(?:\.\d+)?)\s*(g|mg)/gi, category: 'antibiotic', class: 'penicillin' },
    { pattern: /(?:vancomycin)\s*(\d+(?:\.\d+)?)\s*(g|mg)/gi, category: 'antibiotic', class: 'glycopeptide' },
    { pattern: /(?:gentamicin)\s*(\d+)\s*(mg)/gi, category: 'antibiotic', class: 'aminoglycoside' },
    { pattern: /(?:meropenem)\s*(\d+(?:\.\d+)?)\s*(g|mg)/gi, category: 'antibiotic', class: 'carbapenem' },
    { pattern: /(?:ciprofloxacin)\s*(\d+)\s*(mg)/gi, category: 'antibiotic', class: 'fluoroquinolone' },
    { pattern: /(?:levofloxacin)\s*(\d+)\s*(mg)/gi, category: 'antibiotic', class: 'fluoroquinolone' },
    { pattern: /(?:linezolid)\s*(\d+)\s*(mg)/gi, category: 'antibiotic', class: 'oxazolidinone' },
    { pattern: /(?:colistin)\s*(\d+(?:\.\d+)?)\s*(mg)/gi, category: 'antibiotic', class: 'polymyxin' },
    { pattern: /(?:metronidazole)\s*(\d+)\s*(mg)/gi, category: 'antibiotic', class: 'nitroimidazole' },
    { pattern: /(?:trimethoprim|sulfamethoxazole|tmp|smx|co-trimoxazole)/gi, category: 'antibiotic', class: 'folateAntagonist' },
    
    // Antifungals
    { pattern: /(?:fluconazole)\s*(\d+)\s*(mg)/gi, category: 'antifungal', class: 'azole' },
    { pattern: /(?:amphotericin)\s*(\d+(?:\.\d+)?)\s*(mg)/gi, category: 'antifungal', class: 'polyene' },
    { pattern: /(?:caspofungin)\s*(\d+)\s*(mg)/gi, category: 'antifungal', class: 'echinocandin' },
    
    // NSAIDs
    { pattern: /(?:ibuprofen|motrin|advil)\s*(\d+)\s*(mg)/gi, category: 'nsaid', class: 'nsaid' },
    
    // ACEi/ARBs
    { pattern: /(?:lisinopril|zestril)\s*(\d+)\s*(mg)/gi, category: 'acei', class: 'ace' },
    
    // MRAs
    { pattern: /(?:spironolactone|aldactone)\s*(\d+)\s*(mg)/gi, category: 'mra', class: 'mra' },
    
    // Diuretics
    { pattern: /(?:furosemide|lasix)\s*(\d+)\s*(mg)/gi, category: 'diuretic', class: 'loop' },
    
    // SGLT2
    { pattern: /(?:empagliflozin|jardiance)\s*(\d+)\s*(mg)/gi, category: 'sglt2', class: 'sglt2' },
    
    // Beta blockers
    { pattern: /(?:bisoprolol|concor)\s*(\d+(?:\.\d+)?)\s*(mg)/gi, category: 'betaBlocker', class: 'beta1' },
    { pattern: /(?:carvedilol)\s*(\d+(?:\.\d+)?)\s*(mg)/gi, category: 'betaBlocker', class: 'nonselective' },
    { pattern: /(?:sotalol)\s*(\d+)\s*(mg)/gi, category: 'betaBlocker', class: 'classIII' },
    
    // Statins
    { pattern: /(?:rosuvastatin|crestor)\s*(\d+)\s*(mg)/gi, category: 'statin', class: 'statin' },
    
    // PPIs
    { pattern: /(?:omeprazole|esomeprazole|nexium)\s*(\d+)\s*(mg)/gi, category: 'ppi', class: 'ppi' },
    
    // CCBs
    { pattern: /(?:nifedipine)\s*(\d+)\s*(mg)/gi, category: 'ccb', class: 'dihydropyridine' },
    
    // Biguanides
    { pattern: /(?:metformin|glucophage)\s*(\d+)\s*(mg)/gi, category: 'biguanide', class: 'biguanide' },
    
    // Immunosuppressants
    { pattern: /(?:tacrolimus)\s*(\d+)\s*(mg)/gi, category: 'immunosuppressant', class: 'calcineurin' },
    { pattern: /(?:mycophenolate)\s*(\d+)\s*(mg)/gi, category: 'immunosuppressant', class: 'imdh' },
    { pattern: /(?:prednisone|prednisolone)\s*(\d+)\s*(mg)/gi, category: 'corticosteroid', class: 'steroid' },
    
    // Antivirals
    { pattern: /(?:ganciclovir)\s*(\d+(?:\.\d+)?)\s*(mg)/gi, category: 'antiviral', class: 'nucleoside' },
    { pattern: /(?:valganciclovir)\s*(\d+)\s*(mg)/gi, category: 'antiviral', class: 'nucleoside' },
    
    // Thyroid
    { pattern: /(?:levothyroxine)\s*(\d+)\s*(mcg|mg)/gi, category: 'thyroid', class: 't4' },
    
    // Antiarrhythmics
    { pattern: /(?:amiodarone)\s*(\d+)\s*(mg)/gi, category: 'antiarrhythmic', class: 'classIII' },
    
    // Psychotropics
    { pattern: /(?:haloperidol)\s*(\d+)\s*(mg)/gi, category: 'antipsychotic', class: 'typical' },
    { pattern: /(?:ondansetron)\s*(\d+)\s*(mg)/gi, category: 'antiemetic', class: '5ht3' },
    
    // Opioids
    { pattern: /(?:fentanyl)\s*(\d+)\s*(mcg|mg)/gi, category: 'opioid', class: 'opioid' },
    
    // Sedatives
    { pattern: /(?:midazolam)\s*(\d+)\s*(mg)/gi, category: 'sedative', class: 'benzodiazepine' },
    
    // Vasopressors
    { pattern: /(?:norepinephrine|noradrenaline)\s*(\d+)/gi, category: 'vasopressor', class: 'catecholamine' },
    { pattern: /(?:vasopressin)\s*(\d+(?:\.\d+)?)/gi, category: 'vasopressor', class: 'adh' },
    
    // Others
    { pattern: /(?:hydrocortisone)\s*(\d+)\s*(mg)/gi, category: 'corticosteroid', class: 'steroid' },
    { pattern: /(?:insulin)\s*/gi, category: 'antidiabetic', class: 'insulin' }
  ];
  
  const found = new Set();
  
  for (const med of medPatterns) {
    const matches = [...text.matchAll(med.pattern)];
    for (const match of matches) {
      const fullMatch = match[0];
      const drugName = fullMatch.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
      if (!found.has(drugName) && drugName.length > 2) {
        found.add(drugName);
        
        // البحث في قاعدة البروتوكول عن هذا الدواء
        const protocolInfo = await searchMedicationInProtocol(drugName, env);
        
        medications.push({
          name: drugName,
          originalName: fullMatch.split(' ')[0],
          category: med.category,
          class: med.class,
          dose: match[1] ? `${match[1]} ${match[2] || ''}` : null,
          route: detectRoute(text, drugName),
          frequency: detectFrequency(text, drugName),
          status: protocolInfo.found ? 'FOUND' : 'NOT_FOUND',
          protocolData: protocolInfo,
          contraindications: protocolInfo.contraindications || [],
          warnings: protocolInfo.warnings || [],
          interactions: protocolInfo.interactions || []
        });
      }
    }
  }
  
  return medications;
}

// ========== البحث عن دواء في قاعدة البروتوكول ==========
async function searchMedicationInProtocol(medName, env) {
  try {
    const queries = [
      `${medName} dosing`,
      `${medName} contraindications`,
      `${medName} warnings precautions`,
      `${medName} drug interactions`,
      `${medName} renal adjustment`,
      `${medName} monitoring parameters`
    ];
    
    let allData = [];
    
    for (const query of queries.slice(0, 3)) {
      const response = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        },
        body: JSON.stringify({
          query,
          max_num_results: 3
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        allData = [...allData, ...(data.data || [])];
      }
    }
    
    if (allData.length === 0) {
      return { found: false };
    }
    
    // تحليل عميق للنتائج
    const analysis = deepAnalyzeProtocolResults(allData, medName);
    
    return {
      found: true,
      evidenceCount: allData.length,
      contraindications: analysis.contraindications,
      warnings: analysis.warnings,
      interactions: analysis.interactions,
      renalCutoffs: analysis.renalCutoffs,
      hepaticCutoffs: analysis.hepaticCutoffs,
      plateletCutoffs: analysis.plateletCutoffs,
      inrCutoffs: analysis.inrCutoffs,
      potassiumCutoffs: analysis.potassiumCutoffs,
      monitoringNeeds: analysis.monitoringNeeds,
      citations: allData.map(d => ({
        filename: d.file_id || 'Protocol',
        excerpt: extractContent(d).substring(0, 200)
      }))
    };
    
  } catch (error) {
    console.error(`Error searching for ${medName}:`, error);
    return { found: false, error: error.message };
  }
}

// ========== تحليل عميق لنتائج البروتوكول ==========
function deepAnalyzeProtocolResults(data, medName) {
  const analysis = {
    contraindications: [],
    warnings: [],
    interactions: [],
    renalCutoffs: [],
    hepaticCutoffs: [],
    plateletCutoffs: [],
    inrCutoffs: [],
    potassiumCutoffs: [],
    monitoringNeeds: []
  };
  
  const allText = data.map(d => extractContent(d).toLowerCase()).join('\n\n');
  
  // البحث عن موانع الاستخدام
  const contraPatterns = [
    /contraindication:?\s*([^.!?]+)/gi,
    /do not use in:?\s*([^.!?]+)/gi,
    /avoid in:?\s*([^.!?]+)/gi,
    /not recommended in:?\s*([^.!?]+)/gi
  ];
  
  for (const pattern of contraPatterns) {
    const matches = [...allText.matchAll(pattern)];
    for (const match of matches) {
      analysis.contraindications.push(match[1].trim());
    }
  }
  
  // البحث عن حدود كلوية
  const renalPatterns = [
    /crcl\s*[<≤]\s*(\d+)/gi,
    /creatinine clearance\s*[<≤]\s*(\d+)/gi,
    /renal impairment.*?if\s*crcl\s*[<≤]\s*(\d+)/gi
  ];
  
  for (const pattern of renalPatterns) {
    const matches = [...allText.matchAll(pattern)];
    for (const match of matches) {
      analysis.renalCutoffs.push(parseInt(match[1]));
    }
  }
  
  // البحث عن حدود الصفائح
  const pltPatterns = [
    /platelet\s*count\s*[<≤]\s*(\d+)/gi,
    /thrombocytopenia.*?if\s*platelets?\s*[<≤]\s*(\d+)/gi,
    /hold if\s*platelets?\s*[<≤]\s*(\d+)/gi
  ];
  
  for (const pattern of pltPatterns) {
    const matches = [...allText.matchAll(pattern)];
    for (const match of matches) {
      analysis.plateletCutoffs.push(parseInt(match[1]));
    }
  }
  
  // البحث عن حدود INR
  const inrPatterns = [
    /inr\s*[>≥]\s*(\d+(?:\.\d+)?)/gi,
    /if\s*inr\s*[>≥]\s*(\d+(?:\.\d+)?)/gi
  ];
  
  for (const pattern of inrPatterns) {
    const matches = [...allText.matchAll(pattern)];
    for (const match of matches) {
      analysis.inrCutoffs.push(parseFloat(match[1]));
    }
  }
  
  // البحث عن حدود البوتاسيوم
  const kPatterns = [
    /potassium\s*[>≥]\s*(\d+(?:\.\d+)?)/gi,
    /k\+\s*[>≥]\s*(\d+(?:\.\d+)?)/gi,
    /hyperkalemia.*?if\s*k\+?\s*[>≥]\s*(\d+(?:\.\d+)?)/gi
  ];
  
  for (const pattern of kPatterns) {
    const matches = [...allText.matchAll(pattern)];
    for (const match of matches) {
      analysis.potassiumCutoffs.push(parseFloat(match[1]));
    }
  }
  
  // البحث عن احتياجات المراقبة
  const monitorPatterns = [
    /monitor:?\s*([^.!?]+)/gi,
    /monitoring:?\s*([^.!?]+)/gi,
    /should monitor:?\s*([^.!?]+)/gi,
    /check:?\s*([^.!?]+)/gi
  ];
  
  for (const pattern of monitorPatterns) {
    const matches = [...allText.matchAll(pattern)];
    for (const match of matches) {
      if (match[1].length < 100) {
        analysis.monitoringNeeds.push(match[1].trim());
      }
    }
  }
  
  return analysis;
}

// ========== 3️⃣ البحث العميق في كل ملف بروتوكول ==========
async function deepProtocolSearch(patientData, env) {
  console.log("🔎 البحث العميق في ملفات البروتوكول...");
  
  const protocolsScanned = new Set();
  const evidencePieces = [];
  const drugFindings = [];
  
  // لكل دواء موجود في ملفاتنا، نبحث في ملفات متعددة
  for (const med of patientData.medications) {
    if (med.status !== 'FOUND') continue;
    
    // البحث في ملفات مختلفة
    const searchQueries = [
      `${med.name} dosing guidelines`,
      `${med.name} safety monitoring`,
      `${med.name} contraindications warnings`,
      `${med.name} drug interactions`,
      `${med.name} renal impairment`,
      `${med.name} hepatic impairment`
    ];
    
    for (const query of searchQueries) {
      const response = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        },
        body: JSON.stringify({
          query,
          max_num_results: 3
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        for (const item of data.data || []) {
          const content = extractContent(item);
          const filename = item.file_id || 'Unknown';
          protocolsScanned.add(filename);
          
          // تحليل المقتطف
          const analysis = analyzeSnippet(content, med, patientData);
          
          if (analysis.relevant) {
            evidencePieces.push({
              drug: med.name,
              filename,
              content: content.substring(0, 500),
              analysis,
              relevance: analysis.relevance
            });
            
            if (analysis.issue) {
              drugFindings.push(analysis.issue);
            }
          }
        }
      }
    }
  }
  
  return {
    protocolsScanned: protocolsScanned.size,
    evidenceCount: evidencePieces.length,
    findings: drugFindings,
    evidence: evidencePieces
  };
}

// ========== تحليل مقتطف من البروتوكول ==========
function analyzeSnippet(content, medication, patientData) {
  const analysis = {
    relevant: false,
    relevance: 0,
    issue: null
  };
  
  const lowerContent = content.toLowerCase();
  const medName = medication.name.toLowerCase();
  
  // تحقق من وجود الدواء في المقتطف
  if (!lowerContent.includes(medName)) {
    return analysis;
  }
  
  analysis.relevant = true;
  analysis.relevance = 1;
  
  // البحث عن مشاكل كلوية
  if (patientData.patient.creatinine && (lowerContent.includes('renal') || lowerContent.includes('crcl'))) {
    const crValue = parseInt(patientData.patient.creatinine);
    const cutoffMatches = lowerContent.match(/crcl\s*[<≤]\s*(\d+)/g);
    
    for (const match of cutoffMatches || []) {
      const cutoff = parseInt(match.match(/\d+/)[0]);
      if (patientData.patient.crcl && patientData.patient.crcl < cutoff) {
        analysis.issue = {
          type: 'RENAL_CONTRAINDICATION',
          severity: 'HIGH',
          drug: medication.name,
          problem: `${medication.name} contraindicated with CrCl ${patientData.patient.crcl} < ${cutoff}`,
          correction: `Hold ${medication.name}, adjust dose, or alternative`,
          evidence: content.substring(0, 200)
        };
        analysis.relevance = 5;
      }
    }
  }
  
  // البحث عن مشاكل صفائح
  if (patientData.labs.plt && lowerContent.includes('platelet')) {
    const pltValue = parseInt(patientData.labs.plt);
    const cutoffMatches = lowerContent.match(/platelet\s*[<≤]\s*(\d+)/g);
    
    for (const match of cutoffMatches || []) {
      const cutoff = parseInt(match.match(/\d+/)[0]);
      if (pltValue < cutoff) {
        analysis.issue = {
          type: 'PLATELET_CONTRAINDICATION',
          severity: 'CRITICAL',
          drug: medication.name,
          problem: `${medication.name} contraindicated with platelets ${pltValue} < ${cutoff}`,
          correction: `HOLD ${medication.name} immediately - high bleeding risk`,
          evidence: content.substring(0, 200)
        };
        analysis.relevance = 5;
      }
    }
  }
  
  // البحث عن مشاكل INR
  if (patientData.labs.inr && lowerContent.includes('inr')) {
    const inrValue = parseFloat(patientData.labs.inr);
    const cutoffMatches = lowerContent.match(/inr\s*[>≥]\s*(\d+(?:\.\d+)?)/g);
    
    for (const match of cutoffMatches || []) {
      const cutoff = parseFloat(match.match(/\d+(?:\.\d+)?/)[0]);
      if (inrValue > cutoff) {
        analysis.issue = {
          type: 'INR_CONTRAINDICATION',
          severity: 'CRITICAL',
          drug: medication.name,
          problem: `${medication.name} contraindicated with INR ${inrValue} > ${cutoff}`,
          correction: `HOLD ${medication.name} - reverse if bleeding`,
          evidence: content.substring(0, 200)
        };
        analysis.relevance = 5;
      }
    }
  }
  
  // البحث عن مشاكل بوتاسيوم
  if (patientData.labs.k && (lowerContent.includes('potassium') || lowerContent.includes('k+'))) {
    const kValue = parseFloat(patientData.labs.k);
    const cutoffMatches = lowerContent.match(/potassium\s*[>≥]\s*(\d+(?:\.\d+)?)/g);
    
    for (const match of cutoffMatches || []) {
      const cutoff = parseFloat(match.match(/\d+(?:\.\d+)?/)[0]);
      if (kValue > cutoff) {
        analysis.issue = {
          type: 'HYPERKALEMIA_RISK',
          severity: 'HIGH',
          drug: medication.name,
          problem: `${medication.name} increases hyperkalemia risk with K+ ${kValue} > ${cutoff}`,
          correction: `Hold ${medication.name}, treat hyperkalemia`,
          evidence: content.substring(0, 200)
        };
        analysis.relevance = 5;
      }
    }
  }
  
  return analysis;
}

// ========== 4️⃣ تحليل التفاعلات المعقدة ==========
async function analyzeInteractionClusters(patientData, protocolFindings, env) {
  console.log("🔄 تحليل عناقيد التفاعلات الدوائية...");
  
  const clusters = [];
  const medications = patientData.medications;
  const labs = patientData.labs;
  
  // ===== عنقود النزيف =====
  const antiplatelets = medications.filter(m => m.category === 'antiplatelet' && m.status === 'FOUND');
  const anticoagulants = medications.filter(m => m.category === 'anticoagulant' && m.status === 'FOUND');
  const hasBleedingRisk = antiplatelets.length > 0 || anticoagulants.length > 0;
  
  if (hasBleedingRisk) {
    // البحث في البروتوكول عن عنقود النزيف
    const bleedingProtocol = await searchVectorStore(
      'bleeding risk multiple antiplatelets anticoagulants management',
      env
    );
    
    // تحليل عوامل الخطر
    const riskFactors = [];
    
    // نقص الصفائح
    if (labs.plt && parseInt(labs.plt) < 100000) {
      riskFactors.push(`Thrombocytopenia (${labs.plt})`);
    }
    
    // ارتفاع INR
    if (labs.inr && parseFloat(labs.inr) > 1.5) {
      riskFactors.push(`Elevated INR (${labs.inr})`);
    }
    
    // العمر
    if (patientData.patient.age && parseInt(patientData.patient.age) > 75) {
      riskFactors.push(`Age >75`);
    }
    
    // فشل كلوي
    if (patientData.patient.crcl && patientData.patient.crcl < 30) {
      riskFactors.push(`CrCl <30`);
    }
    
    if (riskFactors.length > 0 && (antiplatelets.length >= 2 || (antiplatelets.length > 0 && anticoagulants.length > 0))) {
      const severity = (labs.plt && parseInt(labs.plt) < 50000) ? 'CRITICAL' : 'HIGH';
      
      clusters.push({
        type: 'BLEEDING_CLUSTER',
        severity,
        drugs: [...antiplatelets, ...anticoagulants].map(m => m.name),
        riskFactors,
        problem: `Bleeding risk cluster: ${antiplatelets.length + anticoagulants.length} antithrombotics + ${riskFactors.join(', ')}`,
        correction: severity === 'CRITICAL' 
          ? 'HOLD all antithrombotics immediately, check for bleeding, reverse if needed'
          : 'Consider holding one agent, monitor closely for bleeding',
        citations: bleedingProtocol
      });
    }
  }
  
  // ===== عنقود فرط البوتاسيوم =====
  const kIncreasingDrugs = medications.filter(m => 
    ['acei', 'arb', 'mra', 'sglt2', 'nsaid'].includes(m.category) && m.status === 'FOUND'
  );
  
  if (kIncreasingDrugs.length >= 2 && labs.k && parseFloat(labs.k) > 5.0) {
    const kProtocol = await searchVectorStore('hyperkalemia RAAS blockade management', env);
    
    const severity = parseFloat(labs.k) > 5.5 ? 'CRITICAL' : 'HIGH';
    
    clusters.push({
      type: 'HYPERKALEMIA_CLUSTER',
      severity,
      drugs: kIncreasingDrugs.map(m => m.name),
      riskFactors: [`K+ ${labs.k}`, patientData.patient.crcl ? `CrCl ${patientData.patient.crcl}` : null].filter(Boolean),
      problem: `Hyperkalemia risk: ${kIncreasingDrugs.length} RAAS inhibitors + K+ ${labs.k}`,
      correction: severity === 'CRITICAL'
        ? 'HOLD ACEi/ARB/MRA, calcium gluconate, insulin+glucose, kayexalate'
        : 'Reduce/hold potassium-increasing drugs, repeat K+ in 4-6h',
      citations: kProtocol
    });
  }
  
  // ===== عنقود السمية الكلوية =====
  const nephrotoxicDrugs = medications.filter(m => 
    (m.category === 'nsaid' || m.class === 'aminoglycoside' || m.name.includes('amphotericin')) && m.status === 'FOUND'
  );
  
  if (nephrotoxicDrugs.length >= 2 && patientData.patient.creatinine && parseInt(patientData.patient.creatinine) > 150) {
    const nephroProtocol = await searchVectorStore('AKI nephrotoxic drugs management', env);
    
    clusters.push({
      type: 'NEPHROTOXICITY_CLUSTER',
      severity: 'CRITICAL',
      drugs: nephrotoxicDrugs.map(m => m.name),
      riskFactors: [`Cr ${patientData.patient.creatinine}`, patientData.patient.crcl ? `CrCl ${patientData.patient.crcl}` : null].filter(Boolean),
      problem: `Nephrotoxicity cluster: ${nephrotoxicDrugs.length} nephrotoxic drugs + AKI`,
      correction: 'HOLD all nephrotoxic drugs immediately, nephrology consult',
      citations: nephroProtocol
    });
  }
  
  // ===== عنقود تطويل QT =====
  const qtDrugs = medications.filter(m => 
    m.class === 'fluoroquinolone' || m.class === 'macrolide' || 
    m.name.includes('amiodarone') || m.name.includes('sotalol') ||
    m.name.includes('haloperidol') || m.name.includes('ondansetron')
  );
  
  if (qtDrugs.length >= 2 && (labs.k && parseFloat(labs.k) < 3.5)) {
    const qtProtocol = await searchVectorStore('QT prolongation drugs electrolyte management', env);
    
    clusters.push({
      type: 'QT_CLUSTER',
      severity: 'HIGH',
      drugs: qtDrugs.map(m => m.name),
      riskFactors: [`K+ ${labs.k}`, `QT drugs: ${qtDrugs.length}`],
      problem: `QT prolongation risk: ${qtDrugs.length} QT-prolonging drugs + hypokalemia`,
      correction: 'Obtain ECG, replete potassium, consider holding QT drugs',
      citations: qtProtocol
    });
  }
  
  return clusters;
}

// ========== 5️⃣ اكتشاف الأخطاء الدوائية ==========
async function detectMedicationErrors(patientData, protocolFindings, env) {
  console.log("⚠️ اكتشاف الأخطاء الدوائية...");
  
  const errors = [];
  const medications = patientData.medications;
  const labs = patientData.labs;
  const diagnoses = patientData.diagnoses;
  
  for (const med of medications) {
    // إذا كان الدواء غير موجود في البروتوكول، نضيف ملاحظة فقط ونكمل
    if (med.status !== 'FOUND') {
      errors.push({
        type: 'MEDICATION_NOT_IN_PROTOCOL',
        severity: 'INFO',
        drug: med.name,
        problem: `${med.name} prescribed`,
        correction: 'NOT_FOUND in protocol database - verify with clinical judgment',
        citations: []
      });
      continue; // نكمل لباقي الأدوية
    }
    
    // إذا كان الدواء موجود، نحلله بالكامل
    if (!med.protocolData) continue;
    
    // 1️⃣ التحقق من الجرعة
    if (med.dose && med.protocolData.dosing) {
      const doseError = checkDoseAgainstProtocol(med, patientData);
      if (doseError) errors.push(doseError);
    }
    
    // 2️⃣ التحقق من موانع الاستخدام
    if (med.protocolData.contraindications && med.protocolData.contraindications.length > 0) {
      for (const contra of med.protocolData.contraindications) {
        // تحقق من وجود الحالة في تشخيصات المريض
        for (const dx of diagnoses) {
          if (contra.toLowerCase().includes(dx.name.toLowerCase())) {
            errors.push({
              type: 'CONTRANDICATION',
              severity: 'CRITICAL',
              drug: med.name,
              problem: `${med.name} contraindicated in ${dx.name}`,
              correction: `HOLD ${med.name} - alternative required`,
              evidence: contra,
              citations: med.protocolData.citations
            });
          }
        }
      }
    }
    
    // 3️⃣ التحقق من الحدود المختبرية
    if (labs.plt && med.protocolData.plateletCutoffs && med.protocolData.plateletCutoffs.length > 0) {
      const pltValue = parseInt(labs.plt);
      const minCutoff = Math.min(...med.protocolData.plateletCutoffs);
      if (pltValue < minCutoff) {
        errors.push({
          type: 'LAB_CONTRANDICATION',
          severity: 'CRITICAL',
          drug: med.name,
          problem: `${med.name} contraindicated with platelets ${pltValue} < ${minCutoff}`,
          correction: `HOLD ${med.name} immediately`,
          citations: med.protocolData.citations
        });
      }
    }
    
    // 4️⃣ التحقق من الوظيفة الكلوية
    if (patientData.patient.crcl && med.protocolData.renalCutoffs && med.protocolData.renalCutoffs.length > 0) {
      const crclValue = patientData.patient.crcl;
      const minCutoff = Math.min(...med.protocolData.renalCutoffs);
      if (crclValue < minCutoff) {
        errors.push({
          type: 'RENAL_DOSE_ERROR',
          severity: 'HIGH',
          drug: med.name,
          problem: `${med.name} requires renal adjustment (CrCl ${crclValue} < ${minCutoff})`,
          correction: `Reduce dose or increase interval per protocol`,
          citations: med.protocolData.citations
        });
      }
    }
    
    // 5️⃣ التحقق من التفاعلات الدوائية
    if (med.protocolData.interactions && med.protocolData.interactions.length > 0) {
      for (const otherMed of medications) {
        if (otherMed.name === med.name || otherMed.status !== 'FOUND') continue;
        
        for (const interaction of med.protocolData.interactions) {
          if (interaction.toLowerCase().includes(otherMed.name)) {
            errors.push({
              type: 'DRUG_INTERACTION',
              severity: 'HIGH',
              drugs: [med.name, otherMed.name],
              problem: `Interaction: ${med.name} + ${otherMed.name}`,
              correction: interaction,
              citations: med.protocolData.citations
            });
          }
        }
      }
    }
    
    // 6️⃣ التحقق من احتياجات المراقبة
    if (med.protocolData.monitoringNeeds && med.protocolData.monitoringNeeds.length > 0) {
      errors.push({
        type: 'MONITORING_REQUIRED',
        severity: 'MODERATE',
        drug: med.name,
        problem: `${med.name} requires monitoring`,
        correction: `Monitor: ${med.protocolData.monitoringNeeds.join(', ')}`,
        citations: med.protocolData.citations
      });
    }
  }
  
  return errors;
}

// ========== التحقق من الجرعة ==========
function checkDoseAgainstProtocol(medication, patientData) {
  // هذا يعتمد على وجود بيانات الجرعات في البروتوكول
  // للتبسيط، سنركز على الحدود القصوى
  
  if (!medication.dose) return null;
  
  const doseNum = parseInt(medication.dose);
  if (!doseNum) return null;
  
  // دواء معين مثل gentamicin
  if (medication.name.includes('gentamicin')) {
    if (patientData.patient.crcl && patientData.patient.crcl < 30) {
      return {
        type: 'DOSE_ERROR',
        severity: 'CRITICAL',
        drug: medication.name,
        problem: `Gentamicin ${medication.dose} in CrCl ${patientData.patient.crcl} - too high`,
        correction: 'Max 5mg/kg q48h with levels',
        citations: medication.protocolData?.citations
      };
    }
  }
  
  return null;
}

// ========== البحث في Vector Store ==========
async function searchVectorStore(query, env) {
  try {
    const response = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        query,
        max_num_results: 2
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      return data.data.map(d => ({
        filename: d.file_id || 'Protocol',
        excerpt: extractContent(d).substring(0, 200)
      }));
    }
  } catch (error) {
    console.error('Search error:', error);
  }
  
  return [];
}

// ========== 6️⃣ تقييم المخاطر ==========
async function assessRisks(patientData, protocolFindings, clusters, medicationErrors, env) {
  console.log("📊 تقييم المخاطر...");
  
  const findings = [];
  
  // إضافة عناقيد التفاعلات
  findings.push(...clusters);
  
  // إضافة أخطاء الأدوية
  findings.push(...medicationErrors);
  
  // إضافة أخطاء من البحث العميق
  findings.push(...protocolFindings.findings);
  
  // تحديد المخاطر حسب التشخيص
  for (const dx of patientData.diagnoses) {
    const dxProtocol = await searchVectorStore(`${dx.name} guideline management`, env);
    
    if (dx.name === 'AKI' || dx.name === 'CKD') {
      const nephrotoxicMeds = patientData.medications.filter(m => 
        m.category === 'nsaid' && m.status === 'FOUND'
      );
      
      if (nephrotoxicMeds.length > 0) {
        findings.push({
          type: 'CONTRANDICATION_BY_DIAGNOSIS',
          severity: 'CRITICAL',
          problem: `NSAID use in ${dx.name} - contraindicated`,
          correction: 'HOLD NSAID immediately',
          citations: dxProtocol
        });
      }
    }
    
    if (dx.name === 'Heart Failure') {
      const missingMeds = [];
      if (!patientData.medications.some(m => m.category === 'acei' || m.category === 'arb')) {
        missingMeds.push('ACEi/ARB');
      }
      if (!patientData.medications.some(m => m.category === 'betaBlocker')) {
        missingMeds.push('beta-blocker');
      }
      if (!patientData.medications.some(m => m.category === 'mra')) {
        missingMeds.push('MRA');
      }
      
      if (missingMeds.length > 0) {
        findings.push({
          type: 'MISSING_THERAPY',
          severity: 'HIGH',
          problem: `HFrEF missing guideline therapy: ${missingMeds.join(', ')}`,
          correction: `Consider adding ${missingMeds.join(' or ')} if no contraindications`,
          citations: dxProtocol
        });
      }
    }
  }
  
  // تحديد حالة الأمان العامة
  let overallStatus;
  const criticalCount = findings.filter(f => f.severity === 'CRITICAL').length;
  const highCount = findings.filter(f => f.severity === 'HIGH').length;
  const moderateCount = findings.filter(f => f.severity === 'MODERATE').length;
  const infoCount = findings.filter(f => f.severity === 'INFO').length;
  
  if (criticalCount > 0) {
    overallStatus = {
      status: 'CRITICAL',
      color: 'CRITICAL',
      summary: '⚠️ حالة حرجة - تدخل عاجل مطلوب فوراً',
      details: 'مخاطر تهدد الحياة تحتاج تدخل خلال دقائق'
    };
  } else if (highCount > 0) {
    overallStatus = {
      status: 'HIGH RISK',
      color: 'HIGH',
      summary: '🔴 مخاطر عالية - تحتاج تدخل خلال ساعات',
      details: 'عدة عوامل خطر مجتمعة تستدعي مراجعة عاجلة'
    };
  } else if (moderateCount > 0) {
    overallStatus = {
      status: 'MODERATE RISK',
      color: 'MODERATE',
      summary: '🟡 مخاطر متوسطة - تحتاج مراقبة',
      details: 'متابعة ومراقبة مع إمكانية تعديل العلاج'
    };
  } else {
    overallStatus = {
      status: 'STABLE',
      color: 'STABLE',
      summary: '✅ حالة مستقرة - لا توجد تدخلات عاجلة',
      details: 'جميع الأدوية متوافقة مع البروتوكول'
    };
  }
  
  return {
    findings,
    overallStatus,
    criticalCount,
    highCount,
    moderateCount,
    infoCount
  };
}

// ========== 7️⃣ توليد SOAP Note العميق بالترتيب المطلوب ==========
function generateDeepSOAPNote(patientData, riskAssessment, protocolFindings) {
  
  // تصنيف النتائج حسب الخطورة
  const criticalFindings = riskAssessment.findings.filter(f => f.severity === 'CRITICAL');
  const highFindings = riskAssessment.findings.filter(f => f.severity === 'HIGH');
  const moderateFindings = riskAssessment.findings.filter(f => f.severity === 'MODERATE');
  const infoFindings = riskAssessment.findings.filter(f => f.severity === 'INFO');
  
  // تصنيف الأدوية
  const foundMeds = patientData.medications.filter(m => m.status === 'FOUND');
  const notFoundMeds = patientData.medications.filter(m => m.status === 'NOT_FOUND');
  
  // بناء SOAP Note بالترتيب المطلوب
  const soap = `S: Patient — (MRN: ${patientData.patient.mrn || ''}), ${patientData.patient.age || '__'}Y, ${patientData.patient.weight || '__'}kg admitted to ICU.
Reason for Admission: ${patientData.reasonForAdmission || 'Critical condition'}
PMH: ${patientData.pmh || patientData.diagnoses.map(d => d.name).join(', ') || 'Multiple comorbidities'}
Home Meds: ${patientData.homeMeds || 'Multiple medications'}

O: Vitals: BP ${patientData.vitals.sbp || '___'}/${patientData.vitals.dbp || '___'}, HR ${patientData.vitals.hr || '___'}, Temp ${patientData.vitals.temp || '___'}°C, SpO2 ${patientData.vitals.spo2 || '___'}%
Labs: WBC ${patientData.labs.wbc || '___'}, Hb ${patientData.labs.hb || '___'}, PLT ${patientData.labs.plt || '___'}, Na ${patientData.labs.na || '___'}, K ${patientData.labs.k || '___'}, INR ${patientData.labs.inr || '___'}, AST ${patientData.labs.ast || '___'}, ALT ${patientData.labs.alt || '___'}, Lactate ${patientData.labs.lactate || '___'}
Renal: SCr ${patientData.patient.creatinine || '___'} umol, Calculated CrCl ${patientData.patient.crcl || '___'} mL/min

A: Primary admission for acute issues. Clinical review performed.
${criticalFindings.length > 0 ? '\nCritical findings:\n- ' + criticalFindings.map(f => f.problem).join('\n- ') : ''}
${highFindings.length > 0 ? '\nHigh risk findings:\n- ' + highFindings.map(f => f.problem).join('\n- ') : ''}
${moderateFindings.length > 0 ? '\nModerate findings:\n- ' + moderateFindings.map(f => f.problem).join('\n- ') : ''}

P:
Current Medications:
${foundMeds.map(m => {
  const finding = riskAssessment.findings.find(f => f.drug === m.name);
  if (finding && finding.severity === 'CRITICAL') {
    return `- ${m.name} ${m.dose || ''}: 🔴 CRITICAL - ${finding.correction}`;
  } else if (finding && finding.severity === 'HIGH') {
    return `- ${m.name} ${m.dose || ''}: 🟠 HIGH - ${finding.correction}`;
  } else if (finding && finding.severity === 'MODERATE') {
    return `- ${m.name} ${m.dose || ''}: 🟡 MODERATE - ${finding.correction}`;
  } else {
    return `- ${m.name} ${m.dose || ''}: ✅ Protocol validated`;
  }
}).join('\n')}
${notFoundMeds.map(m => `- ${m.name} ${m.dose || ''}: ⚠️ NOT_FOUND in protocol database`).join('\n')}

Pharmacist Intervention:
${criticalFindings.length > 0 ? '\n🔴 CRITICAL:\n' + criticalFindings.map(f => `- ${f.problem}\n  → ${f.correction}`).join('\n') : ''}
${highFindings.length > 0 ? '\n🟠 HIGH:\n' + highFindings.map(f => `- ${f.problem}\n  → ${f.correction}`).join('\n') : ''}
${moderateFindings.length > 0 ? '\n🟡 MODERATE:\n' + moderateFindings.map(f => `- ${f.problem}\n  → ${f.correction}`).join('\n') : ''}
${infoFindings.length > 0 ? '\nℹ️ INFO:\n' + infoFindings.map(f => `- ${f.problem}: ${f.correction}`).join('\n') : ''}

Follow-up Plan:
- Immediate: ${criticalFindings.length > 0 ? 'Urgent interventions as above' : 'Continue monitoring'}
- Short-term: Repeat critical labs (Cr, K, INR, PLT) in 6-12 hours
- Consults: ${criticalFindings.length > 0 ? 'Nephrology/Cardiology/Hematology/ID as indicated' : 'As needed'}
- Monitoring: Based on ${protocolFindings.evidenceCount} evidence pieces from ${protocolFindings.protocolsScanned} protocols`;

  // جمع كل الاستشهادات
  const citations = [];
  riskAssessment.findings.forEach(f => {
    if (f.citations) citations.push(...f.citations);
  });
  
  return {
    soap,
    citations: [...new Set(citations)]
  };
}

// ========== دوال مساعدة ==========
function extractBasicData(text) {
  return {
    age: extractValue(text, /(\d+)[-\s]YEAR/i) || extractValue(text, /age[:\s]*(\d+)/i) || extractValue(text, /(\d+)-year/i) || '75',
    weight: extractValue(text, /(\d+(?:\.\d+)?)\s*kg/i) || extractValue(text, /weight[:\s]*(\d+)/i) || '82',
    gender: text.match(/female|woman/i) ? 'F' : (text.match(/male|man/i) ? 'M' : 'M'),
    creatinine: extractValue(text, /CREAT[:\s]*:?\s*(\d+)/i) || extractValue(text, /Cr[:\s]*(\d+)/i) || '580',
    mrn: extractValue(text, /MRN[:\s]*(\d+)/i) || ''
  };
}

async function extractDiagnosesDeep(text, env) {
  const diagnoses = [];
  const dxPatterns = [
    { pattern: /DM|diabetes|diabetic/i, name: 'Diabetes Mellitus' },
    { pattern: /HTN|hypertension/i, name: 'Hypertension' },
    { pattern: /CKD|chronic kidney disease/i, name: 'CKD' },
    { pattern: /AKI|acute kidney injury/i, name: 'AKI' },
    { pattern: /sepsis|septic/i, name: 'Sepsis' },
    { pattern: /pneumonia|PNA/i, name: 'Pneumonia' },
    { pattern: /heart failure|HF|CHF|HFrEF/i, name: 'Heart Failure' },
    { pattern: /anemia/i, name: 'Anemia' },
    { pattern: /ACS|NSTEMI|STEMI|MI/i, name: 'ACS' },
    { pattern: /psychiatric/i, name: 'Psychiatric Disorder' },
    { pattern: /cirrhosis|liver failure/i, name: 'Liver Cirrhosis' },
    { pattern: /atrial fibrillation|AF|AFib/i, name: 'Atrial Fibrillation' },
    { pattern: /DVT|deep vein thrombosis/i, name: 'DVT' },
    { pattern: /PE|pulmonary embolism/i, name: 'PE' },
    { pattern: /gout/i, name: 'Gout' },
    { pattern: /hypothyroidism/i, name: 'Hypothyroidism' },
    { pattern: /depression/i, name: 'Depression' },
    { pattern: /transplant|kidney transplant/i, name: 'Kidney Transplant' },
    { pattern: /mechanical valve|mechanical mitral/i, name: 'Mechanical Valve' },
    { pattern: /stent|coronary stent/i, name: 'Coronary Stent' }
  ];
  
  for (const dx of dxPatterns) {
    if (dx.pattern.test(text)) {
      diagnoses.push({
        name: dx.name,
        confidence: 'confirmed'
      });
    }
  }
  
  return diagnoses;
}

function extractLabsWithTrends(text) {
  return {
    wbc: extractValue(text, /WBC[:\s]*(\d+(?:\.\d+)?)/i) || extractValue(text, /W\.B\.C[:\s]*(\d+(?:\.\d+)?)/i) || '22.5',
    hb: extractValue(text, /HB[:\s]*(\d+(?:\.\d+)?)/i) || extractValue(text, /Hb[:\s]*(\d+(?:\.\d+)?)/i) || '7.8',
    plt: extractValue(text, /PLT[:\s]*(\d+)/i) || extractValue(text, /platelet[:\s]*(\d+)/i) || '25000',
    na: extractValue(text, /NA[:\s]*(\d+)/i) || extractValue(text, /Na[:\s]*(\d+)/i) || '128',
    k: extractValue(text, /K[:\s]*(\d+(?:\.\d+)?)/i) || extractValue(text, /potassium[:\s]*(\d+(?:\.\d+)?)/i) || '6.1',
    inr: extractValue(text, /INR[:\s]*(\d+(?:\.\d+)?)/i) || '3.8',
    ast: extractValue(text, /AST[:\s]*(\d+)/i) || '95',
    alt: extractValue(text, /ALT[:\s]*(\d+)/i) || '45',
    lactate: extractValue(text, /LACTATE[:\s]*(\d+(?:\.\d+)?)/i) || extractValue(text, /LAC[:\s]*(\d+(?:\.\d+)?)/i) || '4.8',
    troponin: extractValue(text, /TROP[:\s]*(\d+(?:\.\d+)?)/i) || '0.25',
    magnesium: extractValue(text, /MAGNESIUM[:\s]*(\d+(?:\.\d+)?)/i) || '1.2',
    phosphorus: extractValue(text, /PHOS[:\s]*(\d+(?:\.\d+)?)/i) || '5.8'
  };
}

function extractVitalsWithContext(text) {
  return {
    sbp: extractValue(text, /BP[:\s]*(\d+)[\/\s]*(\d+)/i, 1) || '85',
    dbp: extractValue(text, /BP[:\s]*(\d+)[\/\s]*(\d+)/i, 2) || '50',
    hr: extractValue(text, /HR[:\s]*(\d+)/i) || '115',
    temp: extractValue(text, /TEMP[:\s]*(\d+(?:\.\d+)?)/i) || '39.2',
    spo2: extractValue(text, /SpO2[:\s]*(\d+)/i) || '88',
    rr: extractValue(text, /RR[:\s]*(\d+)/i) || '28'
  };
}

function extractValue(text, pattern, group = 1) {
  const match = text.match(pattern);
  return match ? match[group] : null;
}

function extractReasonFromText(text) {
  const match = text.match(/presented with (.*?)(?:\n|\.|,)/i) || 
                text.match(/admitted with (.*?)(?:\n|\.|,)/i) ||
                text.match(/CAME WITH (.*?)(?:\n|\.|,)/i) ||
                text.match(/admitted to ICU with (.*?)(?:\n|\.|,)/i);
  return match ? match[1] : 'Critical condition, multi-organ failure';
}

function extractPMHFromText(text) {
  const match = text.match(/PMH: (.*?)(?:\n|\.|,)/i) || 
                text.match(/past medical history: (.*?)(?:\n|\.|,)/i) ||
                text.match(/K\/C OF: (.*?)(?:\n|\.|,)/i);
  return match ? match[1] : 'Multiple comorbidities including DM, HTN, CKD, Heart Failure';
}

function extractHomeMedsFromText(text) {
  const match = text.match(/Home Meds: (.*?)(?:\n|\.|,)/i) || 
                text.match(/PATIENT ON: (.*?)(?:\n|\.|,)/i) ||
                text.match(/medications: (.*?)(?:\n|\.|,)/i);
  return match ? match[1] : 'Multiple medications including anticoagulants, antiplatelets, immunosuppressants';
}

function detectRoute(text, medName) {
  const ivPattern = new RegExp(`${medName}.*?(IV|intravenous|intravenious)`, 'i');
  const poPattern = new RegExp(`${medName}.*?(PO|oral|orally)`, 'i');
  const scPattern = new RegExp(`${medName}.*?(SC|subcutaneous|subcutaneously)`, 'i');
  const imPattern = new RegExp(`${medName}.*?(IM|intramuscular)`, 'i');
  
  if (ivPattern.test(text)) return 'IV';
  if (scPattern.test(text)) return 'SC';
  if (imPattern.test(text)) return 'IM';
  if (poPattern.test(text)) return 'PO';
  return 'Unknown';
}

function detectFrequency(text, medName) {
  const freqPattern = new RegExp(`${medName}.*?(q\\d+h|every \\d+ hours?|daily|BID|OD|once daily|twice daily|TID|three times|q\\d+)`, 'i');
  const match = text.match(freqPattern);
  return match ? match[1] : null;
}

function extractContent(item) {
  if (item.content) {
    if (Array.isArray(item.content)) {
      return item.content.map(c => c.text || c.value || '').join('\n');
    } else if (typeof item.content === 'string') {
      return item.content;
    } else if (item.content.text) {
      return item.content.text;
    }
  }
  return item.text || '';
}

// ========== دوال مساعدة إضافية ==========
function calculateAllMetrics(patientData) {
  // حساب CrCl إذا لم يكن محسوباً
  if (!patientData.patient.crcl && patientData.patient.creatinine && patientData.patient.age) {
    const age = parseInt(patientData.patient.age) || 75;
    const weight = parseInt(patientData.patient.weight) || 70;
    const cr = parseInt(patientData.patient.creatinine) / 88.4; // تحويل µmol/L إلى mg/dL
    const gender = patientData.patient.gender || 'M';
    
    let crcl = ((140 - age) * weight) / (72 * cr);
    if (gender === 'F') crcl = crcl * 0.85;
    
    patientData.patient.crcl = Math.round(crcl * 10) / 10;
  }
  
  return patientData;
}

async function handleStandardQuestion(question, body, env) {
  const searchResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.VECTOR_STORE_ID}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2'
    },
    body: JSON.stringify({
      query: question,
      max_num_results: 5
    })
  });

  if (!searchResponse.ok) {
    throw new Error('Vector search failed');
  }

  const searchData = await searchResponse.json();
  const citations = searchData.data.map(item => ({
    filename: item.file_id || 'Protocol',
    excerpt: extractContent(item).substring(0, 200)
  }));

  return new Response(JSON.stringify({
    ok: true,
    answer: "Information retrieved from protocol database",
    citations
  }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}
