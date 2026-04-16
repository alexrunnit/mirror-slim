const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { toolNames, note, userId, latitude, longitude } = req.body;

    if (!toolNames || !toolNames.length || !userId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // Pull tool data for selected tools
    const { data: toolData } = await supabaseClient
        .from('tool_index')
        .select('name, description, category, science')
        .in('name', toolNames);

    if (!toolData || toolData.length === 0) {
        return res.status(400).json({ error: 'No matching tools found' });
    }

    // Generate science notes for any tools missing them
    const toolsNeedingScience = toolData.filter(t => !t.science);
    
    if (toolsNeedingScience.length > 0) {
        await Promise.all(toolsNeedingScience.map(async (tool) => {
            try {
                const scienceResponse = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: 'claude-haiku-4-5-20251001',
                        max_tokens: 200,
                        messages: [{
                            role: 'user',
                            content: `Generate a concise science note for this personal wellness tool. Focus on the neurological, physiological, and psychological mechanisms. Two to three sentences maximum.

Tool name: ${tool.name}
Personal description: ${tool.description}`
                        }]
                    })
                });
                const scienceData = await scienceResponse.json();
                const scienceNote = scienceData.content[0].text.trim();

                // Save science note back to tool_index
                await supabaseClient
                    .from('tool_index')
                    .update({ science: scienceNote })
                    .eq('name', tool.name);

                // Update local tool data
                tool.science = scienceNote;

            } catch (error) {
                console.error('Science generation error for', tool.name, error);
            }
        }));
    }

    // Run geocoding in parallel with context gathering
    const [geoResult, contextResult] = await Promise.all([
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

        // Gather context for stack summary
        (async () => {
            try {
                const [entriesResult, moodResult, undertowResult, personaResult] = await Promise.all([
                    supabaseClient
                        .from('entries')
                        .select('entry, created_at')
                        .eq('user_id', userId)
                        .not('entry', 'is', null)
                        .gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString())
                        .order('created_at', { ascending: false })
                        .limit(3),
                    supabaseClient
                        .from('mood')
                        .select('score, created_at')
                        .eq('user_id', userId)
                        .order('created_at', { ascending: false })
                        .limit(3),
                    supabaseClient
                        .from('undertow_log')
                        .select('undertow_name, pattern_tag, created_at')
                        .eq('user_id', userId)
                        .gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString())
                        .order('created_at', { ascending: false })
                        .limit(3),
                    supabaseClient
                        .from('persona')
                        .select('field, value')
                        .eq('is_sensitive', false)
                        .in('field', ['current_life_phase', 'known_anchors', 'energy_patterns', 'current_momentum', 'wellness_practices'])
                ]);

                return {
                    todayEntries: entriesResult.data || [],
                    recentMoods: moodResult.data || [],
                    todayUndertows: undertowResult.data || [],
                    personaContext: personaResult.data || []
                };
            } catch (error) {
                console.error('Context gathering error:', error);
                return { todayEntries: [], recentMoods: [], todayUndertows: [], personaContext: [] };
            }
        })()
    ]);

    const locationName = geoResult;
    const { todayEntries, recentMoods, todayUndertows, personaContext } = contextResult;

    // Get current hour for time of day
    const hour = new Date().getHours();
    let timeOfDay = '';
    if (hour >= 5 && hour < 12) timeOfDay = 'morning';
    else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
    else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
    else timeOfDay = 'night';

    // Assemble tool context for summary
    const toolContext = toolData.map(t => 
        `Tool: ${t.name} (${t.category})\nPersonal meaning: ${t.description}\nScience: ${t.science || 'generating...'}`
    ).join('\n\n');

    const personaText = personaContext.map(p => `${p.field}: ${p.value}`).join('\n');
    
    const entriesText = todayEntries.length > 0 
        ? todayEntries.map(e => e.entry?.substring(0, 200)).join('\n\n')
        : 'No entries logged today yet.';

    const moodText = recentMoods.length > 0
        ? `Recent mood scores: ${recentMoods.map(m => m.score).join(', ')}`
        : '';

    const undertowText = todayUndertows.length > 0
        ? `Undertows logged today: ${todayUndertows.map(u => `${u.undertow_name} (${u.pattern_tag})`).join(', ')}`
        : '';

    // Generate stack summary
    const summaryPrompt = `You are Mirror's Toolbox intelligence. Your function is to help this person understand what they just did for themselves — the science, the personal meaning, and the emergent effect of the combination.

Structure your response in three parts with no headers:

1. ACKNOWLEDGEMENT — one sentence naming what was logged, when, and the category mix without praise or drama.

2. EDUCATION — for each tool, one sentence naming its specific neurological or physiological mechanism. Then one paragraph synthesizing what this stack produced as a whole — the emergent effect that the combination created beyond what any individual tool would have produced alone. Name cortisol, serotonin, dopamine, parasympathetic/sympathetic nervous system, or other specific mechanisms where accurate.

3. REINFORCEMENT — one to two sentences grounding the stack in this person's specific context and journey. Reference their personal descriptions of the tools, not just the science. Reference today's entries or undertow activity if present and relevant. This should feel like it came from someone who knows them, not a wellness app.

TOOLS LOGGED THIS ${timeOfDay.toUpperCase()}:
${toolContext}

PERSON CONTEXT:
${personaText}

${moodText ? `MOOD DATA:\n${moodText}` : ''}
${undertowText ? `UNDERTOW ACTIVITY TODAY:\n${undertowText}` : ''}
${entriesText !== 'No entries logged today yet.' ? `TODAY'S JOURNAL ENTRIES:\n${entriesText}` : ''}

${note ? `USER NOTE:\n${note}` : ''}`;

    let stackSummary = '';
    try {
        const summaryResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 600,
                messages: [{ role: 'user', content: summaryPrompt }]
            })
        });
        const summaryData = await summaryResponse.json();
        stackSummary = summaryData.content[0].text.trim();
    } catch (error) {
        console.error('Summary generation error:', error);
        stackSummary = '';
    }

    // Save tool log rows — one per tool
    const logRows = toolNames.map(name => ({
        tool_name: name,
        note: note || null,
        stack_summary: stackSummary || null,
        location: locationName || null,
        latitude: latitude || null,
        longitude: longitude || null,
        user_id: userId
    }));

    const { error } = await supabaseClient
        .from('tool_log')
        .insert(logRows);

    if (error) {
        return res.status(500).json({ error: 'Failed to save tool log: ' + error.message });
    }

    return res.status(200).json({
        success: true,
        stackSummary: stackSummary,
        toolCount: toolNames.length,
        location: locationName,
        timeOfDay: timeOfDay
    });
}