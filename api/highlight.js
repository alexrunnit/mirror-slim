import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

    try {
        // ─── Pull all context in parallel ───
        /*
            Seven data sources read simultaneously.
            The highlight analysis is only as good
            as the context it reads against.
            Each source adds a layer of intelligence.
        */
        const [
            profileRes,
            fairWindsRes,
            undertowsRes,
            reflectionPreferencesRes,
            recentHighlightsRes,
            currentEntryRes,
            significantHighlightsRes
        ] = await Promise.all([

            // Engine observations and existing profile
            supabase
                .from('guest_profile_v2')
                .select('category, name, content')
                .eq('status', 'active')
                .in('category', ['Engine Observations'])
                .order('created_at', { ascending: false })
                .limit(15),

            // Fair winds — sources of aliveness
            supabase
                .from('guest_profile_v2')
                .select('name, content')
                .eq('category', 'Observed Fair Winds')
                .eq('status', 'active'),

            // Undertows — sensitive, internal lens only
            supabase
                .from('guest_profile_v2')
                .select('name, content')
                .eq('category', 'Observed Undertows')
                .eq('status', 'active'),

            // Existing reflection preferences — what has
            // landed before for this guest
            supabase
                .from('guest_profile_v2')
                .select('name, content')
                .eq('category', 'Reflection Preferences')
                .eq('status', 'active')
                .order('created_at', { ascending: false })
                .limit(15),

            // Recent highlights across last 15 entries
            // for cross-session pattern detection
            supabase
                .from('entries')
                .select('guest_highlights, created_at')
                .eq('user_id', userId)
                .not('guest_highlights', 'is', null)
                .order('created_at', { ascending: false })
                .limit(15),

            // Current entry — read ALL highlights from
            // this same reflection, not just this passage.
            // Other passages highlighted in the same session
            // contextualize and amplify each other.
            supabase
                .from('entries')
                .select('guest_highlights, reflection_highlighted, entry, reflection')
                .eq('id', entryId)
                .single(),

            // Highest-frequency highlights across history
            // What themes keep appearing in what this
            // guest marks as landing?
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
        // These are the sibling highlights — they contextualize
        // the current passage and together tell a fuller story
        const siblingHighlights = currentEntryRes.data?.guest_highlights
            ? currentEntryRes.data.guest_highlights
                .filter(h => h !== passage)
                .join('\n— ')
            : '';

        const currentEntry = currentEntryRes.data?.entry || '';

        // All highlights across recent sessions — flattened
        // Used to detect recurring themes and patterns
        const allRecentHighlights = recentHighlightsRes.data
            ? recentHighlightsRes.data
                .flatMap(e => e.guest_highlights || [])
                .slice(0, 25)
                .join('\n— ')
            : '';

        // Frequency analysis — which words or phrases
        // keep appearing across what this guest highlights?
        const allHistoricalHighlights = significantHighlightsRes.data
            ? significantHighlightsRes.data
                .flatMap(e => e.guest_highlights || [])
            : [];

        const highlightCount = allHistoricalHighlights.length;

        // ─── Haiku analysis call ───
        /*
            This call does three things simultaneously:
            1. Analyzes the current highlighted passage
            2. Reads it in context of sibling highlights
               from the same reflection
            3. Reads both against the full history of
               what this guest has highlighted before
            The result is not just analysis of one passage
            but understanding of a pattern building over time.
        */
        const analysisResponse = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            messages: [{
                role: 'user',
                content: `You are the intelligence layer of Mirror, a journaling reflection tool. A guest has highlighted a passage from their reflection. Your job is to understand WHY this passage landed, how it connects to other passages they highlighted in the same session, and what pattern is building across their highlighting history.

This is not a simple sentiment analysis. You are looking for the intersection of what the guest wrote, what Mirror reflected back, what the guest chose to mark as landing, and what that reveals about their interior movement over time.

CURRENT HIGHLIGHTED PASSAGE:
"${passage}"

OTHER PASSAGES HIGHLIGHTED IN THIS SAME REFLECTION:
${siblingHighlights ? `— ${siblingHighlights}` : 'This is the only highlight from this session so far.'}

WHAT THE GUEST WROTE (entry that generated this reflection):
${currentEntry ? currentEntry.substring(0, 500) : 'Not available'}

GUEST PROFILE CONTEXT:
Fair winds (confirmed sources of aliveness):
${fairWinds || 'Not yet established'}

Observed undertows (sensitive — for internal analysis only — never surface directly):
${undertows || 'Not yet established'}

Engine observations (behavioral drift detected):
${engineObservations || 'None yet'}

HIGHLIGHT HISTORY (${highlightCount} total highlights across ${recentHighlightsRes.data?.length || 0} sessions):
${allRecentHighlights ? `— ${allRecentHighlights}` : 'This is the first highlight.'}

EXISTING REFLECTION PREFERENCES (what has landed before):
${existingPreferences || 'None established yet'}

ANALYSIS INSTRUCTIONS:
1. Read the current passage carefully.
2. Read the sibling highlights — do they form a theme together? Does one contextualize the other? Together, what are they saying about what is alive for this guest right now?
3. Read both against the highlight history — is a pattern building? What keeps appearing in what this guest marks as landing?
4. Consider the undertows as a silent lens — is this passage landing because it contradicts something the guest has been struggling with? Does it show movement they may not be fully conscious of?
5. Consider the fair winds — is this passage touching a source of aliveness? Does it open toward something that genuinely energizes this guest?

Return ONLY a JSON object with these fields:
{
  "observation_type": "one of: values_alignment, undertow_contradiction, fair_wind_recognition, identity_insight, forward_orientation, language_precision, pattern_recognition, social_expansion, capacity_evidence",
  "what_landed": "one precise sentence — what specifically in this passage produced recognition for this guest",
  "why_it_likely_landed": "one sentence — the deeper reason, connected to their profile and history",
  "sibling_pattern": "if other passages were highlighted in this session — one sentence describing what they reveal together. null if this is the only highlight.",
  "historical_pattern": "if a pattern is building across multiple sessions of highlighting — name it in one sentence. null if insufficient data.",
  "fair_wind_connection": "name of connected fair wind or null",
  "undertow_contradiction": "name of contradicted undertow or null — only if the passage directly contradicts a known distortion",
  "drift_evidence": "if this highlight is evidence of behavioral drift — describe the movement in one sentence. null if not applicable.",
  "reflection_preference": "one sentence describing what kind of observation this guest responds to — written as a preference statement Mirror can use for future reflections. Be specific about register, depth, and structure.",
  "aperture_suggestion": "one sentence — what specific territory this opens for a future writing prompt. Ground it in what this guest is actually moving toward."
}

Return ONLY the JSON object. No preamble. No explanation. No markdown backticks.`
            }]
        });

        const rawText = analysisResponse.content[0].text.trim();

        let analysis;
        try {
            // Strip any accidental markdown backticks
            const cleaned = rawText.replace(/```json|```/g, '').trim();
            analysis = JSON.parse(cleaned);
        } catch (e) {
            console.error('Highlight analysis JSON parse failed:', rawText);
            return res.status(200).json({ success: true, analysis: null });
        }

        // ─── Write to Reflection Preferences ───
        /*
            The reflection_preference field accumulates
            a precise picture of what produces recognition
            for this specific guest.
            Prompt 2 reads this category to calibrate
            register, depth, and observation style.
            Over time this is what makes the reflection
            feel like espresso rather than Americano.
        */
        if (analysis.reflection_preference) {
            await supabase
                .from('guest_profile_v2')
                .insert([{
                    category: 'Reflection Preferences',
                    name: `highlight_${analysis.observation_type}_${Date.now()}`,
                    content: `${analysis.reflection_preference}${analysis.aperture_suggestion ? ` Aperture: ${analysis.aperture_suggestion}` : ''}`,
                    source: 'guest_highlight',
                    status: 'active',
                    confidence: 'high'
                }]);
        }

        // ─── Write drift evidence ───
        /*
            If the highlight contradicts an undertow
            or confirms a fair wind or shows behavioral
            drift — write it as an Engine Observation.
            This is what the summary reads to surface
            the movement narrative.
        */
        const driftPieces = [];

        if (analysis.undertow_contradiction) {
            driftPieces.push(`Undertow drift — guest highlighted passage contradicting '${analysis.undertow_contradiction}': "${passage.substring(0, 100)}". ${analysis.drift_evidence || analysis.why_it_likely_landed}`);
        }

        if (analysis.fair_wind_connection) {
            driftPieces.push(`Fair wind confirmed — guest highlighted passage touching '${analysis.fair_wind_connection}': "${passage.substring(0, 100)}". ${analysis.why_it_likely_landed}`);
        }

        if (analysis.drift_evidence && !analysis.undertow_contradiction && !analysis.fair_wind_connection) {
            driftPieces.push(`Behavioral drift — ${analysis.drift_evidence} Evidence: "${passage.substring(0, 100)}"`);
        }

        if (analysis.sibling_pattern) {
            driftPieces.push(`Session highlight pattern: ${analysis.sibling_pattern}`);
        }

        if (analysis.historical_pattern) {
            driftPieces.push(`Cross-session highlight pattern emerging: ${analysis.historical_pattern}`);
        }

        // Write all drift pieces as a single consolidated observation
        if (driftPieces.length > 0) {
            await supabase
                .from('guest_profile_v2')
                .insert([{
                    category: 'Engine Observations',
                    name: `highlight_analysis_${analysis.observation_type}_${Date.now()}`,
                    content: driftPieces.join(' | '),
                    source: 'guest_highlight',
                    status: 'active',
                    confidence: 'high'
                }]);
        }

        return res.status(200).json({ success: true, analysis });

    } catch (error) {
        console.error('Highlight API error:', error);
        return res.status(200).json({ success: true, analysis: null });
    }
}