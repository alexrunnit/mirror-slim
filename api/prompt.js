const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userId, recentEntries, currentMood, currentFeelings } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'No userId provided' });
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
        .select('summary')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);

    let summaryContext = '';
    if (summaryRows && summaryRows.length > 0) {
        summaryContext = summaryRows[0].summary;
    }

    // Build recent entry history
    let historyContext = '';
    if (recentEntries && recentEntries.length > 0) {
        historyContext = recentEntries
            .map((e, i) => `Entry ${i + 1}:\n${e.entry}`)
            .join('\n\n');
    }

    // Build current state context
    let currentStateContext = '';
    if (currentMood) {
        currentStateContext += `Mood: ${currentMood}/10\n`;
    }
    if (currentFeelings && currentFeelings.length > 0) {
        currentStateContext += `Feelings present: ${currentFeelings.join(', ')}\n`;
    }

    // Get current hour for time of day awareness
    const hour = new Date().getHours();
    let timeOfDay = '';
    if (hour >= 5 && hour < 12) timeOfDay = 'morning';
    else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
    else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
    else timeOfDay = 'night';

    const promptSystem = `You are a writing prompt generator for a private journal. Your sole function is to produce one single question that opens thought and invites genuine reflection.

The question must be:
- Specific to this person based on their recent writing, current emotional state, and context
- Calibrated to their mood and feelings if provided — meet them where they are, not where they should be
- Pointed enough to provoke thought but open enough to allow any direction
- Grounded in something real from their recent entries or persona — never generic
- Appropriate for the time of day: ${timeOfDay}
- One sentence only
- No preamble, no explanation, no options — just the question itself

If the mood is low (1-4) or difficult feelings are present: ask something that acknowledges the weight without amplifying it — something that opens rather than demands.
If the mood is neutral (5-6): ask something that gently probes what's underneath the surface.
If the mood is high (7-10) or expansive feelings are present: ask something that extends the forward momentum — what's possible from here.

This person's context:
${personaContext}

${summaryContext ? `Recent pattern summary:\n${summaryContext}\n` : ''}

${currentStateContext ? `CURRENT STATE:\n${currentStateContext}` : ''}

${historyContext ? `Recent entries:\n${historyContext}` : ''}`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                system: promptSystem,
                messages: [
                    {
                        role: 'user',
                        content: `Generate one writing prompt for my journal session this ${timeOfDay}.`
                    }
                ]
            })
        });

        const data = await response.json();
        const prompt = data.content[0].text.trim();

        const { data: newRow, error } = await supabaseClient
            .from('entries')
            .insert([{
                prompt: prompt,
                user_id: userId
            }])
            .select('id')
            .single();

        if (!newRow || !newRow.id) {
            return res.status(500).json({ error: 'Row insert failed', prompt: prompt });
        }

        return res.status(200).json({ 
            prompt: prompt,
            rowId: newRow.id
        });

    } catch (error) {
        return res.status(500).json({ error: 'Prompt generation failed: ' + error.message });
    }
}