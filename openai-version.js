// OpenAI GPT-4 version with latest knowledge
async function generateQuestionsFromOpenAI(userName) {
  const config = getConfig();
  const userConfig = config[userName];
  if (!userConfig) throw new Error(`User ${userName} not found in config`);
  
  const totalQuestions = userConfig.questionsPerQuiz;
  const apiKey = process.env.OPENAI_API_KEY;

  const topicsList = Object.entries(userConfig.subjects)
    .map(([subject, topics]) => `${subject}: ${topics.join(", ")}`)
    .join("\n");

  const prompt = `Generate exactly ${totalQuestions} multiple choice questions for a ${userConfig.year} student using the LATEST 2024 UK curriculum standards.

Topics to cover (spread questions evenly across all topics):
${topicsList}

Return ONLY a valid JSON array with no extra text. Each object must have:
- "q": the question text
- "options": array of exactly 4 option strings  
- "answer": index (0-3) of the correct option
- "topic": the topic name
- "subject": the subject name

Make questions reflect current 2024 educational standards and real-world applications. Mix easy and medium difficulty. No duplicate questions.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',  // Latest GPT-4 with April 2024 knowledge
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 4000
    })
  });

  if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
  
  const data = await response.json();
  const content = data.choices[0].message.content;
  
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Failed to parse OpenAI response");
  
  return JSON.parse(jsonMatch[0]).slice(0, totalQuestions);
}