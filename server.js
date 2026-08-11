const express=require("express");
const multer=require("multer");
const OpenAI=require("openai");
const pdfParse=require("pdf-parse");
const mammoth=require("mammoth");
const fs=require("fs");
const path=require("path");

const app=express();
const upload=multer({
  dest:"/tmp/contractcheck",
  limits:{fileSize:12*1024*1024}
});

app.use(express.static(path.join(__dirname,"public")));
app.get("/api/health",(req,res)=>res.json({ok:true,service:"ContractCheck"}));

app.post("/api/analyze",upload.single("contract"),async(req,res)=>{
  let filePath;
  try{
    if(!process.env.OPENAI_API_KEY)
      return res.status(500).json({error:"لم يتم إعداد مفتاح OpenAI بعد."});
    if(!req.file)
      return res.status(400).json({error:"ارفع ملف PDF أو DOCX."});

    filePath=req.file.path;
    let text="";
    const name=req.file.originalname.toLowerCase();

    if(req.file.mimetype==="application/pdf" || name.endsWith(".pdf")){
      text=(await pdfParse(fs.readFileSync(filePath))).text;
    }else if(name.endsWith(".docx")){
      text=(await mammoth.extractRawText({path:filePath})).value;
    }else{
      return res.status(400).json({error:"الصيغة المدعومة PDF أو DOCX فقط."});
    }

    if(!text.trim())
      return res.status(400).json({error:"لم أستطع استخراج النص من الملف."});

    text=text.slice(0,60000);

    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const prompt=`أنت ContractCheck، أداة فحص أولي للعقود في السعودية.
حلل العقد التالي باللغة العربية. لا تقدم حكمًا قانونيًا قطعيًا ولا تخترع مواد نظامية.
أخرج JSON صالح فقط بهذا الشكل:
{
 "score":0,
 "summary":"",
 "risks":[
   {"level":"high|medium|low","title":"","clause":"","why":"","question":""}
 ],
 "good_points":[],
 "missing_or_unclear":[]
}
ركز على: الشرط الجزائي، المسؤولية وحدودها، الإنهاء، التجديد، الدفع، تعديل الأسعار، الملكية الفكرية، السرية، الاختصاص وتسوية النزاع، الالتزامات غير المتوازنة، وأي بند قد يسبب مخاطرة مالية أو تشغيلية.
اجعل score من 0 إلى 100، حيث 100 أعلى خطورة.
إذا كانت نقطة تحتاج مراجعة قانون سعودي، اكتب ذلك بدل اختراع نص نظامي.

نص العقد:
${text}`;

    const response=await client.responses.create({
      model:"gpt-5",
      input:prompt
    });

    let raw=response.output_text.trim();
    raw=raw.replace(/^```json\s*/i,"").replace(/```$/,"").trim();

    let data;
    try{
      data=JSON.parse(raw);
    }catch{
      data={score:null,summary:raw,risks:[],good_points:[],missing_or_unclear:[]};
    }
    res.json(data);
  }catch(err){
    console.error(err);
    res.status(500).json({error:"صار خطأ أثناء التحليل. تأكد من مفتاح OpenAI وصحة الملف."});
  }finally{
    if(filePath)try{fs.unlinkSync(filePath)}catch{}
  }
});

const port=process.env.PORT||3000;
app.listen(port,()=>console.log(`ContractCheck running on ${port}`));
