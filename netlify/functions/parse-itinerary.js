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

  // ── Search mode: use Tavily to find real itinerary ──────────────────────────
  if (mode === 'search' && tavilyKey) {
    try {
      const lines = text.split('\n');
      const ship = (lines.find(l => l.startsWith('Ship:')) || '').replace('Ship:', '').trim();
      const dateRaw = (lines.find(l => l.startsWith('Departure date:')) || '').replace('Departure date:', '').trim();

      if (ship) {
        // Format date nicely for search query
        const d = new Date(dateRaw);
        const dateFormatted = !isNaN(d)
          ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
          : dateRaw;

        const query = `${ship} cruise itinerary ${dateFormatted} ports of call`;
        console.log('Tavily search:', query);

        const tavilyRes = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: tavilyKey,
            query,
            search_depth: 'basic',
            max_results: 5,
            include_answer: true,
            include_raw_content: false
          })
        });

        const tavilyData = await tavilyRes.json();

        // Build context from Tavily results
        let searchContext = '';
        if (tavilyData.answer) {
          searchContext += `Summary: ${tavilyData.answer}\n\n`;
        }
        if (tavilyData.results?.length) {
          searchContext += tavilyData.results
            .map(r => `Source: ${r.title}\n${r.content}`)
            .join('\n\n---\n\n')
            .slice(0, 4000);
        }

        if (searchContext) {
          contextText = `Ship: ${ship}\nDate: ${dateRaw}\n\nWeb search results:\n${searchContext}`;
        }
      }
    } catch(e) {
      console.log('Tavily error:', e.message);
    }
  }

  // ── Call Groq to parse/extract itinerary ────────────────────────────────────
  const systemPrompt = mode === 'search'
    ? `You are a cruise itinerary assistant. Extract the cruise itinerary from the search results and return ONLY valid JSON, no markdown, no explanation:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
Rules:
- Skip ALL At Sea / Sea Day entries
- First stop = departure port, last stop = return port
- All dates in YYYY-MM-DD format
- Clean city names: remove times, Depart/Return/Arrive labels
- Trip name format: "X-Night [Destination] — [Ship Name]"
- If you cannot determine the itinerary with confidence, return {"stops":[]}`
    : `You are a travel itinerary parser. Return ONLY valid JSON, no markdown, no explanation:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
Rules:
- Skip At Sea / Sea Day entries
- Skip room, deck, reservation number lines
- All dates in YYYY-MM-DD format
- Remove times and Depart/Return/Arrive from city names
- Trip name from first title-like line in the text`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        temperature: 0,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contextText }
        ]
      })
    });

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch { return { statusCode: 500, body: JSON.stringify({ error: 'AI parse failed', raw }) }; }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(parsed)
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
