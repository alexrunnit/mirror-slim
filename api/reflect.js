export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { entry } = req.body;

    if (!entry) {
        return res.status(400).json({ error: 'No entry provided' });
    }

    // Hardcoded test response — Claude integration comes in Step 4
    const reflection = "This is a test reflection. The routing is working correctly.";

    return res.status(200).json({ reflection });
}