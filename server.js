/**
 * Guangzhou TK Trading — service WhatsApp Baileys
 *
 * Se connecte à WhatsApp Web via Baileys et expose un point d'entrée HTTP que
 * le site TK Trading (Next.js) appelle pour envoyer les notifications de suivi.
 * Numéro utilisé : le numéro chinois de l'entreprise (+86 186 2017 6205).
 *
 * Premier lancement : scanner le QR code (terminal ou page /qr) avec WhatsApp
 * sur le téléphone du numéro chinois. La session est ensuite enregistrée dans
 * ./auth_state/ — les redémarrages suivants se reconnectent tout seuls.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
} = require("baileys");
const { usePostgresAuthState } = require("./auth-postgres");

const PORT = process.env.PORT || 3001;
const API_TOKEN = process.env.API_TOKEN || "change-me-in-railway";
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "auth_state");
const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || "1500", 10);

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

let sock = null;
let connectionState = "disconnected";
let pendingQr = null; // latest QR string, cleared once scanned

/** Normalize a phone number into Baileys' JID format (e.g. "237673473230@s.whatsapp.net"). */
function toJid(phone) {
  const clean = String(phone).replace(/[^\d]/g, "");
  return `${clean}@s.whatsapp.net`;
}

async function startSock() {
  // Session en base si DATABASE_URL est fourni (indispensable sur Render :
  // le disque y est effacé à chaque redémarrage). Sinon, dossier local.
  let state, saveCreds, clearAuth;
  if (process.env.DATABASE_URL) {
    ({ state, saveCreds, clearAuth } = await usePostgresAuthState(
      process.env.DATABASE_URL,
    ));
    console.log("[auth] session WhatsApp stockée en base PostgreSQL");
  } else {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    clearAuth = async () => fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log(`[auth] session WhatsApp stockée dans ${AUTH_DIR}`);
  }
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    logger,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      pendingQr = qr;
      console.log("\n================================================");
      console.log("📱 SCANNEZ CE QR AVEC LE WHATSAPP CHINOIS (+86 186 2017 6205)");
      console.log("================================================");
      console.log("Option 1 - Open in your browser:");
      console.log("  https://<your-railway-url>/qr");
      console.log("Option 2 - Scan from terminal (if visible):\n");
      qrcodeTerminal.generate(qr, { small: true });
      console.log("\nOn your phone:");
      console.log("  WhatsApp Business → Settings → Linked Devices → Link a Device\n");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[code] || code;
      console.warn(`[baileys] Connection closed. Reason: ${reason}`);
      connectionState = "disconnected";
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("[baileys] Reconnecting in 3s...");
        setTimeout(() => startSock().catch((e) => console.error(e)), 3000);
      } else {
        // WhatsApp a invalidé la session (téléphone hors ligne trop longtemps,
        // appareil délié…). On efface la session périmée et on relance : un
        // nouveau QR est alors proposé sur /qr, au lieu de rester bloqué sans
        // aucun moyen de se reconnecter.
        console.error("[baileys] Session invalidée — nettoyage et nouveau QR.");
        setTimeout(async () => {
          try {
            if (clearAuth) await clearAuth();
          } catch (e) {
            console.error("[baileys] clearAuth a échoué:", e);
          }
          startSock().catch((e) => console.error(e));
        }, 2000);
      }
    } else if (connection === "open") {
      connectionState = "connected";
      pendingQr = null;
      const me = sock.user?.id?.split(":")[0];
      console.log(`✅ Connected to WhatsApp as ${me}`);
    } else if (connection === "connecting") {
      connectionState = "connecting";
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "32kb" }));

// Public endpoints (no auth required): /health, /qr
const PUBLIC_PATHS = new Set(["/health", "/qr", "/"]);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token !== API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

app.get("/", (_req, res) => {
  res.redirect("/qr");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    connection: connectionState,
    hasQr: Boolean(pendingQr),
    time: new Date().toISOString(),
  });
});

// Public QR page — visit this from your phone or computer browser to scan with
// WhatsApp Business → Linked Devices → Link a Device.
app.get("/qr", async (_req, res) => {
  if (connectionState === "connected") {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:48px;">
        <h1 style="color:#16a34a;">✅ Already connected</h1>
        <p>The WhatsApp account is linked. No QR code needed.</p>
      </body></html>
    `);
  }
  if (!pendingQr) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:48px;">
        <h1>⏳ Generating QR code…</h1>
        <p>Refresh this page in 5 seconds.</p>
        <script>setTimeout(()=>location.reload(),5000)</script>
      </body></html>
    `);
  }
  try {
    const dataUrl = await QRCode.toDataURL(pendingQr, { width: 360, margin: 2 });
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:24px;">
        <h1>📱 TK Trading — connecter WhatsApp</h1>
        <p>1. Ouvrez WhatsApp sur le téléphone du numéro chinois (+86 186 2017 6205)<br/>
           2. Paramètres → Appareils connectés → Connecter un appareil<br/>
           3. Dirigez la caméra vers ce code</p>
        <img src="${dataUrl}" alt="QR" style="border:8px solid #16a34a;border-radius:12px;"/>
        <p style="color:#666;font-size:13px;">QR refreshes automatically every 20 seconds.</p>
        <script>setTimeout(()=>location.reload(),18000)</script>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send("QR render error: " + e.message);
  }
});

app.post("/send", async (req, res) => {
  if (connectionState !== "connected" || !sock) {
    return res.status(503).json({
      ok: false,
      error: `Not connected to WhatsApp (state: ${connectionState})`,
    });
  }
  const { to, message } = req.body || {};
  if (!to || !message) {
    return res.status(400).json({ ok: false, error: "Body must include {to, message}" });
  }

  const jid = toJid(to);

  try {
    // Verify the recipient actually has WhatsApp
    const [check] = await sock.onWhatsApp(jid);
    if (!check?.exists) {
      return res
        .status(400)
        .json({ ok: false, error: `Number ${to} is not on WhatsApp` });
    }

    // Small delay to look less bot-like
    await new Promise((r) => setTimeout(r, SEND_DELAY_MS));

    const sent = await sock.sendMessage(jid, { text: message });
    return res.json({ ok: true, id: sent?.key?.id });
  } catch (e) {
    console.error("send failed:", e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "Failed to send" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 TK Trading Baileys service listening on port ${PORT}`);
  console.log(`   Health: GET  http://localhost:${PORT}/health`);
  console.log(`   Send:   POST http://localhost:${PORT}/send`);
  console.log(`   API_TOKEN: ${API_TOKEN === "change-me-in-railway" ? "⚠️ DEFAULT — change in production" : "✓ set"}`);
  startSock().catch((e) => {
    console.error("Fatal: failed to start WhatsApp socket:", e);
    process.exit(1);
  });

  // Anti-mise en veille : l'offre gratuite de Render endort un service resté
  // 15 min sans requête, et le réveil prend ~50 s — le premier message d'un
  // colis partirait donc en retard, voire échouerait. Un appel régulier sur
  // sa propre adresse maintient le service éveillé.
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) {
    setInterval(
      () => {
        fetch(`${publicUrl.replace(/\/$/, "")}/health`).catch(() => {});
      },
      10 * 60 * 1000,
    );
    console.log(`[keepalive] auto-appel de ${publicUrl}/health toutes les 10 min`);
  }
});
