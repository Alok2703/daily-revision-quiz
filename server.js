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
  // Try App Password method first (simpler and more reliable)
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransporter({
        service: 'gmail',
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASSWORD
        }
      });

      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: toEmail,
        subject: subject,
        text: body
      });

      console.log(`✅ Email sent to ${toEmail}: ${subject}`);
      return true;
    } catch (err) {
      console.error(`❌ App Password method failed for ${toEmail}:`, err.message);
    }
  }

  // Fallback to OAuth method
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
  
  console.log(`📧 Starting to send daily emails for ${today}`);
  
  // Send personalized email to each user
  for (const [userName, userConfig] of Object.entries(config)) {
    console.log(`Sending email to ${userName} at ${userConfig.email}`);
    const quizUrl = `${QUIZ_URL}/quiz/${userName}`;
    const body = `\n📚 DAILY REVISION - ${today}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎯 Hi ${userName}!\n\nYour daily quiz is ready: ${quizUrl}\n(${userConfig.questionsPerQuiz} MCQs - AI Generated!)\n\n💡 Fresh questions every day!\nGood luck! 🚀\n`;
    
    const success = await sendEmail(userConfig.email, `📚 Daily Revision - ${today}`, body);
    console.log(`Email to ${userName}: ${success ? 'SUCCESS' : 'FAILED'}`);
  }
  
  console.log('📧 Daily email sending completed');
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
  
  // Choose appropriate questions file based on user
  let questionsBank;
  if (userName === 'Kahaan') {
    questionsBank = require('./year3_questions.js');
  } else {
    questionsBank = require('./questions.js');
  }
  
  console.log('Available subjects in questions bank:', Object.keys(questionsBank));
  
  const allQuestions = [];
  
  // Topic name mapping from config to questions.js format
  const topicMapping = {
    // Math topics
    'Algebra': 'algebra',
    'Bearings': 'bearings', 
    'Compound Shapes': 'compound_shapes',
    'Circles': 'circles',
    'Angles': 'angles',
    'Probability': 'probability',
    'Percentages': 'percentages',
    'Addition': 'addition',
    'Subtraction': 'subtraction',
    'Multiplication': 'multiplication',
    'Division': 'division',
    
    // Science topics
    'Forces': 'forces',
    'Electromagnetism': 'electromagnetism', 
    'Work Done': 'work_done',
    'Periodic Table': 'periodic_table',
    'Chemical Reactions': 'reactions',
    'Plants': 'plants',
    
    // English topics
    'Spelling': 'spelling',
    'Punctuation': 'punctuation',
    'Conjunctions': 'conjunctions',
    'Prepositions': 'prepositions',
    'Adjectives': 'adjectives',
    'Adverbs': 'adverbs',
    'Nouns': 'nouns',
    'Verbs and Tenses': 'verbs and tenses'
  };
  
  // Collect questions from all subjects/topics
  for (const [subject, topics] of Object.entries(userConfig.subjects)) {
    console.log(`Processing subject: ${subject}`);
    if (questionsBank[subject]) {
      console.log(`Available topics in ${subject}:`, Object.keys(questionsBank[subject]));
    }
    
    for (const topic of topics) {
      const mappedTopic = topicMapping[topic] || topic.toLowerCase().replace(/\s+/g, '_');
      console.log(`Looking for topic: ${topic} -> ${mappedTopic}`);
      
      if (questionsBank[subject] && questionsBank[subject][mappedTopic]) {
        console.log(`Found ${questionsBank[subject][mappedTopic].length} questions for ${topic}`);
        const topicQuestions = questionsBank[subject][mappedTopic].map(q => ({
          q: q.q,
          options: q.options,
          answer: q.answer,
          subject: subject,
          topic: topic
        }));
        allQuestions.push(...topicQuestions);
      } else {
        console.log(`No questions found for ${subject}/${mappedTopic}`);
      }
    }
  }
  
  console.log(`Total questions collected: ${allQuestions.length}`);
  
  if (allQuestions.length === 0) {
    throw new Error(`No fallback questions available. Checked subjects: ${Object.keys(userConfig.subjects).join(', ')}`);
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
    <button class="btn" type="submit">✅ Submit Answers</button></form></div>
    <script>
      document.querySelector('form').addEventListener('submit', function(e) {
        var totalQuestions = ${quiz.length};
        var answeredCount = 0;
        for (var i = 0; i < totalQuestions; i++) {
          if (document.querySelectorAll('input[name="q' + i + '"]:checked').length > 0) {
            answeredCount++;
          }
        }
        if (answeredCount < totalQuestions) {
          e.preventDefault();
          alert('Please answer all questions! You answered ' + answeredCount + ' out of ' + totalQuestions);
          return false;
        }
        var submitBtn = document.querySelector('.btn');
        submitBtn.textContent = 'Submitting...';
        submitBtn.disabled = true;
      });
    </script></body></html>`;

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

  html += `</div><p style="margin-top:20px;color:#555;font-style:italic;">🚀 Come back tomorrow for fresh new questions!</p></div></div></body></html>`;
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

// Check if user already submitted today
function hasSubmittedToday(userName) {
  const results = getResults(userName);
  if (!results.length) return false;
  const today = new Date().toISOString().slice(0, 10);
  return results[results.length - 1].date === today;
}

function renderAlreadyDonePage(userName, config) {
  const userConfig = config[userName];
  const lastResult = getResults(userName).slice(-1)[0];
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Quiz Complete</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 40px; max-width: 500px; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,0.15); }
    .emoji { font-size: 4em; margin-bottom: 15px; }
    h1 { color: #333; margin-bottom: 10px; }
    p { color: #555; font-size: 1.1em; margin: 10px 0; }
    .score { font-size: 1.3em; font-weight: bold; color: #667eea; margin: 15px 0; }
  </style></head><body>
  <div class="card">
    <div class="emoji">✅</div>
    <h1>Great job, ${userName}!</h1>
    <p>You've already completed today's quiz.</p>
    <div class="score">Today's score: ${lastResult.totalPercent}%</div>
    <p>🚀 Come back tomorrow for fresh new questions!</p>
  </div></body></html>`;
}

// Dynamic quiz route for any user
app.get("/quiz/:userName", (req, res) => {
  const userName = req.params.userName;
  const config = getConfig();
  if (!config[userName]) {
    return res.status(404).send(`<h1>User not found</h1><p>${userName} is not configured in the system</p>`);
  }
  if (hasSubmittedToday(userName)) {
    return res.send(renderAlreadyDonePage(userName, config));
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
    if (hasSubmittedToday(userName)) {
      return res.send(renderAlreadyDonePage(userName, config));
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

  // Send result email to parent
  const userConfig = config[userName];
  if (userConfig.parentEmail) {
    const weakTopics = Object.entries(topicScores).filter(([, d]) => d.percent < 60).map(([t]) => t.replace("_", " → "));
    let body = `📊 Quiz Result for ${userName} (${userConfig.year})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nDate: ${date}\nScore: ${correct}/${total} (${totalPercent}%)\n\nTopic Breakdown:\n`;
    for (const [topic, data] of Object.entries(topicScores)) {
      body += `  ${topic.replace("_", " → ")}: ${data.correct}/${data.total} (${data.percent}%)\n`;
    }
    if (weakTopics.length) body += `\n⚠️ Needs improvement: ${weakTopics.join(", ")}`;
    else body += `\n🌟 All topics passed!`;
    sendEmail(userConfig.parentEmail, `📊 ${userName} scored ${totalPercent}% - Daily Practise Test`, body);
  }

  res.send(renderResultPage(correct, total, topicScores, userName, config));
});

// ============== REGISTER PAGE ==============
app.get("/register", (req, res) => {
  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>QuizBot - Daily Revision for Kids</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Poppins', sans-serif; background: #0f0c29; min-height: 100vh; padding: 20px; position: relative; overflow-x: hidden; }
    body::before { content: ''; position: fixed; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(circle at 30% 50%, rgba(102, 126, 234, 0.15) 0%, transparent 50%), radial-gradient(circle at 70% 80%, rgba(118, 75, 162, 0.1) 0%, transparent 50%); animation: bgFloat 20s ease-in-out infinite; z-index: 0; }
    @keyframes bgFloat { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(-2%, -2%); } }
    .container { max-width: 650px; margin: 0 auto; position: relative; z-index: 1; }
    .header { text-align: center; color: white; margin-bottom: 35px; padding-top: 20px; }
    .header .logo { font-size: 3.5em; margin-bottom: 10px; animation: bounce 2s ease-in-out infinite; }
    @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
    .header h1 { font-size: 2.2em; font-weight: 700; margin-bottom: 8px; background: linear-gradient(135deg, #667eea, #764ba2, #f093fb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .header p { opacity: 0.8; font-size: 1.05em; color: #b8c5e8; }
    .features { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 30px; }
    .feature { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 15px 10px; text-align: center; color: white; }
    .feature .icon { font-size: 1.8em; margin-bottom: 5px; }
    .feature .text { font-size: 0.75em; color: #b8c5e8; }
    .card { background: rgba(255,255,255,0.97); border-radius: 20px; padding: 35px; box-shadow: 0 20px 60px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
    .field { margin-bottom: 22px; }
    .field > label { display: block; font-weight: 600; color: #1a1a2e; margin-bottom: 8px; font-size: 0.9em; letter-spacing: 0.3px; }
    .field input[type="text"], .field input[type="email"], .field input[type="number"], .field select { width: 100%; padding: 14px 16px; border: 2px solid #e8ecf4; border-radius: 12px; font-size: 1em; font-family: 'Poppins', sans-serif; transition: all 0.3s; background: #f8fafc; }
    .field input:focus, .field select:focus { border-color: #667eea; outline: none; background: white; box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1); }
    .field input::placeholder { color: #a0aec0; }
    .topics-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .topics-grid label { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border: 2px solid #e8ecf4; border-radius: 10px; cursor: pointer; font-size: 0.88em; transition: all 0.2s; font-weight: 500; }
    .topics-grid label:hover { border-color: #667eea; background: #f0f0ff; transform: translateY(-1px); }
    .topics-grid input[type="checkbox"] { width: 18px; height: 18px; accent-color: #667eea; }
    .subject-header { font-weight: 700; color: #667eea; margin: 18px 0 10px; font-size: 0.95em; display: flex; align-items: center; gap: 6px; }
    .btn { display: block; width: 100%; padding: 18px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 14px; font-size: 1.15em; font-weight: 600; cursor: pointer; margin-top: 28px; font-family: 'Poppins', sans-serif; transition: all 0.3s; box-shadow: 0 8px 25px rgba(102, 126, 234, 0.35); }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 12px 35px rgba(102, 126, 234, 0.5); }
    .btn:active { transform: translateY(0); }
    .note { background: linear-gradient(135deg, #f0f4ff, #e8ecff); border-radius: 12px; padding: 16px; margin-top: 20px; color: #4a5568; font-size: 0.85em; border: 1px solid #e2e8f0; line-height: 1.5; }
    .frequency-options { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .freq-option { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 2px solid #e8ecf4; border-radius: 10px; cursor: pointer; transition: all 0.2s; font-size: 0.88em; font-weight: 500; }
    .freq-option:hover { border-color: #667eea; background: #f0f0ff; }
    .freq-option input[type="radio"] { width: 18px; height: 18px; accent-color: #667eea; }
    .divider { height: 1px; background: linear-gradient(to right, transparent, #e2e8f0, transparent); margin: 25px 0; }
    @media (max-width: 500px) { .features { grid-template-columns: 1fr; } .topics-grid, .frequency-options { grid-template-columns: 1fr; } .card { padding: 25px 20px; } }
  </style>
  <script>
    function updateTopics() {
      var year = document.getElementById('year').value;
      var yearNum = parseInt(year.replace('Year ', ''));
      document.getElementById('year3-topics').style.display = (yearNum >= 1 && yearNum <= 5) ? 'block' : 'none';
      document.getElementById('year8-topics').style.display = (yearNum >= 6 && yearNum <= 9) ? 'block' : 'none';
    }
  </script>
  </head><body><div class="container">
  <div class="header">
    <div class="logo">\ud83e\udde0</div>
    <h1>QuizBot</h1>
    <p>AI-powered daily revision quizzes delivered to your inbox</p>
  </div>
  <div class="features">
    <div class="feature"><div class="icon">\ud83c\udfaf</div><div class="text">Personalised<br>Questions</div></div>
    <div class="feature"><div class="icon">\ud83d\udcca</div><div class="text">Progress<br>Tracking</div></div>
    <div class="feature"><div class="icon">\ud83d\udce7</div><div class="text">Daily Email<br>Reminders</div></div>
  </div>
  <div class="card">
    <form method="POST" action="/register">
      <div class="field"><label>\ud83d\udc67 Kid's Name</label><input type="text" name="name" placeholder="e.g. Alex" required></div>
      <div class="field"><label>\ud83c\udfeb Year Group</label>
        <select name="year" id="year" onchange="updateTopics()" required>
          <option value="">Select year...</option>
          <option value="Year 3">Year 3</option>
          <option value="Year 4">Year 4</option>
          <option value="Year 5">Year 5</option>
          <option value="Year 6">Year 6</option>
          <option value="Year 7">Year 7</option>
          <option value="Year 8">Year 8</option>
          <option value="Year 9">Year 9</option>
        </select>
      </div>
      <div class="field"><label>\ud83d\udce8 Kid's Email (quiz link sent here)</label><input type="email" name="kidEmail" placeholder="kid@email.com" required></div>
      <div class="field"><label>\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 Parent's Email (results sent here)</label><input type="email" name="parentEmail" placeholder="parent@email.com" required></div>
      <div class="field"><label>\ud83d\udcdd Questions per Quiz</label><input type="number" name="questionsPerQuiz" value="20" min="5" max="40"></div>

      <div class="divider"></div>

      <div class="field"><label>\ud83d\udcc5 How often?</label>
        <div class="frequency-options">
          <label class="freq-option"><input type="radio" name="frequency" value="2"> 2x per week</label>
          <label class="freq-option"><input type="radio" name="frequency" value="3" checked> 3x per week</label>
          <label class="freq-option"><input type="radio" name="frequency" value="5"> Mon\u2013Fri</label>
          <label class="freq-option"><input type="radio" name="frequency" value="7"> Every day</label>
        </div>
      </div>

      <div class="divider"></div>

      <div class="field"><label>\ud83d\udcda Topics to Cover</label>
        <div id="year3-topics" style="display:none;">
          <div class="subject-header">\ud83d\udcd0 Maths</div>
          <div class="topics-grid">
            <label><input type="checkbox" name="topics" value="maths:Addition" checked> Addition</label>
            <label><input type="checkbox" name="topics" value="maths:Subtraction" checked> Subtraction</label>
            <label><input type="checkbox" name="topics" value="maths:Multiplication" checked> Multiplication</label>
            <label><input type="checkbox" name="topics" value="maths:Division" checked> Division</label>
          </div>
          <div class="subject-header">\ud83d\udcd6 English</div>
          <div class="topics-grid">
            <label><input type="checkbox" name="topics" value="english:Spelling" checked> Spelling</label>
            <label><input type="checkbox" name="topics" value="english:Punctuation" checked> Punctuation</label>
            <label><input type="checkbox" name="topics" value="english:Conjunctions" checked> Conjunctions</label>
            <label><input type="checkbox" name="topics" value="english:Prepositions"> Prepositions</label>
            <label><input type="checkbox" name="topics" value="english:Adjectives"> Adjectives</label>
            <label><input type="checkbox" name="topics" value="english:Adverbs"> Adverbs</label>
            <label><input type="checkbox" name="topics" value="english:Nouns"> Nouns</label>
            <label><input type="checkbox" name="topics" value="english:Verbs and Tenses"> Verbs & Tenses</label>
          </div>
          <div class="subject-header">\ud83d\udd2c Science</div>
          <div class="topics-grid">
            <label><input type="checkbox" name="topics" value="science:Plants" checked> Plants</label>
            <label><input type="checkbox" name="topics" value="science:Animals"> Animals</label>
            <label><input type="checkbox" name="topics" value="science:Materials"> Materials</label>
            <label><input type="checkbox" name="topics" value="science:Light"> Light</label>
          </div>
        </div>

        <div id="year8-topics" style="display:none;">
          <div class="subject-header">\ud83d\udcd0 Maths</div>
          <div class="topics-grid">
            <label><input type="checkbox" name="topics" value="maths:Algebra" checked> Algebra</label>
            <label><input type="checkbox" name="topics" value="maths:Bearings" checked> Bearings</label>
            <label><input type="checkbox" name="topics" value="maths:Compound Shapes" checked> Compound Shapes</label>
            <label><input type="checkbox" name="topics" value="maths:Circles" checked> Circles</label>
            <label><input type="checkbox" name="topics" value="maths:Angles" checked> Angles</label>
            <label><input type="checkbox" name="topics" value="maths:Probability" checked> Probability</label>
            <label><input type="checkbox" name="topics" value="maths:Percentages" checked> Percentages</label>
          </div>
          <div class="subject-header">\ud83d\udd2c Science</div>
          <div class="topics-grid">
            <label><input type="checkbox" name="topics" value="science:Forces" checked> Forces</label>
            <label><input type="checkbox" name="topics" value="science:Electromagnetism" checked> Electromagnetism</label>
            <label><input type="checkbox" name="topics" value="science:Work Done" checked> Work Done</label>
            <label><input type="checkbox" name="topics" value="science:Periodic Table" checked> Periodic Table</label>
            <label><input type="checkbox" name="topics" value="science:Chemical Reactions" checked> Chemical Reactions</label>
            <label><input type="checkbox" name="topics" value="science:Photosynthesis"> Photosynthesis</label>
            <label><input type="checkbox" name="topics" value="science:Cells"> Cells</label>
          </div>
        </div>
        <p style="color:#94a3b8;font-size:0.8em;margin-top:8px;font-style:italic;">Select a year group above to see available topics</p>
      </div>

      <button class="btn" type="submit">\ud83d\ude80 Start Free Daily Quizzes</button>
    </form>
    <div class="note">\ud83d\udca1 <strong>How it works:</strong> Your child receives a personalised quiz link via email. After completing it, you get their score and topic breakdown automatically. Questions adapt based on performance!</div>
  </div></div></body></html>`;

  res.send(html);
});

app.post("/register", (req, res) => {
  const { name, year, kidEmail, parentEmail, questionsPerQuiz, topics, frequency } = req.body;

  if (!name || !year || !kidEmail || !parentEmail) {
    return res.status(400).send("<h1>Missing fields</h1><p>Please fill in all required fields.</p><a href='/register'>Go back</a>");
  }

  // Parse topics into subjects object
  const subjects = {};
  const topicList = Array.isArray(topics) ? topics : (topics ? [topics] : []);
  for (const t of topicList) {
    const [subject, topic] = t.split(":");
    if (!subjects[subject]) subjects[subject] = [];
    subjects[subject].push(topic);
  }

  if (Object.keys(subjects).length === 0) {
    return res.status(400).send("<h1>No topics selected</h1><p>Please select at least one topic.</p><a href='/register'>Go back</a>");
  }

  // Save to config
  const config = getConfig();
  config[name] = {
    email: kidEmail,
    parentEmail: parentEmail,
    year: year,
    questionsPerQuiz: parseInt(questionsPerQuiz) || 20,
    frequency: parseInt(frequency) || 5,
    subjects: subjects
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  // Success page
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Registration Complete</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 40px; max-width: 500px; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,0.15); }
    .emoji { font-size: 4em; margin-bottom: 15px; }
    h1 { color: #333; margin-bottom: 10px; }
    p { color: #555; font-size: 1.1em; margin: 10px 0; }
    .details { background: #f0f4ff; border-radius: 10px; padding: 15px; margin: 20px 0; text-align: left; }
    .details p { font-size: 0.95em; margin: 5px 0; }
    .btn { display: inline-block; padding: 12px 30px; background: #11998e; color: white; border-radius: 8px; text-decoration: none; margin-top: 20px; font-size: 1.1em; }
  </style></head><body>
  <div class="card">
    <div class="emoji">🎉</div>
    <h1>Welcome, ${name}!</h1>
    <p>You're all set for daily quizzes!</p>
    <div class="details">
      <p><strong>Year:</strong> ${year}</p>
      <p><strong>Quiz email:</strong> ${kidEmail}</p>
      <p><strong>Parent email:</strong> ${parentEmail}</p>
      <p><strong>Questions:</strong> ${questionsPerQuiz || 20} per quiz</p>
      <p><strong>Topics:</strong> ${topicList.map(t => t.split(":")[1]).join(", ")}</p>
      <p><strong>Frequency:</strong> ${frequency || 5} days per week</p>
    </div>
    <p>📧 Daily quiz link will arrive at 11:00 AM</p>
    <a class="btn" href="/quiz/${name}">▶️ Try Your First Quiz Now</a>
  </div></body></html>`);
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

// Email diagnostic endpoint
app.get("/test-email", async (req, res) => {
  const auth = getGmailAuth();
  if (!auth) {
    return res.json({ status: "error", message: "Gmail credentials not configured" });
  }
  
  try {
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    res.json({ 
      status: "success", 
      message: "Gmail authentication successful",
      emailAddress: profile.data.emailAddress 
    });
  } catch (err) {
    res.json({ 
      status: "error", 
      message: `Gmail authentication failed: ${err.message}` 
    });
  }
});

app.listen(PORT, () => {
  const config = getConfig();
  const userNames = Object.keys(config);
  console.log(`\n📚 Quiz server running at http://localhost:${PORT}`);
  userNames.forEach(userName => {
    console.log(`   ${userName} (${config[userName].year}): http://localhost:${PORT}/quiz/${userName}`);
  });
});
