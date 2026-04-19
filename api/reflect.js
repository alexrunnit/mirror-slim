const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { entry, recentEntries, userId, totalEntryCount, rowId, promptUsed } = req.body;

    if (!entry) {
        return res.status(400).json({ error: 'No entry provided' });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // Pull non-sensitive persona fields
    const { data: personaRows } = await supabaseClient
        .from('persona')
     .select('field, value')
        .eq('is_sensitive', false);

    let personaContext = '';
    if (personaRows && personaRows.length > 0) {
        personaContext = personaRows
            .map(row => `${row.field}: ${row.value}`)
            .join('\n');
    }

    // Pull most recent summary
    const { data: summaryRows } = await supabaseClient
        .from('summaries')
        .select('summary, summary_type')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);

    let summaryContext = '';
    if (summaryRows && summaryRows.length > 0) {
        const rawSummary = summaryRows[0].summary;
        try {
            const parsed = JSON.parse(rawSummary);
            summaryContext = [
                parsed.section3_reflections,
                parsed.section7_progression,
                parsed.section8_forward
            ].filter(Boolean).join('\n\n');
        } catch {
            summaryContext = rawSummary;
        }
    }

    // Build recent entry history context
    let historyContext = '';
    if (recentEntries && recentEntries.length > 0) {
        historyContext = recentEntries
            .map((e, i) => `Entry ${i + 1}:\n${e.entry}\n${e.reflection ? `Reflection: ${e.reflection}` : ''}`)
            .join('\n\n');
    }

    const systemPrompt = `You are a precise, unsentimental reflection surface for a private journal. Your sole function is to return the writer's own words and patterns arranged so they can see themselves more clearly.

You have been given contextual information about this person. Use it to inform the specificity and tone of your reflection — not to interpret or analyze, but to recognize what is being said in the context of who is saying it.

PERSONA CONTEXT:
${personaContext}

${summaryContext ? `EVOLVING PATTERN SUMMARY (recent period):\n${summaryContext}\n` : ''}

RULES:
- Write in second person throughout
- Ground every observation in specific language from the entry — quote or closely paraphrase the writer's exact words
- One focused observation, one extension of that observation, one direct so what
- End with a single declarative closing statement — not a question — that names what this entry reveals when read clearly
- No affirmation, no warmth, no clinical language, no first-person AI voice
- No interpretation beyond what the words themselves contain
- Match length to what the entry needs — never pad
- Honor the tone preference: pragmatic, direct, honest before warm, data before interpretation
- Brooklyn is the writer's dog — a known anchor, not just a pet
- If previous entries are provided, use them to inform pattern recognition across sessions

${historyContext ? `RECENT ENTRY HISTORY:\n${historyContext}` : ''}`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system: systemPrompt,
                messages: [
                    {
                        role: 'user',
                        content: `Here is my journal entry:\n\n${entry}`
                    }
                ]
            })
        });

        const data = await response.json();
        const reflection = data.content[0].text;

        // Update existing row if rowId exists, otherwise insert new row
        let sessionRowId = rowId;

        if (rowId) {
            await supabaseClient
                .from('entries')
                .update({
                    entry: entry,
                    reflection: reflection,
                    prompt_used: promptUsed || false
                })
                .eq('id', rowId);
        } else {
            const { data: newRow } = await supabaseClient
                .from('entries')
                .insert([{
                    entry: entry,
                    reflection: reflection,
                    prompt_used: false,
                    user_id: userId
                }])
                .select('id')
                .single();
            if (newRow) sessionRowId = newRow.id;
        }

        // Trigger synthesis every 10 entries
        if (totalEntryCount && totalEntryCount > 0 && (totalEntryCount + 1) % 10 === 0) {
            await runSynthesis(supabaseClient, recentEntries, personaContext, userId);
        }

        // Trigger weekly summary if 7 days have elapsed
        await checkAndGenerateWeeklySummary(supabaseClient, userId);

        return res.status(200).json({ reflection, sessionRowId });

    } catch (error) {
        return res.status(500).json({ error: 'API call failed: ' + error.message });
    }
}

async function runSynthesis(supabaseClient, recentEntries, personaContext, userId) {
    if (!userId) return;

    // Query last 10 entries directly from Supabase for accurate synthesis window
    const { data: synthesisEntries } = await supabaseClient
        .from('entries')
        .select('entry, reflection, created_at')
        .eq('user_id', userId)
        .not('entry', 'is', null)
        .order('created_at', { ascending: false })
        .limit(10);

    if (!synthesisEntries || synthesisEntries.length === 0) return;

    const entriesText = synthesisEntries
        .map((e, i) => `Entry ${i + 1}:\n${e.entry}`)
        .join('\n\n');

  // Pull recent mood scores for synthesis
    const { data: recentMoods } = await supabaseClient
        .from('mood')
        .select('score, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);

    // Pull recent feelings for synthesis
    const { data: recentFeelings } = await supabaseClient
        .from('feelings')
        .select('feeling, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

    // Compress mood data
    let moodContext = '';
    if (recentMoods && recentMoods.length > 0) {
        const avgMood = (recentMoods.reduce((sum, m) => sum + m.score, 0) / recentMoods.length).toFixed(1);
        const moodScores = recentMoods.map(m => m.score).join(', ');
        moodContext = `Mood scores (most recent first): ${moodScores}\nAverage: ${avgMood}/10`;
    }

    // Pull mood delta data from entries
    const { data: deltaEntries } = await supabaseClient
        .from('entries')
        .select('mood_post, created_at')
        .eq('user_id', userId)
        .not('mood_post', 'is', null)
        .order('created_at', { ascending: false })
        .limit(10);

    let deltaContext = '';
    if (deltaEntries && deltaEntries.length > 0) {
        deltaContext = `Post-reflection mood scores (most recent first): ${deltaEntries.map(e => e.mood_post).join(', ')}`;
    }

    // Compress feelings data
    let feelingsContext = '';
    if (recentFeelings && recentFeelings.length > 0) {
        const feelingCounts = {};
        recentFeelings.forEach(f => {
            feelingCounts[f.feeling] = (feelingCounts[f.feeling] || 0) + 1;
        });
        const sorted = Object.entries(feelingCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([feeling, count]) => `${feeling} (${count})`)
            .join(', ');
        feelingsContext = `Feelings frequency: ${sorted}`;
    }

    // Pull recent inspirations for synthesis
    const { data: recentInspirations } = await supabaseClient
        .from('inspirations')
        .select('content, category, feeling_evoked, location, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);

// Pull recent field notes for synthesis
    const { data: recentFieldNotes } = await supabaseClient
        .from('field_notes')
        .select('content, theme, location, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);

    // Compress field notes data
    let fieldNotesContext = '';
    if (recentFieldNotes && recentFieldNotes.length > 0) {
        const themes = recentFieldNotes
            .filter(n => n.theme)
            .map(n => n.theme)
            .join(', ');
        fieldNotesContext = `Field note themes: ${themes || 'none extracted yet'}`;
    }

    // Compress inspirations data
    let inspirationsContext = '';
    if (recentInspirations && recentInspirations.length > 0) {
        const categoryCount = {};
        recentInspirations.forEach(i => {
            if (i.category) {
                categoryCount[i.category] = (categoryCount[i.category] || 0) + 1;
            }
        });
        const categorySummary = Object.entries(categoryCount)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, count]) => `${cat} (${count})`)
            .join(', ');

        const feelingsSummary = recentInspirations
            .filter(i => i.feeling_evoked)
            .map(i => i.feeling_evoked)
            .join(', ');

        const locationSummary = [...new Set(recentInspirations
            .filter(i => i.location)
            .map(i => i.location))]
            .join(', ');

        inspirationsContext = `Inspiration categories: ${categorySummary || 'none extracted yet'}`;
        if (feelingsSummary) inspirationsContext += `\nFeelings evoked by inspirations: ${feelingsSummary}`;
        if (locationSummary) inspirationsContext += `\nLocations of inspiration: ${locationSummary}`;
    }

    const synthesisPrompt = `You are analyzing a private journal to extract evolving patterns and detect significant changes. You will produce two outputs.

OUTPUT 1 — SUMMARY:
Write a single compressed paragraph (150 words maximum) capturing:
- Recurring themes and their frequency
- Tone and emotional register across this period
- Schema patterns present or notably absent
- Language drift — what words or framings are increasing or decreasing
- Brooklyn's presence and function
- Aspiration language — concrete and active versus conditional and distant
- Overall trajectory — forward, static, or regressing
- Mood trends if data is present — average score, direction, notable shifts
- Feeling patterns if data is present — which feelings appear most, which cluster together

OUTPUT 2 — DETECTED CHANGES:
List any significant changes detected, each on its own line in this exact format:
TYPE|FIELD|DETECTED_VALUE|CONFIDENCE
Where TYPE is either EVENT or DRIFT
Where FIELD is the persona field being updated
Where DETECTED_VALUE is what you observed in the writing or mood/feelings data
Where CONFIDENCE is high, medium, or low

Include mood and feelings trends as DRIFT updates when patterns are persistent and meaningful.
Examples:
DRIFT|current_momentum|Mood scores averaging 7.2 over recent sessions indicating sustained forward movement|high
DRIFT|dominant_patterns|Restless and cautious appearing together frequently, often preceding high output entries|medium

PERSONA BASELINE:
${personaContext}

${moodContext ? `MOOD DATA:\n${moodContext}\n` : ''}
${deltaContext ? `POST-REFLECTION MOOD DATA:\n${deltaContext}\n` : ''}
${feelingsContext ? `FEELINGS DATA:\n${feelingsContext}\n` : ''}
${inspirationsContext ? `INSPIRATION GALLERY DATA:\n${inspirationsContext}\n` : ''}
${fieldNotesContext ? `FIELD NOTES DATA:\n${fieldNotesContext}\n` : ''}

JOURNAL ENTRIES TO ANALYZE:
${entriesText}`;

    try {
        const synthesisResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1024,
                messages: [
                    {
                        role: 'user',
                        content: synthesisPrompt
                    }
                ]
            })
        });

        const synthesisData = await synthesisResponse.json();
        const synthesisText = synthesisData.content[0].text;

        const parts = synthesisText.split('OUTPUT 2');
        const summaryRaw = parts[0].replace('OUTPUT 1 — SUMMARY:', '').replace('# OUTPUT 1 — SUMMARY', '').trim();
        const summaryText = summaryRaw.replace(/#{1,6}\s/g, '').replace(/\*\*/g, '').replace(/\*/g, '').trim();
        const changesText = parts[1] ? parts[1].replace('— DETECTED CHANGES:', '').trim() : '';

        await supabaseClient
            .from('summaries')
            .insert([{
                summary: summaryText,
                entry_count: recentEntries.length,
                user_id: userId
            }]);

        if (changesText) {
            const changeLines = changesText.split('\n').filter(line => line.includes('|'));
            for (const line of changeLines) {
                const [type, field, detectedValue, confidence] = line.split('|');
                if (type && field && detectedValue) {
                    const { data: currentPersona } = await supabaseClient
                        .from('persona')
                        .select('value')
                        .eq('field', field.trim())
                        .single();

                    await supabaseClient
                        .from('persona_updates')
                        .insert([{
                            update_type: type.trim(),
                            field: field.trim(),
                            detected_value: detectedValue.trim(),
                            current_value: currentPersona ? currentPersona.value : '',
                            confidence: confidence ? confidence.trim() : 'medium',
                            reviewed: false,
                            accepted: false,
                            user_id: userId
                        }]);
                }
            }
        }

    } catch (error) {
        console.error('Synthesis error:', error);
    }
}

async function checkAndGenerateWeeklySummary(supabaseClient, userId) {
    try {
        // Check when last weekly summary was generated
        const { data: lastWeekly } = await supabaseClient
            .from('summaries')
            .select('created_at')
            .eq('user_id', userId)
            .eq('summary_type', 'weekly')
            .order('created_at', { ascending: false })
            .limit(1);

        const now = new Date();
        const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

        // If no weekly summary exists or last one was more than 7 days ago
        if (!lastWeekly || lastWeekly.length === 0 || new Date(lastWeekly[0].created_at) < sevenDaysAgo) {
            const periodEnd = now.toISOString();
            const periodStart = sevenDaysAgo.toISOString();

            // Call the summary function
            await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/summary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: userId,
                    periodStart: periodStart,
                    periodEnd: periodEnd,
                    summaryType: 'weekly'
                })
            });
        }
    } catch (error) {
        console.error('Weekly summary check error:', error);
    }
}