const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { undertowName, triggerNote, actionTaken, userId, latitude, longitude } = req.body;

    if (!undertowName || !userId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // Run geocoding and contradiction extraction in parallel
    const [geoResult, extractResult] = await Promise.all([
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

        // Pull recent positive data and extract contradiction note
        (async () => {
            try {
                // Get undertow details for context
                const { data: undertowData } = await supabaseClient
                    .from('undertow_index')
                    .select('typical_internal_narrative, known_contradictions, weakening_indicators')
                    .eq('name', undertowName)
                    .single();

                // Get recent positive signals
                const [entriesResult, moodResult, inspirationsResult] = await Promise.all([
                    supabaseClient
                        .from('entries')
                        .select('entry, created_at')
                        .eq('user_id', userId)
                        .not('entry', 'is', null)
                        .order('created_at', { ascending: false })
                        .limit(3),
                    supabaseClient
                        .from('mood')
                        .select('score, created_at')
                        .eq('user_id', userId)
                        .order('created_at', { ascending: false })
                        .limit(5),
                    supabaseClient
                        .from('inspirations')
                        .select('content, feeling_evoked')
                        .eq('user_id', userId)
                        .order('created_at', { ascending: false })
                        .limit(3)
                ]);

                const recentEntries = entriesResult.data || [];
                const recentMoods = moodResult.data || [];
                const recentInspirations = inspirationsResult.data || [];

                const avgMood = recentMoods.length > 0
                    ? (recentMoods.reduce((sum, m) => sum + m.score, 0) / recentMoods.length).toFixed(1)
                    : null;

                const extractPrompt = `An undertow called "${undertowName}" has just activated. 

The undertow's internal narrative says: "${undertowData?.typical_internal_narrative || ''}"

Known contradictions to this undertow: "${undertowData?.known_contradictions || ''}"

Recent evidence from this person's life:
${recentEntries.map(e => `- Entry: ${e.entry?.substring(0, 200)}`).join('\n')}
${avgMood ? `- Recent average mood: ${avgMood}/10` : ''}
${recentInspirations.map(i => `- Inspiration: ${i.content?.substring(0, 100)}${i.feeling_evoked ? ` (evoked: ${i.feeling_evoked})` : ''}`).join('\n')}

Write one sentence — maximum 30 words — that names specific recent evidence from this person's actual life that directly contradicts what the undertow is claiming. Use concrete details, not general reassurance. Do not address the person directly. State the evidence as fact.`;

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
                        messages: [{ role: 'user', content: extractPrompt }]
                    })
                });

                const extractData = await extractResponse.json();
                return extractData.content[0].text.trim();

            } catch (error) {
                console.error('Contradiction extraction error:', error);
                return '';
            }
        })()
    ]);

    const locationName = geoResult;
    const contradictionNote = extractResult;

    // Extract pattern tag
    let patternTag = '';
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) patternTag = 'morning window';
    else if (hour >= 12 && hour < 17) patternTag = 'afternoon window';
    else if (hour >= 17 && hour < 21) patternTag = 'evening window';
    else patternTag = 'night window';

    // Save to undertow_log
    const { error } = await supabaseClient
        .from('undertow_log')
        .insert([{
            undertow_name: undertowName,
            trigger_note: triggerNote || null,
            action_taken: actionTaken || null,
            pattern_tag: patternTag,
            contradiction_note: contradictionNote || null,
            location: locationName || null,
            latitude: latitude || null,
            longitude: longitude || null,
            user_id: userId
        }]);

    if (error) {
        return res.status(500).json({ error: 'Failed to log undertow: ' + error.message });
    }

    return res.status(200).json({
        success: true,
        contradictionNote: contradictionNote,
        patternTag: patternTag,
        location: locationName
    });
}