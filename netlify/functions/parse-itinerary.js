exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const groqKey = process.env.GROQ_API_KEY;
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

  const userMessage = mode === 'search'
    ? `What ports does the ${ship} visit on its cruise departing ${dateRaw}${port ? ` from ${port}` : ''}? Return as JSON: {"tripName":"string","stops":[{"city":"string","date":"YYYY-MM-DD"}]}`
    : `Extract this itinerary as JSON {"tripName":"string","stops":[{"city":"string","date":"YYYY-MM-DD"}]} skipping At Sea days:\n${text}`;

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

    const groqText = await groqRes.text();
    console.log('Groq HTTP status:', groqRes.status);
    console.log('Groq full response:', groqText.slice(0, 800));

    let gd;
    try { gd = JSON.parse(groqText); } catch {
      return { statusCode: 500, body: JSON.stringify({ error: 'Groq response not JSON', raw: groqText.slice(0,300) }) };
    }

    if (gd.error) {
      console.log('Groq API error:', JSON.stringify(gd.error));
      return { statusCode: 500, body: JSON.stringify({ error: `Groq error: ${gd.error.message || JSON.stringify(gd.error)}` }) };
    }

    const raw = gd.choices?.[0]?.message?.content || '';
    console.log('Groq content:', raw.slice(0, 600));

    let parsed = null;
    try { parsed = JSON.parse(raw.trim()); } catch {}
    if (!parsed) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) try { parsed = JSON.parse(match[0]); } catch {}
    }

    if (!parsed) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not parse JSON', raw: raw.slice(0,300) }) };
    }

    console.log('Stops:', parsed.stops?.length, parsed.stops?.map(s=>s.city).join(', '));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(parsed)
    };

  } catch(err) {
    console.log('Fetch error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
