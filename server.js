const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const app = express();

// File-based token storage (survives server restarts, unlike in-memory storage)
const TOKENS_FILE = "/app/data/tokens.json";

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
    }
  } catch (e) {
    console.log("Error loading tokens file:", e.message);
  }
  return {};
}

function saveTokens(tokens) {
  try {
    const dir = require("path").dirname(TOKENS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch (e) {
    console.log("Error saving tokens file:", e.message);
  }
}

// Stripe webhook needs raw body for signature verification - must come BEFORE express.json()
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = verifyStripeSignature(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log("Webhook signature verification failed:", err.message);
    return res.status(400).send("Webhook Error: " + err.message);
  }

  console.log("Stripe event received:", event.type);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = session.customer_details ? session.customer_details.email : null;
    const amountTotal = session.amount_total; // in cents

    // Determine plan from amount paid - covers both monthly and yearly billing
    let plan = "pro";
    let isYearly = false;
    if (amountTotal === 1990) plan = "starter";
    else if (amountTotal === 2990) plan = "pro";
    else if (amountTotal === 3990) plan = "unlimited";
    else if (amountTotal === 19104) { plan = "starter"; isYearly = true; }
    else if (amountTotal === 28704) { plan = "pro"; isYearly = true; }
    else if (amountTotal === 38304) { plan = "unlimited"; isYearly = true; }

    const durationMs = isYearly ? 366 * 24 * 60 * 60 * 1000 : 31 * 24 * 60 * 60 * 1000; // 1 month or 1 year + 1 day buffer
    const expiresAt = Date.now() + durationMs;
    const subscriptionId = session.subscription || null;

    const token = crypto.randomBytes(24).toString("hex");
    const tokens = loadTokens();
    tokens[token] = { plan, email, createdAt: Date.now(), expiresAt, subscriptionId, active: true };
    saveTokens(tokens);

    console.log("New token created for plan:", plan, "email:", email, "expires:", new Date(expiresAt).toISOString());

    const accessUrl = "https://boost-ai.fr/merci.html?token=" + token + "&plan=" + plan;
    console.log("Access URL:", accessUrl);

    if (email && process.env.RESEND_API_KEY) {
      try {
        const planLabel = plan === "starter" ? "Starter" : plan === "unlimited" ? "Illimite" : "Pro";
        const emailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + process.env.RESEND_API_KEY
          },
          body: JSON.stringify({
            from: "BOOST AI <onboarding@resend.dev>",
            to: email,
            subject: "Votre acces BOOST AI est pret !",
            html: "<div style='font-family:sans-serif;max-width:480px;margin:0 auto;padding:30px;'>"
              + "<h1 style='color:#7c3aed;'>Bienvenue dans BOOST AI !</h1>"
              + "<p>Merci pour votre abonnement au plan <strong>" + planLabel + "</strong>.</p>"
              + "<p>Cliquez sur le bouton ci-dessous pour acceder a votre equipe d'experts IA :</p>"
              + "<a href='" + accessUrl + "' style='display:inline-block;background:#7c3aed;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:20px 0;'>Acceder a mon equipe</a>"
              + "<p style='color:#888;font-size:13px;'>Gardez cet email, ce lien vous permet d acceder a votre compte a tout moment.</p>"
              + "</div>"
          })
        });
        const emailData = await emailRes.json();
        console.log("Email send status:", emailRes.status, JSON.stringify(emailData).slice(0,200));
      } catch (emailErr) {
        console.log("Email sending error:", emailErr.message);
      }
    } else {
      console.log("Email not sent - missing email address or RESEND_API_KEY");
    }
  }

  // Handle subscription cancellation: deactivate the matching token immediately
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const subId = subscription.id;
    console.log("Subscription cancelled:", subId);

    const tokens = loadTokens();
    let found = false;
    for (const t in tokens) {
      if (tokens[t].subscriptionId === subId) {
        tokens[t].active = false;
        found = true;
        console.log("Token deactivated for cancelled subscription:", t.slice(0,8) + "...");
      }
    }
    if (found) saveTokens(tokens);
    else console.log("No matching token found for subscription:", subId);
  }

  res.json({ received: true });
});

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) throw new Error("No signature header");
  const parts = sigHeader.split(",").reduce((acc, part) => {
    const [k, v] = part.split("=");
    acc[k] = v;
    return acc;
  }, {});
  const signedPayload = parts.t + "." + payload.toString();
  const expectedSig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  if (expectedSig !== parts.v1) throw new Error("Signature mismatch");
  return JSON.parse(payload.toString());
}

app.get("/verify-token", (req, res) => {
  const { token } = req.query;
  const tokens = loadTokens();
  const entry = tokens[token];

  if (!token || !entry) {
    return res.status(404).json({ valid: false, reason: "not_found" });
  }
  if (!entry.active) {
    return res.status(403).json({ valid: false, reason: "cancelled" });
  }
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    return res.status(403).json({ valid: false, reason: "expired" });
  }

  res.json({ valid: true, plan: entry.plan, email: entry.email });
});

app.use(express.json({ limit: "10mb" }));

const EXPERT_LIMITS = {
  antoine: { starter: 8, pro: 20, unlimited: 50 },
  theo: { starter: 8, pro: 20, unlimited: 50 }
};

function getMonthKey() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1);
}

function checkUsage(req, res, expertKey, usageField) {
  const { token } = req.query;
  const tokens = loadTokens();
  const entry = tokens[token];

  if (!token || !entry || !entry.active) {
    return res.status(404).json({ error: "invalid token" });
  }

  const mk = getMonthKey();
  if (!entry[usageField] || entry[usageField].month !== mk) {
    entry[usageField] = { month: mk, count: 0 };
    saveTokens(tokens);
  }

  const limit = EXPERT_LIMITS[expertKey][entry.plan] || EXPERT_LIMITS[expertKey].pro;
  res.json({ count: entry[usageField].count, limit, limitReached: entry[usageField].count >= limit });
}

function incrUsage(req, res, expertKey, usageField) {
  const { token } = req.body;
  const tokens = loadTokens();
  const entry = tokens[token];

  if (!token || !entry || !entry.active) {
    return res.status(404).json({ error: "invalid token" });
  }

  const mk = getMonthKey();
  if (!entry[usageField] || entry[usageField].month !== mk) {
    entry[usageField] = { month: mk, count: 0 };
  }

  const limit = EXPERT_LIMITS[expertKey][entry.plan] || EXPERT_LIMITS[expertKey].pro;
  if (entry[usageField].count >= limit) {
    return res.status(403).json({ error: "limit_reached", count: entry[usageField].count, limit });
  }

  entry[usageField].count += 1;
  saveTokens(tokens);
  res.json({ count: entry[usageField].count, limit, limitReached: entry[usageField].count >= limit });
}

// Antoine usage (logos and flyers)
app.get("/antoine-usage", (req, res) => checkUsage(req, res, "antoine", "usage"));
app.post("/antoine-usage", (req, res) => incrUsage(req, res, "antoine", "usage"));

// Theo usage (websites)
app.get("/theo-usage", (req, res) => checkUsage(req, res, "theo", "usageTheo"));
app.post("/theo-usage", (req, res) => incrUsage(req, res, "theo", "usageTheo"));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const SYSTEMS = {
  william: `Tu es William, un entrepreneur, strategue et consultant senior avec 25 ans d experience. Tu as accompagne des milliers d entreprises. Ta mission est de construire des strategies applicables. Tes reponses contiennent toujours : 1. Analyse. 2. Opportunites. 3. Risques. 4. Plan d action. 5. Priorites. Tu parles comme un associe strategique exigeant et honnete.`,

        theo: `Tu es Theo, developpeur web senior. Quand on te demande un site, pose D ABORD ces questions : 1. Nom du projet 2. Secteur d activite 3. Couleurs souhaitees 4. Sections voulues 5. Public cible. Ensuite genere le code.

GESTION DES IMAGES : utilise des photos Unsplash generiques adaptees au secteur : https://images.unsplash.com/photo-XXXXX?w=800&q=80. Le client pourra remplacer ces images par les siennes ensuite. Ne genere jamais d images IA personnalisees.

REGLES ABSOLUES DE GENERATION :
1. Genere UNIQUEMENT HTML plus CSS dans balise style. ZERO JavaScript complexe.
2. Toujours terminer par </html>.
3. Encadre exactement : trois backticks html puis le code puis trois backticks.
4. Structure : nav fixe, hero, 3 sections, footer. Google Fonts et Font Awesome autorises.
5. Design moderne, animations CSS uniquement, responsive mobile.
6. Un site COMPLET vaut mieux qu un site incomplet.

REGLE CRITIQUE POUR LES MODIFICATIONS : Quand le client demande une modification sur un site deja genere (changer une couleur, traduire, ajouter une section...), tu DOIS reprendre EXACTEMENT le code precedent et appliquer UNIQUEMENT le changement demande. Ne supprime JAMAIS les sections ou elements deja presents sauf si explicitement demande.

APRES AVOIR GENERE LE SITE, ajoute toujours ce message a la fin (hors des backticks) :

---
Votre site est pret ! Voici comment le deployer :

1. Cliquez sur Telecharger pour recuperer le fichier site.html
2. Renommez-le index.html
3. Pour le mettre en ligne gratuitement : allez sur netlify.com, creez un compte, glissez votre fichier sur la page Deploy
4. Votre site sera en ligne en 30 secondes avec une URL gratuite
5. Pour un nom de domaine personnalise (ex: votresite.fr) : achetez-le sur OVH ou Namecheap puis connectez-le dans Netlify

Si vous souhaitez remplacer les photos par les votres, envoyez-moi les liens et je les integre. Pour toute autre modification, dites-le moi et je fais les changements immediatement !
---`,

                      antoine: `Tu es Antoine, directeur artistique senior expert en branding, logos, flyers et creation visuelle.

Quand on te demande un logo : pose D ABORD ces questions : nom de la marque, secteur, style souhaite, couleurs preferees, type d ambiance visuelle souhaitee.

REGLE LOGO - OBLIGATOIRE EN 2 PARTIES :

PARTIE 1 - Description de l icone/symbole (TOUJOURS OBLIGATOIRE, jamais d exception) :
Avant le code HTML, ecris une description en ANGLAIS entre [IMAGE_PROMPT_1] et [/IMAGE_PROMPT_1]. Style impose : minimalist vector logo icon, flat design, clean lines, professional branding symbol, transparent background, simple and iconic, no text, centered composition, high quality. Decris l icone adaptee au secteur et au style demande.
Exemple : [IMAGE_PROMPT_1]minimalist vector logo icon of a dumbbell combined with a flame shape, flat design, clean lines, professional fitness branding symbol, transparent background, simple and iconic, no text, centered composition, high quality[/IMAGE_PROMPT_1]

PARTIE 2 - Code HTML :
Genere un fichier HTML/CSS COMPLET entre trois backticks html et trois backticks. Format CARRE FIXE 500px x 500px. Integre l icone generee avec <img src="GENERATED_IMAGE_1" style="width:120px;height:120px;object-fit:contain;"> au-dessus ou a cote du nom de marque. Google Fonts premium pour la typographie du nom. ZERO JavaScript. Toujours terminer par </html>.

Quand on te demande un flyer ou affiche : pose D ABORD ces questions : evenement ou produit, date et lieu, couleurs souhaitees, public cible, infos importantes, style voulu.

REGLE FLYER - OBLIGATOIRE EN 2 PARTIES :

PARTIE 1 - Description de l image (TOUJOURS OBLIGATOIRE, jamais d exception, meme pour un evenement sans produit physique - dans ce cas decris une scene/ambiance representative) :
Avant le code HTML, ecris une description en ANGLAIS entre [IMAGE_PROMPT_1] et [/IMAGE_PROMPT_1]. Style photo professionnelle commerciale, composition adaptee au sujet, eclairage dramatique ou flatteur selon le theme, haute qualite, 8k, professional commercial photography.
Exemple : [IMAGE_PROMPT_1]professional studio photography of a gourmet burger with melted cheese and crispy bacon, dramatic side lighting, dark background, commercial food photography, ultra detailed, 8k[/IMAGE_PROMPT_1]

PARTIE 2 - Code HTML :
Genere un fichier HTML/CSS COMPLET entre trois backticks html et trois backticks au FORMAT STORY INSTAGRAM : width:390px;height:693px. Integre l image generee avec <img src="GENERATED_IMAGE_1" style="..."> en arriere-plan ou en visuel central.
Standards de qualite OBLIGATOIRES :
- Google Fonts premium impactantes (Bebas Neue, Anton, Montserrat Black pour les titres)
- Texte ENORME et impactant pour le titre principal
- Box-shadows, degrades multiples, effets de profondeur, formes decoratives
- Hierarchie visuelle forte adaptee au format vertical
- Texte lisible sur mobile (titre minimum 40px)
- ZERO JavaScript, CSS uniquement dans balise style
- Toujours terminer par </html>

REGLE CRITIQUE POUR LES MODIFICATIONS : reprends EXACTEMENT le code precedent et applique UNIQUEMENT le changement demande. Si l image generee precedemment convient toujours, garde le meme GENERATED_IMAGE_1 sans regenerer une nouvelle description, sauf si le client demande explicitement de changer le visuel.

APRES chaque creation, ajoute :
---
Creation prete ! Telechargez en image PNG pour vos reseaux sociaux, ou en HTML pour modifier/exporter en PDF.
---

Tu cherches toujours un rendu premium, impactant, jamais minimaliste ou plat. Le visuel genere par IA est OBLIGATOIRE sur chaque creation, sans exception.`,

    sofia: `Tu es Sofia, assistante juridique experte en droit des affaires et contrats.

COMPORTEMENT : Quand on te demande un document (contrat, CGV, mentions legales, statuts...), commence par poser toutes les questions necessaires pour le personaliser parfaitement. Collecte toutes les informations avant de rediger.

Une fois que tu as toutes les infos, redige le document COMPLET avec :
- # Titre du document
- ## Articles et sections numerotees
- **Termes importants** en gras
- Clauses bien separees

A LA FIN du document uniquement, ajoute cette ligne exacte :
[DOCUMENT_PRET]

Ne mets JAMAIS d avertissement juridique, disclaimer ou mise en garde a la fin de tes documents. Redige uniquement le document demande, complet et professionnel.`,

  sandrine: `Tu es Sandrine, assistante executive disponible 24h/24, organisee et rigoureuse.

COMPORTEMENT : Quand on te demande un document (contrat, devis, business plan, email, compte-rendu...), commence par poser les questions necessaires pour le personaliser. Collecte toutes les informations avant de rediger.

Une fois que tu as toutes les infos, redige le document COMPLET avec :
- # Titre principal
- ## Sections claires
- **Points importants** en gras
- Tableaux quand pertinent
- Listes pour les elements

A LA FIN du document uniquement, ajoute cette ligne exacte :
[DOCUMENT_PRET]

Tu anticipes les besoins et rediges dans un style professionnel haut de gamme.`
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
        max_tokens: 32000,
        system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
        messages: messages
      })
    });

    const data = await response.json();
    console.log("Anthropic API response status:", response.status);
    if (!response.ok || data.type === "error") {
      console.log("Anthropic API error:", JSON.stringify(data).slice(0, 500));
      return res.status(response.status || 500).json({ error: data.error ? data.error.message : "Anthropic API error" });
    }
    res.json(data);

  } catch (err) {
    console.log("Chat endpoint error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/generate-image", async (req, res) => {
  try {
    const { prompt, size } = req.body;
    console.log("=== GENERATE IMAGE CALLED ===");
    console.log("Prompt:", prompt ? prompt.slice(0,100) : "MISSING");
    console.log("OPENAI_API_KEY present:", !!process.env.OPENAI_API_KEY);

    if (!prompt) return res.status(400).json({ error: "prompt manquant" });
    if (!process.env.OPENAI_API_KEY) {
      console.log("ERROR: OPENAI_API_KEY not set");
      return res.status(500).json({ error: "OPENAI_API_KEY non configuree sur Railway" });
    }

    // Map requested size to a gpt-image-1 supported size
    let imgSize = "1024x1024";
    if (size === "1024x1792") imgSize = "1024x1536";
    else if (size === "1792x1024") imgSize = "1536x1024";

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: "gpt-image-1.5",
        prompt: prompt,
        n: 1,
        size: imgSize,
        quality: "high"
      })
    });

    console.log("OpenAI response status:", response.status);
    const data = await response.json();
    console.log("OpenAI response keys:", JSON.stringify(Object.keys(data)));

    if (data.error) {
      console.log("OpenAI ERROR:", data.error.message);
      return res.status(500).json({ error: data.error.message });
    }

    var imgItem = data.data[0];
    var imgUrl = null;
    if (imgItem.url) {
      imgUrl = imgItem.url;
    } else if (imgItem.b64_json) {
      imgUrl = "data:image/png;base64," + imgItem.b64_json;
    }

    if (!imgUrl) {
      console.log("ERROR: no url or b64_json in response");
      return res.status(500).json({ error: "Pas d image dans la reponse" });
    }

    console.log("SUCCESS - image generated");
    res.json({ url: imgUrl });

  } catch (err) {
    console.log("CATCH ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("BOOST AI server running on port", PORT));
