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

  // Common "of the Seas" ships that users might abbreviate
  const SHIP_EXPANSIONS = {
    'independence': 'independence-of-the-seas',
    'independence of the seas': 'independence-of-the-seas',
    'anthem': 'anthem-of-the-seas',
    'anthem of the seas': 'anthem-of-the-seas',
    'symphony': 'symphony-of-the-seas',
    'wonder': 'wonder-of-the-seas',
    'icon': 'icon-of-the-seas',
    'oasis': 'oasis-of-the-seas',
    'allure': 'allure-of-the-seas',
    'harmony': 'harmony-of-the-seas',
    'navigator': 'navigator-of-the-seas',
    'explorer': 'explorer-of-the-seas',
    'adventure': 'adventure-of-the-seas',
    'voyager': 'voyager-of-the-seas',
    'freedom': 'freedom-of-the-seas',
    'liberty': 'liberty-of-the-seas',
    'mariner': 'mariner-of-the-seas',
    'vision': 'vision-of-the-seas',
    'radiance': 'radiance-of-the-seas',
    'brilliance': 'brilliance-of-the-seas',
    'serenade': 'serenade-of-the-seas',
    'jewel': 'jewel-of-the-seas',
    'enchantment': 'enchantment-of-the-seas',
    'grandeur': 'grandeur-of-the-seas',
    'utopia': 'utopia-of-the-seas',
    'odyssey': 'odyssey-of-the-seas',
    'spectrum': 'spectrum-of-the-seas',
    'quantum': 'quantum-of-the-seas',
    'ovation': 'ovation-of-the-seas',
    'carnival glory': 'carnival-glory',
    'carnival magic': 'carnival-magic',
    'carnival dream': 'carnival-dream',
    'carnival breeze': 'carnival-breeze',
    'carnival vista': 'carnival-vista',
    'carnival horizon': 'carnival-horizon',
    'carnival celebration': 'carnival-celebration',
    'norwegian cruise': 'norwegian-cruise-line',
    'norwegian joy': 'norwegian-joy',
    'norwegian bliss': 'norwegian-bliss',
    'norwegian escape': 'norwegian-escape',
    'norwegian prima': 'norwegian-prima',
  };

  if (mode === 'search') {
    try {
      const lines = text.split('\n');
      const shipRaw = (lines.find(l => l.startsWith('Ship:')) || '').replace('Ship:', '').trim();
      const dateRaw = (lines.find(l => l.startsWith('Departure date:')) || '').replace('Departure date:', '').trim();

      if (shipRaw && dateRaw) {
        const d = new Date(dateRaw);
        const dateStr = !isNaN(d) ? d.toISOString().split('T')[0] : '';
        
        // Resolve ship slug - check expansions first, then slugify
        const shipKey = shipRaw.toLowerCase().trim();
        const shipSlug = SHIP_EXPANSIONS[shipKey] || 
          shipRaw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

        const cruiseLines = ['royal-caribbean','carnival','norwegian','celebrity','princess','holland-america','msc','disney'];
        const nights = ['5-nights','7-nights','4-nights','6-nights','8-nights','9-nights','10-nights','11-nights','12-nights','3-nights','14-nights'];

        // Build all URLs
        const urls = [];
        for (const line of cruiseLines) {
          for (const night of nights) {
            urls.push(`https://gangwaze.com/cruise-lines/${line}/${shipSlug}/${dateStr}/${night}`);
          }
        }

        const fetchOne = async (url) => {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(8000)
          });
          if (!res.ok) throw new Error(`${res.status}`);
          const html = await res.text();
          if (!html.includes('Day 1') && !html.includes('Cruise Ports')) throw new Error('not itinerary');
          const plain = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g,'&').replace(/&#\d+;/g,' ').replace(/\s+/g,' ').trim();
          const s = plain.search(/Day 1|Cruise Ports|Cruise Itinerary/i);
          const e = plain.search(/Weather Forecast|Shore Excursion|Safety Score|Cruise Ship\b/i);
          if (s === -1) throw new Error('no section');
          return { text: plain.slice(s, e > s ? e : s+4000), url };
        };

        // Parallel batches of 15
        let itineraryText = null;
        let sourceUrl = null;
        for (let i = 0; i < urls.length; i += 15) {
          const batch = urls.slice(i, i+15);
          const results = await Promise.allSettled(batch.map(fetchOne));
          const ok = results.find(r => r.status === 'fulfilled');
          if (ok) { itineraryText = ok.value.text; sourceUrl = ok.value.url; break; }
        }

        if (itineraryText) {
          contextText = `Ship: ${shipRaw}\nDate: ${dateRaw}\nSource: ${sourceUrl}\n\nItinerary data:\n${itineraryText}`;
        } else {
          // Nothing found — tell AI to use its knowledge
          contextText = `Ship: ${shipRaw}\nDate: ${dateRaw}\n\nNo web data found. Use your knowledge to reconstruct the most likely itinerary for this sailing.`;
        }
      }
    } catch(e) {
      console.log('Search error:', e.message);
    }
  }

  const systemPrompt = mode === 'search'
    ? `You are a cruise itinerary assistant. Extract or reconstruct the cruise itinerary and return ONLY valid JSON, no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
- Skip ALL At Sea / Sea Day entries
- First stop = departure port, last stop = return port
- All dates YYYY-MM-DD format
- Clean city names: remove times, Depart/Return/Arrive labels
- Trip name format: "X-Night [Destination] — [Ship Name]"
- If truly cannot determine, return {"stops":[]}`
    : `You are a travel itinerary parser. Return ONLY valid JSON, no markdown:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}
- Skip At Sea / Sea Day entries
- Skip room, deck, reservation number lines
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
