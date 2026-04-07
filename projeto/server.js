const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const app = express();

app.use(express.json());
app.use(express.static("public"));

// banco
const db = new sqlite3.Database("messages.db");

db.run(`
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

// pegar mensagens
app.get("/messages", (req, res) => {
    db.all("SELECT * FROM messages ORDER BY id DESC LIMIT 50", (err, rows) => {
        res.json(rows);
    });
});

// enviar mensagem
app.post("/messages", (req, res) => {
    const { text } = req.body;

    if (!text || text.length > 200) {
        return res.status(400).send("Mensagem inválida");
    }

    db.run("INSERT INTO messages (text) VALUES (?)", [text], () => {
        res.sendStatus(200);
    });
});

app.listen(8080, () => {
    console.log("Servidor rodando em http://localhost:8080");
});