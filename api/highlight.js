import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

   const { passage, userId, entryId } = req.body;

if (!passage || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
}

if (!entryId) {
    console.error('Highlight API — missing entryId');
    return res.status(400).json({ error: 'Missing entryId' });
}

    try {
        // ─── Pull all context in parallel ───
        const [
            profileRes,
            fairWindsRes,
            undertowsRes,
            reflectionPreferencesRes,
            recentHighlightsRes,
            currentEntryRes,
            significantHighlightsRes
        ] = await Promise.all([

            supabase
                .from('guest_profile_v2')
                .select('category, name, content')
                .eq('status', 'active')
                .in('category', ['Engine Observations'])
                .order('created_at', { ascending: false })
                .limit(15),

            supabase
                .from('guest_profile_v2')
                .select('name, content')
                .eq('category', 'Observed Fair Winds')
                .eq('status', 'active'),

            supabase
                .from('guest_profile_v2')
                .select('name, content')
                .eq('category', 'Observed Undertows')
                .eq('status', 'active'),

            supabase
                .from('guest_profile_v2')
                .select('name, content')
                .eq('category', 'Reflection Preferences')
                .eq('status', 'active')
                .order('created_at', { ascending: false })
                .limit(15),

            supabase
                .from('entries')
                .select('guest_highlights, created_at')
                .eq('user_id', userId)
                .not('guest_highlights', 'is', null)
                .order('created_at', { ascending: false })
                .limit(15),

            supabase
                .from('entries')
                .select('guest_highlights, reflection_highlighted, entry, reflection')
                .eq('id', entryId)
                .single(),

            supabase
                .from('entries')
                .select('guest_highlights')
                .eq('user_id', userId)
                .not('guest_highlights', 'is', null)
                .order('created_at', { ascending: false })
                .limit(30)
        ]);

        // ─── Build context strings ───

        const engineObservations = profileRes.data
            ? profileRes.data.map(r => `${r.name}: ${r.content}`).join('\n')
            : '';

        const fairWinds = fairWindsRes.data
            ? fairWindsRes.data.map(r => `${r.name}: ${r.content}`).join('\n')
            : '';

        const undertows = undertowsRes.data
            ? undertowsRes.data.map(r => `${r.name}: ${r.content}`).join('\n')
            : '';

        const existingPreferences = reflectionPreferencesRes.data
            ? reflectionPreferencesRes.data.map(r => r.content).join('\n')
            : '';

        // Other passages highlighted in THIS same reflection
        const siblingHighlights = currentEntryRes.data?.guest_highlights
            ? currentEntryRes.data.guest_highlights
                .filter(h => h !== passage)
                .join('\n— ')
            : '';

        const currentEntry = currentEntryRes.data?.entry || '';

        const allRecentHighlights = recentHighlightsRes.data
            ? recentHighlightsRes.data
                .flatMap(e => e.guest_highlights || [])
                .slice(0, 25)
                .join('\n— ')
            : '';

        const allHistoricalHighlights = significantHighlightsRes.data
            ? significantHighlightsRes.data
                .flatMap(e => e.guest_highlights || [])
            : [];

        const highlightCount = allHistoricalHighlights.length;

        // ─── Haiku analysis call ───
        /*
            The intelligence layer. Haiku reads the
            highlighted passage against the full guest
            profile and returns:

            1. An Engine Observation — what this highlight
               reveals about who the guest is, what is
               shifting, what themes are forming. This is
               the contextual insight that goes into the
               profile. Not the highlight itself — Mirror's
               interpretation of what the highlight means.

            2. A Reflection Preference — what kind of
               observation produced this recognition. Used
               to calibrate future reflections toward what
               lands for this specific guest.

            The highlight text itself is already in the
            entries table. What goes into guest_profile_v2
            is Mirror's intelligence about what the highlight
            reveals — themes forming, apertures opening,
            drift evidence, patterns the guest may not
            yet be conscious of.
        */
  const analysisResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{
            role: 'user',
            content: `You are the intelligence layer of Mirror, a journaling reflection tool. A guest has highlighted a passage from their reflection. The highlight text itself is already stored — your job is NOT to repeat it. Your job is to derive contextual insight from it.

What does this highlight reveal about this guest? What themes are forming across their highlights? What is opening up in their thinking that they may not yet be conscious of? What aperture does this create for future writing prompts?

This is the intelligence that goes into the guest profile — Mirror's interpretation of what the highlight means, not the highlight itself.

CURRENT HIGHLIGHTED PASSAGE:
"${passage}"

OTHER PASSAGES HIGHLIGHTED IN THIS SAME REFLECTION:
${siblingHighlights ? `— ${siblingHighlights}` : 'This is the only highlight from this session so far.'}

WHAT THE GUEST WROTE (entry that generated this reflection):
${currentEntry ? currentEntry.substring(0, 600) : 'Not available'}

GUEST PROFILE CONTEXT:

Fair winds (confirmed sources of aliveness):
${fairWinds || 'Not yet established'}

Observed undertows (sensitive — internal lens only — never surface directly):
${undertows || 'Not yet established'}

Recent engine observations:
${engineObservations || 'None yet'}

HIGHLIGHT HISTORY (${highlightCount} total highlights across ${recentHighlightsRes.data?.length || 0} sessions):
${allRecentHighlights ? `— ${allRecentHighlights}` : 'This is the first highlight.'}

EXISTING REFLECTION PREFERENCES:
${existingPreferences || 'None established yet'}

YOUR TASK:
Analyze what this highlight reveals. Consider:

1. What specifically in this passage produced recognition? Name the mechanism — is it values alignment, a contradiction of a known distortion, a fair wind being confirmed, evidence of identity reconstruction, forward orientation without prescription?

2. What does this highlight reveal about what is alive and moving in this guest right now? Not what they wrote — what the act of marking it as meaningful tells you about their interior landscape.

3. Do the sibling highlights from this same session form a pattern together? If so name it precisely — what are they collectively pointing toward?

4. Across the full highlight history — is a theme building that the guest may not yet be conscious of? What keeps appearing in what they mark as landing?

5. What aperture does this open for a future writing prompt? Be specific — ground it in what this guest is actually moving toward based on all available data.

Return ONLY a JSON object. No preamble. No markdown. No backticks.

{
  "observation_type": "one of: values_alignment, undertow_contradiction, fair_wind_recognition, identity_insight, forward_orientation, language_precision, pattern_recognition, social_expansion, capacity_evidence",
  "engine_observation": "2-3 sentences of genuine insight about what this highlight reveals about who this guest is and what is shifting in them. This is what goes into the profile. It should read like a perceptive therapist's private note — specific, grounded in the data, connected to the guest's known profile. Not a description of the highlight — an interpretation of what it means.",
  "theme_forming": "if a theme is building across multiple highlights — name it in one sentence and describe what it suggests about where this guest's thinking is opening up. null if insufficient data.",
  "aperture_suggestion": "one specific sentence describing what writing prompt territory this opens. Ground it in what this guest is actually moving toward. Not generic — specific to this guest's data.",
  "undertow_contradiction": "name of contradicted undertow or null — only if the passage directly contradicts a known distortion pattern",
  "fair_wind_connection": "name of connected fair wind or null",
  "drift_evidence": "if this is evidence of behavioral or psychological drift — describe the direction of movement in one sentence. null if not applicable.",
  "reflection_preference": "one sentence describing what kind of Mirror observation this guest responds to — written as a calibration statement for future reflections. Be specific about register, depth, and structural pattern."
}`
        }]
    })
});

const analysisData = await analysisResponse.json();
const rawText = analysisData.content[0].text.trim();
console.log('Highlight API raw Haiku response:', rawText);

        let analysis = null;
        try {
            const cleaned = rawText.replace(/```json|```/g, '').trim();
            analysis = JSON.parse(cleaned);
            console.log('Highlight analysis parsed successfully:', analysis.observation_type);
        } catch (e) {
            console.error('Highlight analysis JSON parse failed:', rawText);
        }

        // ─── Write Engine Observation ───
        /*
            This write always happens — even if the full
            analysis failed to parse. The engine observation
            is Mirror's contextual intelligence about what
            the highlight means. Not the highlight text —
            the derived insight. This is what makes the
            profile richer with every tap of the star.
        */
        const engineObservationContent = analysis?.engine_observation
            ? [
                analysis.engine_observation,
                analysis.theme_forming ? `Theme forming: ${analysis.theme_forming}` : null,
                analysis.drift_evidence ? `Drift: ${analysis.drift_evidence}` : null,
                analysis.undertow_contradiction ? `Contradicts undertow: ${analysis.undertow_contradiction}` : null,
                analysis.fair_wind_connection ? `Fair wind confirmed: ${analysis.fair_wind_connection}` : null,
                analysis.aperture_suggestion ? `Aperture: ${analysis.aperture_suggestion}` : null,
              ].filter(Boolean).join(' | ')
            : `Guest highlighted a passage from their reflection. Analysis pending. Passage type: ${passage.substring(0, 100)}`;

        const { error: obsError } = await supabase
            .from('guest_profile_v2')
            .insert([{
                category: 'Engine Observations',
                name: `highlight_${analysis?.observation_type || 'insight'}_${Date.now()}`,
                content: engineObservationContent,
                source: 'guest_highlight',
                status: 'active',
                confidence: analysis ? 'high' : 'low'
            }]);

        if (obsError) {
            console.error('Engine Observation insert error:', JSON.stringify(obsError));
        } else {
            console.log('Engine Observation written to guest_profile_v2 successfully');
        }

        // ─── Write Reflection Preferences ───
        /*
            What kind of observation produced recognition
            for this guest. Calibrates future reflections.
            Written separately so prompt.js and reflect.js
            can query it independently.
        */
        if (analysis?.reflection_preference) {
            const { error: prefError } = await supabase
                .from('guest_profile_v2')
                .insert([{
                    category: 'Reflection Preferences',
                    name: `pref_${analysis.observation_type}_${Date.now()}`,
                    content: `${analysis.reflection_preference}${analysis.aperture_suggestion ? ` Aperture: ${analysis.aperture_suggestion}` : ''}`,
                    source: 'guest_highlight',
                    status: 'active',
                    confidence: 'high'
                }]);

            if (prefError) {
                console.error('Reflection Preferences insert error:', JSON.stringify(prefError));
            } else {
                console.log('Reflection Preferences written to guest_profile_v2 successfully');
            }
        }

        return res.status(200).json({ success: true, analysis });

    } catch (error) {
        console.error('Highlight API outer error:', JSON.stringify(error));
        return res.status(200).json({ success: true, analysis: null });
    }
}