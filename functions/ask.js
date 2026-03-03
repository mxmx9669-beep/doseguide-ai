// File: /functions/ask.js
// CLINICAL PHARMACIST AI PLATFORM
// SYSTEM LOGIC SPECIFICATION v1.1

export async function onRequest(context) {

  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (request.method === "OPTIONS") {
    return new Response(null,{status:204,headers:corsHeaders});
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({error:"Method not allowed"}),{
      status:405,
      headers:{ "Content-Type":"application/json",...corsHeaders}
    });
  }

  try{

    const body = await request.json();

    const { case_text } = body;

    if(!case_text){
      return new Response(JSON.stringify({error:"Missing case_text"}),{
        status:400,
        headers:{ "Content-Type":"application/json",...corsHeaders}
      });
    }

    // STEP A
    const extractedData = extractStructuredData(case_text);

    // STEP B
    const crcl = calculateCrCl(extractedData);

    extractedData.renal.crcl = crcl.value;

    // STEP C1
    const template1 = generateTemplate1SOAP(extractedData);

    // STEP C2
    const clinical = performClinicalAnalysis(extractedData);

    // STEP C3
    const pharmReview = reviewPharmacotherapy(extractedData,clinical);

    // STEP C4
    const interventions = await generateInterventions(
      extractedData,
      pharmReview,
      env
    );

    // STEP C5
    const template2 = generateTemplate2SOAP(
      extractedData,
      clinical,
      interventions
    );

    return new Response(JSON.stringify({
      ok:true,
      template1_soap:template1,
      clinical_analysis:clinical,
      pharmacotherapy_review:pharmReview,
      interventions:interventions,
      template2_soap:template2,
      renal:extractedData.renal
    }),{
      headers:{ "Content-Type":"application/json",...corsHeaders}
    });

  }catch(error){

    return new Response(JSON.stringify({
      ok:false,
      error:error.message
    }),{
      status:500,
      headers:{ "Content-Type":"application/json",...corsHeaders}
    });

  }

}

// ================================
// DATA EXTRACTION
// ================================

function extractStructuredData(text){

  const data={

    patient:{
      age:extractAge(text),
      sex:extractSex(text),
      weight:extractWeight(text),
      height:extractHeight(text),
      ward:extractWard(text),
      mrn:extractMRN(text)
    },

    admission:{
      reason:extractReason(text)
    },

    history:{
      pmh:extractPMH(text),
      home_meds:extractHomeMeds(text)
    },

    vitals:extractVitals(text),

    labs:extractLabs(text),

    renal:{
      scr_umol:extractCreatinine(text),
      crcl:null
    },

    current_meds:extractCurrentMedications(text)

  };

  return data;

}

// ================================
// CrCl CALCULATION
// ================================

function calculateCrCl(data){

  const age=data.patient.age;
  const sex=data.patient.sex;
  const weight=data.patient.weight;
  const height=data.patient.height;
  const scr=data.renal.scr_umol;

  if(!age || !weight || !scr){
    return {value:null};
  }

  const scr_mgdl=scr/88.4;

  let weightKg=weight;

  if(height && sex){

    const heightIn=height/2.54;

    const ibw=sex==="F"
      ?45.5+2.3*(heightIn-60)
      :50+2.3*(heightIn-60);

    if(weight>=1.2*ibw){

      const adj=ibw+0.4*(weight-ibw);

      weightKg=adj;

    }

  }

  let crcl=((140-age)*weightKg)/(72*scr_mgdl);

  if(sex==="F") crcl*=0.85;

  return {value:Math.round(crcl)};

}

// ================================
// TEMPLATE 1 SOAP
// ================================

function generateTemplate1SOAP(data){

  const p=data.patient;
  const r=data.renal;

  const age=p.age??"";
  const weight=p.weight??"";
  const ward=p.ward??"N/A";
  const mrn=p.mrn??"";

  const reason=data.admission.reason??"N/A";
  const pmh=data.history.pmh??"N/A";
  const home=data.history.home_meds??"N/A";

  const scr=r.scr_umol??"___";
  const crcl=r.crcl?`${r.crcl} mL/min`:"—";

  let meds="N/A";

  if(data.current_meds.length>0){

    meds=data.current_meds.map(m=>`- ${m}`).join("\n");

  }

return `S: Patient (MRN: ${mrn}), ${age} Y, ${weight} kg admitted to ${ward}.
Reason for Admission: ${reason}
PMH: ${pmh}
Home Meds: ${home}

O: Vitals: N/A
Labs: N/A
Renal: SCr ${scr} umol, Calculated CrCl ${crcl}

A: Primary admission for ${reason}.

P:
Current Medications:
${meds}`;

}

// ================================
// CLINICAL ANALYSIS
// ================================

function performClinicalAnalysis(data){

  const analysis={

    primary_problem:null,
    secondary_problems:[]

  };

  if(data.labs?.na && data.labs.na<135){
    analysis.secondary_problems.push("Hyponatremia");
  }

  if(data.labs?.k && data.labs.k>5.1){
    analysis.secondary_problems.push("Hyperkalemia");
  }

  if(data.renal.scr_umol>110){
    analysis.secondary_problems.push("Possible AKI");
  }

  return analysis;

}

// ================================
// PHARMACOTHERAPY REVIEW
// ================================

function reviewPharmacotherapy(data){

  const review={
    medications:data.current_meds,
    renal:data.renal.crcl
  };

  return review;

}

// ================================
// INTERVENTIONS (VECTOR SEARCH)
// ================================

async function generateInterventions(data,review,env){

  const interventions=[];

  for(const med of review.medications){

    const query=`${med} dosing renal adjustment`;

    const res=await fetch("https://api.openai.com/v1/responses",{

      method:"POST",

      headers:{
        "Authorization":`Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type":"application/json"
      },

      body:JSON.stringify({

        model:"gpt-4.1-mini",

        input:query,

        tools:[{
          type:"file_search",
          vector_store_ids:[env.VECTOR_STORE_ID]
        }]

      })

    });

    const json=await res.json();

    if(json.output_text){

      interventions.push({

        medication:med,

        recommendation:"Review dosing",

        rationale:"Protocol guidance retrieved",

        evidence:json.output_text

      });

    }else{

      interventions.push({

        medication:med,

        recommendation:"Review medication",

        rationale:"Evidence not found in local protocol"

      });

    }

  }

  return interventions;

}

// ================================
// TEMPLATE 2 SOAP
// ================================

function generateTemplate2SOAP(data,analysis,interventions){

  const p=data.patient;
  const r=data.renal;

  const crcl=r.crcl?`${r.crcl} mL/min`:"—";

  const meds=data.current_meds.length
    ?data.current_meds.map(m=>`- ${m}`).join("\n")
    :"- No medications started";

  const intervs=interventions.length
    ?interventions.map(i=>`- ${i.medication}: ${i.recommendation}`).join("\n")
    :"- No interventions identified";

return `S: Patient (MRN: ${p.mrn??""}), ${p.age??""}Y, ${p.weight??""}kg admitted to ${p.ward??"N/A"}.
Reason for Admission: ${data.admission.reason??"N/A"}
PMH: ${data.history.pmh??"N/A"}
Home Meds: ${data.history.home_meds??"N/A"}

O: Vitals: N/A
Labs: N/A
Renal: SCr ${r.scr_umol??"___"} umol, Calculated CrCl ${crcl}

A: Primary admission for acute issues. Clinical review performed.

P:
Current Medications:
${meds}

Pharmacist Intervention:
${intervs}

Follow-up Plan:
- Monitor renal function
- Repeat labs in 24 hours`;

}

// ================================
// EXTRACTION HELPERS
// ================================

function extractAge(text){

const m=text.match(/(\d+)[-\s]*year/i);
return m?parseInt(m[1]):null;

}

function extractSex(text){

if(/female/i.test(text))return"F";
if(/male/i.test(text))return"M";
return null;

}

function extractWeight(text){

const m=text.match(/(\d+)\s*kg/i);
return m?parseFloat(m[1]):null;

}

function extractHeight(text){

const m=text.match(/(\d+)\s*cm/i);
return m?parseFloat(m[1]):null;

}

function extractMRN(text){

const m=text.match(/MRN[:\s]*(\d+)/i);
return m?m[1]:null;

}

function extractWard(text){

const m=text.match(/ICU|CCU|MICU|SICU/i);
return m?m[0]:null;

}

function extractReason(text){

const m=text.match(/admitted (?:for|with) ([^\n]+)/i);
return m?m[1]:null;

}

function extractPMH(text){

const m=text.match(/PMH[:\s]*(.*)/i);
return m?m[1]:null;

}

function extractHomeMeds(text){

const m=text.match(/home meds[:\s]*(.*)/i);
return m?m[1]:null;

}

function extractVitals(text){return{};}

function extractLabs(text){return{};}

function extractCreatinine(text){

const m=text.match(/creatinine[:\s]*(\d+)/i);
return m?parseInt(m[1]):null;

}

function extractCurrentMedications(text){

const meds=[];

const m=text.match(/medications?:\s*([\s\S]+)/i);

if(!m)return meds;

const lines=m[1].split("\n");

for(const l of lines){

const name=l.trim();

if(name.length>2) meds.push(name);

}

return meds;

}
