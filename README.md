# Daily Revision Quiz

AI-powered adaptive revision quiz for **Aakhya (Year 8)** and **Kahaan (Year 3)**.

## How It Works
- Questions are generated fresh daily by **Google Gemini AI**
- Topics are configured in `config.json` — just edit the file to change topics
- 25 MCQs per quiz, spread across all configured topics
- Auto-scoring with topic breakdown and personalized motivation
- Daily email with quiz links sent at **11:00 AM BST** via GitHub Actions

## Topics (configurable in `config.json`)

**Year 8 — Aakhya:**
- Maths: Algebra, Bearings, Compound Shapes, Circles, Angles, Probability, Percentages
- Science: Forces, Electromagnetism, Work Done, Periodic Table, Chemical Reactions

**Year 3 — Kahaan:**
- Maths: Addition, Subtraction, Multiplication, Division
- English: Spelling, Punctuation, Conjunctions
- Science: Plants, Materials, Light and Shadows, Forces, States of Matter

## Changing Topics
Edit `config.json` — add, remove, or change topics. No code changes needed. Gemini generates questions based on whatever's in the config.

## URLs
- Year 8: https://daily-revision-quiz.onrender.com/
- Year 3: https://daily-revision-quiz.onrender.com/year3

## Daily Email
GitHub Actions triggers `/send-emails` at 11:00 AM BST every day. No manual intervention needed.

## Environment Variables (on Render)
- `GEMINI_API_KEY` — Google Gemini API key
- `GMAIL_CREDENTIALS` — Gmail OAuth credentials JSON
- `GMAIL_TOKEN` — Gmail OAuth token JSON

## Deploy on Render
1. Connect this repo on render.com
2. Build Command: `npm install`
3. Start Command: `npm start`
