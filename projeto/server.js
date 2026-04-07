const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const app = express();

app.use(express.json());
app.use(express.static("public"));

// banco
const db = new sqlite3.Database("messages.db");

function ensureSchema(callback) {
    db.serialize(() => {
        db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `);

        db.all("PRAGMA table_info(messages)", (err, columns) => {
            if (err) {
                return callback(err);
            }

            const hasName = columns.some((column) => column.name === "name");

            if (hasName) {
                return callback(null);
            }

            db.run("ALTER TABLE messages ADD COLUMN name TEXT DEFAULT 'Anonimo'", (alterErr) => {
                callback(alterErr || null);
            });
        });
    });
}

// pegar mensagens
app.get("/messages", (req, res) => {
    db.all("SELECT * FROM messages ORDER BY id DESC LIMIT 50", (err, rows) => {
        res.json(rows);
    });
});

// enviar mensagem
app.post("/messages", (req, res) => {
    const { text, name } = req.body;
    const cleanName = String(name || "").trim();

    if (!text || text.length > 200) {
        return res.status(400).send("Mensagem inválida");
    }

    if (!cleanName || cleanName.length > 30) {
        return res.status(400).send("Nome inválido");
    }

    db.run("INSERT INTO messages (name, text) VALUES (?, ?)", [cleanName, text], () => {
        res.sendStatus(200);
    });
});

ensureSchema((schemaErr) => {
    if (schemaErr) {
        console.error("Erro ao preparar banco:", schemaErr.message);
        process.exit(1);
    }

    app.listen(8080, () => {
        console.log("Servidor rodando em http://localhost:8080");
    });
});