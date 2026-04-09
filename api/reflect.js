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
        .select('field, value, category')
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
        .select('summary')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);

    let summaryContext = '';
    if (summaryRows && summaryRows.length > 0) {
        summaryContext = summaryRows[0].summary;
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
            await supabaseClient
                .from('entries')
                .insert([{
                    entry: entry,
                    reflection: reflection,
                    prompt_used: false,
                    user_id: userId
                }]);
        }

        // Trigger synthesis every 10 entries
  if (totalEntryCount && totalEntryCount > 0 && (totalEntryCount + 1) % 10 === 0) {
            await runSynthesis(supabaseClient, recentEntries, personaContext, userId);
        }

        return res.status(200).json({ reflection });

    } catch (error) {
        return res.status(500).json({ error: 'API call failed: ' + error.message });
    }
}

async function runSynthesis(supabaseClient, recentEntries, personaContext, userId) {
    if (!recentEntries || recentEntries.length === 0) return;

    const entriesText = recentEntries
        .map((e, i) => `Entry ${i + 1}:\n${e.entry}`)
        .join('\n\n');

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

OUTPUT 2 — DETECTED CHANGES:
List any significant changes detected, each on its own line in this exact format:
TYPE|FIELD|DETECTED_VALUE|CONFIDENCE
Where TYPE is either EVENT or DRIFT
Where FIELD is the persona field being updated
Where DETECTED_VALUE is what you observed in the writing
Where CONFIDENCE is high, medium, or low

PERSONA BASELINE:
${personaContext}

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