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
    const [
        personaRes,
        relationshipsRes,
        undertowsRes,
        fairWindsRes,
        engineDetectedRes,
        haikuScanRes,
        highlightObsRes,
        reflectionPreferencesRes,
        valuesRes,
        observedValuesRes,
        summaryRes,
        feelingsRes,
        recentEntriesRes,
        inspirationsRes,
        recentPromptsRes
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

        // Engine-detected observations — synthesis rows
        // Most diverse — written across many sessions
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content, created_at')
            .eq('category', 'Engine Observations')
            .eq('source', 'engine_detected')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(15),

        // Haiku entry scan rows — live signal per session
        // Most recent behavioral data — what is present NOW
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content, created_at')
            .eq('category', 'Engine Observations')
            .eq('source', 'haiku_entry_scan')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(10),

        // Guest highlight observations — limited to 5 rows
        // What has landed — register calibration only
        // Never dominates aperture selection
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content, created_at')
            .eq('category', 'Engine Observations')
            .eq('source', 'guest_highlight')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(5),

        // Reflection preferences — HOW to write, never WHAT
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
            .limit(5),

        // Last 5 prompts — aperture variety enforcement
        // Sonnet must see what was asked recently
        // to find a genuinely different door each session
        supabaseClient
            .from('entries')
            .select('prompt, created_at')
            .eq('user_id', userId)
            .not('prompt', 'is', null)
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

    // Merge three observation sources with explicit weighting.
    // Each row truncated to 150 chars — signal only, no
    // 400-word paragraphs drowning the rest of the context.
    // engine_detected: diverse synthesis across many sessions
    // haiku_entry_scan: live behavioral signal from recent entries
    // guest_highlight: what has landed — limited to 5 rows
    const allObservations = [
        ...(engineDetectedRes.data || []),
        ...(haikuScanRes.data || []),
        ...(highlightObsRes.data || [])
    ];
    const observationsContext = allObservations.length > 0
        ? allObservations
            .map(o => `${o.name}: ${o.content.substring(0, 150)}`)
            .join('\n')
        : '';

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

    // Last 5 prompts — the loop-breaker
    // If Sonnet can see what it already asked it can find
    // a genuinely different door rather than a variation
    // of the same one
    const recentPromptsContext = recentPromptsRes.data?.length > 0
        ? recentPromptsRes.data
            .map((p, i) => `Prompt ${i + 1}: ${p.prompt}`)
            .join('\n')
        : '';

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

Character first. Voice second. Task third.

───────────────────────────────────────────────────
WHAT YOU ARE GENERATING
───────────────────────────────────────────────────

One writing prompt. Two sentences. Hard stop.

Sentence one: a statement. Specific. No question
mark. Names something true about this guest right
now. Not an evaluation. An observation.

Sentence two: one question. Question mark. Done.
Opens inward. Never yes or no. Never rhetorical.

───────────────────────────────────────────────────
APERTURE SELECTION — THE ONLY TASK BEFORE WRITING
───────────────────────────────────────────────────

Before writing a single word — read the LAST 5
PROMPTS at the bottom of the guest context.

Those are the doors already opened. Do not open
them again. Do not open a variation of them.
Find a room that has not been visited.

The profile has many categories. Use them all
across sessions. The guest's life is not only
identity reconstruction and internal signals.
It also contains:

— Work: what they are building, who they are
  becoming professionally, what Mirror building
  means for their sense of purpose
— Aspirations: the specific futures named —
  Scotland, Italy, Sweden, Puerto Rico, the old
  man smiling in a distant country
— Social connection: the stranger encounters,
  the Arabic family, Brooklyn, the people below
  the rooftop monastery
— Body and energy: sleep, the cold shower, the
  nap, the gym, the regulatory stack
— Formative experiences: what shaped the person
  who arrived at the glass dome
— Unfinished stories: what has not yet resolved
— Interests and passions: what produces aliveness
  beyond the identity reconstruction work
— Present moment: what is actually here right now
  that has not been named in the writing yet

APERTURE SELECTION HIERARCHY:

FIRST — fair winds not recently opened
A confirmed source of aliveness that has not
appeared in the last 5 prompts. Open toward
what it produces — not the activity itself.

SECOND — values in action not recently named
Where is a value operating in behavior that
the guest hasn't yet named? Where is a value
being tested or stretched right now?

THIRD — profile category not recently visited
What has not been opened in the last 5 prompts?
Pick from the list above. Open obliquely —
observation first, question second.

FOURTH — pattern break
Where does today's data differ from the dominant
pattern? The change — however small — is worth
naming.

FIFTH — present moment
What is actually here right now that has not
been written about yet?

───────────────────────────────────────────────────
WRITING THE PROMPT
───────────────────────────────────────────────────

SENTENCE ONE — THE OBSERVATION

Name one true thing about this guest right now.
Specific enough that no one else could receive
this sentence. Not a summary. Not an evaluation.
Not a compliment. The thing that is present.

SENTENCE TWO — THE QUESTION

One question that flows from sentence one.
The guest can only answer it by going inward.
Opens without directing. Ends and stops.

───────────────────────────────────────────────────
HARD LIMITS — NON-NEGOTIABLE
───────────────────────────────────────────────────

NEVER: more than two sentences total
NEVER: ask what something feels like in the
       body or mind — banned entirely
NEVER: affirm, evaluate, or compliment
       the guest's capacity, insight, or growth
NEVER: open the same territory as any of the
       last 5 prompts — read them first
NEVER: use first person
NEVER: use clinical, wellness, or AI language
NEVER: make an undertow the aperture
NEVER: surface relationship names
NEVER: open toward identity reconstruction,
       the redirect skill, internal vs external
       validation, or the stream/storm metaphor
       unless no other aperture exists in the
       entire profile — and even then, find
       a different angle into that territory

───────────────────────────────────────────────────
OUTPUT
───────────────────────────────────────────────────

Two sentences. 80 tokens maximum. No preamble.
No labels. No quotation marks. Stop after the
question mark. The prompt. That is all.

───────────────────────────────────────────────────
GUEST CONTEXT
───────────────────────────────────────────────────

Time of day: ${timeOfDay}

${recentPromptsContext ? `LAST 5 PROMPTS — READ BEFORE SELECTING APERTURE (find a door not opened here):\n${recentPromptsContext}\n` : ''}
${personaContext ? `PERSONA AND PROFILE:\n${personaContext}\n` : ''}
${sensitiveRelationshipsContext ? `SIGNIFICANT RELATIONSHIPS (tonal awareness only — never surface):\n${sensitiveRelationshipsContext}\n` : ''}
${undertowsContext ? `OBSERVED UNDERTOWS (aperture avoidance — never surface):\n${undertowsContext}\n` : ''}
${fairWindsContext ? `OBSERVED FAIR WINDS (priority aperture — open toward what these touch, not the activity):\n${fairWindsContext}\n` : ''}
${observationsContext ? `MIRROR OBSERVATIONS (signal only — engine_detected and haiku_scan for aperture, highlight rows for register):\n${observationsContext}\n` : ''}
${reflectionPreferencesContext ? `REFLECTION PREFERENCES (HOW to write only — never determines WHAT to open toward):\n${reflectionPreferencesContext}\n` : ''}
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