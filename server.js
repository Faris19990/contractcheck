const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const mammoth = require("mammoth");
const path = require("path");

const app = express();

/* =========================================================
   إعدادات عامة
========================================================= */

const MAX_FILE_SIZE = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/* =========================================================
   Rate Limit
========================================================= */

const requestLog = new Map();

const RATE_WINDOW = 10 * 60 * 1000;
const RATE_MAX = 8;

function getIP(req) {
  return String(
    req.headers["x-forwarded-for"] ||
    req.ip ||
    "unknown"
  )
    .split(",")[0]
    .trim();
}

function rateLimit(req, res, next) {
  const ip = getIP(req);
  const now = Date.now();

  const previous =
    requestLog.get(ip) || [];

  const recent =
    previous.filter(
      time =>
        now - time < RATE_WINDOW
    );

  if (recent.length >= RATE_MAX) {
    return res.status(429).json({
      error:
        "تم الوصول إلى الحد المؤقت من التحليلات. يرجى المحاولة مرة أخرى بعد قليل."
    });
  }

  recent.push(now);

  requestLog.set(
    ip,
    recent
  );

  next();
}


/* =========================================================
   Health Check
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "Ihata"
    });
  }
);


/* =========================================================
   OpenAI
========================================================= */

function getClient() {

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "لم يتم إعداد مفتاح OpenAI في متغيرات البيئة."
    );
  }

  return new OpenAI({
    apiKey:
      process.env.OPENAI_API_KEY
  });
}


/* =========================================================
   Helpers
========================================================= */

function cleanJSON(raw) {

  return String(raw || "")
    .replace(
      /^```json\s*/i,
      ""
    )
    .replace(
      /^```\s*/i,
      ""
    )
    .replace(
      /```\s*$/i,
      ""
    )
    .trim();

}


function getFileType(file) {

  const name =
    String(
      file.originalname || ""
    ).toLowerCase();

  if (
    file.mimetype ===
      "application/pdf" ||
    name.endsWith(".pdf")
  ) {
    return "pdf";
  }

  if (
    file.mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    return "docx";
  }

  return null;
}


function safeCategory(value) {

  const allowed = [
    "مقاولات وأعمال",
    "عقود تجارية",
    "إيجار",
    "عمل",
    "توريد",
    "شراكات واستثمار",
    "تقنية وخدمات",
    "عقد آخر"
  ];

  return allowed.includes(value)
    ? value
    : "غير محدد";
}


/* =========================================================
   DOCX
========================================================= */

async function extractDOCX(file) {

  const result =
    await mammoth.extractRawText({
      buffer: file.buffer
    });

  return result.value.trim();
}


/* =========================================================
   PDF
========================================================= */

async function uploadPDF(
  client,
  file
) {

  const fileForOpenAI =
    await toFile(
      file.buffer,
      file.originalname ||
        "document.pdf",
      {
        type: "application/pdf"
      }
    );

  return client.files.create({
    file: fileForOpenAI,
    purpose: "user_data"
  });
}


/* =========================================================
   JSON Parser
========================================================= */

function parseResponse(
  response,
  fallback
) {

  const raw =
    cleanJSON(
      response?.output_text ||
      ""
    );

  if (!raw) {
    return fallback;
  }

  try {

    return JSON.parse(raw);

  } catch {

    return {
      ...fallback,
      summary: raw
    };

  }
}


/* =========================================================
   الأسلوب العام لإحاطة
========================================================= */

const IHATA_STYLE = `

أنت "إحاطة"، مساعد ذكي متخصص في الفحص الأولي للمستندات
والمعلومات القانونية.

أسلوبك القانوني يجب أن يكون:

- رسميًا.
- رصينًا.
- دقيقًا.
- واضحًا وسهل الفهم.
- خاليًا من العامية.
- خاليًا من المبالغة.
- لا تستخدم عبارات تسويقية.
- لا تستخدم لغة روبوتية جامدة.
- لا تستخدم عبارات قطعية عندما لا تسمح الوثيقة أو المعطيات بذلك.

استخدم المصطلحات القانونية الصحيحة، ثم وضح أثرها بلغة يفهمها غير المتخصص.

لا تفترض أن المستخدم محامٍ.

عند شرح أي نقطة مهمة، حاول تنظيمها ذهنيًا وفق:

1. النتيجة أو الخلاصة.
2. التحليل.
3. الأثر المحتمل.
4. ما يستحق المراجعة.

لا يلزم إظهار هذه العناوين في كل إجابة إذا كان ذلك سيجعل النص متكررًا،
لكن يجب أن يكون هذا التسلسل حاضرًا في طريقة التحليل.

مثال على الأسلوب المطلوب:

"تظهر مخاطرة تعاقدية في بند الإنهاء، إذ يتيح البند لأحد الأطراف
إنهاء العقد وفق شروط محددة دون ظهور حق مماثل للطرف الآخر.
وقد يؤدي ذلك إلى عدم توازن نسبي في حقوق الإنهاء. ويوصى بمراجعة
نطاق هذا الحق وشروط ممارسته قبل التوقيع."

وليس:

"البند هذا فيه مشكلة كبيرة."

إذا كانت المعلومة غير موجودة في المستند، قل:

"غير مذكور في المستند."

إذا كانت المسألة تحتاج إلى تفسير أو تحقق من نظام سعودي،
قل:

"تحتاج مراجعة قانونية سعودية."

لا تقدم رأيًا قانونيًا قطعيًا عندما لا تتوافر المعطيات الكافية.

لا تخترع:
- مواد نظامية.
- أحكامًا قضائية.
- أرقام قضايا.
- تواريخ.
- مبالغ.
- وقائع.
- التزامات.
- حقوقًا غير مذكورة.

فرّق دائمًا بين:
- ما ورد صراحة في المستند.
- ما يمكن استنتاجه من صياغته.
- وما يحتاج إلى مراجعة قانونية.

`;


/* =========================================================
   Contract Prompt
========================================================= */

function contractInstructions(category) {

  return `

${IHATA_STYLE}

أنت الآن تحلل عقدًا.

الاختيار المبدئي للمستخدم:
${category}

لا تعتمد على الاختيار بشكل أعمى.

حدد نوع العقد الحقيقي من محتواه، ثم قارنه بالتصنيف المختار.

إذا كان التصنيف المختار غير مناسب، وضح ذلك في:
selected_category

والـ document_type يجب أن يعكس طبيعة المستند الفعلية.

راجع العقد من الناحية التالية:

أولًا: البيانات الأساسية

- أطراف العقد.
- صفات الأطراف إذا كانت مذكورة.
- موضوع العقد.
- تاريخ العقد.
- مدة العقد.
- التجديد.
- الإشعارات.
- المبالغ.
- العملات.
- النسب.
- المواعيد.

ثانيًا: الالتزامات

- التزامات كل طرف.
- مواعيد التنفيذ.
- شروط التسليم.
- شروط الدفع.
- الضمانات.
- المسؤوليات.

ثالثًا: المخاطر

راجع خصوصًا:

- الشرط الجزائي.
- المسؤولية.
- التعويض.
- حدود المسؤولية.
- الإنهاء.
- الفسخ.
- التجديد.
- التأخير.
- الدفع.
- تعديل الأسعار.
- السرية.
- الملكية الفكرية.
- الاختصاص القضائي.
- تسوية النزاعات.
- الالتزامات غير المتوازنة.
- المخاطر المالية.
- المخاطر التشغيلية.

إذا كان العقد مقاولات أو أعمالًا، راجع:

- نطاق العمل.
- مدة التنفيذ.
- المستخلصات.
- الدفعة المقدمة.
- التأخير.
- غرامات التأخير.
- الأعمال الإضافية.
- تغيير نطاق العمل.
- المواصفات.
- الاستلام.
- العيوب.
- الضمان.
- التأمين.
- سحب الأعمال.
- الإنهاء.

إذا كان إيجارًا، راجع:

- مدة الإيجار.
- الأجرة.
- التجديد.
- الزيادة.
- التأمين.
- الصيانة.
- الإخلاء.
- الفسخ.

إذا كان عقد عمل، راجع:

- الأجر.
- مدة العقد.
- فترة التجربة.
- ساعات العمل.
- الإجازات.
- الإنهاء.
- السرية.
- الملكية الفكرية.

إذا كان العقد تجاريًا أو تقنيًا، راجع كذلك:

- نطاق الخدمات.
- مستوى الخدمة إن وجد.
- الملكية الفكرية.
- البيانات.
- السرية.
- الدعم.
- التحديثات.
- المسؤولية.
- حدود الاستخدام.

مهم:

لا تعتبر غياب بند معين مخالفة قانونية تلقائيًا.

لا تعتبر وجود شرط معين مخالفًا للنظام لمجرد أنه غير مألوف.

إذا ظهرت نقطة قد يكون لها أثر قانوني مهم، اشرح السبب بدل إطلاق حكم قطعي.

في risks:

level يجب أن يكون واحدًا من:

high
medium
low

استخدم:

high
عندما يكون البند ذا أثر مالي أو قانوني جوهري أو ينشئ التزامًا
قد يكون عالي الأثر.

medium
عندما تكون المسألة مهمة ولكن أثرها يعتمد على ظروف أو صياغة إضافية.

low
عندما تكون الملاحظة محدودة الأثر أو تحتاج فقط إلى توضيح.

في question:
اكتب سؤالًا عمليًا يستطيع المستخدم طرحه على الطرف الآخر
أو على المحامي.

في good_points:
اذكر البنود أو الحمايات الموجودة فعلًا في المستند.

في missing_or_unclear:
اذكر فقط ما ظهر أنه غير واضح أو غير موجود وله أهمية فعلية.

في balance_check:
قيّم التوازن التعاقدي من حيث توزيع الالتزامات والحقوق،
ولا تصدر حكمًا قانونيًا قطعيًا.

أخرج JSON صالح فقط.

الصيغة:

{
  "document_type": "",
  "selected_category": "${category}",

  "score": 0,

  "summary": "",

  "key_information": {
    "amounts": [],
    "dates": [],
    "durations": []
  },

  "risks": [
    {
      "level": "high",
      "title": "",
      "clause": "",
      "why": "",
      "question": ""
    }
  ],

  "good_points": [],

  "missing_or_unclear": [],

  "balance_check": {
    "assessment": "",
    "notes": []
  }
}

`;
}


/* =========================================================
   Judgment Prompt
========================================================= */

const judgmentInstructions = `

${IHATA_STYLE}

أنت الآن تحلل حكمًا أو وثيقة قضائية.

التحليل يجب أن يركز على مضمون الوثيقة كما ورد فيها.

لا تصدر حكمًا جديدًا.

لا تتنبأ بنتيجة الاستئناف.

لا تقل إن الحكم صحيح أو باطل بشكل قطعي.

لا تفترض أن الحكم نهائي إلا إذا ذكرت الوثيقة ذلك صراحة.

استخرج قدر الإمكان:

- نوع القضية.
- المحكمة.
- الدائرة.
- رقم القضية.
- رقم الحكم.
- تاريخ الحكم.
- المدعي.
- المدعى عليه.
- الوقائع.
- الطلبات.
- الدفوع.
- الأدلة إذا وردت.
- أسباب الحكم.
- منطوق الحكم.
- المبالغ.
- الالتزامات.
- المدد.
- الاعتراض.
- الاستئناف.
- القطعية إذا ذكرت صراحة.

عند تلخيص الحكم:

ابدأ بالنتيجة التي انتهت إليها المحكمة.

ثم وضح بصورة مختصرة:
- ماذا طلب الأطراف؟
- ما الذي اعتمدت عليه المحكمة؟
- ماذا قررت؟
- ما الالتزامات الناتجة عن الحكم؟

إذا كان هناك فرق بين الوقائع والطلبات والمنطوق،
حافظ على هذا الفرق.

إذا وجدت تعارضًا ظاهرًا داخل الوثيقة،
اذكره بوصفه تعارضًا ظاهرًا فقط.

لا تحاول تصحيح الوثيقة من نفسك.

في legal_review_needed:
ضع النقاط التي تستحق مراجعة قانونية متخصصة،
خصوصًا إذا كان فهمها يعتمد على نظام أو إجراء غير ظاهر في الوثيقة.

إذا لم تكن المعلومة موجودة:
اكتب "غير مذكور في الوثيقة".

أخرج JSON صالح فقط:

{
  "document_type": "",

  "case_type": "",

  "case_information": {
    "court": "",
    "chamber": "",
    "case_number": "",
    "judgment_number": "",
    "judgment_date": ""
  },

  "parties": {
    "claimant": "",
    "defendant": ""
  },

  "summary": "",

  "claims": [],

  "defenses": [],

  "facts": [],

  "reasons": [],

  "judgment": "",

  "financial_obligations": [],

  "deadlines": [],

  "appeal_information": "",

  "important_points": [],

  "missing_or_unclear": [],

  "legal_review_needed": []
}

`;


/* =========================================================
   Comparison Prompt
========================================================= */

const comparisonInstructions = `

${IHATA_STYLE}

أنت الآن تقارن بين مستندين قانونيين.

المطلوب تحديد الفروقات الفعلية بين المستندين،
وليس مجرد تلخيص كل مستند.

قارن خصوصًا:

- البنود المضافة.
- البنود المحذوفة.
- البنود المعدلة.
- المبالغ.
- الأسعار.
- النسب.
- التواريخ.
- المدد.
- الشرط الجزائي.
- الإنهاء.
- التجديد.
- المسؤولية.
- التعويض.
- الدفع.
- السرية.
- الملكية الفكرية.
- الاختصاص.
- تسوية النزاعات.
- الالتزامات.
- المخاطر المالية.
- المخاطر التشغيلية.

عند اكتشاف تغيير:

اشرح:
1. ماذا كان في المستند الأول؟
2. ماذا أصبح في المستند الثاني؟
3. ما الأثر المحتمل لهذا التغيير؟

لا تفترض أن التغيير ضار لمجرد أنه تغيير.

إذا كان التغيير يحتاج إلى تفسير قانوني سعودي،
اكتب:
"تحتاج مراجعة قانونية سعودية."

أخرج JSON صالح فقط:

{
  "document_1_type": "",
  "document_2_type": "",

  "summary": "",

  "important_changes": [
    {
      "level": "high",
      "title": "",
      "document_1": "",
      "document_2": "",
      "impact": ""
    }
  ],

  "added_clauses": [],

  "removed_clauses": [],

  "changed_amounts": [],

  "changed_dates_or_durations": [],

  "changed_obligations": [],

  "legal_review_needed": []
}

`;


/* =========================================================
   Analyze Single Document
========================================================= */

async function analyzeSingle(
  client,
  file,
  instructions
) {

  const type =
    getFileType(file);

  if (!type) {
    throw new Error(
      "الصيغة المدعومة PDF أو DOCX فقط."
    );
  }


  /* DOCX */

  if (type === "docx") {

    const text =
      await extractDOCX(file);

    if (!text) {
      throw new Error(
        "لم أستطع استخراج النص من ملف Word."
      );
    }

    return client.responses.create({

      model: "gpt-5",

      input: `
${instructions}

نص الوثيقة:

${text.slice(
  0,
  65000
)}
`

    });

  }


  /* PDF */

  const uploaded =
    await uploadPDF(
      client,
      file
    );

  try {

    return await client.responses.create({

      model: "gpt-5",

      input: [
        {
          role: "user",

          content: [
            {
              type: "input_file",
              file_id:
                uploaded.id
            },

            {
              type: "input_text",
              text:
                instructions
            }
          ]
        }
      ]

    });

  } finally {

    try {

      await client.files.delete(
        uploaded.id
      );

    } catch {}

  }

}


/* =========================================================
   Comparison Preparation
========================================================= */

async function prepareComparisonFile(
  client,
  file
) {

  const type =
    getFileType(file);

  if (!type) {
    throw new Error(
      "الصيغة المدعومة PDF أو DOCX فقط."
    );
  }


  if (type === "docx") {

    const text =
      await extractDOCX(file);

    if (!text) {
      throw new Error(
        "لم أستطع استخراج النص من ملف Word."
      );
    }

    return {

      type: "text",

      name:
        file.originalname,

      text:
        text.slice(
          0,
          65000
        )

    };

  }


  const uploaded =
    await uploadPDF(
      client,
      file
    );

  return {

    type: "file",

    name:
      file.originalname,

    fileId:
      uploaded.id

  };

}


/* =========================================================
   Compare Documents
========================================================= */

async function compareDocuments(
  client,
  file1,
  file2
) {

  const first =
    await prepareComparisonFile(
      client,
      file1
    );

  const second =
    await prepareComparisonFile(
      client,
      file2
    );


  const content = [

    {
      type: "input_text",
      text:
        comparisonInstructions
    },

    {
      type: "input_text",
      text:
        `اسم المستند الأول: ${first.name}`
    },

    {
      type: "input_text",
      text:
        `اسم المستند الثاني: ${second.name}`
    }

  ];


  if (
    first.type ===
    "file"
  ) {

    content.push({
      type: "input_file",
      file_id:
        first.fileId
    });

  } else {

    content.push({
      type: "input_text",
      text:
        `نص المستند الأول:\n${first.text}`
    });

  }


  if (
    second.type ===
    "file"
  ) {

    content.push({
      type: "input_file",
      file_id:
        second.fileId
    });

  } else {

    content.push({
      type: "input_text",
      text:
        `نص المستند الثاني:\n${second.text}`
    });

  }


  try {

    return await client.responses.create({

      model: "gpt-5",

      input: [
        {
          role: "user",
          content
        }
      ]

    });

  } finally {

    if (
      first.type ===
      "file"
    ) {

      try {

        await client.files.delete(
          first.fileId
        );

      } catch {}

    }


    if (
      second.type ===
      "file"
    ) {

      try {

        await client.files.delete(
          second.fileId
        );

      } catch {}

    }

  }

}


/* =========================================================
   Contract API
========================================================= */

app.post(
  "/api/analyze",

  rateLimit,

  upload.single(
    "document"
  ),

  async (
    req,
    res
  ) => {

    try {

      const client =
        getClient();


      if (!req.file) {

        return res
          .status(400)
          .json({
            error:
              "يرجى رفع ملف PDF أو DOCX."
          });

      }


      const category =
        safeCategory(
          req.body?.category
        );


      const response =
        await analyzeSingle(

          client,

          req.file,

          contractInstructions(
            category
          )

        );


      return res.json(

        parseResponse(

          response,

          {

            document_type:
              "غير محدد",

            selected_category:
              category,

            score:
              null,

            summary:
              "",

            key_information: {

              amounts: [],

              dates: [],

              durations: []

            },

            risks: [],

            good_points: [],

            missing_or_unclear: [],

            balance_check: {

              assessment:
                "",

              notes: []

            }

          }

        )

      );

    } catch (err) {

      console.error(
        "Contract error:",
        err
      );


      return res
        .status(
          err.message?.includes(
            "25MB"
          )
            ? 413
            : 500
        )
        .json({

          error:
            err.message ||
            "حدث خطأ أثناء تحليل العقد."

        });

    }

  }
);


/* =========================================================
   Judgment API
========================================================= */

app.post(
  "/api/analyze-judgment",

  rateLimit,

  upload.single(
    "document"
  ),

  async (
    req,
    res
  ) => {

    try {

      const client =
        getClient();


      if (!req.file) {

        return res
          .status(400)
          .json({
            error:
              "يرجى رفع صك الحكم بصيغة PDF أو DOCX."
          });

      }


      const response =
        await analyzeSingle(

          client,

          req.file,

          judgmentInstructions

        );


      return res.json(

        parseResponse(

          response,

          {

            document_type:
              "وثيقة قضائية",

            case_type:
              "",

            case_information: {

              court:
                "",

              chamber:
                "",

              case_number:
                "",

              judgment_number:
                "",

              judgment_date:
                ""

            },

            parties: {

              claimant:
                "",

              defendant:
                ""

            },

            summary:
              "",

            claims: [],
            defenses: [],
            facts: [],
            reasons: [],

            judgment:
              "",

            financial_obligations:
              [],

            deadlines:
              [],

            appeal_information:
              "",

            important_points:
              [],

            missing_or_unclear:
              [],

            legal_review_needed:
              []

          }

        )

      );

    } catch (err) {

      console.error(
        "Judgment error:",
        err
      );


      return res
        .status(500)
        .json({

          error:
            err.message ||
            "حدث خطأ أثناء تحليل الحكم."

        });

    }

  }
);


/* =========================================================
   Comparison API
========================================================= */

app.post(

  "/api/compare",

  rateLimit,

  upload.fields([

    {
      name:
        "document1",

      maxCount:
        1

    },

    {
      name:
        "document2",

      maxCount:
        1
    }

  ]),

  async (
    req,
    res
  ) => {

    try {

      const client =
        getClient();


      const file1 =
        req.files
          ?.document1
          ?.[0];


      const file2 =
        req.files
          ?.document2
          ?.[0];


      if (
        !file1 ||
        !file2
      ) {

        return res
          .status(400)
          .json({

            error:
              "يرجى رفع المستندين أولًا."

          });

      }


      const response =
        await compareDocuments(

          client,

          file1,

          file2

        );


      return res.json(

        parseResponse(

          response,

          {

            document_1_type:
              "غير محدد",

            document_2_type:
              "غير محدد",

            summary:
              "",

            important_changes:
              [],

            added_clauses:
              [],

            removed_clauses:
              [],

            changed_amounts:
              [],

            changed_dates_or_durations:
              [],

            changed_obligations:
              [],

            legal_review_needed:
              []

          }

        )

      );

    } catch (err) {

      console.error(
        "Comparison error:",
        err
      );


      return res
        .status(500)
        .json({

          error:
            err.message ||
            "حدث خطأ أثناء مقارنة المستندين."

        });

    }

  }

);


/* =========================================================
   Multer Errors
========================================================= */

app.use(

  (
    err,
    req,
    res,
    next
  ) => {

    if (
      err instanceof
      multer.MulterError
    ) {

      if (
        err.code ===
        "LIMIT_FILE_SIZE"
      ) {

        return res
          .status(413)
          .json({

            error:
              "حجم الملف كبير. الحد الأقصى 25MB."

          });

      }


      return res
        .status(400)
        .json({

          error:
            "حدث خطأ أثناء رفع الملف."

        });

    }


    next(err);

  }

);


/* =========================================================
   Server
========================================================= */

const port =
  process.env.PORT ||
  3000;


app.listen(

  port,

  () => {

    console.log(
      `Ihata running on ${port}`
    );

  }

);
