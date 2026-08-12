const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const mammoth = require("mammoth");
const path = require("path");

const app = express();

const MAX_FILE_SIZE = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

app.use(express.static(path.join(__dirname, "public")));

/* =========================
   Rate Limit
========================= */

const requestLog = new Map();

const RATE_WINDOW = 10 * 60 * 1000;
const RATE_MAX = 8;

function getIP(req) {
  const forwarded = req.headers["x-forwarded-for"];

  return String(
    forwarded ||
    req.ip ||
    "unknown"
  )
    .split(",")[0]
    .trim();
}

function rateLimit(req, res, next) {
  const ip = getIP(req);
  const now = Date.now();

  const previous = requestLog.get(ip) || [];

  const recent = previous.filter(
    time => now - time < RATE_WINDOW
  );

  if (recent.length >= RATE_MAX) {
    return res.status(429).json({
      error:
        "تم الوصول للحد المؤقت من التحليلات. حاول مرة أخرى بعد قليل."
    });
  }

  recent.push(now);
  requestLog.set(ip, recent);

  next();
}

/* =========================
   Health
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Ihata"
  });
});

/* =========================
   OpenAI
========================= */

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "لم يتم إعداد مفتاح OpenAI."
    );
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

/* =========================
   Helpers
========================= */

function cleanJSON(raw) {
  return String(raw || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function getFileType(file) {
  const name =
    String(file.originalname || "").toLowerCase();

  if (
    file.mimetype === "application/pdf" ||
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

/* =========================
   DOCX
========================= */

async function extractDOCX(file) {
  const result =
    await mammoth.extractRawText({
      buffer: file.buffer
    });

  return result.value.trim();
}

/* =========================
   PDF
========================= */

async function analyzePDF(
  client,
  file,
  instructions
) {
  const originalName =
    file.originalname || "document.pdf";

  const fileForOpenAI =
    await toFile(
      file.buffer,
      originalName,
      {
        type: "application/pdf"
      }
    );

  const uploaded =
    await client.files.create({
      file: fileForOpenAI,
      purpose: "user_data"
    });

  try {
    return await client.responses.create({
      model: "gpt-5-mini",

      input: [
        {
          role: "user",

          content: [
            {
              type: "input_file",
              file_id: uploaded.id
            },

            {
              type: "input_text",
              text: instructions
            }
          ]
        }
      ]
    });
  }

  finally {
    /*
      لا نؤخر إرسال النتيجة
      بانتظار حذف الملف.
    */
    client.files
      .delete(uploaded.id)
      .catch(() => {});
  }
}

/* =========================
   Document Analyzer
========================= */

async function analyzeDocument(
  client,
  file,
  instructions
) {
  if (
    !file ||
    !file.buffer ||
    file.buffer.length === 0
  ) {
    throw new Error(
      "الملف فارغ أو لم يتم رفعه بشكل صحيح."
    );
  }

  const type =
    getFileType(file);

  if (!type) {
    throw new Error(
      "الصيغة المدعومة PDF أو DOCX فقط."
    );
  }

  if (type === "pdf") {
    return analyzePDF(
      client,
      file,
      instructions
    );
  }

  const text =
    await extractDOCX(file);

  if (!text) {
    throw new Error(
      "لم أستطع استخراج النص من ملف Word."
    );
  }

  return client.responses.create({
    model: "gpt-5-mini",

    input: `
${instructions}

نص الوثيقة:

${text.slice(0, 65000)}
`
  });
}

/* =========================
   JSON Parser
========================= */

function parseResponse(
  response,
  fallback
) {
  const raw =
    cleanJSON(
      response?.output_text || ""
    );

  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  }

  catch {
    return {
      ...fallback,
      summary: raw
    };
  }
}

/* =========================
   CONTRACT PROMPT
========================= */

function contractInstructions(
  category
) {
return `
أنت "إحاطة"، أداة فحص أولي للمستندات القانونية في السعودية.

حلل المستند باللغة العربية.

أنت أداة مساعدة وليست بديلًا عن المحامي.

لا تقدم حكمًا قانونيًا قطعيًا.
لا تخترع مواد أو أنظمة أو أحكامًا قضائية.
لا تخترع معلومات غير موجودة في المستند.

إذا احتاجت نقطة إلى تحقق أو تفسير قانوني سعودي، اكتب:

"تحتاج مراجعة قانونية سعودية"

القسم الذي اختاره المستخدم:

${category}

تحقق من النوع الحقيقي للعقد من محتواه.

إذا كان المستخدم اختار القسم الخطأ،
لا تتبع اختياره بشكل أعمى.

حدد نوع المستند الحقيقي.

أمثلة:

عقد مقاولات
عقد تجاري
عقد إيجار
عقد عمل
عقد توريد
عقد شراكة
عقد استثمار
عقد تقنية
عقد خدمات
عقد بيع
عقد وكالة
عقد استشارات
عقد صيانة
غير محدد

راجع خصوصًا:

- الشرط الجزائي
- المسؤولية
- التعويض
- الإنهاء
- التجديد
- الدفع
- تعديل الأسعار
- السرية
- الملكية الفكرية
- الاختصاص القضائي
- تسوية النزاع
- الالتزامات غير المتوازنة
- المخاطر المالية
- المخاطر التشغيلية

إذا كان العقد مقاولات، راجع:

- مدة التنفيذ
- نطاق العمل
- المستخلصات
- الدفعة المقدمة
- التأخير
- غرامات التأخير
- الأعمال الإضافية
- تغيير نطاق العمل
- المواصفات
- الاستلام
- العيوب
- الضمان
- التأمين
- سحب الأعمال
- الإنهاء

إذا كان إيجار:

- مدة الإيجار
- الأجرة
- التجديد
- الزيادة
- التأمين
- الصيانة
- الإخلاء
- الفسخ

إذا كان عمل:

- الأجر
- المدة
- التجربة
- ساعات العمل
- الإجازات
- الإنهاء
- السرية
- الملكية الفكرية

استخرج:

- المبالغ
- العملات
- النسب
- التواريخ
- المدد
- الإشعارات
- أي أرقام مهمة

لا تعتبر غياب بند مخالفة قانونية تلقائيًا.

إذا لم توجد معلومة:

ضعها في missing_or_unclear.

score:

0 = مخاطرة منخفضة جدًا

100 = أعلى مخاطرة ظاهرة في المستند.

أخرج JSON صالح فقط:

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
      "level": "high|medium|low",
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

/* =========================
   JUDGMENT PROMPT
========================= */

const judgmentInstructions = `
أنت "إحاطة"، أداة فحص أولي للأحكام والوثائق القضائية في السعودية.

حلل الوثيقة باللغة العربية.

لا تصدر حكمًا جديدًا.

لا تتنبأ بنتيجة الاستئناف.

لا تقل إن الحكم صحيح أو باطل بشكل قطعي.

لا تخترع مواد أو أنظمة أو وقائع.

إذا احتاجت نقطة إلى تحقق قانوني سعودي، اكتب:

"تحتاج مراجعة قانونية سعودية"

إذا لم تكن المعلومة موجودة:

"غير مذكور في الوثيقة"

استخرج قدر الإمكان:

- نوع القضية
- المحكمة
- الدائرة
- رقم القضية
- رقم الحكم
- تاريخ الحكم
- المدعي
- المدعى عليه
- الوقائع
- الطلبات
- الدفوع
- الأدلة
- أسباب الحكم
- منطوق الحكم
- المبالغ
- الالتزامات
- المدد
- الاعتراض
- الاستئناف
- القطعية إذا كانت مذكورة صراحة

حدد أهم ما انتهت إليه المحكمة.

حدد الالتزامات الواقعة على الأطراف.

حدد النقاط غير الواضحة.

حدد أي تعارض ظاهر داخل الوثيقة فقط.

أخرج JSON صالح فقط:

{
  "document_type": "صك حكم أو وثيقة قضائية",

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

/* =========================
   DOCUMENT COMPARISON PROMPT
========================= */

const comparisonInstructions = `
أنت "إحاطة"، أداة مقارنة أولية بين مستندين قانونيين في السعودية.

حلل المستندين باللغة العربية.

لا تقدم حكمًا قانونيًا قطعيًا.

لا تخترع مواد أو أنظمة أو أحكامًا قضائية.

لا تخترع معلومات غير موجودة في المستندين.

حدد نوع كل مستند.

قارن بينهما بوضوح، وركز على:

- البنود المضافة
- البنود المحذوفة
- البنود التي تغيرت صياغتها أو معناها الظاهر
- المبالغ والأسعار
- التواريخ والمدد
- الشرط الجزائي
- الإنهاء والتجديد
- المسؤوليات والتعويض
- الدفع
- الملكية الفكرية والسرية
- الاختصاص وتسوية النزاع
- الالتزامات غير المتوازنة
- أي تغيير قد يسبب أثرًا ماليًا أو تشغيليًا ظاهرًا

لا تقل إن التغيير غير نظامي بشكل قطعي.

إذا احتاجت نقطة إلى تحقق قانوني سعودي، اكتب:

"تحتاج مراجعة قانونية سعودية"

أخرج JSON صالح فقط:

{
  "document_1_type": "",
  "document_2_type": "",
  "summary": "",

  "important_changes": [
    {
      "level": "high|medium|low",
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

async function extractDocumentForComparison(
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
      kind: "text",
      name:
        file.originalname ||
        "document.docx",
      text:
        text.slice(0, 65000)
    };
  }

  const originalName =
    file.originalname ||
    "document.pdf";

  const fileForOpenAI =
    await toFile(
      file.buffer,
      originalName,
      {
        type: "application/pdf"
      }
    );

  const uploaded =
    await client.files.create({
      file: fileForOpenAI,
      purpose: "user_data"
    });

  return {
    kind: "file",
    name: originalName,
    fileId: uploaded.id
  };
}

async function compareDocuments(
  client,
  file1,
  file2
) {
  const doc1 =
    await extractDocumentForComparison(
      client,
      file1
    );

  const doc2 =
    await extractDocumentForComparison(
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
        `المستند الأول: ${doc1.name}`
    },

    {
      type: "input_text",
      text:
        `المستند الثاني: ${doc2.name}`
    }

  ];

  if (doc1.kind === "file") {

    content.push({
      type: "input_file",
      file_id: doc1.fileId
    });

  } else {

    content.push({
      type: "input_text",
      text:
        `نص المستند الأول:\n${doc1.text}`
    });

  }

  if (doc2.kind === "file") {

    content.push({
      type: "input_file",
      file_id: doc2.fileId
    });

  } else {

    content.push({
      type: "input_text",
      text:
        `نص المستند الثاني:\n${doc2.text}`
    });

  }

  try {

    return await client.responses.create({
      model: "gpt-5-mini",

      input: [
        {
          role: "user",
          content
        }
      ]
    });

  }

  finally {

    if (doc1.kind === "file") {
      client.files
        .delete(doc1.fileId)
        .catch(() => {});
    }

    if (doc2.kind === "file") {
      client.files
        .delete(doc2.fileId)
        .catch(() => {});
    }

  }
}

/* =========================
   Contract API
========================= */

app.post(
  "/api/analyze",
  rateLimit,
  upload.single("document"),
  async (req, res) => {

    try {

      const client =
        getClient();

      if (!req.file) {

        return res.status(400).json({
          error:
            "ارفع ملف PDF أو DOCX."
        });

      }

      const category =
        safeCategory(
          req.body?.category
        );

      const response =
        await analyzeDocument(
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

            score: null,

            summary: "",

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
        )
      );

    }

    catch (err) {

      console.error(
        "Contract error:",
        err
      );

      return res.status(500).json({
        error:
          err.message ||
          "صار خطأ أثناء تحليل العقد."
      });

    }

  }
);

/* =========================
   Judgment API
========================= */

app.post(
  "/api/analyze-judgment",
  rateLimit,
  upload.single("document"),
  async (req, res) => {

    try {

      const client =
        getClient();

      if (!req.file) {

        return res.status(400).json({
          error:
            "ارفع صك الحكم بصيغة PDF أو DOCX."
        });

      }

      const response =
        await analyzeDocument(
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

            summary: "",

            claims: [],
            defenses: [],
            facts: [],
            reasons: [],

            judgment: "",

            financial_obligations: [],
            deadlines: [],

            appeal_information: "",

            important_points: [],

            missing_or_unclear: [],

            legal_review_needed: []
          }
        )
      );

    }

    catch (err) {

      console.error(
        "Judgment error:",
        err
      );

      return res.status(500).json({
        error:
          err.message ||
          "صار خطأ أثناء تحليل الحكم."
      });

    }

  }
);

/* =========================
   Comparison API
========================= */

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

      if (!file1 || !file2) {

        return res.status(400).json({
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

      return res.json(
        parseResponse(
          response,
          {
            document_1_type:
              "غير محدد",

            document_2_type:
              "غير محدد",

            summary: "",

            important_changes: [],

            added_clauses: [],

            removed_clauses: [],

            changed_amounts: [],

            changed_dates_or_durations: [],

            changed_obligations: [],

            legal_review_needed: []
          }
        )
      );

    }

    catch (err) {

      console.error(
        "Comparison error:",
        err
      );

      return res.status(500).json({
        error:
          err.message ||
          "صار خطأ أثناء مقارنة المستندين."
      });

    }

  }
);

/* =========================
   Multer Error Handler
========================= */

app.use(
  (err, req, res, next) => {

    if (
      err instanceof multer.MulterError
    ) {

      if (
        err.code === "LIMIT_FILE_SIZE"
      ) {

        return res.status(413).json({
          error:
            "حجم الملف كبير. الحد الأقصى المسموح حاليًا هو 25MB."
        });

      }

      return res.status(400).json({
        error:
          "حدث خطأ أثناء رفع الملف."
      });

    }

    next(err);
  }
);

/* =========================
   Server
========================= */

const port =
  process.env.PORT || 3000;

app.listen(
  port,
  () => {
    console.log(
      `Ihata running on ${port}`
    );
  }
);
