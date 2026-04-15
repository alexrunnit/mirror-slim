const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { content, userId, latitude, longitude } = req.body;

    if (!content || !userId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // Run geocoding and theme extraction in parallel
    const [geoResult, themeResult] = await Promise.all([
        // Geocoding
        (async () => {
            if (!latitude || !longitude) return '';
            try {
                const geoResponse = await fetch(
                    `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
                    { headers: { 'User-Agent': 'Mirror-Slim/1.0' } }
                );
                const geoData = await geoResponse.json();
                if (geoData && geoData.address) {
                    const addr = geoData.address;
                    return [
                        addr.city || addr.town || addr.village || addr.municipality,
                        addr.state,
                        addr.country
                    ].filter(Boolean).join(', ');
                }
                return '';
            } catch (geoError) {
                console.error('Geocoding error:', geoError);
                return '';
            }
        })(),

        // Theme extraction
        (async () => {
            try {
                const extractResponse = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: 'claude-haiku-4-5-20251001',
                        max_tokens: 50,
                        messages: [
                            {
                                role: 'user',
                                content: `Extract one to three theme keywords from this field note. Return only the keywords separated by commas, nothing else.

Field note: "${content}"`
                            }
                        ]
                    })
                });
                const extractData = await extractResponse.json();
                return extractData.content[0].text.trim();
            } catch (extractError) {
                console.error('Theme extraction error:', extractError);
                return '';
            }
        })()
    ]);

    const locationName = geoResult;
    const theme = themeResult;

    // Save to field_notes table
    const { error } = await supabaseClient
        .from('field_notes')
        .insert([{
            content: content,
            theme: theme || null,
            location: locationName || null,
            latitude: latitude || null,
            longitude: longitude || null,
            user_id: userId
        }]);

    if (error) {
        return res.status(500).json({ error: 'Failed to save field note: ' + error.message });
    }

    return res.status(200).json({
        success: true,
        theme: theme,
        location: locationName
    });
}