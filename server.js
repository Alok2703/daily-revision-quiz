const express = require("express");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG_PATH = path.join(__dirname, "config.json");
const RESULTS_PATH = path.join(__dirname, "results.json");
const YEAR3_RESULTS_PATH = path.join(__dirname, "year3_results.json");
const PORT = process.env.PORT || 3000;

// ============== EMAIL CONFIG ==============
const QUIZ_URL = "https://daily-revision-quiz.onrender.com";

function getGmailAuth() {
  const credentials = JSON.parse(process.env.GMAIL_CREDENTIALS || "{}");
  const token = JSON.parse(process.env.GMAIL_TOKEN || "{}");
  if (!credentials.installed && !credentials.web) return null;
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function sendEmail(toEmail, subject, body) {
  const auth = getGmailAuth();
  if (!auth) { console.error("❌ Gmail credentials not configured"); return false; }
  const gmail = google.gmail({ version: "v1", auth });
  const message = [
    `To: ${toEmail}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(body).toString("base64"),
  ].join("\r\n");
  const encodedMessage = Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    await gmail.users.messages.send({ userId: "me", requestBody: { raw: encodedMessage } });
    console.log(`✅ Email sent to ${toEmail}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send email to ${toEmail}:`, err.message);
    return false;
  }
}

async function sendDailyEmails() {
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const config = getConfig();
  
  // Send personalized email to each user
  for (const [userName, userConfig] of Object.entries(config)) {
    const quizUrl = `${QUIZ_URL}/quiz/${userName}`;
    const body = `\n📚 DAILY REVISION - ${today}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎯 Hi ${userName}!\n\nYour daily quiz is ready: ${quizUrl}\n(${userConfig.questionsPerQuiz} MCQs - AI Generated!)\n\n💡 Fresh questions every day!\nGood luck! 🚀\n`;
    
    await sendEmail(userConfig.email, `📚 Daily Revision - ${today}`, body);
  }
}



function getConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

// Generate questions from Gemini REST API based on config topics
async function generateQuestionsFromGemini(userName) {
  const config = getConfig();
  const userConfig = config[userName];
  if (!userConfig) throw new Error(`User ${userName} not found in config`);
  
  const totalQuestions = userConfig.questionsPerQuiz;
  
  // First try to use pre-generated questions as fallback
  try {
    const fallbackQuestions = generateFallbackQuestions(userName, totalQuestions);
    if (fallbackQuestions && fallbackQuestions.length >= totalQuestions) {
      console.log(`Using fallback questions for ${userName}`);
      return fallbackQuestions.slice(0, totalQuestions);
    }
  } catch (err) {
    console.log('Fallback questions failed, trying Gemini...');
  }
  
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not found, using fallback questions');
  }

  const topicsList = Object.entries(userConfig.subjects)
    .map(([subject, topics]) => `${subject}: ${topics.join(", ")}`)
    .join("\n");

  const prompt = `Generate exactly ${totalQuestions} multiple choice questions for a ${userConfig.year} student.

Topics to cover (spread questions evenly across all topics):
${topicsList}

Return ONLY a valid JSON array with no extra text. Each object must have:
- "q": the question text
- "options": array of exactly 4 option strings
- "answer": index (0-3) of the correct option
- "topic": the topic name (e.g. "Algebra", "Forces")
- "subject": the subject name (e.g. "maths", "science")

Make questions age-appropriate for ${userConfig.year}. Mix easy and medium difficulty. No duplicate questions.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
  
  // Retry logic for quota exceeded errors
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      if (resp.status === 429) {
        const retryAfter = Math.pow(2, attempt) * 1000;
        console.log(`⏳ Quota exceeded, retrying in ${retryAfter}ms (attempt ${attempt}/3)`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        continue;
      }

      if (!resp.ok) {
        console.log(`Gemini API failed: ${resp.status}, falling back to pre-generated questions`);
        return generateFallbackQuestions(userName, totalQuestions);
      }

      const data = await resp.json();
      const text = data.candidates[0].content.parts[0].text;

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.log('Failed to parse Gemini response, using fallback');
        return generateFallbackQuestions(userName, totalQuestions);
      }

      return JSON.parse(jsonMatch[0]).slice(0, totalQuestions);
    } catch (err) {
      if (attempt === 3) {
        console.log(`All Gemini attempts failed, using fallback questions: ${err.message}`);
        return generateFallbackQuestions(userName, totalQuestions);
      }
      console.log(`⚠️ Attempt ${attempt} failed: ${err.message}`);
    }
  }
}

// Fallback function to generate questions from pre-existing question bank
function generateFallbackQuestions(userName, totalQuestions) {
  const config = getConfig();
  const userConfig = config[userName];
  if (!userConfig) throw new Error(`User ${userName} not found in config`);
  
  // Import the questions bank
  const questionsBank = require('./questions.js');
  
  const allQuestions = [];
  
  // Collect questions from all subjects/topics
  for (const [subject, topics] of Object.entries(userConfig.subjects)) {
    for (const topic of topics) {
      const topicKey = topic.toLowerCase().replace(/\s+/g, '_');
      if (questionsBank[subject] && questionsBank[subject][topicKey]) {
        const topicQuestions = questionsBank[subject][topicKey].map(q => ({
          ...q,
          subject: subject,
          topic: topic
        }));
        allQuestions.push(...topicQuestions);
      }
    }
  }
  
  if (allQuestions.length === 0) {
    throw new Error('No fallback questions available');
  }
  
  // Shuffle and select questions
  const shuffled = allQuestions.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, totalQuestions);
}

// ---- Results helpers ----
function getResults(userName) {
  const resultsPath = path.join(__dirname, `${userName}_results.json`);
  if (fs.existsSync(resultsPath)) return JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  return [];
}
function saveResult(userName, result) {
  const resultsPath = path.join(__dirname, `${userName}_results.json`);
  const results = getResults(userName);
  results.push(result);
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
}

// ---- Quiz HTML renderer ----
function renderQuizPage(quiz, userName, lastScore, config) {
  const userConfig = config[userName];
  const title = `📚 Daily Revision Quiz`;
  const subtitle = `${userConfig.year} — ${userName}`;
  const gradientBg = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
  const tagColor = "#667eea";
  const hoverBorder = "#667eea";
  const hoverBg = "#f5f3ff";
  const btnBg = "#667eea";
  const submitAction = `/submit/${userName}`;

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

function renderResultPage(correct, total, topicScores, userName, config) {
  const userConfig = config[userName];
  const totalPercent = Math.round((correct / total) * 100);
  const retryLink = `/quiz/${userName}`;

  let motivationMsg;
  if (totalPercent === 100) motivationMsg = `${userName} you are AMAZING! 🌟 100% - Perfect score!`;
  else if (totalPercent >= 90) motivationMsg = `${userName} you are BRILLIANT! 🎉 Keep shining!`;
  else if (totalPercent >= 80) motivationMsg = `${userName} you are GREAT! 💪 Fantastic effort!`;
  else if (totalPercent >= 70) motivationMsg = `${userName}, well done! 👏 Getting stronger every day!`;
  else if (totalPercent >= 60) motivationMsg = `${userName}, good effort! 📚 A little more practice and you'll smash it!`;
  else if (totalPercent >= 50) motivationMsg = `${userName}, don't give up! 🌈 You're learning!`;
  else motivationMsg = `${userName}, keep trying! 💪 Every mistake is a step towards success!`;

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
    html += `<div style="background:#fff3cd;border-radius:10px;padding:15px;margin-top:20px;text-align:left;color:#856404;"><h3>${userName}, let's improve these topics:</h3><ul style="margin:8px 0 8px 20px;">${weakAreas.map(t => `<li style="margin:4px 0;font-weight:bold;">${t}</li>`).join("")}</ul><p style="font-style:italic;margin-top:8px;">Revise these and try again - you'll see the difference!</p></div>`;
  } else {
    html += `<div style="background:#d4edda;border-radius:10px;padding:15px;margin-top:20px;text-align:center;color:#155724;"><h3>${userName}, you smashed every topic! Nothing to improve - you're on fire! 🔥</h3></div>`;
  }

  html += `</div><a class="btn" href="${retryLink}">🔄 Try Again</a></div></div></body></html>`;
  return html;
}

// ---- ROUTES ----

// Loading page HTML
function loadingPage(title, subtitle, gradientBg, loadUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: ${gradientBg}; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .loader { text-align: center; color: white; }
    .loader h1 { font-size: 2em; margin-bottom: 15px; }
    .loader p { font-size: 1.2em; opacity: 0.9; }
    .spinner { margin: 20px auto; width: 40px; height: 40px; border: 4px solid rgba(255,255,255,0.3); border-top: 4px solid white; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style></head><body>
  <div class="loader"><h1>${title}</h1><p>${subtitle}</p><div class="spinner"></div><p>Generating your quiz...</p></div>
  <script>window.location.href='${loadUrl}';</script>
  </body></html>`;
}

// Dynamic quiz route for any user
app.get("/quiz/:userName", (req, res) => {
  const userName = req.params.userName;
  const config = getConfig();
  if (!config[userName]) {
    return res.status(404).send(`<h1>User not found</h1><p>${userName} is not configured in the system</p>`);
  }
  res.send(loadingPage("📚 Daily Revision Quiz", `${config[userName].year} — ${userName}`, "linear-gradient(135deg, #667eea 0%, #764ba2 100%)", `/generate/${userName}`));
});

app.get("/generate/:userName", async (req, res) => {
  const userName = req.params.userName;
  try {
    const config = getConfig();
    if (!config[userName]) {
      return res.status(404).send(`<h1>User not found</h1><p>${userName} is not configured</p>`);
    }
    const results = getResults(userName);
    const lastScore = results.length ? results[results.length - 1].totalPercent : null;
    const quiz = await generateQuestionsFromGemini(userName);
    res.send(renderQuizPage(quiz, userName, lastScore, config));
  } catch (err) {
    console.error(`Error generating quiz for ${userName}:`, err.message);
    res.status(500).send(`<h1>Error generating quiz</h1><p>${err.message}</p><p>Check your GEMINI_API_KEY environment variable</p>`);
  }
});

app.post("/submit/:userName", (req, res) => {
  const userName = req.params.userName;
  const config = getConfig();
  if (!config[userName]) {
    return res.status(404).send(`<h1>User not found</h1><p>${userName} is not configured</p>`);
  }
  
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
  saveResult(userName, { date, correct, total, totalPercent, topicScores });

  res.send(renderResultPage(correct, total, topicScores, userName, config));
});

// Backwards compatibility routes
app.get("/", (req, res) => {
  res.redirect("/quiz/Aakhya");
});

app.get("/year3", (req, res) => {
  res.redirect("/quiz/Kahaan");
});

// History endpoints
app.get("/history/:userName", (req, res) => res.json(getResults(req.params.userName)));
app.get("/history", (req, res) => res.json(getResults("Aakhya")));
app.get("/year3/history", (req, res) => res.json(getResults("Kahaan")));

// Config endpoint - view/update config
app.get("/config", (req, res) => {
  const config = getConfig();
  res.json({ year8: { ...config.year8 }, year3: { ...config.year3 } });
});

// Manual email trigger
app.get("/send-emails", async (req, res) => {
  await sendDailyEmails();
  res.send("✅ Emails sent!");
});

app.listen(PORT, () => {
  const config = getConfig();
  const userNames = Object.keys(config);
  console.log(`\n📚 Quiz server running at http://localhost:${PORT}`);
  userNames.forEach(userName => {
    console.log(`   ${userName} (${config[userName].year}): http://localhost:${PORT}/quiz/${userName}`);
  });
});
