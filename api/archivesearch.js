const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userId, query } = req.body;

    if (!userId || !query) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // Pull relevant data for search context
    const [entriesResult, moodResult, feelingsResult, toolResult, summaryResult] = await Promise.all([
        supabaseClient
            .from('entries')
            .select('entry, reflection, created_at')
            .eq('user_id', userId)
            .not('entry', 'is', null)
            .order('created_at', { ascending: false })
            .limit(30),
        supabaseClient
            .from('mood')
            .select('score, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(30),
        supabaseClient
            .from('feelings')
            .select('feeling, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50),
        supabaseClient
            .from('tool_log')
            .select('tool_name, stack_summary, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(30),
        supabaseClient
            .from('summaries')
            .select('summary, period_start, period_end, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(5)
    ]);

    const entries = entriesResult.data || [];
    const moods = moodResult.data || [];
    const feelings = feelingsResult.data || [];
    const tools = toolResult.data || [];
    const summaries = summaryResult.data || [];

    // Assemble search context
    const entriesContext = entries.map(e => {
        const date = new Date(e.created_at);
        const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        const hour = date.getHours();
        let timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
        return `[${dateStr} at ${timeStr} — ${timeOfDay}]\nEntry: ${e.entry}\nReflection: ${e.reflection || 'none'}`;
    }).join('\n\n');

    const moodContext = moods.map(m => 
        `[${new Date(m.created_at).toLocaleDateString()}] Mood: ${m.score}/10`
    ).join('\n');

    const feelingCounts = {};
    feelings.forEach(f => { feelingCounts[f.feeling] = (feelingCounts[f.feeling] || 0) + 1; });
    const feelingsContext = Object.entries(feelingCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([f, c]) => `${f} (${c} times)`)
        .join(', ');

    const toolContext = tools.map(t => 
        `[${new Date(t.created_at).toLocaleDateString()}] ${t.tool_name}${t.stack_summary ? '\nStack summary: ' + t.stack_summary.substring(0, 200) : ''}`
    ).join('\n\n');

    const summaryContext = summaries.map(s => {
        let text = s.summary;
        try {
            const parsed = JSON.parse(s.summary);
            text = [parsed.section3_reflections, parsed.section7_progression].filter(Boolean).join('\n');
        } catch {}
        return `[Summary ${new Date(s.created_at).toLocaleDateString()}]: ${text.substring(0, 500)}`;
    }).join('\n\n');

    const searchPrompt = `You are Mirror's Archive search intelligence. The user is querying their own personal journal and wellness data. Answer their question precisely and honestly using only the data provided. 

After your answer, list the most relevant source entries that informed your response — just the dates and a brief excerpt. Maximum 3 sources.

Format your response as:
ANSWER: [your direct answer, 2-4 sentences, grounded in the actual data]

SOURCES:
[date] — [brief excerpt or data point that was relevant]

USER QUESTION: ${query}

JOURNAL ENTRIES AND REFLECTIONS:
${entriesContext.substring(0, 4000)}

MOOD DATA:
${moodContext}

FEELINGS DATA:
${feelingsContext}

TOOL LOG:
${toolContext.substring(0, 1000)}

SUMMARY INSIGHTS:
${summaryContext.substring(0, 1000)}`;

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
                max_tokens: 600,
                messages: [{ role: 'user', content: searchPrompt }]
            })
        });

        const data = await response.json();
        const answer = data.content[0].text.trim();

        return res.status(200).json({
            success: true,
            answer: answer,
            query: query
        });

    } catch (error) {
        return res.status(500).json({ error: 'Search failed: ' + error.message });
    }
}