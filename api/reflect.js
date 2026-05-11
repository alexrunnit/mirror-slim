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

    // Pull stated and observed values
    const { data: guestValues } = await supabaseClient
        .from('guest_profile_v2')
        .select('name, content')
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

    // Pull mirror guest observations
    const { data: observations } = await supabaseClient
        .from('mirror_guest_observations')
        .select('update_type, field, detected_content, confidence, created_at')
        .eq('accepted', true)
        .order('created_at', { ascending: false })
        .limit(20);

    let observationsContext = '';
    if (observations && observations.length > 0) {
        observationsContext = observations
            .map(o => `${o.update_type} — ${o.field}: ${o.detected_content}`)
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

    // Build recent entry history context
    let historyContext = '';
    if (recentEntries && recentEntries.length > 0) {
        historyContext = recentEntries
            .map((e, i) => `Entry ${i + 1}:\n${e.entry}\n${e.reflection ? `Reflection: ${e.reflection}` : ''}`)
            .join('\n\n');
    }

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
${observationsContext ? `MIRROR OBSERVATIONS (detected across sessions):\n${observationsContext}\n` : ''}
${humanValuesContext ? `HUMAN VALUES:\n${humanValuesContext}\n` : ''}
${summaryContext ? `MOST RECENT SUMMARY:\n${summaryContext}\n` : ''}
${historyContext ? `LAST FIVE ENTRIES AND REFLECTIONS:\n${historyContext}` : ''}`;

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
                max_tokens: 1024,
                system: systemPrompt,
                messages: [
                    {
                        role: 'user',
                        content: `Here is the writing prompt that opened this session:\n\n${promptUsed || 'No prompt used'}\n\nHere is the guest's journal entry:\n\n${entry}`
                    }
                ]
            })
        });

        const data = await response.json();
        const reflection = data.content[0].text;

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

    const { data: synthesisEntries } = await supabaseClient
        .from('entries')
        .select('entry, reflection, created_at')
        .eq('user_id', userId)
        .not('entry', 'is', null)
        .order('created_at', { ascending: false })
        .limit(10);

    if (!synthesisEntries || synthesisEntries.length === 0) return;

    const entriesText = synthesisEntries
        .map((e, i) => `Entry ${i + 1}:\n${e.entry}`)
        .join('\n\n');

    const { data: recentMoods } = await supabaseClient
        .from('mood')
        .select('score, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);

    const { data: recentFeelings } = await supabaseClient
        .from('feelings')
        .select('feeling, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

    let moodContext = '';
    if (recentMoods && recentMoods.length > 0) {
        const avgMood = (recentMoods.reduce((sum, m) => sum + m.score, 0) / recentMoods.length).toFixed(1);
        const moodScores = recentMoods.map(m => m.score).join(', ');
        moodContext = `Mood scores (most recent first): ${moodScores}\nAverage: ${avgMood}/10`;
    }

    const { data: deltaEntries } = await supabaseClient
        .from('entries')
        .select('mood_post, created_at')
        .eq('user_id', userId)
        .not('mood_post', 'is', null)
        .order('created_at', { ascending: false })
        .limit(10);

    let deltaContext = '';
    if (deltaEntries && deltaEntries.length > 0) {
        deltaContext = `Post-reflection mood scores (most recent first): ${deltaEntries.map(e => e.mood_post).join(', ')}`;
    }

    let feelingsContext = '';
    if (recentFeelings && recentFeelings.length > 0) {
        const feelingCounts = {};
        recentFeelings.forEach(f => {
            feelingCounts[f.feeling] = (feelingCounts[f.feeling] || 0) + 1;
        });
        const sorted = Object.entries(feelingCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([feeling, count]) => `${feeling} (${count})`)
            .join(', ');
        feelingsContext = `Feelings frequency: ${sorted}`;
    }

    const { data: recentInspirations } = await supabaseClient
        .from('inspirations')
        .select('content, category, feeling_evoked, location, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);

    const { data: recentFieldNotes } = await supabaseClient
        .from('field_notes')
        .select('content, theme, location, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);

    let fieldNotesContext = '';
    if (recentFieldNotes && recentFieldNotes.length > 0) {
        const themes = recentFieldNotes
            .filter(n => n.theme)
            .map(n => n.theme)
            .join(', ');
        fieldNotesContext = `Field note themes: ${themes || 'none extracted yet'}`;
    }

    let inspirationsContext = '';
    if (recentInspirations && recentInspirations.length > 0) {
        const categoryCount = {};
        recentInspirations.forEach(i => {
            if (i.category) {
                categoryCount[i.category] = (categoryCount[i.category] || 0) + 1;
            }
        });
        const categorySummary = Object.entries(categoryCount)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, count]) => `${cat} (${count})`)
            .join(', ');

        const feelingsSummary = recentInspirations
            .filter(i => i.feeling_evoked)
            .map(i => i.feeling_evoked)
            .join(', ');

        const locationSummary = [...new Set(recentInspirations
            .filter(i => i.location)
            .map(i => i.location))]
            .join(', ');

        inspirationsContext = `Inspiration categories: ${categorySummary || 'none extracted yet'}`;
        if (feelingsSummary) inspirationsContext += `\nFeelings evoked by inspirations: ${feelingsSummary}`;
        if (locationSummary) inspirationsContext += `\nLocations of inspiration: ${locationSummary}`;
    }

    // Pull current stated values for synthesis context
    const { data: statedValues } = await supabaseClient
        .from('guest_profile_v2')
        .select('name, status')
        .eq('category', 'Stated Values')
        .eq('status', 'active');

    let valuesContext = '';
    if (statedValues && statedValues.length > 0) {
        valuesContext = statedValues
            .map(v => v.name)
            .join(', ');
    }

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
                messages: [
                    {
                        role: 'user',
                        content: synthesisPrompt
                    }
                ]
            })
        });

        const synthesisData = await synthesisResponse.json();
        const synthesisText = synthesisData.content[0].text;

        const parts = synthesisText.split('OUTPUT 2');
        const summaryRaw = parts[0].replace('OUTPUT 1 — SUMMARY:', '').replace('# OUTPUT 1 — SUMMARY', '').trim();
        const summaryText = summaryRaw.replace(/#{1,6}\s/g, '').replace(/\*\*/g, '').replace(/\*/g, '').trim();
        const changesText = parts[1] ? parts[1].replace('— DETECTED CHANGES:', '').trim() : '';

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
                if (type && field && detectedContent) {

                    // Handle human value discoveries — write to guest_profile_v2
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
                                    status: 'active'
                                }]);
                        }
                        continue;
                    }

                    // Handle regular persona observations — write to mirror_guest_observations
                    await supabaseClient
                        .from('mirror_guest_observations')
                        .insert([{
                            update_type: type.trim(),
                            field: field.trim(),
                            detected_content: detectedContent.trim(),
                            existing_content: '',
                            confidence: confidence ? confidence.trim() : 'medium',
                            category: 'persona',
                            reviewed: false,
                            accepted: false,
                            user_id: userId
                        }]);
                }
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
            const periodEnd = now.toISOString();
            const periodStart = sevenDaysAgo.toISOString();

            await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/summary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: userId,
                    periodStart: periodStart,
                    periodEnd: periodEnd,
                    summaryType: 'weekly'
                })
            });
        }
    } catch (error) {
        console.error('Weekly summary check error:', error);
    }
}