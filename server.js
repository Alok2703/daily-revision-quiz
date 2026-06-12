const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG_PATH = path.join(__dirname, "config.json");
const RESULTS_PATH = path.join(__dirname, "results.json");
const YEAR3_RESULTS_PATH = path.join(__dirname, "year3_results.json");
const PORT = process.env.PORT || 3000;

function getConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

// Generate questions from Gemini REST API based on config topics
async function generateQuestionsFromGemini(yearKey) {
  const config = getConfig();
  const yearConfig = config[yearKey];
  const totalQuestions = yearConfig.questionsPerQuiz;
  const apiKey = process.env.GEMINI_API_KEY;

  const topicsList = Object.entries(yearConfig.subjects)
    .map(([subject, topics]) => `${subject}: ${topics.join(", ")}`)
    .join("\n");

  const yearLabel = yearKey === "year8" ? "Year 8" : "Year 3";

  const prompt = `Generate exactly ${totalQuestions} multiple choice questions for a ${yearLabel} student.

Topics to cover (spread questions evenly across all topics):
${topicsList}

Return ONLY a valid JSON array with no extra text. Each object must have:
- "q": the question text
- "options": array of exactly 4 option strings
- "answer": index (0-3) of the correct option
- "topic": the topic name (e.g. "Algebra", "Forces")
- "subject": the subject name (e.g. "maths", "science")

Make questions age-appropriate for ${yearLabel}. Mix easy and medium difficulty. No duplicate questions.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });

  if (!resp.ok) throw new Error(`Gemini API error: ${resp.status} ${await resp.text()}`);

  const data = await resp.json();
  const text = data.candidates[0].content.parts[0].text;

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Failed to parse Gemini response");

  return JSON.parse(jsonMatch[0]).slice(0, totalQuestions);
}

// ---- Results helpers ----
function getResults() {
  if (fs.existsSync(RESULTS_PATH)) return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));
  return [];
}
function saveResult(result) {
  const results = getResults();
  results.push(result);
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
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

// ---- Quiz HTML renderer ----
function renderQuizPage(quiz, yearKey, lastScore, config) {
  const yearConfig = config[yearKey];
  const isYear8 = yearKey === "year8";
  const title = isYear8 ? "📚 Daily Revision Quiz" : "📝 Year 3 Test";
  const subtitle = isYear8 ? `Year 8 — ${yearConfig.name}` : `Year 3 — ${yearConfig.name}`;
  const gradientBg = isYear8 ? "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" : "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)";
  const tagColor = isYear8 ? "#667eea" : "#f5576c";
  const hoverBorder = isYear8 ? "#667eea" : "#f5576c";
  const hoverBg = isYear8 ? "#f5f3ff" : "#fff0f3";
  const btnBg = isYear8 ? "#667eea" : "#f5576c";
  const submitAction = isYear8 ? "/submit" : "/year3/submit";

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: ${gradientBg}; min-height: 100vh; padding: 20px; }
    .container { max-width: 700px; margin: 0 auto; }
    .header { text-align: center; color: white; margin-bottom: 30px; }
    .header h1 { font-size: 2em; margin-bottom: 5px; }
    .header p { opacity: 0.9; }
    .stats { background: rgba(255,255,255,0.15); border-radius: 10px; padding: 12px; margin-bottom: 20px; color: white; text-align: center; }
    .card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
    .card h3 { color: #333; margin-bottom: 5px; font-size: 1em; }
    .card .topic-tag { display: inline-block; background: ${tagColor}; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.7em; margin-bottom: 8px; }
    .card p { color: #555; margin-bottom: 12px; font-size: 1.05em; }
    .options label { display: block; padding: 10px 14px; margin: 5px 0; border: 2px solid #e0e0e0; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
    .options label:hover { border-color: ${hoverBorder}; background: ${hoverBg}; }
    .options input[type="radio"] { margin-right: 10px; }
    .btn { display: block; width: 100%; padding: 16px; background: ${btnBg}; color: white; border: none; border-radius: 10px; font-size: 1.2em; cursor: pointer; margin-top: 20px; }
    .btn:hover { opacity: 0.9; }
    .loading { text-align: center; color: white; font-size: 1.3em; margin-top: 50px; }
  </style></head><body><div class="container">
  <div class="header"><h1>${title}</h1><p>${subtitle}</p></div>`;

  if (lastScore !== null) {
    html += `<div class="stats">📊 Last Score: <strong>${lastScore}%</strong></div>`;
  }

  html += `<form method="POST" action="${submitAction}">`;

  quiz.forEach((q, i) => {
    const topicLabel = `${q.subject} → ${q.topic}`;
    html += `<div class="card">
      <span class="topic-tag">${topicLabel}</span>
      <h3>Q${i + 1}.</h3>
      <p>${q.q}</p>
      <div class="options">
        ${q.options.map((opt, j) => `<label><input type="radio" name="q${i}" value="${j}" required> ${opt}</label>`).join("")}
      </div>
      <input type="hidden" name="a${i}" value="${q.answer}">
      <input type="hidden" name="t${i}" value="${q.subject}_${q.topic}">
    </div>`;
  });

  html += `<input type="hidden" name="total" value="${quiz.length}">
    <button class="btn" type="submit">✅ Submit Answers</button></form></div></body></html>`;

  return html;
}

function renderResultPage(correct, total, topicScores, yearKey, config) {
  const yearConfig = config[yearKey];
  const isYear8 = yearKey === "year8";
  const name = yearConfig.name;
  const totalPercent = Math.round((correct / total) * 100);
  const retryLink = isYear8 ? "/" : "/year3";

  let motivationMsg;
  if (totalPercent === 100) motivationMsg = `${name} you are AMAZING! 🌟 100% - Perfect score!`;
  else if (totalPercent >= 90) motivationMsg = `${name} you are BRILLIANT! 🎉 Keep shining!`;
  else if (totalPercent >= 80) motivationMsg = `${name} you are GREAT! 💪 Fantastic effort!`;
  else if (totalPercent >= 70) motivationMsg = `${name}, well done! 👏 Getting stronger every day!`;
  else if (totalPercent >= 60) motivationMsg = `${name}, good effort! 📚 A little more practice and you'll smash it!`;
  else if (totalPercent >= 50) motivationMsg = `${name}, don't give up! 🌈 You're learning!`;
  else motivationMsg = `${name}, keep trying! 💪 Every mistake is a step towards success!`;

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
    .topic-name { color: #555; }
    .topic-score { font-weight: bold; }
    .good { color: #11998e; }
    .weak { color: #e74c3c; }
    .btn { display: inline-block; padding: 12px 30px; background: #11998e; color: white; border-radius: 8px; text-decoration: none; margin-top: 25px; font-size: 1.1em; }
  </style></head><body><div class="container"><div class="result-card">
    <div class="score">${totalPercent}%</div>
    <div class="motivation">${motivationMsg}</div>
    <p>${correct} out of ${total} correct</p>
    <div class="topics"><h3 style="margin:15px 0">Topic Breakdown:</h3>`;

  const weakAreas = [];
  for (const [topic, data] of Object.entries(topicScores)) {
    const label = topic.replace("_", " → ");
    const cls = data.percent >= 60 ? "good" : "weak";
    if (data.percent < 60) weakAreas.push(label);
    html += `<div class="topic-row"><span class="topic-name">${label}</span><span class="topic-score ${cls}">${data.correct}/${data.total} (${data.percent}%)</span></div>`;
  }

  html += `</div>`;

  if (weakAreas.length) {
    html += `<div style="background:#fff3cd;border-radius:10px;padding:15px;margin-top:20px;text-align:left;color:#856404;"><h3>${name}, let's improve these topics:</h3><ul style="margin:8px 0 8px 20px;">${weakAreas.map(t => `<li style="margin:4px 0;font-weight:bold;">${t}</li>`).join("")}</ul><p style="font-style:italic;margin-top:8px;">Revise these and try again - you'll see the difference!</p></div>`;
  } else {
    html += `<div style="background:#d4edda;border-radius:10px;padding:15px;margin-top:20px;text-align:center;color:#155724;"><h3>${name}, you smashed every topic! Nothing to improve - you're on fire! 🔥</h3></div>`;
  }

  html += `</div><a class="btn" href="${retryLink}">🔄 Try Again</a></div></div></body></html>`;
  return html;
}

// ---- ROUTES ----

// Year 8 quiz
app.get("/", async (req, res) => {
  try {
    const config = getConfig();
    const results = getResults();
    const lastScore = results.length ? results[results.length - 1].totalPercent : null;
    const quiz = await generateQuestionsFromGemini("year8");
    res.send(renderQuizPage(quiz, "year8", lastScore, config));
  } catch (err) {
    console.error("Error generating Year 8 quiz:", err.message);
    res.status(500).send(`<h1>Error generating quiz</h1><p>${err.message}</p><p>Check your Gemini API key in config.json</p>`);
  }
});

app.post("/submit", (req, res) => {
  const config = getConfig();
  const total = parseInt(req.body.total);
  let correct = 0;
  const topicScores = {};

  for (let i = 0; i < total; i++) {
    const userAns = req.body[`q${i}`];
    const correctAns = req.body[`a${i}`];
    const topic = req.body[`t${i}`];

    if (!topicScores[topic]) topicScores[topic] = { correct: 0, total: 0 };
    topicScores[topic].total++;

    if (userAns === correctAns) {
      correct++;
      topicScores[topic].correct++;
    }
  }

  for (const t of Object.keys(topicScores)) {
    topicScores[t].percent = Math.round((topicScores[t].correct / topicScores[t].total) * 100);
  }

  const totalPercent = Math.round((correct / total) * 100);
  const date = new Date().toISOString().slice(0, 10);
  saveResult({ date, correct, total, totalPercent, topicScores });

  res.send(renderResultPage(correct, total, topicScores, "year8", config));
});

// Year 3 quiz
app.get("/year3", async (req, res) => {
  try {
    const config = getConfig();
    const results = getYear3Results();
    const lastScore = results.length ? results[results.length - 1].totalPercent : null;
    const quiz = await generateQuestionsFromGemini("year3");
    res.send(renderQuizPage(quiz, "year3", lastScore, config));
  } catch (err) {
    console.error("Error generating Year 3 quiz:", err.message);
    res.status(500).send(`<h1>Error generating quiz</h1><p>${err.message}</p><p>Check your Gemini API key in config.json</p>`);
  }
});

app.post("/year3/submit", (req, res) => {
  const config = getConfig();
  const total = parseInt(req.body.total);
  let correct = 0;
  const topicScores = {};

  for (let i = 0; i < total; i++) {
    const userAns = req.body[`q${i}`];
    const correctAns = req.body[`a${i}`];
    const topic = req.body[`t${i}`];

    if (!topicScores[topic]) topicScores[topic] = { correct: 0, total: 0 };
    topicScores[topic].total++;

    if (userAns === correctAns) {
      correct++;
      topicScores[topic].correct++;
    }
  }

  for (const t of Object.keys(topicScores)) {
    topicScores[t].percent = Math.round((topicScores[t].correct / topicScores[t].total) * 100);
  }

  const totalPercent = Math.round((correct / total) * 100);
  const date = new Date().toISOString().slice(0, 10);
  saveYear3Result({ date, correct, total, totalPercent, topicScores });

  res.send(renderResultPage(correct, total, topicScores, "year3", config));
});

// History endpoints
app.get("/history", (req, res) => res.json(getResults()));
app.get("/year3/history", (req, res) => res.json(getYear3Results()));

// Config endpoint - view/update config
app.get("/config", (req, res) => {
  const config = getConfig();
  res.json({ year8: { ...config.year8 }, year3: { ...config.year3 } });
});

app.listen(PORT, () => {
  console.log(`\n📚 Quiz server running at http://localhost:${PORT}`);
  console.log(`   Year 8 (${getConfig().year8.name}): http://localhost:${PORT}/`);
  console.log(`   Year 3 (${getConfig().year3.name}): http://localhost:${PORT}/year3`);
});
