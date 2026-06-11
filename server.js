const express = require("express");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const cron = require("node-cron");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RESULTS_PATH = path.join(__dirname, "results.json");
const YEAR3_RESULTS_PATH = path.join(__dirname, "year3_results.json");
const CACHE_PATH = path.join(__dirname, "daily_cache.json");

// ============== EMAIL CONFIG ==============
const TO_EMAIL = "alok.singhal2703@gmail.com";
const QUIZ_URL = "https://daily-revision-quiz.onrender.com";
const YEAR3_QUIZ_URL = "https://daily-revision-quiz.onrender.com/year3";

function getGmailAuth() {
  const credentials = JSON.parse(process.env.GMAIL_CREDENTIALS || "{}");
  const token = JSON.parse(process.env.GMAIL_TOKEN || "{}");
  if (!credentials.installed && !credentials.web) return null;
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function sendEmail(subject, body) {
  const auth = getGmailAuth();
  if (!auth) { console.error("❌ Gmail credentials not configured"); return false; }
  const gmail = google.gmail({ version: "v1", auth });
  const message = [
    `To: ${TO_EMAIL}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(body).toString("base64"),
  ].join("\r\n");
  const encodedMessage = Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    await gmail.users.messages.send({ userId: "me", requestBody: { raw: encodedMessage } });
    console.log(`✅ [${new Date().toLocaleTimeString()}] Email sent: ${subject}`);
    return true;
  } catch (err) {
    console.error("❌ Failed to send email:", err.message);
    return false;
  }
}

async function sendDailyEmails() {
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const body1 = `\n📚 DAILY REVISION - ${today}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎯 TAKE TODAY'S QUIZ: ${QUIZ_URL}\n(18 MCQs - Maths & Science - Auto-scored!)\n\n💡 Fresh AI-generated questions every day!\nGood luck! 🚀\n`;
  const body2 = `\n📝 YEAR 3 TEST - ${today}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎯 TAKE TODAY'S TEST: ${YEAR3_QUIZ_URL}\n(22 Questions - Maths, English & Science - Auto-scored!)\n\n💡 Fresh AI-generated questions every day!\nGood luck! 🚀\n`;
  await sendEmail(`Today's Revision - ${today}`, body1);
  await sendEmail(`Year 3 Test - ${today}`, body2);
}

cron.schedule("0 7 * * *", () => {
  console.log("⏰ Cron triggered - sending daily emails");
  sendDailyEmails();
});
console.log("📧 Email cron scheduled: daily at 07:00 UTC");

// ============== GEMINI AI QUESTION GENERATION ==============
async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    }),
  });
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Empty Gemini response");
  return JSON.parse(text);
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getCache() {
  if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
  return {};
}

function setCache(key, data) {
  const cache = getCache();
  cache[key] = data;
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function generateYear8Questions(weakTopics) {
  const cacheKey = `year8_${getTodayKey()}`;
  const cache = getCache();
  if (cache[cacheKey]) return cache[cacheKey];

  const topics = ["Algebra", "Bearings", "Compound Shapes", "Circles", "Angles", "Probability", "Percentages", "Forces", "Electromagnetism", "Work Done", "Periodic Table", "Chemical Reactions"];
  let focusInstruction = "";
  if (weakTopics && weakTopics.length) {
    focusInstruction = `Focus MORE questions (at least 3 each) on these weak areas: ${weakTopics.join(", ")}. Make those questions slightly easier to build confidence.`;
  }

  const prompt = `Generate exactly 18 multiple choice questions for a Year 8 (age 12-13) UK student.
Topics: ${topics.join(", ")}
${focusInstruction}
Each question must have exactly 4 options with only 1 correct answer.
Return ONLY a JSON array with this exact format, no other text:
[{"q":"question text","options":["A","B","C","D"],"answer":0,"topic":"maths_algebra"}]
- "answer" is the index (0-3) of the correct option
- "topic" must be in format "subject_topicname" using: maths_algebra, maths_bearings, maths_compound_shapes, maths_circles, maths_angles, maths_probability, maths_percentages, science_forces, science_electromagnetism, science_work_done, science_periodic_table, science_reactions
- Mix difficulties appropriately for Year 8
- Questions must be different from typical textbook questions - be creative!`;

  try {
    const questions = await callGemini(prompt);
    if (questions.length >= 10) {
      setCache(cacheKey, questions);
      return questions;
    }
  } catch (err) {
    console.error("❌ Gemini Year 8 generation failed:", err.message);
  }
  const fallback = require("./questions");
  return generateFallbackQuiz(fallback, 18);
}

async function generateYear3Questions(strongTopics) {
  const cacheKey = `year3_${getTodayKey()}`;
  const cache = getCache();
  if (cache[cacheKey]) return cache[cacheKey];

  let focusInstruction = "";
  if (strongTopics && strongTopics.length) {
    focusInstruction = `Make questions HARDER for these strong topics: ${strongTopics.join(", ")} (e.g. bigger numbers, trickier sentences).`;
  }

  const prompt = `Generate exactly 22 multiple choice questions for a Year 3 (age 7-8) UK student.
Topics: Addition, Subtraction, Multiplication, Division, Spelling, Punctuation, Conjunctions, Science
${focusInstruction}
Each question must have exactly 4 options with only 1 correct answer.
Return ONLY a JSON array with this exact format, no other text:
[{"q":"question text","options":["A","B","C","D"],"answer":0,"topic":"maths_addition"}]
- "answer" is the index (0-3) of the correct option
- "topic" must be: maths_addition, maths_subtraction, maths_multiplication, maths_division, english_spelling, english_punctuation, english_conjunction, science_general
- Maths: use numbers appropriate for Year 3 (up to 1000 for add/subtract, times tables up to 12)
- English: age-appropriate spelling, punctuation rules, joining sentences
- Science: plants, animals, light, forces, rocks, materials
- Be creative - different questions every time!`;

  try {
    const questions = await callGemini(prompt);
    if (questions.length >= 10) {
      setCache(cacheKey, questions);
      return questions;
    }
  } catch (err) {
    console.error("❌ Gemini Year 3 generation failed:", err.message);
  }
  const fallback = require("./year3_questions");
  return generateFallbackQuiz(fallback, 22);
}

function generateFallbackQuiz(bank, count) {
  const allQs = [];
  for (const [subject, topics] of Object.entries(bank)) {
    for (const [topic, qs] of Object.entries(topics)) {
      qs.forEach(q => allQs.push({ ...q, topic: `${subject}_${topic}` }));
    }
  }
  return allQs.sort(() => Math.random() - 0.5).slice(0, count);
}

// ============== RESULTS ==============
function getResults() {
  if (fs.existsSync(RESULTS_PATH)) return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));
  return [];
}
function saveResult(result) {
  const results = getResults();
  results.push(result);
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
}
function getWeakTopics() {
  const results = getResults();
  if (!results.length) return null;
  const last = results[results.length - 1];
  const weak = [];
  for (const [topic, data] of Object.entries(last.topicScores)) {
    if (data.percent < 60) weak.push(topic);
  }
  return weak.length ? weak : null;
}
function getYear3Results() {
  if (fs.existsSync(YEAR3_RESULTS_PATH)) return JSON.parse(fs.readFileSync(YEAR3_RESULTS_PATH, "utf-8"));
  return [];
}
function saveYear3Result(result) {
  const results = getYear3Results();
  results.push(result);
  fs.writeFileSync(YEAR3_RESULTS_PATH, JSON.stringify(results, null, 2));
}
function getYear3StrongTopics() {
  const results = getYear3Results();
  if (!results.length) return null;
  const last = results[results.length - 1];
  const strong = [];
  for (const [topic, data] of Object.entries(last.topicScores)) {
    if (data.percent >= 80) strong.push(topic);
  }
  return strong.length ? strong : null;
}

// ============== ROUTES ==============
app.get("/", async (req, res) => {
  const weakTopics = getWeakTopics();
  const results = getResults();
  const lastScore = results.length ? results[results.length - 1].totalPercent : null;

  let quiz;
  try {
    quiz = await generateYear8Questions(weakTopics);
  } catch (e) {
    quiz = generateFallbackQuiz(require("./questions"), 18);
  }

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Daily Revision Quiz</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
    .container { max-width: 700px; margin: 0 auto; }
    .header { text-align: center; color: white; margin-bottom: 30px; }
    .header h1 { font-size: 2em; margin-bottom: 5px; }
    .header p { opacity: 0.9; }
    .stats { background: rgba(255,255,255,0.15); border-radius: 10px; padding: 12px; margin-bottom: 20px; color: white; text-align: center; }
    .card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
    .card h3 { color: #333; margin-bottom: 5px; font-size: 1em; }
    .card .topic-tag { display: inline-block; background: #667eea; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.7em; margin-bottom: 8px; }
    .card p { color: #555; margin-bottom: 12px; font-size: 1.05em; }
    .options label { display: block; padding: 10px 14px; margin: 5px 0; border: 2px solid #e0e0e0; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
    .options label:hover { border-color: #667eea; background: #f5f3ff; }
    .options input[type="radio"] { margin-right: 10px; }
    .btn { display: block; width: 100%; padding: 16px; background: #667eea; color: white; border: none; border-radius: 10px; font-size: 1.2em; cursor: pointer; margin-top: 20px; }
    .btn:hover { background: #5a6fd6; }
    .weak { background: #fff3cd; border-radius: 8px; padding: 10px; margin-bottom: 15px; color: #856404; text-align: center; }
  </style></head><body><div class="container">
  <div class="header"><h1>\ud83d\udcda Daily Revision Quiz</h1><p>Year 8 \u2014 Maths & Science \u2022 AI-Generated</p></div>`;

  if (lastScore !== null) html += `<div class="stats">\ud83d\udcca Last Score: <strong>${lastScore}%</strong></div>`;
  if (weakTopics) html += `<div class="weak">\u26a0\ufe0f Focus areas today: <strong>${weakTopics.map(t => t.replace("_", " \u2192 ")).join(", ")}</strong></div>`;

  html += `<form method="POST" action="/submit">`;
  quiz.forEach((q, i) => {
    const topicLabel = (q.topic || "general").replace("_", " \u2192 ").replace(/^\w/, c => c.toUpperCase());
    html += `<div class="card">
      <span class="topic-tag">${topicLabel}</span>
      <h3>Q${i + 1}.</h3>
      <p>${q.q}</p>
      <div class="options">
        ${q.options.map((opt, j) => `<label><input type="radio" name="q${i}" value="${j}" required> ${opt}</label>`).join("")}
      </div>
      <input type="hidden" name="a${i}" value="${q.answer}">
      <input type="hidden" name="t${i}" value="${q.topic}">
    </div>`;
  });
  html += `<input type="hidden" name="total" value="${quiz.length}">
    <button class="btn" type="submit">\u2705 Submit Answers</button></form></div></body></html>`;
  res.send(html);
});

app.post("/submit", (req, res) => {
  const total = parseInt(req.body.total);
  let correct = 0;
  const topicScores = {};

  for (let i = 0; i < total; i++) {
    const userAns = req.body[`q${i}`];
    const correctAns = req.body[`a${i}`];
    const topic = req.body[`t${i}`];
    if (!topicScores[topic]) topicScores[topic] = { correct: 0, total: 0 };
    topicScores[topic].total++;
    if (userAns === correctAns) { correct++; topicScores[topic].correct++; }
  }

  for (const t of Object.keys(topicScores)) {
    topicScores[t].percent = Math.round((topicScores[t].correct / topicScores[t].total) * 100);
  }

  const totalPercent = Math.round((correct / total) * 100);
  saveResult({ date: new Date().toISOString().slice(0, 10), correct, total, totalPercent, topicScores });

  let motivationMsg;
  if (totalPercent === 100) motivationMsg = "Aakhya you are AMAZING! \ud83c\udf1f 100% - Perfect score!";
  else if (totalPercent >= 90) motivationMsg = "Aakhya you are BRILLIANT! \ud83c\udf89 Keep shining!";
  else if (totalPercent >= 80) motivationMsg = "Aakhya you are GREAT! \ud83d\udcaa Fantastic effort!";
  else if (totalPercent >= 70) motivationMsg = "Aakhya, well done! \ud83d\udc4f Getting stronger every day!";
  else if (totalPercent >= 60) motivationMsg = "Aakhya, good effort! \ud83d\udcda A little more practice!";
  else if (totalPercent >= 50) motivationMsg = "Aakhya, don't give up! \ud83c\udf08 You're learning!";
  else motivationMsg = "Aakhya, keep trying! \ud83d\udcaa Every mistake is a step towards success!";

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Quiz Result</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); min-height: 100vh; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; text-align: center; }
    .result-card { background: white; border-radius: 16px; padding: 40px; margin-top: 40px; box-shadow: 0 8px 30px rgba(0,0,0,0.15); }
    .score { font-size: 4em; font-weight: bold; color: ${totalPercent >= 70 ? "#11998e" : totalPercent >= 50 ? "#f39c12" : "#e74c3c"}; }
    .motivation { font-size: 1.3em; margin: 20px 0; color: #2d2d2d; font-weight: bold; background: linear-gradient(135deg, #667eea22, #764ba222); padding: 15px; border-radius: 10px; }
    .topics { text-align: left; margin-top: 20px; }
    .topic-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
    .good { color: #11998e; font-weight: bold; }
    .weak { color: #e74c3c; font-weight: bold; }
    .btn { display: inline-block; padding: 12px 30px; background: #11998e; color: white; border-radius: 8px; text-decoration: none; margin-top: 25px; font-size: 1.1em; }
  </style></head><body><div class="container"><div class="result-card">
    <div class="score">${totalPercent}%</div>
    <div class="motivation">${motivationMsg}</div>
    <p>${correct} out of ${total} correct</p>
    <div class="topics"><h3 style="margin:15px 0">Topic Breakdown:</h3>`;

  const weakAreas = [];
  for (const [topic, data] of Object.entries(topicScores)) {
    const label = topic.replace("_", " > ").replace(/^\w/, c => c.toUpperCase());
    const cls = data.percent >= 60 ? "good" : "weak";
    if (data.percent < 60) weakAreas.push(label);
    html += `<div class="topic-row"><span>${label}</span><span class="${cls}">${data.correct}/${data.total} (${data.percent}%)</span></div>`;
  }
  html += `</div>`;

  if (weakAreas.length) {
    html += `<div style="background:#fff3cd;border-radius:10px;padding:15px;margin-top:20px;text-align:left;color:#856404;"><h3>Aakhya, let's improve these:</h3><ul style="margin:8px 0 8px 20px;">${weakAreas.map(t => `<li style="margin:4px 0;font-weight:bold;">${t}</li>`).join("")}</ul></div>`;
  } else {
    html += `<div style="background:#d4edda;border-radius:10px;padding:15px;margin-top:20px;color:#155724;"><h3>You smashed every topic! \ud83d\udd25</h3></div>`;
  }
  html += `</div><a class="btn" href="/">\ud83d\udd04 Try Again</a></div></div></body></html>`;
  res.send(html);
});

app.get("/history", (req, res) => res.json(getResults()));

// ============== YEAR 3 ==============
app.get("/year3", async (req, res) => {
  const strongTopics = getYear3StrongTopics();
  const results = getYear3Results();
  const lastScore = results.length ? results[results.length - 1].totalPercent : null;

  let quiz;
  try {
    quiz = await generateYear3Questions(strongTopics);
  } catch (e) {
    quiz = generateFallbackQuiz(require("./year3_questions"), 22);
  }

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Year 3 Test</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); min-height: 100vh; padding: 20px; }
    .container { max-width: 700px; margin: 0 auto; }
    .header { text-align: center; color: white; margin-bottom: 30px; }
    .header h1 { font-size: 2em; margin-bottom: 5px; }
    .header p { opacity: 0.9; }
    .stats { background: rgba(255,255,255,0.15); border-radius: 10px; padding: 12px; margin-bottom: 20px; color: white; text-align: center; }
    .card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
    .card h3 { color: #333; margin-bottom: 5px; font-size: 1em; }
    .card .topic-tag { display: inline-block; background: #4facfe; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.7em; margin-bottom: 8px; }
    .card p { color: #555; margin-bottom: 12px; font-size: 1.05em; }
    .options label { display: block; padding: 10px 14px; margin: 5px 0; border: 2px solid #e0e0e0; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
    .options label:hover { border-color: #4facfe; background: #f0f8ff; }
    .options input[type="radio"] { margin-right: 10px; }
    .btn { display: block; width: 100%; padding: 16px; background: #4facfe; color: white; border: none; border-radius: 10px; font-size: 1.2em; cursor: pointer; margin-top: 20px; }
    .btn:hover { background: #3a8fd9; }
    .levelup { background: #d4edda; border-radius: 8px; padding: 10px; margin-bottom: 15px; color: #155724; text-align: center; }
  </style></head><body><div class="container">
  <div class="header"><h1>\ud83d\udcdd Year 3 Test</h1><p>Maths, English & Science \u2022 AI-Generated</p></div>`;

  if (lastScore !== null) html += `<div class="stats">\ud83d\udcca Last Score: <strong>${lastScore}%</strong></div>`;
  if (strongTopics) html += `<div class="levelup">\u2b06\ufe0f Levelling up: <strong>${strongTopics.map(t => t.replace("_", " \u2192 ")).join(", ")}</strong></div>`;

  html += `<form method="POST" action="/year3/submit">`;
  quiz.forEach((q, i) => {
    const topicLabel = (q.topic || "general").replace("_", " \u2192 ").replace(/^\w/, c => c.toUpperCase());
    html += `<div class="card">
      <span class="topic-tag">${topicLabel}</span>
      <h3>Q${i + 1}.</h3>
      <p>${q.q}</p>
      <div class="options">
        ${q.options.map((opt, j) => `<label><input type="radio" name="q${i}" value="${j}" required> ${opt}</label>`).join("")}
      </div>
      <input type="hidden" name="a${i}" value="${q.answer}">
      <input type="hidden" name="t${i}" value="${q.topic}">
    </div>`;
  });
  html += `<input type="hidden" name="total" value="${quiz.length}">
    <button class="btn" type="submit">\u2705 Submit Answers</button></form></div></body></html>`;
  res.send(html);
});

app.post("/year3/submit", (req, res) => {
  const total = parseInt(req.body.total);
  let correct = 0;
  const topicScores = {};

  for (let i = 0; i < total; i++) {
    const userAns = req.body[`q${i}`];
    const correctAns = req.body[`a${i}`];
    const topic = req.body[`t${i}`];
    if (!topicScores[topic]) topicScores[topic] = { correct: 0, total: 0 };
    topicScores[topic].total++;
    if (userAns === correctAns) { correct++; topicScores[topic].correct++; }
  }

  for (const t of Object.keys(topicScores)) {
    topicScores[t].percent = Math.round((topicScores[t].correct / topicScores[t].total) * 100);
  }

  const totalPercent = Math.round((correct / total) * 100);
  saveYear3Result({ date: new Date().toISOString().slice(0, 10), correct, total, totalPercent, topicScores });

  let motivationMsg;
  if (totalPercent === 100) motivationMsg = "Kahaan you are a SUPERSTAR! \ud83c\udf1f 100% - Perfect score!";
  else if (totalPercent >= 90) motivationMsg = "Kahaan you are BRILLIANT! \ud83c\udf89 Almost perfect!";
  else if (totalPercent >= 80) motivationMsg = "Kahaan you did GREAT today! \ud83d\udcaa Amazing effort!";
  else if (totalPercent >= 70) motivationMsg = "Kahaan, well done! \ud83d\udc4f Getting stronger every day!";
  else if (totalPercent >= 60) motivationMsg = "Kahaan, good effort! \ud83d\udcda A little more practice!";
  else if (totalPercent >= 50) motivationMsg = "Kahaan, don't give up! \ud83c\udf08 You're learning!";
  else motivationMsg = "Kahaan, keep trying! \ud83d\udcaa Every mistake helps you learn!";

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Year 3 Result</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); min-height: 100vh; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; text-align: center; }
    .result-card { background: white; border-radius: 16px; padding: 40px; margin-top: 40px; box-shadow: 0 8px 30px rgba(0,0,0,0.15); }
    .score { font-size: 4em; font-weight: bold; color: ${totalPercent >= 70 ? "#11998e" : totalPercent >= 50 ? "#f39c12" : "#e74c3c"}; }
    .motivation { font-size: 1.3em; margin: 20px 0; color: #2d2d2d; font-weight: bold; background: linear-gradient(135deg, #f093fb22, #f5576c22); padding: 15px; border-radius: 10px; }
    .topics { text-align: left; margin-top: 20px; }
    .topic-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
    .good { color: #11998e; font-weight: bold; }
    .weak { color: #e74c3c; font-weight: bold; }
    .btn { display: inline-block; padding: 12px 30px; background: #11998e; color: white; border-radius: 8px; text-decoration: none; margin-top: 25px; font-size: 1.1em; }
  </style></head><body><div class="container"><div class="result-card">
    <div class="score">${totalPercent}%</div>
    <div class="motivation">${motivationMsg}</div>
    <p>${correct} out of ${total} correct</p>
    <div class="topics"><h3 style="margin:15px 0">Topic Breakdown:</h3>`;

  const strongAreas = [], weakAreas = [];
  for (const [topic, data] of Object.entries(topicScores)) {
    const label = topic.replace("_", " > ").replace(/^\w/, c => c.toUpperCase());
    const cls = data.percent >= 80 ? "good" : "weak";
    if (data.percent >= 80) strongAreas.push(label);
    else if (data.percent < 60) weakAreas.push(label);
    html += `<div class="topic-row"><span>${label}</span><span class="${cls}">${data.correct}/${data.total} (${data.percent}%)</span></div>`;
  }
  html += `</div>`;

  if (strongAreas.length) html += `<div style="background:#d4edda;border-radius:10px;padding:15px;margin-top:20px;text-align:left;color:#155724;"><h3>\u2b06\ufe0f Tomorrow these will be harder:</h3><ul style="margin:8px 0 8px 20px;">${strongAreas.map(t => `<li style="margin:4px 0;font-weight:bold;">${t}</li>`).join("")}</ul></div>`;
  if (weakAreas.length) html += `<div style="background:#fff3cd;border-radius:10px;padding:15px;margin-top:20px;text-align:left;color:#856404;"><h3>\ud83d\udcda Keep practising:</h3><ul style="margin:8px 0 8px 20px;">${weakAreas.map(t => `<li style="margin:4px 0;font-weight:bold;">${t}</li>`).join("")}</ul></div>`;

  html += `</div><a class="btn" href="/year3">\ud83d\udd04 Try Again</a></div></div></body></html>`;
  res.send(html);
});

app.get("/year3/history", (req, res) => res.json(getYear3Results()));

// Manual email trigger
app.get("/send-emails", async (req, res) => {
  await sendDailyEmails();
  res.send("✅ Emails sent!");
});

app.listen(PORT, () => {
  console.log(`\n\ud83d\udcda Quiz server running at http://localhost:${PORT}`);
  console.log(`   AI-powered questions via Google Gemini`);
});
