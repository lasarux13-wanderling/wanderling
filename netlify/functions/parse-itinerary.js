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

        // Most common cruise lines and night lengths — try them in parallel
        const cruiseLines = ['royal-caribbean','carnival','norwegian','celebrity','princess','holland-america','msc','disney'];
        const nights = ['7-nights','5-nights','4-nights','6-nights','8-nights','9-nights','10-nights','11-nights','12-nights','3-nights'];

        // Build all URLs
        const urls = [];
        for (const line of cruiseLines) {
          for (const night of nights) {
            urls.push(`https://gangwaze.com/cruise-lines/${line}/${shipSlug}/${dateStr}/${night}`);
          }
        }

        // Fetch all in parallel with a race — first valid one wins
        const fetchOne = async (url) => {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000)
          });
          if (!res.ok) throw new Error('not ok');
          const html = await res.text();
          if (!html.includes('Cruise Ports') && !html.includes('Day 1')) throw new Error('not itinerary');
          const plain = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g,'&').replace(/&#\d+;/g,' ')
            .replace(/\s+/g, ' ').trim();
          const startIdx = plain.search(/Cruise Itinerary|Cruise Ports|Day 1/i);
          const endIdx = plain.search(/Weather Forecast|Shore Excursion|Safety Score/i);
          if (startIdx === -1) throw new Error('no itinerary section');
          return plain.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 4000);
        };

        // Try batches of 10 in parallel
        let itineraryText = null;
        for (let i = 0; i < urls.length; i += 10) {
          const batch = urls.slice(i, i + 10);
          const results = await Promise.allSettled(batch.map(fetchOne));
          const success = results.find(r => r.status === 'fulfilled');
          if (success) {
            itineraryText = success.value;
            break;
          }
        }

        if (itineraryText) {
          contextText = `Ship: ${ship}\nDate: ${dateRaw}\n\nReal itinerary from gangwaze.com:\n${itineraryText}`;
        }
      }
    } catch(e) {
      console.log('Search error:', e.message);
    }
  }

  const systemPrompt = mode === 'search'
    ? `You are a cruise itinerary assistant. Extract the cruise itinerary and return ONLY valid JSON, no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
- Skip ALL At Sea / Sea Day entries
- First stop = departure port, last stop = return port
- All dates YYYY-MM-DD
- Clean city names: remove times, Depart/Return/Arrive labels
- Trip name: "X-Night [Destination] — [Ship Name]"
- If cannot determine, return {"stops":[]}`
    : `You are a travel itinerary parser. Return ONLY valid JSON, no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
- Skip At Sea / Sea Day entries
- Skip room, deck, reservation lines
- All dates YYYY-MM-DD
- Remove times and Depart/Return/Arrive from city names`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
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
