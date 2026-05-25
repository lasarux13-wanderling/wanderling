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

  const systemPrompt = mode === 'search'
    ? `You are a cruise itinerary database. Output ONLY a raw JSON object. No explanation, no markdown, no text before or after. Just the JSON.

Format:
{"tripName":"string","stops":[{"city":"string","date":"YYYY-MM-DD"}]}

Rules:
- stops = only actual port stops, no At Sea days
- first stop = departure port + departure date
- last stop = return port + return date  
- all dates in YYYY-MM-DD format
- if unknown return: {"tripName":"","stops":[]}`
    : `Extract itinerary ports. Output ONLY raw JSON, no markdown, no text:
{"tripName":"string","stops":[{"city":"string","date":"YYYY-MM-DD"}]}
Skip At Sea days. YYYY-MM-DD dates only.`;

  const userMessage = mode === 'search'
    ? `Cruise: ${ship}\nDeparture date: ${dateRaw}${port ? `\nDeparture port: ${port}` : ''}`
    : text;

  console.log('Groq request:', userMessage.slice(0,100));

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        temperature: 0,
        max_tokens: 1000,
        response_format: { type: 'json_object' }, // Force JSON output
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ]
      })
    });

    const gd = await groqRes.json();
    const raw = gd.choices?.[0]?.message?.content || '';
    console.log('Groq raw:', raw.slice(0, 500));

    let parsed;
    try {
      // Try direct parse first
      parsed = JSON.parse(raw.trim());
    } catch {
      // Try extracting JSON from surrounding text
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); }
        catch(e) {
          console.log('JSON extract failed:', match[0].slice(0,200));
          return { statusCode: 500, body: JSON.stringify({ error: 'JSON parse failed', raw: raw.slice(0,300) }) };
        }
      } else {
        console.log('No JSON found in:', raw.slice(0,300));
        return { statusCode: 500, body: JSON.stringify({ error: 'No JSON in response', raw: raw.slice(0,300) }) };
      }
    }

    console.log('Stops found:', parsed.stops?.length, parsed.stops?.map(s=>s.city).join(', '));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(parsed)
    };
  } catch(err) {
    console.log('Error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
