exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const groqKey = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!groqKey) return { statusCode: 500, body: JSON.stringify({ error: 'Groq API key not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const { text, mode } = body;
  if (!text) return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };

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

      const query = `${ship} cruise itinerary ${dateFormatted} ports of call day by day schedule`;
      console.log('Tavily search:', query);

      const tavilyRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          search_depth: 'advanced',
          max_results: 5,
          include_answer: true,
          include_raw_content: false
        })
      });

      const tavilyData = await tavilyRes.json();
      console.log('Tavily answer:', tavilyData.answer?.slice(0,200));
      console.log('Tavily results count:', tavilyData.results?.length);

      let searchContext = '';
      if (tavilyData.answer) searchContext += `Summary: ${tavilyData.answer}\n\n`;
      if (tavilyData.results?.length) {
        searchContext += tavilyData.results
          .map(r => `Source: ${r.title}\nURL: ${r.url}\n${r.content}`)
          .join('\n\n---\n\n')
          .slice(0, 5000);
      }

      if (searchContext) {
        contextText = `Ship: ${ship}\nDate: ${dateRaw}\n\nWeb search results:\n${searchContext}`;
        console.log('Context length:', contextText.length);
      }
    } catch(e) {
      console.log('Tavily error:', e.message);
    }
  }

  const systemPrompt = mode === 'search'
    ? `You are a cruise itinerary assistant. The user searched for a specific cruise sailing. Extract the EXACT port schedule from the search results.

Return ONLY valid JSON with no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}

Critical rules:
- ONLY include actual port stops — skip ALL "At Sea" or "Sea Day" entries
- The FIRST stop must be the departure port with the departure date
- The LAST stop must be the return port with the return date  
- Include ALL intermediate ports in order
- All dates MUST be in YYYY-MM-DD format
- City names should be clean: "Cape Liberty, Bayonne NJ", "Royal Naval Dockyard, Bermuda", "Nassau, Bahamas"
- Trip name: "X-Night [Destination] — [Ship Name]"
- If you cannot find the specific itinerary in the results, return {"stops":[],"error":"not found"}`
    : `You are a travel itinerary parser. Return ONLY valid JSON with no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
- Skip At Sea / Sea Day entries completely
- Skip room, deck, reservation number lines
- All dates in YYYY-MM-DD format
- Remove times and Depart/Return/Arrive from city names`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        temperature: 0,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contextText }
        ]
      })
    });

    const groqData = await groqRes.json();
    const raw = groqData.choices?.[0]?.message?.content || '';
    console.log('Groq raw response:', raw.slice(0,500));

    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g,'').trim()); }
    catch { 
      console.log('JSON parse failed on:', raw);
      return { statusCode: 500, body: JSON.stringify({ error: 'AI response not valid JSON', raw: raw.slice(0,200) }) }; 
    }

    console.log('Stops found:', parsed.stops?.length);
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
