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

    // Pull non-sensitive persona fields
  const { data: personaRows } = await supabaseClient
    .from('guest_profile_v2')
    .select('category, name, content')
    .eq('is_sensitive', false)
    .eq('status', 'active');

let personaContext = '';
if (personaRows && personaRows.length > 0) {
    const grouped = {};
    personaRows.forEach(row => {
        if (!grouped[row.category]) grouped[row.category] = [];
        grouped[row.category].push(`${row.name}: ${row.content}`);
    });
    personaContext = Object.entries(grouped)
        .map(([cat, items]) => `${cat}:\n${items.join('\n')}`)
        .join('\n\n');
}

    // Pull human values from dedicated table
    const { data: guestValues } = await supabaseClient
    .from('guest_profile_v2')
    .select('name, content, status')
    .eq('category', 'Stated Values')
    .eq('status', 'active');

const { data: observedValues } = await supabaseClient
    .from('guest_profile_v2')
    .select('name, content')
    .eq('category', 'Observed Values')
    .eq('status', 'active');

let humanValuesContext = '';
if (guestValues && guestValues.length > 0) {
    humanValuesContext = 'STATED VALUES:\n' + guestValues
        .map(v => `${v.name}: ${v.content}`)
        .join('\n');
}
if (observedValues && observedValues.length > 0) {
    humanValuesContext += '\n\nOBSERVED VALUES (detected in writing):\n' + observedValues
        .map(v => `${v.name}: ${v.content}`)
        .join('\n');
}

    // Pull most recent summary
    const { data: summaryRows } = await supabaseClient
        .from('summaries')
        .select('summary, summary_type')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);

    let summaryContext = '';
    if (summaryRows && summaryRows.length > 0) {
        const rawSummary = summaryRows[0].summary;
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

    // Pull most recent feelings from Supabase
    const { data: recentFeelingsData } = await supabaseClient
        .from('feelings')
        .select('feeling, note, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);

    let recentFeelingsContext = '';
    if (recentFeelingsData && recentFeelingsData.length > 0) {
        const mostRecentTime = new Date(recentFeelingsData[0].created_at);
        const sessionFeelings = recentFeelingsData.filter(f => {
            const diff = mostRecentTime - new Date(f.created_at);
            return diff < 300000;
        });
        const feelingNames = sessionFeelings.map(f => f.feeling).join(', ');
        const feelingNote = sessionFeelings[0].note || '';
        recentFeelingsContext = `Recent feelings logged: ${feelingNames}`;
        if (feelingNote) recentFeelingsContext += `\nFeelings note: ${feelingNote}`;
    }

    // Query recent entries directly from Supabase
    const { data: recentEntriesData } = await supabaseClient
        .from('entries')
        .select('entry, created_at')
        .eq('user_id', userId)
        .not('entry', 'is', null)
        .order('created_at', { ascending: false })
        .limit(5);

    let historyContext = '';
    if (recentEntriesData && recentEntriesData.length > 0) {
        historyContext = recentEntriesData
            .map((e, i) => `Entry ${i + 1}:\n${e.entry}`)
            .join('\n\n');
    }

    // Pull recent inspirations for prompt context
    const { data: recentInspirations } = await supabaseClient
        .from('inspirations')
        .select('content, category, feeling_evoked, location')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

    let inspirationContext = '';
    if (recentInspirations && recentInspirations.length > 0) {
        inspirationContext = recentInspirations
            .map(i => `${i.content}${i.feeling_evoked ? ` (evoked: ${i.feeling_evoked})` : ''}${i.location ? ` — ${i.location}` : ''}`)
            .join('\n');
    }

    // Build current state context
    let currentStateContext = '';
    if (currentMood) {
        let moodBand = '';
        if (currentMood <= 3) moodBand = 'down and struggling';
        else if (currentMood <= 6) moodBand = 'good stable zone — healthy baseline for this person';
        else if (currentMood <= 8) moodBand = 'upbeat, above baseline';
        else moodBand = 'acutely positive, rare and notable';
        currentStateContext += `Mood: ${currentMood}/10 (${moodBand})\n`;
    }
    if (currentFeelings && currentFeelings.length > 0) {
        currentStateContext += `Feelings present: ${currentFeelings.join(', ')}\n`;
    }
    if (feelingsNote) {
        currentStateContext += `Feelings note: ${feelingsNote}\n`;
    }

    // Get current hour for time of day awareness
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
   This is the baton handed from Prompt 3.
   Read it first. Everything else builds on it.

2. PROGRESSIVE PROFILING SYNTHESIS
   Recurring themes. Language patterns. Undertow
   history. Good wolf moments. Human values in
   action. Mood trajectory. Who this guest is
   across time — not just today.

3. HUMAN VALUES PROFILE
   What this guest stands for. The compass
   underneath everything. Where values have been
   showing up in behavior — even without being
   named. Where they have been absent in a way
   that matters. The good wolf's deepest nature.

4. LAST FIVE ENTRIES
   What has been written recently. The baton
   handed from the most recent sessions. What
   has been moving. What keeps recurring.

5. CURRENT SESSION SIGNALS
   Feelings grid selection. Context note if added.
   Time of day. Location if available. What is
   present right now, today, in this moment.

───────────────────────────────────────────────────
THE APERTURE — FINDING THE RIGHT DOOR
───────────────────────────────────────────────────

From everything above, find one thing worth
pointing at today. Not a summary of all signals.
One aperture. The specific part of this guest's
interior landscape that is worth opening right now.

APERTURE SELECTION HIERARCHY:

FIRST — human values in action
Where does the current data show the guest's
human values operating in their behavior —
even slightly, even incidentally? Where is a
value being lived that the guest hasn't yet
named? Where is a value the guest holds being
tested or stretched? This is the highest
priority aperture. This is where the most
significant movement happens.

SECOND — values-aligned exceptions
Where does the current data show the guest
moving toward what genuinely matters to them
— even slightly, even incidentally?
This is good wolf territory.

THIRD — pattern breaks
Where does today's data differ from the dominant
pattern in the progressive profile? The change
— however small — is the aperture.

FOURTH — returning themes
What keeps coming back in the writing that
hasn't yet fully resolved? Open it gently,
from the side, in a way that feels safe to enter.

FIFTH — present moment
When all else is thin — early sessions, sparse
data — the current feelings and context note
are the aperture.

CALIBRATE TO CURRENT SPEED:
A guest at the beginning of their interior
journey needs an aperture close to the surface.
Specific. Contained. Safe to enter with three
sentences.

A guest who has been writing for months with
depth and specificity can receive an aperture
that goes further in — toward values, toward
long patterns, toward the tensions that have
been building across many sessions.

Same standard. Different calibration.
The progressive profiling engine knows which.

───────────────────────────────────────────────────
WRITING THE PROMPT
───────────────────────────────────────────────────

SENTENCE ONE — THE CURIOSITY STATEMENT

Read the aperture. Find the one true thing.
Write a statement that names it specifically
enough that this guest thinks: Mirror sees me.
This is about me. Right now. This is real.

The test: could this sentence have been written
for anyone else? If yes — rewrite it. The
curiosity statement is specific or it is nothing.

Tone: genuine interest. Not clinical attention.
Not performed warmth. Mirror finds this specific
thing about this specific person genuinely worth
looking at. That energy is in the sentence.

SENTENCE TWO — THE EXPLORATION QUESTION

Flow directly from sentence one. Write one
question the guest can only answer by going
inward. How, what, when, where, or what if.
Never yes or no. Never rhetorical.

The test: does the guest feel glad this question
was asked? Does it arrive as relief — yes, that
is exactly what I needed to be asked? Does it
open without directing? If the guest feels
obligation rather than desire — rewrite it.

TOGETHER — THE AMAZON STANDARD:
Sentence one makes the jungle real and worth
entering. Sentence two hands the guest the
canoe and paddle. The guest finishes reading
and wants to go in.

───────────────────────────────────────────────────
WHAT THIS PROMPT HANDS TO PROMPT 2
───────────────────────────────────────────────────

The aperture Prompt 1 opens determines the
territory Prompt 2 receives. Choose the aperture
carefully. The guest will write from wherever
Prompt 1 points them. Prompt 2 will find what
is beneath whatever the guest brings back.

The baton: one specific, honest, open door.
Prompt 2 receives what comes through it.

───────────────────────────────────────────────────
REGISTER
───────────────────────────────────────────────────

Read the guest's recent entries for vocabulary,
sentence length, rhythm, density, tone. Write
both sentences in the guest's register. Match —
do not mimic. The prompt should feel like a
question this guest might have asked themselves.

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
NEVER: open toward a cognitive distortion —
       check: does this prompt point toward
       permanence, hopelessness, or isolation?
       If yes — redirect to good wolf territory
NEVER: produce the same aperture twice when
       a different one is ready
NEVER: name a human value directly as the
       subject of the question — point at the
       behavior, let the guest name the value

CRISIS: if signals suggest acute distress,
suicidal ideation, or immediate danger —
do not generate a prompt. Acknowledge with
care and direct to human support. Always.

───────────────────────────────────────────────────
OUTPUT
───────────────────────────────────────────────────

Two sentences. No preamble. No explanation.
No labels. No quotation marks. No formatting.
The prompt. That is all.

───────────────────────────────────────────────────
GUEST CONTEXT
───────────────────────────────────────────────────

Time of day: ${timeOfDay}

${personaContext ? `PERSONA AND PROFILE:\n${personaContext}\n` : ''}
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
                max_tokens: 150,
                system: promptSystem,
                messages: [
                    {
                        role: 'user',
                        content: `Generate the writing prompt for this guest's ${timeOfDay} session.`
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