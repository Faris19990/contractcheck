const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const mammoth = require("mammoth");
const fs = require("fs");
const path = require("path");

const app = express();

const upload = multer({
  storage: multer.diskStorage({
    destination: "/tmp",
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();

      const safeName =
        `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

      cb(null, safeName);
    }
  }),
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

app.post(
  "/api/analyze",
  upload.single("contract"),
  async (req, res) => {
    let filePath = null;
    let uploadedFileId = null;

    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({
          error: "لم يتم إعداد مفتاح OpenAI بعد."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "ارفع ملف PDF أو DOCX."
        });
      }

      filePath = req.file.path;

      const originalName =
        req.file.originalname.toLowerCase();

      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });

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

اجعل score من 0 إلى 100،
حيث 100 أعلى خطورة.

إذا لم تكن معلومة معينة موجودة في العقد،
ضعها ضمن missing_or_unclear.

لا تخترع أي نص نظامي.
`;

      let response;

      // PDF
      if (
        req.file.mimetype === "application/pdf" ||
        originalName.endsWith(".pdf")
      ) {
        const uploadedFile = await client.files.create({
          file: fs.createReadStream(filePath),
          purpose: "user_data"
        });

        uploadedFileId = uploadedFile.id;

        response = await client.responses.create({
          model: "gpt-5",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_file",
                  file_id: uploadedFile.id
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

      // DOCX
      else if (
        req.file.mimetype ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        originalName.endsWith(".docx")
      ) {
        const result = await mammoth.extractRawText({
          path: filePath
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

      // Unsupported
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
      } catch (parseError) {
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
        error:
          "صار خطأ أثناء تحليل العقد. حاول مرة أخرى."
      });

    } finally {

      if (uploadedFileId) {
        try {
          const client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
          });

          await client.files.delete(uploadedFileId);
        } catch (deleteError) {
          console.error(
            "Could not delete uploaded OpenAI file:",
            deleteError.message
          );
        }
      }

      if (filePath) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    }
  }
);

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(
    `ContractCheck running on ${port}`
  );
});
