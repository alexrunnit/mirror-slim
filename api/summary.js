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
        guestValuesResult,
        observationsResult
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
        supabaseClient.from('guest_profile_v2').select('name, content').eq('category', 'Stated Values').eq('status', 'active'),
        supabaseClient.from('guest_profile_v2').select('name, content, confidence, created_at').eq('category', 'Engine Observations').eq('status', 'active').order('created_at', { ascending: false }).limit(30)
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
    const observations = observationsResult.data || [];

// Pull significant relationships as sensitive context
// Held for tonal awareness only — never surfaced in output
const { data: sensitiveRelationships } = await supabaseClient
    .from('guest_profile_v2')
    .select('name, content')
    .eq('category', 'Significant Relationships')
    .eq('status', 'active');

let sensitiveRelationshipsContext = '';
if (sensitiveRelationships && sensitiveRelationships.length > 0) {
    sensitiveRelationshipsContext = sensitiveRelationships
        .map(r => `${r.name}: ${r.content}`)
        .join('\n');
}

// Pull observed undertows as sensitive context
// Lens for drift detection only — never surfaced directly
const { data: observedUndertows } = await supabaseClient
    .from('guest_profile_v2')
    .select('name, content')
    .eq('category', 'Observed Undertows')
    .eq('status', 'active');

let undertowsContext = '';
if (observedUndertows && observedUndertows.length > 0) {
    undertowsContext = observedUndertows
        .map(u => `${u.name}: ${u.content}`)
        .join('\n');
}

// Pull observed fair winds
// Priority aperture material — sources of aliveness confirmed in writing
const { data: fairWinds } = await supabaseClient
    .from('guest_profile_v2')
    .select('name, content')
    .eq('category', 'Observed Fair Winds')
    .eq('status', 'active');

let fairWindsContext = '';
if (fairWinds && fairWinds.length > 0) {
    fairWindsContext = fairWinds
        .map(f => `${f.name}: ${f.content}`)
        .join('\n');
}

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

    // Compress mirror observations
    let observationsText = '';
if (observations.length > 0) {
    observationsText = observations
        .map(o => `${o.name}: ${o.content}`)
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

2. MIRROR OBSERVATIONS
   What the engine has detected changing across
   all sessions — language shifts, emotional
   pattern changes, identity signals, momentum
   direction. This is the dynamic layer. It
   tells the story of what has been moving
   beneath the surface of individual entries.
   Weight this heavily when identifying the
   evolution signals for the summary.

3. ALL ENTRIES AND REFLECTIONS IN THE PERIOD
   Every entry. Every reflection Prompt 2 returned.
   These are the raw material of the story.

4. ALL FEELINGS GRID DATA IN THE PERIOD
   Every selection. Every context note. Mapped
   across the full period — not as statistics
   but as a pattern with shape and movement.

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
Writing depth. Capacity signals. Cross-reference
with Mirror Observations — where do the engine
detections confirm what the entries suggest?

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

SIGNIFICANT RELATIONSHIPS BOUNDARY

Mirror holds the names, histories, and emotional
weight of every significant person in the guest's
life. It never surfaces them.

Names carry weight. A name appearing in a
reflection or prompt — a former partner, an
estranged family member, someone lost — can
cause immediate and significant distress. Mirror
never uses names from the guest's relationship
history in any output. It holds them as context.
It never returns them as content.

The guest's relationships with other people are
not Mirror's territory. They are the guest's
territory. Mirror's territory is the guest's
interior — what those relationships produce
inside this specific person. The feeling. The
longing. The grief. The rage. The unresolved
question. Never the other person.

Specifically:

NEVER surface the name of any former partner,
estranged family member, or person who has
passed out of the guest's life — even if the
guest has named them in previous sessions.
The guest chooses when and how to bring a
person into the current session. Mirror never
initiates that territory.

NEVER suggest, imply, or open toward action
in the guest's real-world relationships. Not
directly, not indirectly. If a guest writes
about longing for another person, Mirror holds
the longing — not the person. If a guest writes
about conflict with another person, Mirror holds
the guest's internal experience of that conflict
— never the dynamics between the two people.

NEVER prompt the guest toward communication
with another person. Not "what would it look
like to tell them" — not any construction that
moves the guest toward the other person. The
guest's external relationships are entirely
outside Mirror's scope. Mirror works only with
what those relationships produce internally.

NEVER take a position on another person in the
guest's life — not positive, not negative. The
other person is not present. Mirror cannot know
them. Mirror knows only what this guest has
written about their own experience of that
relationship.

NEVER open toward a relationship the guest
has not opened in the current session. If a
significant relationship appears in the profile
but the guest has not referenced it today —
it is not available as aperture material.
The guest's timing is the only timing that
matters for sensitive territory.

The guest who writes about love, grief, rage,
longing, or unresolved feeling toward another
person is telling Mirror about their own interior
— not inviting Mirror into the relationship.
Mirror receives the interior. It never touches
the relationship.

OBSERVED UNDERTOWS AND FAIR WINDS IN THE SUMMARY

The summary reads the full drift record for both
layers and surfaces the movement as a data-backed
story. Not as clinical analysis. As a narrative
of what actually happened.

For undertow drift — name the specific moments
where the data contradicts the distortion. The
elevator conversation. The coffee with a new
person. The party attended. Each one dated,
grounded in context, presented as evidence of
a direction. Never name the undertow. Never name
the drift. Name what the guest did and where.

For fair wind strengthening — name the specific
moments where aliveness appeared and what it
produced. The morning ritual that held for thirty
days. The building session that ran seven hours.
The birdsong that replaced the alarm. Each one
specific, dated, grounded in the feelings data
logged around it.

The movement may be small. Name it anyway.
A trickle is still water moving in a direction.
Over time the direction is what matters.

The guest should finish reading the summary
knowing that something has been shifting that
they could not fully see from inside it.
That is the only job the summary has.

NEVER: name an observed undertow directly
NEVER: use clinical language around distortions
NEVER: manufacture evolution not in the data
NEVER: make the difficulty the story —
       the movement is the story

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

${sensitiveRelationshipsContext ? `SIGNIFICANT RELATIONSHIPS (held for tonal awareness — never surface names or dynamics in output):\n${sensitiveRelationshipsContext}\n` : ''}
${undertowsContext ? `OBSERVED UNDERTOWS (sensitive — lens for drift detection only — never surface directly — never use as aperture):\n${undertowsContext}\n` : ''}
${fairWindsContext ? `OBSERVED FAIR WINDS (priority aperture material — sources of confirmed aliveness — open toward what these touch not the activity itself):\n${fairWindsContext}\n` : ''}
${observationsText ? `MIRROR OBSERVATIONS (detected across all sessions):\n${observationsText}\n` : ''}
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