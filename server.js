const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const mammoth = require("mammoth");
const path = require("path");

const app = express();

/* =========================================================
   IHATA
   مساعد فحص أولي للمستندات القانونية
========================================================= */

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 55000;

/*
  gpt-5-mini:
  أسرع وأقل تكلفة للاختبارات والاستخدام اليومي.
*/
const MODEL = "gpt-5-mini";

/* =========================================================
   FILE UPLOAD
========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 2
  }
});

/* =========================================================
   STATIC WEBSITE
========================================================= */

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

app.use(
  express.json({
    limit: "1mb"
  })
);

/* =========================================================
   RATE LIMIT
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
        "تم الوصول إلى الحد المؤقت للتحليلات. حاول مرة أخرى بعد قليل."
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
   HEALTH CHECK
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "Ihata",
      model: MODEL
    });
  }
);

/* =========================================================
   OPENAI CLIENT
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
   GENERAL HELPERS
========================================================= */

function cleanJSON(raw) {
  let text = String(raw || "").trim();

  text = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  return text;
}

function extractJSON(raw) {
  const cleaned =
    cleanJSON(raw);

  if (!cleaned) {
    return null;
  }

  try {
    return JSON.parse(cleaned);
  } catch {}

  /*
    محاولة استخراج أول object JSON
    إذا أضاف النموذج كلامًا قبل أو بعد JSON.
  */

  const first =
    cleaned.indexOf("{");

  const last =
    cleaned.lastIndexOf("}");

  if (
    first !== -1 &&
    last !== -1 &&
    last > first
  ) {
    try {
      return JSON.parse(
        cleaned.slice(
          first,
          last + 1
        )
      );
    } catch {}
  }

  return null;
}

function parseResponse(
  response,
  fallback
) {
  const raw =
    response?.output_text || "";

  const parsed =
    extractJSON(raw);

  if (parsed) {
    return parsed;
  }

  /*
    إذا رجع النموذج نصًا بدل JSON
    لا نخلي الموقع ينهار.
  */

  return {
    ...fallback,
    summary:
      cleanJSON(raw) ||
      fallback.summary ||
      "تعذر استخراج نتيجة منظمة من التحليل."
  };
}

function getFileType(file) {
  const name =
    String(
      file?.originalname || ""
    ).toLowerCase();

  if (
    file?.mimetype ===
      "application/pdf" ||
    name.endsWith(".pdf")
  ) {
    return "pdf";
  }

  if (
    file?.mimetype ===
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
   DOCX EXTRACTION
========================================================= */

async function extractDOCX(file) {
  const result =
    await mammoth.extractRawText({
      buffer: file.buffer
    });

  const text =
    String(
      result.value || ""
    ).trim();

  if (!text) {
    throw new Error(
      "لم أستطع استخراج نص من ملف Word."
    );
  }

  return text.slice(
    0,
    MAX_TEXT_CHARS
  );
}

/* =========================================================
   PDF UPLOAD TO OPENAI
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
        type:
          "application/pdf"
      }
    );

  return client.files.create({
    file: fileForOpenAI,
    purpose: "user_data"
  });
}

/* =========================================================
   COMMON LEGAL STYLE
========================================================= */

const legalStyle = `
أسلوبك في التحليل يجب أن يكون:

1. قانونيًا ومنظمًا.
2. واضحًا لغير المتخصص.
3. هادئًا وغير مخيف.
4. لا تستخدم لغة قانونية معقدة دون شرحها.
5. إذا ذكرت مصطلحًا قانونيًا مهمًا، اشرح معناه بجملة قصيرة.
6. لا تقل "هذا العقد باطل" أو "هذا البند غير قانوني" إلا إذا كان ذلك ثابتًا بشكل واضح من النص ومسموحًا بإثباته.
7. الأفضل استخدام عبارات مثل:
   - "هذه النقطة تستحق الانتباه."
   - "قد تحمل هذه الصياغة مخاطرة."
   - "يُنصح بمراجعة هذه النقطة."
   - "تحتاج مراجعة قانونية سعودية."
8. فرّق دائمًا بين:
   - ما ورد فعلًا في المستند.
   - ما يمكن ملاحظته من ناحية الصياغة.
   - ما يحتاج إلى رأي أو تحقق قانوني.
9. لا تخترع مادة نظامية أو رقم مادة أو حكم قضائي.
10. لا تفترض وقائع غير موجودة في المستند.
`;

/* =========================================================
   CONTRACT INSTRUCTIONS
========================================================= */

function contractInstructions(
  category
) {
  return `
أنت "إحاطة"، مساعد ذكي للفحص الأولي للمستندات القانونية في السعودية.

${legalStyle}

المستند الذي أمامك عقد.

القسم الذي اختاره المستخدم:
${category}

مهم جدًا:

اختيار المستخدم ليس بالضرورة النوع الحقيقي للعقد.

افهم محتوى العقد أولًا، ثم حدد نوعه الحقيقي.

لا تعتمد على اسم الملف وحده.

حلل العقد كما هو مكتوب.

ركّز على البنود التي يمكن أن يكون لها أثر عملي أو مالي أو تعاقدي.

افحص خصوصًا:

- أطراف العقد.
- موضوع العقد.
- الالتزامات الرئيسية.
- المقابل المالي.
- الدفعات.
- المواعيد.
- المدد.
- التجديد.
- الإنهاء.
- الفسخ.
- الشرط الجزائي.
- التعويض.
- المسؤولية.
- حدود المسؤولية.
- التأخير.
- القوة القاهرة إذا وجدت.
- السرية.
- الملكية الفكرية.
- عدم المنافسة إذا وجدت.
- الاختصاص القضائي.
- تسوية النزاعات.
- الإشعارات.
- التنازل.
- التعديل.
- الضمانات.
- التأمين.
- الالتزامات التي تقع على طرف دون الآخر.
- أي صياغة غامضة أو واسعة جدًا.

إذا كان العقد مقاولات أو أعمال، راجع أيضًا:

- نطاق العمل.
- مدة التنفيذ.
- الدفعات والمستخلصات.
- الدفعة المقدمة.
- الأعمال الإضافية.
- أوامر التغيير.
- التأخير.
- غرامات التأخير.
- الاستلام.
- العيوب.
- الضمان.
- سحب الأعمال.
- الإنهاء.

إذا كان إيجارًا:

- مدة الإيجار.
- الأجرة.
- الزيادة.
- التجديد.
- التأمين.
- الصيانة.
- الإخلاء.
- الفسخ.
- التزامات المؤجر والمستأجر.

إذا كان عقد عمل:

- الأجر.
- المدة.
- فترة التجربة.
- ساعات العمل.
- الإجازات.
- السرية.
- الملكية الفكرية.
- إنهاء العلاقة.
- الالتزامات بعد انتهاء العمل.

إذا كان عقد توريد:

- المواصفات.
- الكميات.
- الأسعار.
- مواعيد التسليم.
- قبول أو رفض المنتجات.
- العيوب.
- الضمان.
- التأخير.
- الدفع.

إذا كان عقد تقنية أو خدمات:

- نطاق الخدمة.
- مستوى الخدمة.
- الملكية الفكرية.
- البيانات.
- السرية.
- الدعم.
- مدة الخدمة.
- الإنهاء.
- المسؤولية.
- حدود المسؤولية.

استخرج المعلومات المهمة:

- المبالغ.
- العملات.
- النسب.
- التواريخ.
- المدد.
- أرقام البنود المهمة.

في المخاطر:

level يجب أن يكون:
"high"
أو
"medium"
أو
"low"

لكن لا تعتبر كل ملاحظة "خطرًا".

الخطر العالي:
نقطة قد يكون لها أثر مالي أو تعاقدي كبير.

المتوسط:
نقطة تستحق الانتباه أو التوضيح.

المنخفض:
ملاحظة محدودة الأثر.

في clause:
اكتب وصفًا مختصرًا للبند أو موضعه.

في why:
اشرح للمستخدم ببساطة لماذا تستحق النقطة الانتباه.

في question:
حوّل المشكلة إلى سؤال عملي يمكن للمستخدم طرحه قبل التوقيع.

لا تقل إن غياب بند معين يعني تلقائيًا أن العقد مخالف للنظام.

إذا لم تجد معلومة مهمة:
ضعها في missing_or_unclear.

النتيجة يجب أن تكون JSON صالح فقط.

الشكل:

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

مهم:
summary يجب أن يكون طبيعيًا وسهل القراءة، وكأنه مستشار يشرح لصاحب العقد ماذا وجد، وليس تقريرًا آليًا جامدًا.

score من 0 إلى 100:

0 = لا تظهر مخاطر جوهرية في الفحص الأولي.

100 = توجد عدة نقاط عالية الأهمية تستحق مراجعة عاجلة.

الدرجة تقديرية للفحص الأولي وليست تقييمًا قانونيًا نهائيًا.
`;
}

/* =========================================================
   JUDGMENT INSTRUCTIONS
========================================================= */

const judgmentInstructions = `
أنت "إحاطة"، مساعد ذكي للفحص الأولي للأحكام والوثائق القضائية في السعودية.

${legalStyle}

حلل الوثيقة كما هي.

لا تصدر حكمًا جديدًا.

لا تتوقع نتيجة الاستئناف.

لا تقل إن الحكم صحيح أو باطل بشكل قطعي.

لا تخترع مواد أو أنظمة أو وقائع.

إذا كانت المعلومة غير موجودة:
اكتب "غير مذكور في الوثيقة".

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
- الأدلة إذا كانت مذكورة.
- أسباب الحكم.
- منطوق الحكم.
- المبالغ.
- الالتزامات.
- المدد.
- الاعتراض.
- الاستئناف.
- القطعية إذا كانت مذكورة صراحة.

اشرح للمستخدم باختصار:
"ماذا حصل؟"
"ماذا طلب الأطراف؟"
"لماذا اتجهت المحكمة لهذا الحكم بحسب ما يظهر في الوثيقة؟"
"ما الذي انتهى إليه الحكم؟"
"ما الالتزامات الناتجة عنه؟"

لا تستنتج شيئًا غير مذكور.

إذا لاحظت تعارضًا ظاهرًا داخل الوثيقة، اذكره فقط إذا كان واضحًا من النص.

إذا كانت نقطة تحتاج معرفة أو تحققًا قانونيًا:
ضعها في legal_review_needed.

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

summary يجب أن يكون شرحًا طبيعيًا وواضحًا وليس مجرد إعادة نسخ للوثيقة.
`;

/* =========================================================
   COMPARISON INSTRUCTIONS
========================================================= */

const comparisonInstructions = `
أنت "إحاطة"، مساعد ذكي لمقارنة المستندات القانونية في السعودية.

${legalStyle}

قارن المستند الأول والثاني بدقة.

لا تفترض أن المستند الثاني أفضل أو أسوأ إلا بناءً على التغييرات الموجودة فعلًا.

حدد:

- البنود المضافة.
- البنود المحذوفة.
- البنود التي تغيرت.
- تغير المبالغ.
- تغير الأسعار.
- تغير النسب.
- تغير التواريخ.
- تغير المدد.
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
- أي تغير قد يرفع أو يخفض المخاطر.

لا تخترع بندًا غير موجود.

إذا لم يوجد تغيير:
اذكر ذلك.

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
   ANALYZE SINGLE DOCUMENT
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

  /* -------------------------------------------------------
     DOCX
  ------------------------------------------------------- */

  if (type === "docx") {
    const text =
      await extractDOCX(file);

    return client.responses.create({
      model: MODEL,

      input: `
${instructions}

نص الوثيقة:

${text}
`
    });
  }

  /* -------------------------------------------------------
     PDF
  ------------------------------------------------------- */

  const uploaded =
    await uploadPDF(
      client,
      file
    );

  try {
    return await client.responses.create({
      model: MODEL,

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
    /*
      حذف الملف من OpenAI بعد انتهاء التحليل.
    */

    try {
      await client.files.delete(
        uploaded.id
      );
    } catch (deleteError) {
      console.warn(
        "تعذر حذف ملف OpenAI المؤقت:",
        deleteError.message
      );
    }
  }
}

/* =========================================================
   PREPARE COMPARISON FILE
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

    return {
      type: "text",
      name:
        file.originalname,
      text
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
   COMPARE DOCUMENTS
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

  /* المستند الأول */

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

  /* المستند الثاني */

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
      model: MODEL,

      input: [
        {
          role: "user",
          content
        }
      ]
    });
  } finally {
    /* حذف ملفات PDF المؤقتة */

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
   CONTRACT API
========================================================= */

app.post(
  "/api/analyze",
  rateLimit,
  upload.single("document"),

  async (req, res) => {
    try {
      const client =
        getClient();

      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              "ارفع ملف PDF أو DOCX أولًا."
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

      const result =
        parseResponse(
          response,
          {
            document_type:
              "غير محدد",

            selected_category:
              category,

            score: null,

            summary:
              "تعذر استخراج نتيجة منظمة.",

            key_information: {
              amounts: [],
              dates: [],
              durations: []
            },

            risks: [],

            good_points: [],

            missing_or_unclear: [],

            balance_check: {
              assessment: "",
              notes: []
            }
          }
        );

      return res.json(
        result
      );

    } catch (err) {

      console.error(
        "Contract error:",
        err
      );

      const message =
        err?.message ||
        "حدث خطأ أثناء تحليل العقد.";

      return res
        .status(
          message
            .toLowerCase()
            .includes("25mb")
            ? 413
            : 500
        )
        .json({
          error:
            message
        });
    }
  }
);

/* =========================================================
   JUDGMENT API
========================================================= */

app.post(
  "/api/analyze-judgment",
  rateLimit,
  upload.single("document"),

  async (req, res) => {
    try {
      const client =
        getClient();

      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              "ارفع الوثيقة القضائية بصيغة PDF أو DOCX."
          });
      }

      const response =
        await analyzeSingle(
          client,
          req.file,
          judgmentInstructions
        );

      const result =
        parseResponse(
          response,
          {
            document_type:
              "وثيقة قضائية",

            case_type: "",

            case_information: {
              court: "",
              chamber: "",
              case_number: "",
              judgment_number: "",
              judgment_date: ""
            },

            parties: {
              claimant: "",
              defendant: ""
            },

            summary:
              "تعذر استخراج نتيجة منظمة.",

            claims: [],
            defenses: [],
            facts: [],
            reasons: [],

            judgment: "",

            financial_obligations:
              [],

            deadlines: [],

            appeal_information:
              "",

            important_points:
              [],

            missing_or_unclear:
              [],

            legal_review_needed:
              []
          }
        );

      return res.json(
        result
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
            err?.message ||
            "حدث خطأ أثناء تحليل الحكم."
        });
    }
  }
);

/* =========================================================
   COMPARISON API
========================================================= */

app.post(
  "/api/compare",
  rateLimit,

  upload.fields([
    {
      name: "document1",
      maxCount: 1
    },

    {
      name: "document2",
      maxCount: 1
    }
  ]),

  async (req, res) => {
    try {
      const client =
        getClient();

      const file1 =
        req.files?.document1?.[0];

      const file2 =
        req.files?.document2?.[0];

      if (
        !file1 ||
        !file2
      ) {
        return res
          .status(400)
          .json({
            error:
              "ارفع المستندين أولًا."
          });
      }

      const response =
        await compareDocuments(
          client,
          file1,
          file2
        );

      const result =
        parseResponse(
          response,
          {
            document_1_type:
              "غير محدد",

            document_2_type:
              "غير محدد",

            summary:
              "تعذر استخراج نتيجة منظمة.",

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
        );

      return res.json(
        result
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
            err?.message ||
            "حدث خطأ أثناء مقارنة المستندين."
        });
    }
  }
);

/* =========================================================
   MULTER ERROR HANDLER
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

      if (
        err.code ===
        "LIMIT_FILE_COUNT"
      ) {
        return res
          .status(400)
          .json({
            error:
              "عدد الملفات المسموح به غير صحيح."
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
   GENERAL ERROR HANDLER
========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      "Unhandled error:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res
      .status(500)
      .json({
        error:
          "حدث خطأ غير متوقع في الخادم."
      });
  }
);

/* =========================================================
   SERVER
========================================================= */

const port =
  process.env.PORT ||
  3000;

app.listen(
  port,
  () => {
    console.log(
      `Ihata running on port ${port}`
    );
  }
);
