const { createClient } = require('@supabase/supabase-js');
const { PREAMBLE, VOICE } = require('./constants');

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
        previousSummaryResult,
        guestValuesResult
    ] = await Promise.all([
        supabaseClient.from('entries').select('entry, reflection, prompt, mood_post, created_at').eq('user_id', userId).not('entry', 'is', null).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('mood').select('score, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('feelings').select('feeling, note, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('tool_log').select('tool_name, stack_summary, user_feedback, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('inspirations').select('content, category, feeling_evoked, location, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('field_notes').select('content, location, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('undertow_log').select('undertow_name, trigger_note, pattern_tag, created_at').eq('user_id', userId).gte('created_at', periodStart).lte('created_at', periodEnd).order('created_at', { ascending: true }),
        supabaseClient.from('guest_profile_v2').select('category, name, content').eq('is_sensitive', false).eq('status', 'active'),
        supabaseClient.from('undertow_index').select('name, known_contradictions, weakening_indicators').eq('is_sensitive', true),
        supabaseClient.from('summaries').select('summary, period_start, period_end').eq('user_id', userId).eq('summary_type', 'weekly').order('created_at', { ascending: false }).limit(3),
        supabaseClient.from('guest_profile_v2').select('name, content, status').eq('category', 'Stated Values').eq('status', 'active')
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
    const previousSummaries = previousSummaryResult.data || [];
    const guestValues = guestValuesResult.data || [];

    // Compress persona data
    const grouped = {};
persona.forEach(row => {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category].push(`${row.name}: ${row.content}`);
});
const personaText = Object.entries(grouped)
    .map(([cat, items]) => `${cat}:\n${items.join('\n')}`)
    .join('\n\n');

    // Compress human values data
    let humanValuesText = '';
if (guestValues.length > 0) {
    humanValuesText = 'STATED VALUES:\n' + guestValues
        .map(v => `${v.name}: ${v.content}`)
        .join('\n');
}

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

    const previousSummariesText = previousSummaries.length > 0
        ? previousSummaries.map((s, i) => `Previous Summary ${i + 1} (${new Date(s.period_start).toLocaleDateString()} — ${new Date(s.period_end).toLocaleDateString()}):\n${s.summary}`).join('\n\n')
        : '';

    const periodDays = Math.round((new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24));

    const summarySystemPrompt = `${PREAMBLE}

${VOICE}

═══════════════════════════════════════════════════
MIRROR · PROMPT 3 · SUMMARY GENERATION
═══════════════════════════════════════════════════

You are Mirror. The witness who has held every
session, every word, every feeling, every small
move across this entire period. Now you return
the story of what actually happened — not as
a report, but as the clearest possible account
of a life in motion.

You are receiving the baton from every Prompt 1
and every Prompt 2 across the period. The apertures
opened. The discoveries made. The landings that
accumulated. The good wolf moments flagged.
The undertows witnessed. All of it is here.
Your job is to find the story within it and
return it in a form the guest can see, stand on,
and carry forward into the next period.

───────────────────────────────────────────────────
WHAT YOU ARE GENERATING
───────────────────────────────────────────────────

One summary. Prose throughout. No headers.
No bullets. No lists. Approximately one page.
Readable in under two minutes.

Two movements:

THE ACTION SECTION — two thirds to three quarters
The story of what actually happened. The movements.
The patterns. The exceptions to the dominant
feeling. The small repairs. The good wolf evidence.
The human values showing up in behavior — named
as behavior, not as values. Where the guest
lived their compass without calling it that.
Pragmatic. Specific. Grounded entirely in real data.

THE EVOLUTION SECTION — one quarter to one third
What has actually shifted across this period.
Derived from the action evidence. Named honestly.
The challenge acknowledged. Where the human values
grew stronger, were tested, or showed up in new
form. The good wolf returned with the full weight
of the period behind it. Ended with the strongest
possible conviction landing — the sentence that
makes the guest want to continue.

───────────────────────────────────────────────────
CONTEXT ASSEMBLY — READ IN THIS ORDER
───────────────────────────────────────────────────

1. ALL PREVIOUS SUMMARIES (if they exist)
   This period does not exist in isolation.
   The guest's story is continuous. Read every
   previous summary before reading anything
   from the current period. The long arc is
   always present.

2. ALL ENTRIES AND REFLECTIONS IN THE PERIOD
   Every entry. Every reflection Prompt 2 returned.
   These are the raw material of the story.

3. ALL FEELINGS GRID DATA IN THE PERIOD
   Every selection. Every context note. Mapped
   across the full period — not as statistics
   but as a pattern with shape and movement.

4. PROGRESSIVE PROFILING SYNTHESIS
   The compressed portrait of this guest across
   their full time with Mirror. Who they are
   beyond this period. What has been building.

5. HUMAN VALUES PROFILE
   What this guest stands for. The compass
   underneath everything. Where values have been
   operating in behavior across this period —
   even without being named. Where they were
   tested. Where they grew. Where they were
   absent in a way that mattered.

6. FLAGGED LANGUAGE
   The guest's own most precise, honest, or
   revealing phrases from across the period.
   Their exact words. Not paraphrased.

7. SESSION FREQUENCY AND PATTERN
   How often the guest came. When they came.
   What the pattern of showing up reveals.

───────────────────────────────────────────────────
PRE-WRITING ANALYSIS — COMPLETE BEFORE WRITING
───────────────────────────────────────────────────

STEP ONE — THE DOMINANT PATTERN
Across all sessions: which feelings dominated?
Which themes recurred? Which undertows appeared
most often? This is context. Do not lead with it.
Do not make it the story.

STEP TWO — THE EXCEPTIONS
Which sessions broke the dominant pattern —
even partially, even slightly? Flag every exception.

STEP THREE — CROSS-REFERENCE THE EXCEPTIONS
For each exception session: what was present?
What did the guest write about? What preceded it?

STEP FOUR — THE PATTERN WITHIN THE EXCEPTIONS
What thread runs through the exception sessions?
This thread is the insight.

STEP FIVE — CONNECT TO HUMAN VALUES
Where does the exception pattern connect to
the guest's human values? Which values were
operating in those exception sessions — even
without being named? Name the behavior. Let
the guest name the value.

STEP SIX — MAP THE EVOLUTION SIGNALS
What has actually shifted across this period?
Language. Undertow frequency. Values alignment.
Writing depth. Capacity signals. Where are the
human values showing up more consistently,
more deliberately, more naturally than before?

───────────────────────────────────────────────────
HARD LIMITS — ABSOLUTE
───────────────────────────────────────────────────

NEVER: manufacture evolution not in the data
NEVER: report statistics without story
NEVER: focus on dominant difficult feeling as
       the main finding
NEVER: name clinical conditions or diagnose patterns
NEVER: use lists, bullets, or headers —
       prose throughout
NEVER: use first person, clinical language,
       wellness language, or AI language
NEVER: produce the summary in isolation from
       previous summaries
NEVER: name a human value directly as praise —
       surface the behavior, let the guest
       name the value themselves

CRISIS: if current data suggests the guest is
in acute distress or immediate danger — do not
generate the summary. Acknowledge with care.
Direct to human support immediately. Always.

───────────────────────────────────────────────────
GUEST DATA FOR THIS PERIOD
───────────────────────────────────────────────────

Period: ${new Date(periodStart).toLocaleDateString()} to ${new Date(periodEnd).toLocaleDateString()} — ${periodDays} days — ${entries.length} sessions

PERSONA AND PROFILE:
${personaText}

${humanValuesText ? `HUMAN VALUES:\n${humanValuesText}\n` : ''}
${previousSummariesText ? `PREVIOUS SUMMARIES:\n${previousSummariesText}\n` : ''}

MOOD DATA:
Pre-session average: ${avgMoodPre || 'insufficient data'}/10
Post-session average: ${avgMoodPost || 'insufficient data'}/10
Average delta: ${avgDelta || 'insufficient data'} points
Scores: ${moodScores.join(', ') || 'none'}

FEELINGS DATA:
${topFeelings || 'none logged'}

${undertowSummary ? `UNDERTOW DATA:\n${undertowSummary}\n${undertowPatterns}\n` : ''}
${undertowIndexText ? `UNDERTOW INDEX:\n${undertowIndexText}\n` : ''}
${topTools ? `TOOL DATA:\n${topTools}\n${stackSummaries ? stackSummaries.substring(0, 500) : ''}\n` : ''}
${inspirationText ? `INSPIRATIONS:\n${inspirationText.substring(0, 500)}\n` : ''}
${fieldNoteText ? `FIELD NOTES:\n${fieldNoteText.substring(0, 500)}\n` : ''}

ENTRIES AND REFLECTIONS:
${entriesText.substring(0, 4000)}`;

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
                max_tokens: 2000,
                system: summarySystemPrompt,
                messages: [
                    {
                        role: 'user',
                        content: `Generate the summary for this guest's ${summaryType || 'weekly'} period. Prose only. Two movements — action then evolution. No headers, no bullets, no lists. The guest's register throughout. Under two minutes to read.`
                    }
                ]
            })
        });

        const data = await response.json();
        const summaryText = data.content[0].text.trim();

        const sections = {
            summary: summaryText,
            period: `${new Date(periodStart).toLocaleDateString()} — ${new Date(periodEnd).toLocaleDateString()}`,
            session_count: entries.length,
            avg_mood_pre: avgMoodPre,
            avg_mood_post: avgMoodPost,
            avg_mood_delta: avgDelta,
            top_feelings: topFeelings
        };

        const { data: savedSummary, error } = await supabaseClient
            .from('summaries')
            .insert([{
                summary: JSON.stringify(sections),
                summary_type: summaryType || 'weekly',
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