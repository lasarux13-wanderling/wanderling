exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const groqKey = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!groqKey) return { statusCode: 500, body: JSON.stringify({ error: 'Groq key missing' }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const { text, mode } = body;
  if (!text) return { statusCode: 400, body: JSON.stringify({ error: 'No text' }) };

  const lines = text.split('\n');
  const ship = (lines.find(l => l.startsWith('Ship:')) || '').replace('Ship:', '').trim();
  const dateRaw = (lines.find(l => l.startsWith('Departure date:')) || '').replace('Departure date:', '').trim();
  const port = (lines.find(l => l.startsWith('Departure port:')) || '').replace('Departure port:', '').trim();

  let webContext = '';

  // Search for real itinerary data using Tavily
  if (mode === 'search' && tavilyKey && ship) {
    try {
      const d = new Date(dateRaw);
      const dateFormatted = !isNaN(d)
        ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : dateRaw;

      const query = `"${ship}" cruise itinerary ${dateFormatted} ports schedule day by day`;
      console.log('Tavily query:', query);

      const tavilyRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tavilyKey}`
        },
        body: JSON.stringify({
          query,
          search_depth: 'advanced',
          max_results: 5,
          include_answer: true,
          include_raw_content: true
        })
      });

      console.log('Tavily status:', tavilyRes.status);
      const tavilyText = await tavilyRes.text();
      console.log('Tavily response (300):', tavilyText.slice(0, 300));

      let td = {};
      try { td = JSON.parse(tavilyText); } catch(e) { console.log('Tavily parse error:', e.message); }

      const results = td.results || [];
      const answer = td.answer || '';
      console.log('Tavily answer:', answer.slice(0, 200));
      console.log('Tavily results:', results.length);

      if (answer) webContext += `Summary: ${answer}\n\n`;
      for (const r of results.slice(0, 4)) {
        const content = (r.raw_content || r.content || '').slice(0, 1500);
        webContext += `[${r.title}]\n${content}\n\n`;
      }
    } catch(e) {
      console.log('Tavily error:', e.message);
    }
  }

  const userMessage = mode === 'search'
    ? `${webContext
        ? `Use this real web data to extract the port schedule:\n\nShip: ${ship}\nDate: ${dateRaw}\n\n${webContext.slice(0, 5000)}`
        : `What ports does the ${ship} visit departing ${dateRaw}${port ? ` from ${port}` : ''}?`
      }

Return ONLY JSON: {"tripName":"string","stops":[{"city":"string","date":"YYYY-MM-DD"}]}
Skip At Sea days. First stop = departure port. Last stop = return port.`
    : `Extract itinerary as JSON {"tripName":"string","stops":[{"city":"string","date":"YYYY-MM-DD"}]} skipping At Sea days:\n${text}`;

  console.log('Has web context:', !!webContext, 'length:', webContext.length);

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0,
        max_tokens: 1000,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const gd = await groqRes.json();
    if (gd.error) return { statusCode: 500, body: JSON.stringify({ error: `Groq: ${gd.error.message}` }) };

    const raw = gd.choices?.[0]?.message?.content || '';
    console.log('Groq response:', raw.slice(0, 400));

    let parsed = null;
    try { parsed = JSON.parse(raw.trim()); } catch {}
    if (!parsed) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) try { parsed = JSON.parse(match[0]); } catch {}
    }

    if (!parsed) return { statusCode: 500, body: JSON.stringify({ error: 'Could not parse response', raw: raw.slice(0,200) }) };

    console.log('Stops:', parsed.stops?.length, parsed.stops?.map(s => s.city).join(', '));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(parsed)
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
