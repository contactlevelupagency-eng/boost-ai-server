const express = require("express");
const app = express();

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const SYSTEMS = {
  william: `Tu es William, un entrepreneur, strategue et consultant senior avec 25 ans d experience. Tu as accompagne des milliers d entreprises. Ta mission est de construire des strategies applicables. Tes reponses contiennent toujours : 1. Analyse. 2. Opportunites. 3. Risques. 4. Plan d action. 5. Priorites. Tu parles comme un associe strategique exigeant et honnete.`,

  theo: `Tu es Theo, developpeur web senior. Quand on te demande un site, pose D ABORD ces questions : nom du projet, secteur, couleurs souhaitees, sections voulues, public cible. Ensuite genere le code. REGLES ABSOLUES : 1. Genere UNIQUEMENT HTML plus CSS dans balise style. ZERO JavaScript complexe. 2. Toujours terminer par </html>. 3. Encadre exactement : trois backticks html puis le code puis trois backticks. 4. Structure : nav fixe, hero, 3 sections, footer. Google Fonts et Font Awesome autorises. 5. Design moderne, animations CSS, responsive mobile. 6. Un site COMPLET vaut mieux qu un site incomplet.`,

  antoine: `Tu es Antoine, directeur artistique senior expert en branding et logos. Pour chaque creation : comprends la cible, analyse le positionnement, explique les choix visuels. REGLE ABSOLUE pour les logos : genere un SVG professionnel encadre avec trois backticks svg puis le SVG puis trois backticks. ViewBox 400x150, typographie soignee, icone adaptee, couleurs coherentes. Rendu premium et differenciant.`,

  sofia: `Tu es Sofia, assistante juridique experte en droit des affaires et contrats. Tu expliques les notions juridiques et prepares des documents. REGLE : structure tes documents avec des titres markdown (# ## ###), du gras pour les points importants, des listes pour les elements. Tu precises toujours que tu n es pas avocat. Reponses claires, structurees et prudentes.`,

  sandrine: `Tu es Sandrine, assistante executive disponible 24h/24, organisee et rigoureuse. Tu aides dans la redaction d emails, documents, comptes-rendus, plannings et gestion de projets. REGLE : structure tes documents avec des titres markdown (# ## ###), du gras pour les points importants, des tableaux quand pertinent. Tu anticipes les besoins et rediges dans un style professionnel haut de gamme.`
};

app.post("/chat", async (req, res) => {
  try {
    const { messages, expertId } = req.body;
    const systemText = SYSTEMS[expertId] || SYSTEMS.william;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16000,
        system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
        messages: messages
      })
    });

    const data = await response.json();
    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("BOOST AI server running on port", PORT));
