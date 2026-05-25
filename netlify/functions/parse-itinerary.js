exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const { text, mode } = body;
  if (!text) return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };

  let contextText = text;

  if (mode === 'search') {
    try {
      const lines = text.split('\n');
      const ship = (lines.find(l => l.startsWith('Ship:')) || '').replace('Ship:', '').trim();
      const dateRaw = (lines.find(l => l.startsWith('Departure date:')) || '').replace('Departure date:', '').trim();

      if (ship && dateRaw) {
        const d = new Date(dateRaw);
        const dateStr = !isNaN(d) ? d.toISOString().split('T')[0] : '';
        const shipSlug = ship.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

        // Try multiple sources
        const urls = [
          `https://gangwaze.com/cruise-lines/royal-caribbean/${shipSlug}/${dateStr}/5-nights`,
          `https://gangwaze.com/cruise-lines/royal-caribbean/${shipSlug}/${dateStr}/7-nights`,
          `https://gangwaze.com/cruise-lines/carnival/${shipSlug}/${dateStr}/7-nights`,
          `https://gangwaze.com/cruise-lines/norwegian/${shipSlug}/${dateStr}/7-nights`,
        ];

        for (const url of urls) {
          try {
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Wandermap/1.0)' }
            });
            if (!res.ok) continue;

            const html = await res.text();
            const plain = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                              .replace(/<style[\s\S]*?<\/style>/gi, '')
                              .replace(/<[^>]+>/g, ' ')
                              .replace(/\s+/g, ' ');

            // Find itinerary section
            const start = plain.search(/cruise itinerary|itinerary map|cruise ports/i);
            const end = plain.search(/weather forecast|shore excursion|safety score/i);

            if (start > -1) {
              const section = plain.slice(start, end > start ? end : start + 3000);
              contextText = `Ship: ${ship}\nDate: ${dateRaw}\n\nReal itinerary data:\n${section}`;
              break;
            }
          } catch { continue; }
        }
      }
    } catch(e) {
      console.log('Web search failed:', e.message);
    }
  }

  const systemPrompt = mode === 'search'
    ? `You are a cruise itinerary assistant. Extract the cruise itinerary from the data provided and return ONLY valid JSON with no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
IMPORTANT rules:
- Skip ALL "At Sea" days
- Include departure port as first stop and return port as last stop  
- Convert ALL dates to YYYY-MM-DD format
- City names should be clean: "Cape Liberty, Bayonne NJ" or "Royal Naval Dockyard, Bermuda"
- Trip name format: "5-Night Bermuda Cruise — Independence of the Seas"
- If you truly cannot determine the itinerary, return {"stops":[]}`
    : `You are a travel itinerary parser. Return ONLY valid JSON with no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
- Skip At Sea/Sea Day entries
- Skip room, deck, reservation number lines
- All dates in YYYY-MM-DD format
- Remove time info and Depart/Return/Arrive from city names
- Trip name from first title-like line`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
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
    catch { return { statusCode: 500, body: JSON.stringify({ error: 'AI response not valid JSON', raw }) }; }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(parsed)
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
