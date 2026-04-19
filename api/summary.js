const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userId, periodStart, periodEnd, summaryType } = req.body;

    if (!userId || !periodStart || !periodEnd) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // Pull all data sources across the period
    const [
        entriesResult,
        moodResult,
        feelingsResult,
        toolLogResult,
        inspirationsResult,
        fieldNotesResult,
        undertowLogResult,
        personaResult,
        undertowIndexResult,
        previousSummaryResult
    ] = await Promise.all([
        supabaseClient.from('entries').select('entry, reflection, prompt, mood_post, created_at').eq('user_id', userId).not('entry', 'is', null).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('mood').select('score, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('feelings').select('feeling, note, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('tool_log').select('tool_name, stack_summary, user_feedback, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('inspirations').select('content, category, feeling_evoked, location, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('field_notes').select('content, location, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('undertow_log').select('undertow_name, trigger_note, pattern_tag, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('persona').select('field, value').eq('is_sensitive', false),
        supabaseClient.from('undertow_index').select('name, known_contradictions, weakening_indicators').eq('is_sensitive', true),
        supabaseClient.from('summaries').select('summary, period_start, period_end').eq('user_id', userId).eq('summary_type', 'weekly').order('created_at', { ascending: false }).limit(1)
    ]);

    const entries = entriesResult.data || [];
    const moods = moodResult.data || [];
    const feelings = feelingsResult.data || [];
    const toolLogs = toolLogResult.data || [];
    const inspirations = inspirationsResult.data || [];
    const fieldNotes = fieldNotesResult.data || [];
    const undertowLogs = undertowLogResult.data || [];
    const persona = personaResult.data || [];
    const undertowIndex = undertowIndexResult.data || [];
    const previousSummary = previousSummaryResult.data?.[0] || null;

    // Compress data for context
    const personaText = persona.map(p => `${p.field}: ${p.value}`).join('\n');

    const entriesText = entries.map((e, i) => 
        `Entry ${i + 1} (${new Date(e.created_at).toLocaleDateString()}):\n${e.entry}\nReflection: ${e.reflection || 'none'}`
    ).join('\n\n');

    const moodScores = moods.map(m => m.score);
    const moodPostScores = entries.filter(e => e.mood_post).map(e => e.mood_post);
    const avgMoodPre = moodScores.length > 0 ? (moodScores.reduce((a, b) => a + b, 0) / moodScores.length).toFixed(1) : null;
    const avgMoodPost = moodPostScores.length > 0 ? (moodPostScores.reduce((a, b) => a + b, 0) / moodPostScores.length).toFixed(1) : null;
    const avgDelta = avgMoodPre && avgMoodPost ? (avgMoodPost - avgMoodPre).toFixed(1) : null;

    const feelingCounts = {};
    feelings.forEach(f => { feelingCounts[f.feeling] = (feelingCounts[f.feeling] || 0) + 1; });
    const topFeelings = Object.entries(feelingCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, c]) => `${f} (${c})`).join(', ');

    const toolCounts = {};
    toolLogs.forEach(t => { toolCounts[t.tool_name] = (toolCounts[t.tool_name] || 0) + 1; });
    const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `${t} (${c})`).join(', ');
    const stackSummaries = toolLogs.filter(t => t.stack_summary).map(t => t.stack_summary).join('\n\n');

    const undertowCounts = {};
    undertowLogs.forEach(u => { undertowCounts[u.undertow_name] = (undertowCounts[u.undertow_name] || 0) + 1; });
    const undertowSummary = Object.entries(undertowCounts).sort((a, b) => b[1] - a[1]).map(([u, c]) => `${u} (${c} times)`).join(', ');
    const undertowPatterns = undertowLogs.map(u => `${u.undertow_name} — ${u.pattern_tag}${u.trigger_note ? ': ' + u.trigger_note.substring(0, 100) : ''}`).join('\n');

    const inspirationText = inspirations.map(i => `${i.content}${i.feeling_evoked ? ` (evoked: ${i.feeling_evoked})` : ''}${i.location ? ` — ${i.location}` : ''}`).join('\n');
    const fieldNoteText = fieldNotes.map(f => `${f.content}${f.location ? ` — ${f.location}` : ''}`).join('\n');

    const undertowIndexText = undertowIndex.map(u => 
        `${u.name}:\nKnown contradictions: ${u.known_contradictions}\nWeakening indicators: ${u.weakening_indicators}`
    ).join('\n\n');

    const periodDays = Math.round((new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24));

    // Generate all sections in parallel
    const sectionPrompts = [
        // Section 1 - The Period
        `Write Section 1 of a personal growth summary called "The Period." One short paragraph. State: date range from ${new Date(periodStart).toLocaleDateString()} to ${new Date(periodEnd).toLocaleDateString()}, ${periodDays} days, ${entries.length} journal entries written. Factual, no interpretation. Under 50 words.`,

        // Section 2 - Mood Arc and Feelings
        `Write Section 2 of a personal growth summary called "Mood Arc." Data: Pre-session mood average: ${avgMoodPre || 'insufficient data'}/10. Post-session mood average: ${avgMoodPost || 'insufficient data'}/10. Average delta per session: ${avgDelta || 'insufficient data'} points. Mood scores across period: ${moodScores.join(', ') || 'none'}. Top feelings logged: ${topFeelings || 'none'}. Write 2-3 precise paragraphs covering mood trajectory, the delta pattern, and the feeling landscape. Name what the numbers reveal about baseline and regulation. No clinical language. No affirmation. Under 120 words.`,

        // Section 3 - Reflection Distillation
        `Write Section 3 of a personal growth summary called "Reflection Distillation." Read these journal entries and their reflections and distill what Mirror saw repeatedly across the period — the themes that recurred, the patterns that were named, the observations that appeared more than once. Do not quote entries. Synthesize what the reflections collectively revealed about who was writing them. 2-3 paragraphs, under 150 words.\n\nENTRIES AND REFLECTIONS:\n${entriesText.substring(0, 3000)}`,

        // Section 4 - Language and Tone Drift
        `Write Section 4 of a personal growth summary called "Language and Tone Drift." Analyze the full body of writing below — journal entries, inspirations, field notes, and undertow entries — for shifts in language patterns. Identify: conditional versus declarative language frequency, past versus future orientation, recurring phrases and sentiments, what themes are surfacing in inspirations, what field notes reveal about environmental awareness, undertow breakdown (${undertowSummary || 'none logged'}). 2-3 paragraphs, under 150 words.\n\nJOURNAL ENTRIES:\n${entries.map(e => e.entry).join('\n\n').substring(0, 2000)}\n\nINSPIRATIONS:\n${inspirationText.substring(0, 500)}\n\nFIELD NOTES:\n${fieldNoteText.substring(0, 500)}\n\nUNDERTOW ENTRIES:\n${undertowPatterns.substring(0, 500)}`,

        // Section 5 - Your Words
        `Write Section 5 of a personal growth summary called "Your Words." Read these journal entries and identify 2-3 sentences or short passages where the writer's language was most precise, most self-aware, or most clearly pointed toward something they hadn't previously named. Return them exactly as written in quotation marks, each on its own line, with one sentence of context explaining why this moment stood out. No motivational framing. Just the moments where the writing was sharpest.\n\nENTRIES:\n${entries.map(e => e.entry).join('\n\n').substring(0, 3000)}`,

        // Section 6 - Tool Intelligence
        `Write Section 6 of a personal growth summary called "Tool Intelligence." Data: Most used tools: ${topTools || 'none logged'}. Stack summaries from the period: ${stackSummaries.substring(0, 1000) || 'none'}. Write 2-3 paragraphs covering: which tools dominated, what the stacks collectively produced, any patterns in tool usage relative to time of day or undertow activity, and one observation about what the tool data suggests about how this person is regulating, stabilizing, and expanding. Under 150 words.`,

        // Section 7 - Progression Markers
        `Write Section 7 of a personal growth summary called "Progression Markers." Compare evidence from this period against the documented undertow weakening indicators and known contradictions below. Name which weakening indicators are showing evidence of activation. Name which known contradictions are being lived out. Note any transformation trends emerging — not just present versus baseline, but trajectory and velocity of change. Where is momentum building? Where is it stalled? Be specific and honest. 2-3 paragraphs, under 150 words.\n\nUNDERTOW INDEX:\n${undertowIndexText.substring(0, 1500)}\n\nPERIOD ENTRIES:\n${entries.map(e => e.entry).join('\n\n').substring(0, 2000)}\n\nPERSONA BASELINE:\n${personaText.substring(0, 1000)}`,

        // Section 8 - Forward
        `Write Section 8 of a personal growth summary called "Forward." Based on all the data from this period, name 2-3 concrete near-term observations about what the evidence points toward. Not goals. Not advice. Not motivation. Just what the data suggests is ready to be acted on or paid attention to. One sentence each. Under 60 words total.`
    ];

    try {
        // Generate all sections in parallel
        const sectionResponses = await Promise.all(
            sectionPrompts.map(prompt => 
                fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: 'claude-sonnet-4-20250514',
                        max_tokens: 600,
                        messages: [{ role: 'user', content: prompt }]
                    })
                }).then(r => r.json()).then(d => d.content[0].text.trim())
            )
        );

        const sections = {
            section1_period: sectionResponses[0],
            section2_mood: sectionResponses[1],
            section3_reflections: sectionResponses[2],
            section4_language: sectionResponses[3],
            section5_your_words: sectionResponses[4],
            section6_tools: sectionResponses[5],
            section7_progression: sectionResponses[6],
            section8_forward: sectionResponses[7]
        };

        // Save to summaries table
        const { data: savedSummary, error } = await supabaseClient
            .from('summaries')
            .insert([{
                summary: JSON.stringify(sections),
                summary_type: summaryType || 'custom',
                period_start: periodStart,
                period_end: periodEnd,
                entry_count: entries.length,
                user_id: userId
            }])
            .select('id')
            .single();

        if (error) {
            return res.status(500).json({ error: 'Failed to save summary: ' + error.message });
        }

        return res.status(200).json({
            success: true,
            summaryId: savedSummary.id,
            sections: sections
        });

    } catch (error) {
        return res.status(500).json({ error: 'Summary generation failed: ' + error.message });
    }
}
