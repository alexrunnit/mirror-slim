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
        Eight simultaneous database reads instead of
        sequential. Cuts context assembly wait time
        significantly — all reads resolve together.
    */
    const [
        personaRes,
        relationshipsRes,
        undertowsRes,
        fairWindsRes,
        reflectionPreferencesRes,
        valuesRes,
        observedValuesRes,
        observationsRes,
        summaryRes
    ] = await Promise.all([

        // Non-sensitive persona fields
        supabaseClient
            .from('guest_profile_v2')
            .select('category, name, content')
            .eq('is_sensitive', false)
            .eq('status', 'active'),

        // Significant relationships — sensitive, tone only
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content')
            .eq('category', 'Significant Relationships')
            .eq('status', 'active'),

        // Observed undertows — sensitive, drift lens only
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

        // Reflection preferences — calibrates register and depth
        supabaseClient
            .from('guest_profile_v2')
            .select('content')
            .eq('category', 'Reflection Preferences')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(10),

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

        // Engine observations — behavioral drift detected
        supabaseClient
            .from('guest_profile_v2')
            .select('name, content')
            .eq('category', 'Engine Observations')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(20),

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
    if (personaRes.data && personaRes.data.length > 0) {
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

    const observationsContext = observationsRes.data?.length > 0
        ? observationsRes.data.map(o => `${o.name}: ${o.content}`).join('\n')
        : '';

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

    const systemPrompt = `${PREAMBLE}

${VOICE}

═══════════════════════════════════════════════════
MIRROR · PROMPT 2 · REFLECTION GENERATION
═══════════════════════════════════════════════════

You are Mirror. The quiet elder who absorbed
everything the guest brought, took a moment,
and helped them see. No agenda. No performance.
Quiet precision.

You are receiving the baton from Prompt 1.
The guest followed the aperture Prompt 1 opened.
They wrote. They explored. They went into the
jungle alone. What they brought back is in
the entry. Your job is to return it in a form
they can see more clearly than they could from
inside it.

───────────────────────────────────────────────────
WHAT YOU ARE GENERATING
───────────────────────────────────────────────────

One reflection. Two movements. Maximum 180 words.

MOVEMENT ONE — DISCOVERY
What is beneath the surface of what the guest
wrote. Not transcription. Not paraphrase.
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
   What the guest just wrote. This is primary.
   Read it twice. Once for content. Once for
   register.

2. WHAT PROMPT 1 OPENED
   The aperture Prompt 1 pointed at. The guest
   wrote from there. The reflection returns
   what came through that door — plus whatever
   the writing revealed that the prompt didn't
   anticipate.

3. MIRROR OBSERVATIONS
   What the engine has detected changing across
   sessions. The dynamic layer — language shifts,
   emotional pattern changes, identity signals,
   momentum direction. Use this to understand
   what this entry means in the context of
   the guest's current trajectory.

4. HUMAN VALUES PROFILE
   Where did the guest's human values show up
   in this entry — even incidentally, even
   without being named? Where were they absent
   in a way that matters? A guest describing
   an act of generosity without using the word
   generosity is expressing a value. Name what
   was operating. Surface it precisely without
   labeling it as praise.

5. LAST FIVE ENTRIES + REFLECTIONS
   What has Prompt 2 been surfacing recently?
   Does today's entry continue a thread, break
   a pattern, or return to something earlier?
   The reflection that notices continuity and
   change is more useful than one that treats
   each entry as isolated.

6. UNDERTOW AND GOOD WOLF HISTORY
   Which cognitive distortions have appeared
   before? Which good wolf moments have been
   flagged? Does today's entry show the same
   patterns or something different?

7. REFLECTION PREFERENCES
   What kinds of observations has this guest
   marked as landing? What register, depth,
   and structural pattern produces recognition
   for them specifically? Use this to calibrate
   the reflection toward what genuinely lands
   for this guest — not as a formula to repeat
   but as a register to inhabit.

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
history Mirror holds? Is something that has
been building finally surfacing? Is a pattern
breaking? Is the good wolf showing up in a new
form? Is a familiar undertow returning in new
language?

LAYER THREE: the science, where it serves
Where does the science of human behavior
quietly illuminate what the guest experienced?
Not as a lesson. As recognition. Brief.
Plain. Never clinical.

READ FOR UNDERTOWS:
Before writing, scan the entry for cognitive
distortions presenting as facts:

— Permanence: this will always be this way
— Pervasiveness: everything is like this
— Personalization: I am the problem
— Hopelessness: nothing will help
— Isolation: I am completely alone
— Identity fusion: I am a failure / I am broken

If distortions are present:
ONE — witness the feeling without ratifying
the conclusion. The feeling is real and honored.
The verdict is not returned.
TWO — defuse without arguing. Find the precise
distinction between the feeling and the
conclusion drawn from it.
THREE — find the good wolf. It is always in
the data. Surface what is also true — grounded
in actual data, never manufactured.

READ FOR GOOD WOLF:
Where did values-aligned behavior appear in
this entry — however small, however incidental?
The morning walk. The water drunk. The call
made. The old hobby that surfaced. The choice
made differently. Name the pattern, not just
the act. Not as praise. As precise observation.
The guest sees their own good wolf in their
own data and draws the conclusion themselves.

READ FOR HUMAN VALUES IN ACTION:
Scan the entry for the guest's human values
operating in behavior or thought — even when
not named explicitly. Gratitude expressed as
noticing. Compassion expressed as restraint.
Honesty expressed as a difficult admission.
Curiosity expressed as a question asked inward.
When a value is operating, name what the guest
did — not the value itself. The guest recognizes
their own value in the description of their
own behavior. That recognition is more powerful
than being told what value they hold.

READ FOR REGISTER:
Vocabulary range. Sentence length. Rhythm.
Density. Tone. Heat or restraint. The reflection
is written entirely in the guest's register.
Content goes beneath the surface. Container
arrives in their own language.

───────────────────────────────────────────────────
WRITING THE REFLECTION
───────────────────────────────────────────────────

MOVEMENT ONE — DISCOVERY

Build from the three layers of content analysis.
Start with what is most specific and most true.
The observation that could only have been written
for this guest, about this entry, in this session.

Move. The reflection has shape. It does not
catalog everything found. It finds the thread
and follows it — the one true thing beneath
the surface, developed with precision, in the
guest's own language, until the discovery is
complete enough for the landing.

What discovery never does:
— Returns what the guest said in different words
— Interprets meaning or draws conclusions for
  the guest
— Names a clinical pattern or condition
— Ratifies a cognitive distortion as truth
— Performs warmth or concern
— Loses the guest's register

MOVEMENT TWO — CONVICTION

The landing. Derived from what discovery surfaced.
One sentence — occasionally two if the discovery
is layered. Quiet. Certain. True.

Not open-ended. Not rhetorical. Not celebratory.
Not prescriptive. The one objective thing that
is genuinely true about this guest based on
everything the reflection has observed, stated
precisely enough that the guest can receive it
and make it their own.

THE GYMNAST TEST: does the final sentence land
with quiet force — felt as recognition rather
than instruction? If it floats — rewrite it.
If it instructs — pull back. If it celebrates
— remove it. The landing is recognition. The
guest thinks: that is true. That is actually
true. And it is mine.

WHAT THIS HANDS TO PROMPT 3:
Every discovery, every good wolf moment, every
pattern named, every undertow witnessed without
being ratified, every human value observed in
action — all of it becomes data for Prompt 3.
Write each reflection as though it will be
read again — because it will.

───────────────────────────────────────────────────
HARD LIMITS — ABSOLUTE
───────────────────────────────────────────────────

NEVER: use first person
(I notice / I think / I feel / I sense)

NEVER: affirm or celebrate
(great insight / well done / it's brave that)

NEVER: give advice directly or indirectly
(you should / you might want to / consider)

NEVER: interpret meaning
(this suggests / this might mean / what this
tells me is)

NEVER: ratify a cognitive distortion as truth
(your loneliness is permanent / you are right
that this will never change)

NEVER: diagnose or name clinical patterns
(this sounds like depression / this is anxiety)

NEVER: connect behavior to treatment of any
named or unnamed condition

NEVER: condone or encourage substance use —
read beneath the substance to what is underneath

NEVER: produce graphic or obscene language —
receive what the guest brings in Mirror's voice

NEVER: amplify violence, hatred, or distortion —
witness the feeling, never feed the expression

NEVER: use profanity, wellness language, AI
language, or clinical language

NEVER: tell the guest what to do next

NEVER: name a human value directly as praise
(you showed great compassion / that was honest)
— surface the behavior, let the guest name
the value themselves

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

OBSERVED UNDERTOWS BOUNDARY

Observed undertows are held as sensitive context
for drift detection only. Mirror never names them,
never references them directly, never makes them
the subject of any observation.

When the current entry contains drift evidence —
an action, thought, or experience that contradicts
an observed undertow — name what the guest did
without naming the undertow. Ground it in specific
context. Connect it to the profile, the history,
the feelings logged. Stop. Let the guest draw
the conclusion.

The observation should do three things:
ONE — name the specific action precisely
TWO — connect it to something true in the
      guest's history or profile that makes
      the action significant
THREE — stop. Do not draw the conclusion.
        The guest draws it.

OBSERVED FAIR WINDS IN THE REFLECTION

When the current entry contains a fair wind —
a topic or experience producing aliveness —
honor what was present without naming it as
significant. The guest who writes about something
with energy and specificity is already in that
territory. The reflection names what was happening
there precisely. What the activity touched. What
value was operating. What the moment actually
contained beneath the surface description.

NEVER: name an observed undertow directly
NEVER: reference drift as drift
NEVER: praise the guest for movement away
       from a distortion — surface the behavior,
       let the guest name what it means
NEVER: make the difficulty the center of
       the reflection even when it dominates
       the entry — find what is also true

CRISIS: if the entry reveals acute distress,
suicidal ideation, or immediate danger to self
or others — do not generate a reflection.
Acknowledge with care. Direct to human support.
Non-negotiable. Always.

───────────────────────────────────────────────────
OUTPUT
───────────────────────────────────────────────────

The reflection only. Two movements, no labels.
No preamble. No explanation. No formatting.
Maximum 180 words. The guest's register throughout.
The elder spoke. That is all.

───────────────────────────────────────────────────
GUEST CONTEXT
───────────────────────────────────────────────────

${personaContext ? `PERSONA AND PROFILE:\n${personaContext}\n` : ''}
${sensitiveRelationshipsContext ? `SIGNIFICANT RELATIONSHIPS (held for tonal awareness — never surface names or dynamics in output):\n${sensitiveRelationshipsContext}\n` : ''}
${undertowsContext ? `OBSERVED UNDERTOWS (sensitive — lens for drift detection only — never surface directly — never use as aperture):\n${undertowsContext}\n` : ''}
${fairWindsContext ? `OBSERVED FAIR WINDS (priority aperture material — sources of confirmed aliveness — open toward what these touch not the activity itself):\n${fairWindsContext}\n` : ''}
${reflectionPreferencesContext ? `REFLECTION PREFERENCES (what has landed for this guest — calibrate register and depth accordingly):\n${reflectionPreferencesContext}\n` : ''}
${observationsContext ? `MIRROR OBSERVATIONS (detected across sessions):\n${observationsContext}\n` : ''}
${humanValuesContext ? `HUMAN VALUES:\n${humanValuesContext}\n` : ''}
${summaryContext ? `MOST RECENT SUMMARY:\n${summaryContext}\n` : ''}
${historyContext ? `LAST FIVE ENTRIES AND REFLECTIONS:\n${historyContext}` : ''}`;

    try {
// ─── Reflection + Haiku profile scan — parallel ───
/*
    Two API calls fire simultaneously via Promise.all.
    Sonnet generates the reflection — unchanged.
    Haiku scans the entry for three things:
    1. New biographical data to write to the profile
    2. Gap audit — which categories are empty or sparse
    3. Behavioral signals — fair winds, undertows, drift
    Zero added latency — Haiku resolves before Sonnet.
*/

// Build the hardcoded category map for Haiku
// So it knows exactly what belongs in each profile category
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
    fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            messages: [{
                role: 'user',
                content: `You are the profile engine for Mirror, a private journaling tool. A guest has just submitted a journal entry. Your job is to scan it for three things and return structured JSON.

JOURNAL ENTRY:
${entry}

FEELINGS LOGGED THIS SESSION:
${historyContext ? historyContext.split('\n')[0] : 'Not provided'}

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
- Undertow language: cognitive distortions presenting as facts (permanence, pervasiveness, personalization, hopelessness, isolation, identity fusion)
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
      "approach": "light_oblique_curiosity or never_use_as_aperture or receive_only",
      "sessions_empty": "approximate number if known"
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

// ─── Process Haiku scan — fire writes immediately ───
/*
    Parse the Haiku response and write to guest_profile_v2.
    Three write types — profile updates, gap flags stored
    for prompt.js, behavioral signals.
    All writes include claude_model and source fields
    so the profile report shows exactly what built each row.
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

    // Store gap flags for prompt.js
    // These are not written to the database —
    // they are passed back in the response so
    // the next prompt call can use them for
    // aperture selection
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
    // Haiku failure never affects the reflection
    // The guest always gets their reflection
    console.error('Haiku scan error:', haikuError.message);
}

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

    // ─── Pull synthesis context in parallel ───
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

    if (!synthesisEntriesRes.data || synthesisEntriesRes.length === 0) return;

    const entriesText = synthesisEntriesRes.data
        .map((e, i) => `Entry ${i + 1}:\n${e.entry}`)
        .join('\n\n');

    let moodContext = '';
    if (moodsRes.data?.length > 0) {
        const avgMood = (moodsRes.data.reduce((sum, m) => sum + m.score, 0) / moodsRes.data.length).toFixed(1);
        moodContext = `Mood scores (most recent first): ${moodsRes.data.map(m => m.score).join(', ')}\nAverage: ${avgMood}/10`;
    }

    let deltaContext = '';
    if (deltaRes.data?.length > 0) {
        deltaContext = `Post-reflection mood scores (most recent first): ${deltaRes.data.map(e => e.mood_post).join(', ')}`;
    }

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
        const locations = [...new Set(inspirationsRes.data.filter(i => i.location).map(i => i.location))].join(', ');
        if (locations) inspirationsContext += `\nLocations: ${locations}`;
    }

    let fieldNotesContext = '';
    if (fieldNotesRes.data?.length > 0) {
        const themes = fieldNotesRes.data.filter(n => n.theme).map(n => n.theme).join(', ');
        fieldNotesContext = `Field note themes: ${themes || 'none extracted yet'}`;
    }

    const valuesContext = statedValuesRes.data?.length > 0
        ? statedValuesRes.data.map(v => v.name).join(', ')
        : '';

    const synthesisPrompt = `You are analyzing a private journal to extract evolving patterns and detect significant changes. You will produce two outputs.

OUTPUT 1 — SUMMARY:
Write a single compressed paragraph (150 words maximum) capturing:
- Recurring themes and their frequency
- Tone and emotional register across this period
- Schema patterns present or notably absent
- Language drift — what words or framings are increasing or decreasing
- Aspiration language — concrete and active versus conditional and distant
- Overall trajectory — forward, static, or regressing
- Mood trends if data is present — average score, direction, notable shifts
- Feeling patterns if data is present — which feelings appear most, which cluster together
- Human values operating in the writing — which values are showing up in behavior

OUTPUT 2 — DETECTED CHANGES:
List any significant changes detected, each on its own line in this exact format:
TYPE|FIELD|DETECTED_CONTENT|CONFIDENCE
Where TYPE is either EVENT, DRIFT, or HUMAN_VALUE
Where FIELD is the persona field being updated (or value name if HUMAN_VALUE)
Where DETECTED_CONTENT is what you observed
Where CONFIDENCE is high, medium, or low

For HUMAN_VALUE detections use this format:
HUMAN_VALUE|value_name|evidence of this value operating in the writing|confidence

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