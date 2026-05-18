const { createClient } = require('@supabase/supabase-js');
const { PREAMBLE, VOICE } = require('./constants');

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

    // ─── Pull all context in parallel ───
    /*
        Nine simultaneous reads. All context assembled
        before the system prompt is built. No sequential
        waits. The reflection call fires immediately
        after context is ready.
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
        observationsRes,
        summaryRes
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

        // Observed undertows — drift detection only
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
        // Synthesis and Haiku scan rows — diverse behavioral
        // data across many sessions
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content, created_at')
            .eq('category', 'Engine Observations')
            .eq('source', 'engine_detected')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(15),

        // Guest highlight observations — limited to 5 rows
        // What landed and what shifted — informs but never
        // dominates the reflection
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content, created_at')
            .eq('category', 'Engine Observations')
            .eq('source', 'guest_highlight')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(5),

        // Reflection preferences — register calibration only
        // HOW Mirror speaks to this guest, never WHAT it opens
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

        // Engine observations — haiku scan rows
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content, created_at')
            .eq('category', 'Engine Observations')
            .eq('source', 'haiku_entry_scan')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(10),

        // Most recent summary
        supabaseClient
            .from('summaries')
            .select('summary, summary_type')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1)
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

    // Merge engine observations — three sources, weighted
    // engine_detected (15) + haiku_entry_scan (10) +
    // guest_highlight (5) = balanced picture
    // Highlights inform. They never set the agenda.
    const allObservations = [
        ...(engineDetectedRes.data || []),
        ...(observationsRes.data || []),
        ...(highlightObsRes.data || [])
    ];
    const observationsContext = allObservations.length > 0
        ? allObservations.map(o => `${o.name}: ${o.content}`).join('\n')
        : '';

    // Reflection preferences — register and depth calibration
    // What has landed tells Mirror HOW to speak
    // It never tells Mirror WHAT to speak about
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

    const historyContext = recentEntries?.length > 0
        ? recentEntries
            .map((e, i) => `Entry ${i + 1}:\n${e.entry}\n${e.reflection ? `Reflection: ${e.reflection}` : ''}`)
            .join('\n\n')
        : '';

    // ─── Build the category map for Haiku ───
    const categoryMap = `
DEMOGRAPHIC: age, location, nationality, languages spoken, living situation
SITUATIONAL: current life chapter, recent major changes, living environment
FORMATIVE EXPERIENCES: childhood, education, pivotal moments, defining experiences
UNFINISHED STORIES: unresolved situations, ongoing challenges, open chapters
CHARACTER AND IDENTITY: how the guest sees themselves, identity markers, self-description
INNER LANDSCAPE: emotional patterns, internal experience, psychological tendencies
BODY AND ENERGY: physical health, energy levels, sleep, exercise, physical sensations
SIGNIFICANT RELATIONSHIPS: family, partners, friendships — names and dynamics
SOCIAL CONNECTION: community, belonging, social patterns, isolation or connection
INTERESTS AND PASSIONS: hobbies, creative pursuits, what energizes them
WORK: occupation, professional identity, work satisfaction, career
PURPOSE: sense of meaning, what the guest feels called to do
ASPIRATIONS: future vision, goals, dreams, what they are moving toward
CURRENT CHAPTER: what is happening right now, the dominant theme of this period
STATED VALUES: what the guest says matters to them
OBSERVED VALUES: values detected operating in behavior even when not named
ENGINE OBSERVATIONS: behavioral patterns, drift, signals detected across sessions
`;

    const systemPrompt = `${PREAMBLE}

${VOICE}

═══════════════════════════════════════════════════
MIRROR · PROMPT 2 · REFLECTION GENERATION
═══════════════════════════════════════════════════

VOICE AND CHARACTER — READ THIS FIRST

Everything below is operational instruction.
The PREAMBLE and VOICE above are who Mirror is.
They are not context. They are not background.
They are the elder speaking.

The data that follows — profile observations,
highlight patterns, Reflection Preferences,
engine detections — informs what Mirror sees.
It never changes how Mirror speaks or who
Mirror is.

Reflection Preferences tell Mirror what register
has produced recognition for this guest. Mirror
uses this to calibrate depth and tone. It does
not use it to change character. The elder remains
the elder regardless of what the data shows.

Engine Observations — including rows derived
from guest highlights — tell Mirror what is
shifting in this guest. Mirror uses this to
understand the guest's current trajectory.
It does not use it to generate a reflection
that simply mirrors those observations back.
The reflection finds what is beneath the surface.
It does not report what the engine already named.

Mirror's voice is always:
— Plain words. Short sentences.
— Second person throughout.
— No first person ever.
— No clinical language.
— No wellness language.
— No AI language.
— No affirmation or celebration.
— No advice.
— The elder spoke. That is all.

───────────────────────────────────────────────────
WHAT YOU ARE GENERATING
───────────────────────────────────────────────────

One reflection. Two movements. Maximum 180 words.

MOVEMENT ONE — DISCOVERY
What is beneath the surface of what the guest
wrote. Not transcription. Not paraphrase.
Not a summary of what the engine already detected.
What was actually there that the guest couldn't
see from inside it.

MOVEMENT TWO — CONVICTION
The landing. One quiet, certain, true statement
derived from everything discovery surfaced.
The gymnast sticking it. The guest reads it
and thinks: that is true. That is actually
true. And it is mine.

───────────────────────────────────────────────────
CONTEXT ASSEMBLY — READ IN THIS ORDER
───────────────────────────────────────────────────

1. THE CURRENT ENTRY
   Primary. Read it twice. Once for content.
   Once for register. Everything else is context
   for this entry — not the subject of the
   reflection instead of this entry.

2. MIRROR OBSERVATIONS
   What the engine has detected across sessions.
   Use this to understand what this entry means
   in the context of the guest's trajectory.
   Do not reproduce these observations in the
   reflection. Find what is beneath them.

3. GUEST HIGHLIGHTS (in Engine Observations)
   What has landed for this guest in previous
   sessions. Use this to understand what produces
   recognition — not to repeat those themes.
   The reflection finds new ground, informed
   by what has already landed.

4. REFLECTION PREFERENCES
   How this guest receives Mirror's output.
   Calibrates register and depth.
   Never changes what Mirror surfaces.
   Never directs what territory Mirror opens.
   The data tells Mirror how to speak.
   Mirror's character tells Mirror who to be.

5. HUMAN VALUES PROFILE
   Where did the guest's values show up in
   this entry — even incidentally, even without
   being named? Surface the behavior. Let the
   guest name the value.

6. LAST FIVE ENTRIES + REFLECTIONS
   Does today continue a thread, break a
   pattern, or return to something earlier?

7. UNDERTOW AND GOOD WOLF HISTORY
   Which distortions have appeared before?
   Which good wolf moments have been flagged?
   Does today show the same or something new?

───────────────────────────────────────────────────
PRE-WRITING ANALYSIS — DO THIS BEFORE WRITING
───────────────────────────────────────────────────

READ FOR CONTENT — three layers:

LAYER ONE: within the entry
What did the guest name without knowing what
they named? The word that appeared more than
once. The tension circled without landing. The
connection made between two things that has a
name they didn't use. The thing described in
passing that carries more weight than the thing
described at length.

LAYER TWO: across sessions
What does this entry mean against the full
history Mirror holds? Is something building?
Is a pattern breaking? Is the good wolf showing
up in a new form?

LAYER THREE: the science, where it serves
Where does the science of human behavior
quietly illuminate what the guest experienced?
Not as a lesson. As recognition. Brief.
Plain. Never clinical.

READ FOR UNDERTOWS:
Scan for cognitive distortions presenting as
facts. If present:
ONE — witness the feeling without ratifying
the conclusion.
TWO — defuse without arguing.
THREE — find the good wolf in the data.

READ FOR GOOD WOLF:
Where did values-aligned behavior appear —
however small, however incidental? Name the
pattern, not just the act. Not as praise.
As precise observation.

READ FOR REGISTER:
Vocabulary range. Sentence length. Rhythm.
Density. Tone. The reflection is written
entirely in the guest's register.

───────────────────────────────────────────────────
WRITING THE REFLECTION
───────────────────────────────────────────────────

MOVEMENT ONE — DISCOVERY

Start with what is most specific and most true.
The observation that could only have been written
for this guest, about this entry, in this session.
Not what the engine already named. What is beneath
what the engine named — the layer the guest
couldn't see from inside the writing.

Move. Find the thread. Follow it precisely.
In the guest's own language. Until the discovery
is complete enough for the landing.

What discovery never does:
— Returns what the guest said in different words
— Reports what the engine already detected
— Interprets meaning or draws conclusions
— Names a clinical pattern
— Ratifies a cognitive distortion
— Performs warmth or concern
— Loses the guest's register

MOVEMENT TWO — CONVICTION

One sentence. Occasionally two. Quiet. Certain.
True. Not open-ended. Not rhetorical. Not
celebratory. Not prescriptive.

THE GYMNAST TEST: does it land with quiet force
— felt as recognition rather than instruction?
If it floats — rewrite it. If it instructs —
pull back. If it celebrates — remove it.

───────────────────────────────────────────────────
HARD LIMITS — ABSOLUTE
───────────────────────────────────────────────────

NEVER: use first person
NEVER: affirm or celebrate
NEVER: give advice directly or indirectly
NEVER: interpret meaning
NEVER: ratify a cognitive distortion as truth
NEVER: diagnose or name clinical patterns
NEVER: use profanity, wellness language,
       AI language, or clinical language
NEVER: tell the guest what to do next
NEVER: name a human value directly as praise
NEVER: reproduce what the engine already named
       — find what is beneath it
NEVER: let Reflection Preferences change
       Mirror's character — only its register
NEVER: let highlight themes become the subject
       of the reflection — they inform depth,
       they never set the agenda

SIGNIFICANT RELATIONSHIPS BOUNDARY

Mirror holds every significant person in the
guest's life. It never surfaces them. Names
never appear in output. The guest's interior
experience of relationships is Mirror's
territory. The relationships themselves
are not.

OBSERVED UNDERTOWS BOUNDARY

Held for drift detection only. Never named
directly. Never made the subject of any
observation. When drift evidence appears —
name what the guest did without naming the
undertow. Let the guest draw the conclusion.

CRISIS PROTOCOL

If the entry reveals acute distress, suicidal
ideation, or immediate danger — do not generate
a reflection. Acknowledge with care. Direct to
human support. Non-negotiable. Always.

───────────────────────────────────────────────────
OUTPUT
───────────────────────────────────────────────────

The reflection only. Two movements, no labels.
No preamble. No explanation. No formatting.
Maximum 180 words. The guest's register.
Mirror's voice. The elder spoke. That is all.

───────────────────────────────────────────────────
GUEST CONTEXT
───────────────────────────────────────────────────

${personaContext ? `PERSONA AND PROFILE:\n${personaContext}\n` : ''}
${sensitiveRelationshipsContext ? `SIGNIFICANT RELATIONSHIPS (held for tonal awareness — never surface names or dynamics in output):\n${sensitiveRelationshipsContext}\n` : ''}
${undertowsContext ? `OBSERVED UNDERTOWS (sensitive — drift detection only — never surface directly):\n${undertowsContext}\n` : ''}
${fairWindsContext ? `OBSERVED FAIR WINDS (sources of confirmed aliveness — open toward what these touch):\n${fairWindsContext}\n` : ''}
${observationsContext ? `MIRROR OBSERVATIONS (engine_detected and haiku_entry_scan rows weighted — guest_highlight rows inform register, not agenda):\n${observationsContext}\n` : ''}
${reflectionPreferencesContext ? `REFLECTION PREFERENCES (register and depth calibration only — how Mirror speaks to this guest — never overrides Mirror's character or voice):\n${reflectionPreferencesContext}\n` : ''}
${humanValuesContext ? `HUMAN VALUES:\n${humanValuesContext}\n` : ''}
${summaryContext ? `MOST RECENT SUMMARY:\n${summaryContext}\n` : ''}
${historyContext ? `LAST FIVE ENTRIES AND REFLECTIONS:\n${historyContext}` : ''}`;

    try {
        const [reflectionResponse, haikuResponse] = await Promise.all([

            // ─── Sonnet — reflection generation ───
            fetch('https://api.anthropic.com/v1/messages', {
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
                    messages: [{
                        role: 'user',
                        content: `Here is the writing prompt that opened this session:\n\n${promptUsed || 'No prompt used'}\n\nHere is the guest's journal entry:\n\n${entry}`
                    }]
                })
            }),

            // ─── Haiku — profile scan ───
            /*
                Three jobs per session:
                1. Profile population — extract new
                   biographical data from the entry
                2. Gap audit — classify unmapped
                   categories for prompt aperture
                3. Behavioral signals — fair winds,
                   undertow language, drift evidence
                Runs in parallel. Zero added latency.
                Failure never affects the reflection.
            */
            fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': process.env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 2048,
                    messages: [{
                        role: 'user',
                        content: `You are the profile engine for Mirror, a private journaling tool. A guest has just submitted a journal entry. Your job is to scan it for three things and return structured JSON.

JOURNAL ENTRY:
${entry}

CURRENT PROFILE STATE (what Mirror already knows):
${personaContext ? personaContext.substring(0, 800) : 'Profile is empty — this is an early session'}

PROFILE CATEGORIES:
${categoryMap}

KNOWN FAIR WINDS:
${fairWindsContext || 'None established yet'}

KNOWN UNDERTOWS (sensitive — internal only):
${undertowsContext || 'None established yet'}

YOUR THREE JOBS:

JOB 1 — PROFILE POPULATION
Extract any new factual or contextual information from the entry that belongs in a profile category. Only extract what is genuinely present — do not infer or assume. If nothing new is present, return an empty array.

JOB 2 — GAP AUDIT
Review the current profile state. Identify which categories are empty or sparse. Classify each gap:
- category_1: genuinely unmapped, low risk, could be gently explored
- category_2: conspicuously absent after many sessions, possibly protective, never use as aperture
- category_3: disclosed once, not returned to, receive only, never initiate

JOB 3 — BEHAVIORAL SIGNALS
Scan the entry for:
- Fair wind signals: topics producing energy, longer sentences, specificity, positive feeling clusters
- Undertow language: cognitive distortions presenting as facts
- Drift evidence: actions or thoughts that contradict a known undertow or confirm a known fair wind

Return ONLY a JSON object. No preamble. No markdown. No backticks.

{
  "profile_updates": [
    {
      "category": "exact category name from the list above",
      "name": "brief descriptive label for this data point",
      "content": "the extracted information — specific, grounded in exact language from the entry",
      "is_new": true
    }
  ],
  "gap_audit": [
    {
      "category": "category name",
      "gap_type": "category_1 or category_2 or category_3",
      "approach": "light_oblique_curiosity or never_use_as_aperture or receive_only"
    }
  ],
  "behavioral_signals": [
    {
      "signal_type": "fair_wind_signal or undertow_language or drift_evidence",
      "name": "brief label",
      "content": "what was detected — specific language from the entry",
      "confidence": "low or medium"
    }
  ]
}`
                    }]
                })
            })
        ]);

        // ─── Process reflection ───
        const reflectionData = await reflectionResponse.json();
        const reflection = reflectionData.content[0].text.trim().replace(/^[<>\s]+/, '');

        // ─── Process Haiku scan ───
        /*
            Parse and write immediately. Three write types.
            All tagged with claude_model and source so the
            profile report shows exactly what built each row.
            Failure is caught silently — guest always gets
            their reflection regardless of Haiku outcome.
        */
        let gapFlags = [];

        try {
            const haikuData = await haikuResponse.json();
            const haikuRaw = haikuData.content[0].text.trim();
            const haikuCleaned = haikuRaw.replace(/```json|```/g, '').trim();
            const haikuAnalysis = JSON.parse(haikuCleaned);

            // Write profile updates
            if (haikuAnalysis.profile_updates?.length > 0) {
                const profileInserts = haikuAnalysis.profile_updates.map(update => ({
                    category: update.category,
                    name: `haiku_scan_profile_${update.name?.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`,
                    content: update.content,
                    source: 'haiku_entry_scan',
                    status: 'active',
                    confidence: 'medium',
                    claude_model: 'claude-haiku-4-5-20251001',
                    is_sensitive: update.category === 'Significant Relationships'
                }));

                await supabaseClient
                    .from('guest_profile_v2')
                    .insert(profileInserts);

                console.log(`Haiku profile scan — wrote ${profileInserts.length} profile updates`);
            }

            // Store gap flags for prompt aperture selection
            if (haikuAnalysis.gap_audit?.length > 0) {
                gapFlags = haikuAnalysis.gap_audit;
                console.log(`Haiku gap audit — ${gapFlags.length} gaps classified`);
            }

            // Write behavioral signals
            if (haikuAnalysis.behavioral_signals?.length > 0) {
                const signalInserts = haikuAnalysis.behavioral_signals.map(signal => ({
                    category: 'Engine Observations',
                    name: `haiku_scan_${signal.signal_type}_${signal.name?.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`,
                    content: signal.content,
                    source: 'haiku_entry_scan',
                    status: 'active',
                    confidence: signal.confidence || 'medium',
                    claude_model: 'claude-haiku-4-5-20251001',
                    is_sensitive: signal.signal_type === 'undertow_language'
                }));

                await supabaseClient
                    .from('guest_profile_v2')
                    .insert(signalInserts);

                console.log(`Haiku behavioral scan — wrote ${signalInserts.length} signals`);
            }

        } catch (haikuError) {
            console.error('Haiku scan error:', haikuError.message);
        }

        // ─── Save entry and reflection ───
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

        // ─── Trigger synthesis every 10 entries ───
        if (totalEntryCount && totalEntryCount > 0 && (totalEntryCount + 1) % 10 === 0) {
            await runSynthesis(supabaseClient, recentEntries, personaContext, userId);
        }

        // ─── Trigger Opus portrait every 20 entries ───
        /*
            Fire and forget. Guest never waits for this.
            Opus reads the complete profile, all highlights,
            all summaries, and writes a Guest Portrait row
            to guest_profile_v2. The deepest understanding
            Mirror produces of a single guest.
            synthesize-portrait.js built next session.
        */
        if (totalEntryCount && totalEntryCount > 0 && (totalEntryCount + 1) % 20 === 0) {
            fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/synthesize-portrait`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            }).catch(err => console.error('Portrait synthesis trigger error:', err.message));
        }

        // ─── Trigger weekly summary if 7 days elapsed ───
        await checkAndGenerateWeeklySummary(supabaseClient, userId);

        return res.status(200).json({ reflection, sessionRowId, gapFlags });

    } catch (error) {
        return res.status(500).json({ error: 'API call failed: ' + error.message });
    }
}

async function runSynthesis(supabaseClient, recentEntries, personaContext, userId) {
    if (!userId) return;

    const [
        synthesisEntriesRes,
        moodsRes,
        feelingsRes,
        deltaRes,
        inspirationsRes,
        fieldNotesRes,
        statedValuesRes
    ] = await Promise.all([

        supabaseClient
            .from('entries')
            .select('entry, reflection, created_at')
            .eq('user_id', userId)
            .not('entry', 'is', null)
            .order('created_at', { ascending: false })
            .limit(10),

        supabaseClient
            .from('mood')
            .select('score, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(20),

        supabaseClient
            .from('feelings')
            .select('feeling, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50),

        supabaseClient
            .from('entries')
            .select('mood_post, created_at')
            .eq('user_id', userId)
            .not('mood_post', 'is', null)
            .order('created_at', { ascending: false })
            .limit(10),

        supabaseClient
            .from('inspirations')
            .select('content, category, feeling_evoked, location, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(20),

        supabaseClient
            .from('field_notes')
            .select('content, theme, location, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(10),

        supabaseClient
            .from('guest_profile_v2')
            .select('name')
            .eq('category', 'Stated Values')
            .eq('status', 'active')
    ]);

    if (!synthesisEntriesRes.data?.length) return;

    const entriesText = synthesisEntriesRes.data
        .map((e, i) => `Entry ${i + 1}:\n${e.entry}`)
        .join('\n\n');

    let moodContext = '';
    if (moodsRes.data?.length > 0) {
        const avgMood = (moodsRes.data.reduce((sum, m) => sum + m.score, 0) / moodsRes.data.length).toFixed(1);
        moodContext = `Mood scores (most recent first): ${moodsRes.data.map(m => m.score).join(', ')}\nAverage: ${avgMood}/10`;
    }

    const deltaContext = deltaRes.data?.length > 0
        ? `Post-reflection mood scores: ${deltaRes.data.map(e => e.mood_post).join(', ')}`
        : '';

    let feelingsContext = '';
    if (feelingsRes.data?.length > 0) {
        const feelingCounts = {};
        feelingsRes.data.forEach(f => {
            feelingCounts[f.feeling] = (feelingCounts[f.feeling] || 0) + 1;
        });
        feelingsContext = `Feelings frequency: ${Object.entries(feelingCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([feeling, count]) => `${feeling} (${count})`)
            .join(', ')}`;
    }

    let inspirationsContext = '';
    if (inspirationsRes.data?.length > 0) {
        const categoryCount = {};
        inspirationsRes.data.forEach(i => {
            if (i.category) categoryCount[i.category] = (categoryCount[i.category] || 0) + 1;
        });
        inspirationsContext = `Inspiration categories: ${Object.entries(categoryCount)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, count]) => `${cat} (${count})`)
            .join(', ')}`;
        const feelings = inspirationsRes.data.filter(i => i.feeling_evoked).map(i => i.feeling_evoked).join(', ');
        if (feelings) inspirationsContext += `\nFeelings evoked: ${feelings}`;
    }

    const fieldNotesContext = fieldNotesRes.data?.length > 0
        ? `Field note themes: ${fieldNotesRes.data.filter(n => n.theme).map(n => n.theme).join(', ') || 'none extracted yet'}`
        : '';

    const valuesContext = statedValuesRes.data?.length > 0
        ? statedValuesRes.data.map(v => v.name).join(', ')
        : '';

    const synthesisPrompt = `You are analyzing a private journal to extract evolving patterns and detect significant changes. You will produce two outputs.

OUTPUT 1 — SUMMARY:
Write a single compressed paragraph (150 words maximum) capturing:
- Recurring themes and their frequency
- Tone and emotional register across this period
- Language drift — what words or framings are increasing or decreasing
- Aspiration language — concrete and active versus conditional and distant
- Overall trajectory — forward, static, or regressing
- Mood trends if data is present
- Feeling patterns if data is present
- Human values operating in the writing

OUTPUT 2 — DETECTED CHANGES:
List significant changes, each on its own line:
TYPE|FIELD|DETECTED_CONTENT|CONFIDENCE
Where TYPE is EVENT, DRIFT, or HUMAN_VALUE
Where CONFIDENCE is high, medium, or low

For HUMAN_VALUE:
HUMAN_VALUE|value_name|evidence|confidence

PERSONA BASELINE:
${personaContext}

${valuesContext ? `KNOWN STATED VALUES:\n${valuesContext}\n` : ''}
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
                messages: [{ role: 'user', content: synthesisPrompt }]
            })
        });

        const synthesisData = await synthesisResponse.json();
        const synthesisText = synthesisData.content[0].text;

        const parts = synthesisText.split('OUTPUT 2');
        const summaryText = parts[0]
            .replace('OUTPUT 1 — SUMMARY:', '')
            .replace('# OUTPUT 1 — SUMMARY', '')
            .replace(/#{1,6}\s/g, '')
            .replace(/\*\*/g, '')
            .replace(/\*/g, '')
            .trim();
        const changesText = parts[1]
            ? parts[1].replace('— DETECTED CHANGES:', '').trim()
            : '';

        await supabaseClient
            .from('summaries')
            .insert([{
                summary: summaryText,
                entry_count: recentEntries ? recentEntries.length : 0,
                user_id: userId
            }]);

        if (changesText) {
            const changeLines = changesText.split('\n').filter(line => line.includes('|'));
            for (const line of changeLines) {
                const [type, field, detectedContent, confidence] = line.split('|');
                if (!type || !field || !detectedContent) continue;

                if (type.trim() === 'HUMAN_VALUE') {
                    const { data: existingValue } = await supabaseClient
                        .from('guest_profile_v2')
                        .select('id')
                        .eq('category', 'Observed Values')
                        .eq('name', field.trim())
                        .single();

                    if (!existingValue) {
                        await supabaseClient
                            .from('guest_profile_v2')
                            .insert([{
                                category: 'Observed Values',
                                name: field.trim(),
                                content: detectedContent.trim(),
                                source: 'engine_detected',
                                status: 'active',
                                claude_model: 'claude-haiku-4-5-20251001'
                            }]);
                    }
                    continue;
                }

                await supabaseClient
                    .from('guest_profile_v2')
                    .insert([{
                        category: 'Engine Observations',
                        name: field.trim(),
                        content: detectedContent.trim(),
                        source: 'engine_detected',
                        status: 'active',
                        confidence: confidence ? confidence.trim() : 'medium',
                        claude_model: 'claude-haiku-4-5-20251001'
                    }]);
            }
        }

    } catch (error) {
        console.error('Synthesis error:', error);
    }
}

async function checkAndGenerateWeeklySummary(supabaseClient, userId) {
    try {
        const { data: lastWeekly } = await supabaseClient
            .from('summaries')
            .select('created_at')
            .eq('user_id', userId)
            .eq('summary_type', 'weekly')
            .order('created_at', { ascending: false })
            .limit(1);

        const now = new Date();
        const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

        if (!lastWeekly || lastWeekly.length === 0 || new Date(lastWeekly[0].created_at) < sevenDaysAgo) {
            await fetch(
                `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/summary`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId,
                        periodStart: sevenDaysAgo.toISOString(),
                        periodEnd: now.toISOString(),
                        summaryType: 'weekly'
                    })
                }
            );
        }
    } catch (error) {
        console.error('Weekly summary check error:', error);
    }
}