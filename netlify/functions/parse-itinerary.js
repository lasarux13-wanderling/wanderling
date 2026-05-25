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

        // Cruise lines to try
        const cruiseLines = [
          'royal-caribbean', 'carnival', 'norwegian', 'celebrity',
          'princess', 'holland-america', 'msc', 'disney'
        ];
        // Night lengths to try
        const nights = ['5-nights','7-nights','4-nights','6-nights','8-nights','9-nights','10-nights','11-nights','12-nights','14-nights','3-nights'];

        let found = false;
        outer:
        for (const line of cruiseLines) {
          for (const night of nights) {
            const url = `https://gangwaze.com/cruise-lines/${line}/${shipSlug}/${dateStr}/${night}`;
            try {
              const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Wandermap/1.0)' },
                signal: AbortSignal.timeout(5000)
              });
              if (!res.ok) continue;

              const html = await res.text();
              // Check it's a real itinerary page not a redirect/404
              if (!html.includes('Cruise Ports') && !html.includes('cruise-ports')) continue;

              const plain = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&amp;/g,'&').replace(/&#\d+;/g,' ')
                .replace(/\s+/g, ' ').trim();

              // Extract itinerary section
              const startIdx = plain.search(/Cruise Itinerary|Cruise Ports|itinerary route/i);
              const endIdx = plain.search(/Weather Forecast|Shore Excursion|Safety Score|Cruise Ship\s/i);
              if (startIdx > -1) {
                const section = plain.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 4000);
                contextText = `Ship: ${ship}\nDate: ${dateRaw}\nSource URL: ${url}\n\nReal itinerary data from gangwaze.com:\n${section}`;
                found = true;
                break outer;
              }
            } catch { continue; }
          }
        }

        if (!found) {
          // Fallback: try gangwaze search page
          try {
            const searchUrl = `https://gangwaze.com/cruise-search?ship=${encodeURIComponent(ship)}&date=${dateStr}`;
            const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const html = await res.text();
              const plain = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
              contextText = `${text}\n\nSearch results:\n${plain.slice(0,3000)}`;
            }
          } catch {}
        }
      }
    } catch(e) {
      console.log('Web search error:', e.message);
    }
  }

  const systemPrompt = mode === 'search'
    ? `You are a cruise itinerary assistant. Extract the cruise itinerary from the data and return ONLY valid JSON, no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
Rules:
- Skip ALL At Sea / Sea Day entries
- First stop = departure port, last stop = return port
- All dates in YYYY-MM-DD format
- Clean city names: remove arrival/departure times, Depart/Return/Arrive labels
- Trip name: "X-Night [Destination] — [Ship Name]"
- If itinerary cannot be determined, return {"stops":[]}`
    : `You are a travel itinerary parser. Return ONLY valid JSON, no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
- Skip At Sea / Sea Day entries
- Skip room, deck, reservation lines
- All dates YYYY-MM-DD
- Remove times and Depart/Return/Arrive from city names
- Extract trip name from first title line`;

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
    try { parsed = JSON.parse(raw.replace(/```json|```/g,'').trim()); }
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
