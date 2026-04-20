const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userId, type, page } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    const pageSize = 10;
    const offset = ((page || 1) - 1) * pageSize;

    if (type === 'summaries') {
        const { data: summaries, error } = await supabaseClient
            .from('summaries')
            .select('id, summary, summary_type, period_start, period_end, entry_count, user_notes, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + pageSize - 1);

        if (error) return res.status(500).json({ error: error.message });

        const parsed = summaries.map(s => {
            let sections = null;
            try { sections = JSON.parse(s.summary); } catch { sections = null; }
            return { ...s, sections };
        });

        return res.status(200).json({ success: true, data: parsed, type: 'summaries' });
    }

    if (type === 'reflections') {
        // Pull entries
        const { data: entries, error } = await supabaseClient
            .from('entries')
            .select('id, entry, reflection, prompt, prompt_used, mood_post, created_at')
            .eq('user_id', userId)
            .not('entry', 'is', null)
            .order('created_at', { ascending: false })
            .range(offset, offset + pageSize - 1);

        if (error) return res.status(500).json({ error: error.message });

        // For each entry pull mood and feelings from same day
        const enriched = await Promise.all(entries.map(async (entry) => {
            const entryDate = new Date(entry.created_at);
            const dayStart = new Date(entryDate);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(entryDate);
            dayEnd.setHours(23, 59, 59, 999);

            const [moodResult, feelingsResult] = await Promise.all([
                supabaseClient
                    .from('mood')
                    .select('score')
                    .eq('user_id', userId)
                    .gte('created_at', dayStart.toISOString())
                    .lte('created_at', dayEnd.toISOString())
                    .order('created_at', { ascending: true })
                    .limit(1),
                supabaseClient
                    .from('feelings')
                    .select('feeling')
                    .eq('user_id', userId)
                    .gte('created_at', dayStart.toISOString())
                    .lte('created_at', dayEnd.toISOString())
            ]);

            return {
                ...entry,
                mood_pre: moodResult.data?.[0]?.score || null,
                feelings: feelingsResult.data?.map(f => f.feeling) || []
            };
        }));

        return res.status(200).json({ success: true, data: enriched, type: 'reflections' });
    }

    return res.status(400).json({ error: 'Invalid type' });
}