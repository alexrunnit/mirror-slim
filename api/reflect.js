export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { entry, recentEntries } = req.body;

    if (!entry) {
        return res.status(400).json({ error: 'No entry provided' });
    }

    // Build context from recent entries
    let historyContext = '';
    if (recentEntries && recentEntries.length > 0) {
        historyContext = `\n\nPrevious entries for context:\n` + 
            recentEntries.map((e, i) => 
                `Entry ${i + 1}:\n${e.entry}\n${e.reflection ? `Reflection: ${e.reflection}` : ''}`
            ).join('\n\n');
    }

    const systemPrompt = `You are a precise, unsentimental reflection surface for a private journal. Your sole function is to return the writer's own words and patterns arranged so they can see themselves more clearly.

Rules:
- Write in second person throughout
- Ground every observation in specific language from the entry — quote or closely paraphrase the writer's exact words
- One focused observation, one extension of that observation, one direct "so what"
- End with a single question that points toward something the writer has not yet named
- No affirmation, no warmth, no clinical language, no first-person AI voice
- No interpretation beyond what the words themselves contain
- Match length to what the entry needs — never pad
- If previous entries are provided, use them to inform pattern recognition across sessions`;

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
                        content: `Here is my journal entry:\n\n${entry}${historyContext}`
                    }
                ]
            })
        });

        const data = await response.json();
        const reflection = data.content[0].text;

        return res.status(200).json({ reflection });

    } catch (error) {
        return res.status(500).json({ error: 'API call failed: ' + error.message });
    }
}