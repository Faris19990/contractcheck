const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const mammoth = require("mammoth");
const path = require("path");

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "ContractCheck"
  });
});

app.post("/api/analyze", upload.single("contract"), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "لم يتم إعداد مفتاح OpenAI بعد."
      });
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({
        error: "الملف فارغ أو لم يتم رفعه بشكل صحيح."
      });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const originalName = req.file.originalname;
    const lowerName = originalName.toLowerCase();

    const instructions = `
أنت ContractCheck، أداة فحص أولي للعقود في السعودية.

حلل العقد باللغة العربية.

لا تقدم حكمًا قانونيًا قطعيًا.
لا تخترع مواد أو أنظمة أو أحكامًا قضائية.

إذا كانت نقطة تحتاج مراجعة قانون سعودي، اكتب:
"تحتاج مراجعة قانونية سعودية"

أخرج JSON صالح فقط بهذا الشكل:

{
  "score": 0,
  "summary": "",
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
  "missing_or_unclear": []
}

ركز على:
- الشرط الجزائي
- المسؤولية وحدودها
- الإنهاء
- التجديد
- الدفع
- تعديل الأسعار
- الملكية الفكرية
- السرية
- الاختصاص وتسوية النزاع
- الالتزامات غير المتوازنة
- أي بند قد يسبب مخاطرة مالية أو تشغيلية

اجعل score من 0 إلى 100، حيث 100 أعلى خطورة.

إذا كانت معلومة غير موجودة في العقد، ضعها في missing_or_unclear.

لا تخترع أي نص نظامي.
`;

    let response;

    if (
      req.file.mimetype === "application/pdf" ||
      lowerName.endsWith(".pdf")
    ) {
      const fileForOpenAI = await toFile(
        req.file.buffer,
        originalName,
        {
          type: "application/pdf"
        }
      );

      const uploaded = await client.files.create({
        file: fileForOpenAI,
        purpose: "user_data"
      });

      try {
        response = await client.responses.create({
          model: "gpt-5",
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
      } finally {
        try {
          await client.files.delete(uploaded.id);
        } catch {}
      }
    }

    else if (
      req.file.mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      lowerName.endsWith(".docx")
    ) {
      const result = await mammoth.extractRawText({
        buffer: req.file.buffer
      });

      const text = result.value.trim();

      if (!text) {
        return res.status(400).json({
          error: "لم أستطع استخراج النص من ملف Word."
        });
      }

      response = await client.responses.create({
        model: "gpt-5",
        input: `${instructions}

نص العقد:

${text.slice(0, 60000)}`
      });
    }

    else {
      return res.status(400).json({
        error: "الصيغة المدعومة PDF أو DOCX فقط."
      });
    }

    let raw = response.output_text.trim();

    raw = raw
      .replace(/^```json\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      data = {
        score: null,
        summary: raw,
        risks: [],
        good_points: [],
        missing_or_unclear: []
      };
    }

    return res.json(data);

  } catch (err) {
    console.error("ContractCheck error:", err);

    return res.status(500).json({
      error: "صار خطأ أثناء تحليل العقد. حاول مرة أخرى."
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`ContractCheck running on ${port}`);
});
