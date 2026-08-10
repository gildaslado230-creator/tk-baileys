/**
 * Stockage de la session WhatsApp dans PostgreSQL.
 *
 * Pourquoi : sur l'offre gratuite de Render, le disque est effacé à chaque
 * redémarrage, mise en veille ou redéploiement. Avec la session écrite dans un
 * dossier local, le robot perdrait son lien WhatsApp en permanence et il
 * faudrait rescanner le QR code sans arrêt.
 *
 * En base, la session survit à tout : un seul scan suffit, une fois pour
 * toutes.
 */
const { Pool } = require("pg");
const { initAuthCreds, BufferJSON, proto } = require("baileys");

const TABLE = "whatsapp_auth";

async function usePostgresAuthState(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       id   TEXT PRIMARY KEY,
       data TEXT NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const read = async (id) => {
    const { rows } = await pool.query(
      `SELECT data FROM ${TABLE} WHERE id = $1`,
      [id],
    );
    if (!rows.length) return null;
    try {
      return JSON.parse(rows[0].data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const write = async (id, value) => {
    const data = JSON.stringify(value, BufferJSON.replacer);
    await pool.query(
      `INSERT INTO ${TABLE} (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [id, data],
    );
  };

  const remove = async (id) => {
    await pool.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
  };

  const creds = (await read("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`);
              // Les clés de synchronisation ont un format particulier.
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) out[id] = value;
            }),
          );
          return out;
        },
        set: async (data) => {
          const tasks = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const key = `${type}-${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write("creds", creds),
    /** Efface la session (déconnexion WhatsApp : il faudra rescanner). */
    clearAuth: async () => {
      await pool.query(`DELETE FROM ${TABLE}`);
    },
  };
}

module.exports = { usePostgresAuthState };
