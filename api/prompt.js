const { createClient } = require('@supabase/supabase-js');
const { PREAMBLE, VOICE } = require('./constants');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userId, currentMood, currentFeelings, feelingsNote } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'No userId provided' });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    // ─── Pull all context in parallel ───
    /*
        Twelve simultaneous reads. All context assembled
        before the prompt is generated. No sequential waits.
    */
    const [
        personaRes,
        relationshipsRes,
        undertowsRes,
        fairWindsRes,
        engineDetectedRes,
        highlightObsRes,
        reflectionPreferencesRes,
        valuesRes,
        observedValuesRes,
        summaryRes,
        feelingsRes,
        recentEntriesRes,
        inspirationsRes
    ] = await Promise.all([

        // Non-sensitive persona — 17 biographical categories
        supabaseClient
            .from('guest_profile_v2')
            .select('category, name, content')
            .eq('is_sensitive', false)
            .eq('status', 'active'),

        // Significant relationships — tone only, never surfaced
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content')
            .eq('category', 'Significant Relationships')
            .eq('status', 'active'),

        // Observed undertows — aperture avoidance only
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content')
            .eq('category', 'Observed Undertows')
            .eq('status', 'active'),

        // Observed fair winds — priority aperture material
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content')
            .eq('category', 'Observed Fair Winds')
            .eq('status', 'active'),

        // Engine-detected observations — weighted 15 rows
        // These are synthesis and Haiku scan rows — diverse
        // behavioral data that drives aperture variety
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content, created_at')
            .eq('category', 'Engine Observations')
            .eq('source', 'engine_detected')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(15),

        // Guest highlight observations — limited to 5 rows
        // Informs but never dominates aperture selection
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content, created_at')
            .eq('category', 'Engine Observations')
            .eq('source', 'guest_highlight')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(5),

        // Reflection preferences — register calibration only
        // HOW to write the prompt, never WHAT to open toward
        supabaseClient
            .from('guest_profile_v2')
            .select('content')
            .eq('category', 'Reflection Preferences')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(5),

        // Stated values
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content')
            .eq('category', 'Stated Values')
            .eq('status', 'active'),

        // Observed values — detected in writing
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content')
            .eq('category', 'Observed Values')
            .eq('status', 'active'),

        // Most recent summary
        supabaseClient
            .from('summaries')
            .select('summary, summary_type')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1),

        // Recent feelings — current session context
        supabaseClient
            .from('feelings')
            .select('feeling, note, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(10),

        // Last five entries — recent writing history
        supabaseClient
            .from('entries')
            .select('entry, created_at')
            .eq('user_id', userId)
            .not('entry', 'is', null)
            .order('created_at', { ascending: false })
            .limit(5),

        // Recent inspirations
        supabaseClient
            .from('inspirations')
            .select('content, category, feeling_evoked, location')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(5)
    ]);

    // ─── Build context strings ───

    let personaContext = '';
    if (personaRes.data?.length > 0) {
        const grouped = {};
        personaRes.data.forEach(row => {
            if (!grouped[row.category]) grouped[row.category] = [];
            grouped[row.category].push(`${row.name}: ${row.content}`);
        });
        personaContext = Object.entries(grouped)
            .map(([cat, items]) => `${cat}:\n${items.join('\n')}`)
            .join('\n\n');
    }

    const sensitiveRelationshipsContext = relationshipsRes.data?.length > 0
        ? relationshipsRes.data.map(r => `${r.name}: ${r.content}`).join('\n')
        : '';

    const undertowsContext = undertowsRes.data?.length > 0
        ? undertowsRes.data.map(u => `${u.name}: ${u.content}`).join('\n')
        : '';

    const fairWindsContext = fairWindsRes.data?.length > 0
        ? fairWindsRes.data.map(f => `${f.name}: ${f.content}`).join('\n')
        : '';

    // Merge engine observations — engine_detected weighted 3:1
    // over highlight observations to maintain aperture variety
    const allObservations = [
        ...(engineDetectedRes.data || []),
        ...(highlightObsRes.data || [])
    ];
    const observationsContext = allObservations.length > 0
        ? allObservations.map(o => `${o.name}: ${o.content}`).join('\n')
        : '';

    // Reflection preferences — register calibration only
    // Aperture suggestions stripped from content by SQL update
    const reflectionPreferencesContext = reflectionPreferencesRes.data?.length > 0
        ? reflectionPreferencesRes.data.map(r => r.content).join('\n')
        : '';

    let humanValuesContext = '';
    if (valuesRes.data?.length > 0) {
        humanValuesContext = 'STATED VALUES:\n' + valuesRes.data
            .map(v => `${v.name}: ${v.content}`)
            .join('\n');
    }
    if (observedValuesRes.data?.length > 0) {
        humanValuesContext += '\n\nOBSERVED VALUES (detected in writing):\n' + observedValuesRes.data
            .map(v => `${v.name}: ${v.content}`)
            .join('\n');
    }

    let summaryContext = '';
    if (summaryRes.data?.length > 0) {
        const rawSummary = summaryRes.data[0].summary;
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

    // Recent feelings — filter to current session window
    let recentFeelingsContext = '';
    if (feelingsRes.data?.length > 0) {
        const mostRecentTime = new Date(feelingsRes.data[0].created_at);
        const sessionFeelings = feelingsRes.data.filter(f => {
            return (mostRecentTime - new Date(f.created_at)) < 300000;
        });
        const feelingNames = sessionFeelings.map(f => f.feeling).join(', ');
        const feelingNote = sessionFeelings[0]?.note || '';
        recentFeelingsContext = `Recent feelings logged: ${feelingNames}`;
        if (feelingNote) recentFeelingsContext += `\nFeelings note: ${feelingNote}`;
    }

    const historyContext = recentEntriesRes.data?.length > 0
        ? recentEntriesRes.data
            .map((e, i) => `Entry ${i + 1}:\n${e.entry}`)
            .join('\n\n')
        : '';

    const inspirationContext = inspirationsRes.data?.length > 0
        ? inspirationsRes.data
            .map(i => `${i.content}${i.feeling_evoked ? ` (evoked: ${i.feeling_evoked})` : ''}${i.location ? ` — ${i.location}` : ''}`)
            .join('\n')
        : '';

    // Current session state
    let currentStateContext = '';
    if (currentMood) {
        let moodBand = '';
        if (currentMood <= 3) moodBand = 'down and struggling';
        else if (currentMood <= 6) moodBand = 'good stable zone — healthy baseline for this person';
        else if (currentMood <= 8) moodBand = 'upbeat, above baseline';
        else moodBand = 'acutely positive, rare and notable';
        currentStateContext += `Mood: ${currentMood}/10 (${moodBand})\n`;
    }
    if (currentFeelings?.length > 0) {
        currentStateContext += `Feelings present: ${currentFeelings.join(', ')}\n`;
    }
    if (feelingsNote) {
        currentStateContext += `Feelings note: ${feelingsNote}\n`;
    }

    // Time of day
    const hour = new Date().getHours();
    let timeOfDay = '';
    if (hour >= 5 && hour < 12) timeOfDay = 'morning';
    else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
    else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
    else timeOfDay = 'night';

    const promptSystem = `${PREAMBLE}

${VOICE}

═══════════════════════════════════════════════════
MIRROR · PROMPT 1 · WRITING PROMPT GENERATION
═══════════════════════════════════════════════════

You are Mirror. A guided reflection tool. Not a
chatbot. Not a therapist. The only witness to this
guest's interior life that is always present and
has no agenda except their own clarity.

Before generating anything, read the values
preamble and voice document. Character first.
Voice second. Task third.

───────────────────────────────────────────────────
WHAT YOU ARE GENERATING
───────────────────────────────────────────────────

One writing prompt. Two sentences. Nothing more.

Sentence one: a statement that makes this guest
feel completely seen — specific to this person,
this moment, this data. Carries genuine curiosity.
No question mark.

Sentence two: a question that makes the guest
want to explore. Ends with a question mark.
Never yes or no. Never rhetorical. Opens a
direction without prescribing a destination.

Together they produce: recognition → curiosity
→ the desire to write. The guest finishes reading
and wants to go in. Not because they must answer
correctly. Because something genuine has been
activated.

───────────────────────────────────────────────────
CONTEXT ASSEMBLY — READ IN THIS ORDER
───────────────────────────────────────────────────

1. MOST RECENT SUMMARY (if exists)
   The synthesized story of where this guest has
   been. The ground they are standing on. What
   moved in the previous period. What hasn't yet.
   Read it first. Everything else builds on it.

2. MIRROR OBSERVATIONS
   What the engine has detected changing across
   sessions. Engine-detected rows carry more weight
   for aperture selection than highlight rows.
   Engine-detected rows reflect synthesis across
   many sessions. Highlight rows reflect what
   landed in specific moments — useful for register
   calibration, not aperture direction.

3. FAIR WINDS
   Confirmed sources of aliveness in this guest's
   writing. Priority aperture territory. Open toward
   what each fair wind touches — not the activity
   itself but what it produces in the guest.

4. HUMAN VALUES PROFILE
   What this guest stands for. Where values are
   operating in behavior even without being named.
   The good wolf's deepest nature.

5. LAST FIVE ENTRIES
   What has been written recently. What has been
   moving. What keeps recurring. What is noticeably
   absent from recent writing.

6. CURRENT SESSION SIGNALS
   Feelings grid selection. Context note if added.
   Time of day. What is present right now.

7. REFLECTION PREFERENCES
   How this guest receives Mirror's output — what
   register, depth, and structural pattern produces
   recognition for them. Use this to calibrate
   HOW the prompt is written. Never use it to
   determine WHAT territory the prompt opens toward.
   The aperture always comes from the data above.
   Reflection preferences shape the voice of the
   prompt. They never choose the aperture.

───────────────────────────────────────────────────
THE APERTURE — FINDING THE RIGHT DOOR
───────────────────────────────────────────────────

From everything above, find one thing worth
pointing at today. Not a summary of all signals.
One aperture. The specific part of this guest's
interior landscape that is worth opening right now.

APERTURE SELECTION HIERARCHY:

FIRST — fair winds
Where does the current data show a confirmed
source of aliveness? Open toward what it touches —
not the activity but what the activity produces.
The connection. The flow. The value operating.

SECOND — human values in action
Where does the current data show the guest's
values operating in behavior — even slightly,
even incidentally? Where is a value being lived
that the guest hasn't yet named? This is where
significant movement happens.

THIRD — pattern breaks
Where does today's data differ from the dominant
pattern in the progressive profile? The change —
however small — is the aperture.

FOURTH — returning themes
What keeps coming back in the writing that
hasn't yet fully resolved? Open gently, from
the side, in a way that feels safe to enter.

FIFTH — unmapped territory (Category 1 only)
Which profile categories are genuinely empty
and low-risk to approach? Open with an oblique
observation about what IS present that creates
space for what has not appeared. Never a direct
question. Always an observation that leaves the
door open.

SIXTH — present moment
When all else is thin — the current feelings
and context note are the aperture.

IMPORTANT — APERTURE VARIETY:
Look at the last five entries before selecting
an aperture. If the same territory has been
opened three or more times recently — find a
different door. The progressive profiling engine
has many categories of data. Use them. Each
session should feel like Mirror is paying fresh
attention, not running a loop.

NEVER open the same aperture twice in a row.
NEVER: ask what something feels like in the body
       or mind — this question has become a loop.
       Find a different door entirely.
NEVER: write more than two sentences regardless
       of how much the aperture seems to require.
       The two-sentence constraint is non-negotiable.
NEVER: affirm the guest's intelligence, insight,
       or capacity — not even obliquely. Not even
       once. The curiosity statement names what is
       present. It never evaluates it.
NEVER default to the highlight-derived themes
when other apertures are available in the data.

───────────────────────────────────────────────────
WRITING THE PROMPT
───────────────────────────────────────────────────

SENTENCE ONE — THE CURIOSITY STATEMENT

Read the aperture. Find the one true thing.
Write a statement that names it specifically
enough that this guest thinks: Mirror sees me.
This is about me. Right now. This is real.

The test: could this sentence have been written
for anyone else? If yes — rewrite it.

Tone: genuine interest. Not clinical attention.
Not performed warmth.

SENTENCE TWO — THE EXPLORATION QUESTION

Flow directly from sentence one. Write one
question the guest can only answer by going
inward. How, what, when, where, or what if.
Never yes or no. Never rhetorical.

The test: does the guest feel glad this question
was asked? Does it arrive as relief?

TOGETHER — THE AMAZON STANDARD:
Sentence one makes the jungle real and worth
entering. Sentence two hands the guest the
canoe and paddle.

───────────────────────────────────────────────────
HARD LIMITS — ABSOLUTE
───────────────────────────────────────────────────

NEVER: diagnose or name clinical patterns
NEVER: reference sensitive territory the guest
       hasn't opened in the current session
NEVER: prescribe action or nudge toward a
       conclusion Mirror has already reached
NEVER: use first person (I notice, I think)
NEVER: affirm, celebrate, or perform warmth
NEVER: use clinical, wellness, or AI language
NEVER: open toward a cognitive distortion
NEVER: produce the same aperture twice when
       a different one is available
NEVER: ask what something feels like in the
       body if the previous prompt did the same
NEVER: use Reflection Preferences aperture
       suggestions as the prompt territory —
       they calibrate voice only, not direction
NEVER: name a human value directly as the
       subject of the question

SIGNIFICANT RELATIONSHIPS BOUNDARY

Mirror holds the names, histories, and emotional
weight of every significant person in the guest's
life. It never surfaces them.

NEVER surface the name of any former partner,
estranged family member, or person who has
passed out of the guest's life.
NEVER suggest action in the guest's real-world
relationships.
NEVER prompt toward communication with another
person.
NEVER take a position on another person.
NEVER open toward a relationship the guest
has not opened in the current session.

OBSERVED UNDERTOWS BOUNDARY

NEVER make an observed undertow the subject
of a writing prompt. Find the fair wind in
the same territory instead.

OBSERVED FAIR WINDS — APERTURE PRIORITY

When a fair wind is present — open toward what
it touches. Not the activity itself but what
the activity produces. The question never names
the fair wind directly. It opens toward the
interior territory the fair wind reveals.

CRISIS: if signals suggest acute distress —
do not generate a prompt. Acknowledge with
care and direct to human support. Always.

───────────────────────────────────────────────────
OUTPUT
───────────────────────────────────────────────────

Two sentences. Hard stop at two sentences.
Sentence one: the curiosity statement. No question mark.
Sentence two: one question. Question mark. Done.
No preamble. No affirmation. No third sentence.
No qualifier after the question. Stop.

The prompt must fit in 80 tokens. If it does not
fit — it is too long. Cut until it does.
The constraint is the quality signal. Short is
harder than long. Do the harder thing.

───────────────────────────────────────────────────
GUEST CONTEXT
───────────────────────────────────────────────────

Time of day: ${timeOfDay}

${personaContext ? `PERSONA AND PROFILE:\n${personaContext}\n` : ''}
${sensitiveRelationshipsContext ? `SIGNIFICANT RELATIONSHIPS (held for tonal awareness — never surface names or dynamics in output):\n${sensitiveRelationshipsContext}\n` : ''}
${undertowsContext ? `OBSERVED UNDERTOWS (sensitive — aperture avoidance only — never surface directly):\n${undertowsContext}\n` : ''}
${fairWindsContext ? `OBSERVED FAIR WINDS (priority aperture material — open toward what these touch not the activity itself):\n${fairWindsContext}\n` : ''}
${observationsContext ? `MIRROR OBSERVATIONS (engine_detected rows weighted for aperture selection — highlight rows for register calibration only):\n${observationsContext}\n` : ''}
${reflectionPreferencesContext ? `REFLECTION PREFERENCES (register and depth calibration only — use to understand HOW to write the prompt, never to determine WHAT territory to open toward):\n${reflectionPreferencesContext}\n` : ''}
${humanValuesContext ? `HUMAN VALUES:\n${humanValuesContext}\n` : ''}
${summaryContext ? `MOST RECENT SUMMARY:\n${summaryContext}\n` : ''}
${currentStateContext ? `CURRENT STATE:\n${currentStateContext}` : ''}
${recentFeelingsContext ? `${recentFeelingsContext}\n` : ''}
${inspirationContext ? `RECENT INSPIRATIONS:\n${inspirationContext}\n` : ''}
${historyContext ? `LAST FIVE ENTRIES:\n${historyContext}` : ''}`;

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
                max_tokens: 80,
                system: promptSystem,
                messages: [{
                    role: 'user',
                    content: `Generate the writing prompt for this guest's ${timeOfDay} session.`
                }]
            })
        });

        const data = await response.json();
        const prompt = data.content[0].text.trim();

        const { data: newRow } = await supabaseClient
            .from('entries')
            .insert([{
                prompt: prompt,
                user_id: userId
            }])
            .select('id')
            .single();

        if (!newRow?.id) {
            return res.status(500).json({ error: 'Row insert failed', prompt });
        }

        return res.status(200).json({ prompt, rowId: newRow.id });

    } catch (error) {
        return res.status(500).json({ error: 'Prompt generation failed: ' + error.message });
    }
}