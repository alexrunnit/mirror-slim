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

    // Geocoding only
    let locationName = '';
    if (latitude && longitude) {
        try {
            const geoResponse = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
                { headers: { 'User-Agent': 'Mirror-Slim/1.0' } }
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

    // Save to field_notes table
    const { error } = await supabaseClient
        .from('field_notes')
        .insert([{
            content: content,
            theme: null,
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
        location: locationName
    });
}