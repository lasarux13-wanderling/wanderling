exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { text, mode } = body;
  if (!text) return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };

  const isSearch = mode === 'search';

  const systemPrompt = isSearch
    ? `You are a cruise and travel itinerary lookup assistant. The user will give you a ship name, departure date, and/or departure port. You must recall or reconstruct the most likely itinerary for that sailing and return it as JSON.

Return ONLY valid JSON in this exact format, no markdown, no explanation:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}

Rules:
- Use your knowledge of cruise itineraries to fill in all ports of call in order
- Include the departure port as the first stop and return port as last stop
- Skip At Sea days
- All dates in YYYY-MM-DD format
- Trip name should be descriptive e.g. "7-Night Bahamas Cruise — Independence of the Seas"
- If you cannot determine the itinerary with confidence, return {"stops":[]}`
    : `You are a travel itinerary parser. Extract ports of call from the text provided.
Return ONLY valid JSON in this exact format, no markdown, no explanation:
{"tripName":"string","stops":[{"city":"City Name","date":"YYYY-MM-DD"}]}

Rules:
- Skip At Sea/Sea Day/Cruising entries
- Skip room/deck/reservation numbers  
- Convert all dates to YYYY-MM-DD format
- Remove time info and Depart/Return/Arrive from city names
- Trip name: cruise name only, no ship name or date`;

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
          { role: 'user', content: isSearch ? `Find the itinerary for:\n${text}` : `Parse this itinerary:\n\n${text}` }
        ]
      })
    });

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g,'').trim()); }
    catch { return { statusCode: 500, body: JSON.stringify({ error: 'Could not parse AI response', raw }) }; }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(parsed)
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
