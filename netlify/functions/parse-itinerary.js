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

  let contextText = text;

  if (mode === 'search' && tavilyKey) {
    try {
      const lines = text.split('\n');
      const ship = (lines.find(l => l.startsWith('Ship:')) || '').replace('Ship:', '').trim();
      const dateRaw = (lines.find(l => l.startsWith('Departure date:')) || '').replace('Departure date:', '').trim();
      const d = new Date(dateRaw);
      const dateFormatted = !isNaN(d)
        ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : dateRaw;

      const query = `${ship} ${dateFormatted} cruise itinerary ports schedule`;
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
          max_results: 7,
          include_answer: true,
          include_raw_content: true
        })
      });

      const rawTavily = await tavilyRes.text();
      console.log('Tavily raw (first 300):', rawTavily.slice(0, 300));
      
      let td;
      try { td = JSON.parse(rawTavily); } catch(e) {
        console.log('Tavily JSON parse error:', e.message);
        td = {};
      }

      console.log('Tavily keys:', Object.keys(td).join(', '));
      console.log('Tavily answer:', td.answer?.slice(0,200));
      console.log('Tavily results count:', td.results?.length || td.data?.length || 0);

      // Handle both possible response formats
      const results = td.results || td.data || [];
      const answer = td.answer || td.summary || '';

      let ctx = '';
      if (answer) ctx += `Summary: ${answer}\n\n`;
      for (const r of results) {
        const content = (r.raw_content || r.content || r.text || '').slice(0, 1500);
        const title = r.title || r.url || '';
        ctx += `--- ${title} ---\n${content}\n\n`;
      }

      if (ctx.trim()) {
        contextText = `Find port schedule for:\nShip: ${ship}\nDate: ${dateFormatted}\n\n${ctx.slice(0, 6000)}`;
        console.log('Context length:', contextText.length);
      } else {
        console.log('No content from Tavily, using AI knowledge only');
        contextText = `Ship: ${ship}\nDeparture date: ${dateFormatted}\n\nUse your knowledge to provide the most likely itinerary for this specific sailing.`;
      }

    } catch(e) {
      console.log('Tavily error:', e.message);
    }
  }

  const systemPrompt = mode === 'search'
    ? `You are a cruise itinerary expert. Extract or reconstruct the port schedule.

Return ONLY this JSON, no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}

Rules:
- Skip ALL At Sea / Sea Day entries
- First stop = departure port, last stop = return port  
- All dates YYYY-MM-DD
- Clean city names e.g. "Cape Liberty, NJ", "Bermuda", "Nassau"
- Trip name: "X-Night [Destination] — [Ship]"
- If not enough info: {"stops":[]}`
    : `Extract itinerary from text. Return ONLY JSON, no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
Skip At Sea days, room/deck/reservation info. YYYY-MM-DD dates.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        temperature: 0,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contextText }
        ]
      })
    });

    const gd = await groqRes.json();
    const raw = gd.choices?.[0]?.message?.content || '';
    console.log('Groq response:', raw.slice(0, 500));

    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g,'').trim()); }
    catch {
      console.log('JSON parse failed:', raw.slice(0,200));
      return { statusCode: 500, body: JSON.stringify({ error: 'JSON parse failed', raw: raw.slice(0,200) }) };
    }

    console.log('Stops found:', parsed.stops?.length, parsed.stops?.map(s=>s.city).join(', '));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(parsed)
    };
  } catch(err) {
    console.log('Groq error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
