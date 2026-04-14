const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { undertowEntry, userId, latitude, longitude } = req.body;

    if (!undertowEntry || !userId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // Pull undertow index for classification
    const { data: undertowIndex } = await supabaseClient
        .from('undertow_index')
        .select('name, trigger_pattern, typical_internal_narrative, known_contradictions, weakening_indicators')
        .eq('is_sensitive', true);

    const undertowList = undertowIndex ? undertowIndex.map(u =>
        `Name: ${u.name}\nTrigger pattern: ${u.trigger_pattern}\nInternal narrative: ${u.typical_internal_narrative}\nKnown contradictions: ${u.known_contradictions}\nWeakening indicators: ${u.weakening_indicators}`
    ).join('\n\n') : '';

    // Run geocoding and classification in parallel
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

        // Classify undertow and generate contradiction note
        (async () => {
            try {
                const { data: recentEntries } = await supabaseClient
                    .from('entries')
                    .select('entry')
                    .eq('user_id', userId)
                    .not('entry', 'is', null)
                    .order('created_at', { ascending: false })
                    .limit(3);

                const { data: recentInspirations } = await supabaseClient
                    .from('inspirations')
                    .select('content, feeling_evoked')
                    .eq('user_id', userId)
                    .order('created_at', { ascending: false })
                    .limit(3);

                const { data: recentMoods } = await supabaseClient
                    .from('mood')
                    .select('score')
                    .eq('user_id', userId)
                    .order('created_at', { ascending: false })
                    .limit(5);

                const avgMood = recentMoods && recentMoods.length > 0
                    ? (recentMoods.reduce((sum, m) => sum + m.score, 0) / recentMoods.length).toFixed(1)
                    : null;

                const classifyPrompt = `You are analyzing a journal entry describing a difficult internal experience. Your job is two things: classify which undertow pattern is active, then generate a contradiction note grounded in that undertow's specific known contradictions and weakening indicators.

UNDERTOW INDEX:
${undertowList}

JOURNAL ENTRY DESCRIBING THE EXPERIENCE:
"${undertowEntry}"

RECENT EVIDENCE FROM THIS PERSON'S LIFE:
${recentEntries ? recentEntries.map(e => `- ${e.entry?.substring(0, 150)}`).join('\n') : 'None available'}
${avgMood ? `- Recent average mood: ${avgMood}/10` : ''}
${recentInspirations ? recentInspirations.map(i => `- Inspiration: ${i.content?.substring(0, 100)}${i.feeling_evoked ? ` (evoked: ${i.feeling_evoked})` : ''}`).join('\n') : ''}

INSTRUCTIONS:
1. Identify which undertow pattern best matches the journal entry based on its trigger pattern and internal narrative
2. Read that undertow's known_contradictions and weakening_indicators carefully
3. Find specific recent evidence from the RECENT EVIDENCE section that maps to those known contradictions or weakening indicators for that specific undertow
4. Write a contradiction note that names that specific evidence in relation to what that undertow claims

The contradiction note must:
- Be grounded in the matched undertow's specific claims — not generic positivity
- Reference only recent evidence present in the data above
- Be one sentence, maximum 30 words
- State as fact, not reassurance
- If recent evidence does not map to the matched undertow's specific contradictions, write NONE

Respond in exactly this format:
UNDERTOW: [exact name of the matching undertow]
CONTRADICTION: [one sentence or NONE]`;

                const extractResponse = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: 'claude-haiku-4-5-20251001',
                        max_tokens: 200,
                        messages: [{ role: 'user', content: classifyPrompt }]
                    })
                });

                const extractData = await extractResponse.json();
                return extractData.content[0].text.trim();

            } catch (error) {
                console.error('Classification error:', error);
                return '';
            }
        })()
    ]);

    const locationName = geoResult;
    let undertowName = '';
    let contradictionNote = '';

    if (extractResult) {
        const undertowMatch = extractResult.match(/UNDERTOW:\s*(.+)/);
        const contradictionMatch = extractResult.match(/CONTRADICTION:\s*(.+)/);
        if (undertowMatch) undertowName = undertowMatch[1].trim();
        if (contradictionMatch) {
            const raw = contradictionMatch[1].trim();
            contradictionNote = raw === 'NONE' ? '' : raw;
        }
    }

    const hour = new Date().getHours();
    let patternTag = '';
    if (hour >= 5 && hour < 12) patternTag = 'morning window';
    else if (hour >= 12 && hour < 17) patternTag = 'afternoon window';
    else if (hour >= 17 && hour < 21) patternTag = 'evening window';
    else patternTag = 'night window';

    // Save to undertow_log
    const { error } = await supabaseClient
        .from('undertow_log')
        .insert([{
            undertow_name: undertowName || 'unclassified',
            trigger_note: undertowEntry,
            action_taken: null,
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