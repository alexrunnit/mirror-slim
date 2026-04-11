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

    // Reverse geocode coordinates to place name
    let locationName = '';
    if (latitude && longitude) {
        try {
            const geoResponse = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
                {
                    headers: {
                        'User-Agent': 'Mirror-Slim/1.0'
                    }
                }
            );
            const geoData = await geoResponse.json();
            if (geoData && geoData.address) {
                const addr = geoData.address;
                locationName = [
                    addr.city || addr.town || addr.village || addr.municipality,
                    addr.state,
                    addr.country
                ].filter(Boolean).join(', ');
            }
        } catch (geoError) {
            console.error('Geocoding error:', geoError);
        }
    }

    // Extract category and feeling_evoked using Haiku
    let category = '';
    let feelingEvoked = '';
    let source = '';

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
                max_tokens: 100,
                messages: [
                    {
                        role: 'user',
                       content: `Extract three things from this inspiration capture and respond in exactly this format with nothing else:
CATEGORY: [one of: Person, Place, Nature, Art, Food, Music, Writing, Experience, Object, Other]
FEELING: [one to three words describing the feeling this evoked]
SOURCE: [the origin of this inspiration — a person, place, object, or experience extracted from the text. If unclear write Unknown]

Inspiration: "${content}"` 
                    }
                ]
            })
        });

        const extractData = await extractResponse.json();
        const extractText = extractData.content[0].text.trim();

        const categoryMatch = extractText.match(/CATEGORY:\s*(.+)/);
        const feelingMatch = extractText.match(/FEELING:\s*(.+)/);
        const sourceMatch = extractText.match(/SOURCE:\s*(.+)/);

        if (categoryMatch) category = categoryMatch[1].trim();
        if (feelingMatch) feelingEvoked = feelingMatch[1].trim();
        if (sourceMatch) source = sourceMatch[1].trim();

    } catch (extractError) {
        console.error('Extraction error:', extractError);
    }

    // Save to inspirations table
    const { error } = await supabaseClient
        .from('inspirations')
        .insert([{
            content: content,
            source: source || null,
            category: category || null,
            feeling_evoked: feelingEvoked || null,
            location: locationName || null,
            latitude: latitude || null,
            longitude: longitude || null,
            user_id: userId
        }]);

    if (error) {
        return res.status(500).json({ error: 'Failed to save inspiration: ' + error.message });
    }

    return res.status(200).json({ 
        success: true,
        category: category,
        feeling_evoked: feelingEvoked,
        location: locationName
    });
}