const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const multer = require("multer");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: true,
        credentials: true
    }
});

const uploadsDir = path.join(__dirname, "public", "uploads");
const channelPagePath = path.join(__dirname, "private-pages", "channel.html");
const myIpPagePath = path.join(__dirname, "private-pages", "meuip.html");
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_PROFILE = {
    avatarUrl: "",
    nameColor: "#93c5fd",
    statusText: ""
};

app.set("trust proxy", true);

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const allowedMimeTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/bmp",
    "image/svg+xml",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-matroska-3d",
    "video/mkv",
    "video/matroska",
    "application/x-matroska",
    "video/x-matroska",
    "video/ogg",
    "application/pdf",
    "application/zip",
    "application/x-zip-compressed",
    "application/x-rar-compressed",
    "application/x-7z-compressed",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/json",
    "application/octet-stream",
    "text/plain",
    "text/csv"
]);

const allowedFileExtensions = new Set([
    ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg",
    ".mp4", ".webm", ".mov", ".mkv", ".ogv",
    ".pdf", ".zip", ".rar", ".7z",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".txt", ".csv", ".json"
]);

const uploadStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const safeOriginal = path.basename(file.originalname || "arquivo");
        const ext = path.extname(safeOriginal).slice(0, 15);
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${unique}${ext}`);
    }
});

const upload = multer({
    storage: uploadStorage,
    limits: {
        fileSize: MAX_UPLOAD_BYTES
    },
    fileFilter: (_req, file, cb) => {
        const mime = String(file.mimetype || "").toLowerCase();
        const ext = path.extname(file.originalname || "").toLowerCase();

        if (allowedMimeTypes.has(mime) || allowedFileExtensions.has(ext)) {
            return cb(null, true);
        }

        return cb(new Error("Tipo de arquivo não permitido"));
    }
});

app.use(express.json());

function normalizeCandidateIp(rawValue) {
    let candidate = String(rawValue || "").trim();

    if (!candidate) {
        return "";
    }

    if (candidate.startsWith("[") && candidate.includes("]")) {
        const endBracketIndex = candidate.indexOf("]");
        candidate = candidate.slice(1, endBracketIndex);
    }

    const ipv4WithPortMatch = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);

    if (ipv4WithPortMatch) {
        candidate = ipv4WithPortMatch[1];
    }

    if (candidate.startsWith("::ffff:")) {
        candidate = candidate.slice(7);
    }

    const zoneSuffixIndex = candidate.indexOf("%");

    if (zoneSuffixIndex > -1) {
        candidate = candidate.slice(0, zoneSuffixIndex);
    }

    return candidate;
}

function getClientIpInfo(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "");
    const forwardedCandidates = forwarded
        .split(",")
        .map((entry) => normalizeCandidateIp(entry))
        .filter(Boolean);
    const fallbackCandidates = [
        normalizeCandidateIp(req.ip),
        normalizeCandidateIp(req.socket?.remoteAddress)
    ].filter(Boolean);

    const allCandidates = [...forwardedCandidates, ...fallbackCandidates];
    const seen = new Set();
    let detectedIp = "";
    let ipv4 = "";
    let ipv6 = "";

    allCandidates.forEach((candidate) => {
        if (seen.has(candidate)) {
            return;
        }

        seen.add(candidate);
        const family = net.isIP(candidate);

        if (!family) {
            return;
        }

        if (!detectedIp) {
            detectedIp = candidate;
        }

        if (family === 4 && !ipv4) {
            ipv4 = candidate;
        }

        if (family === 6 && !ipv6) {
            ipv6 = candidate;
        }
    });

    return {
        ip: detectedIp || "desconhecido",
        ipv4: ipv4 || null,
        ipv6: ipv6 || null
    };
}

app.get("/api/meu-ip", (req, res) => {
    const ipInfo = getClientIpInfo(req);

    res.json({
        ...ipInfo,
        at: new Date().toISOString()
    });
});

app.get(/^\/meu-?ip\/?$/, (_req, res) => {
    res.sendFile(myIpPagePath, (err) => {
        if (err) {
            res.status(500).send("Nao foi possivel abrir a pagina");
        }
    });
});

app.get(/^\/channel\/?$/, (_req, res) => {
    res.sendFile(channelPagePath, (err) => {
        if (err) {
            res.status(500).send("Nao foi possivel abrir a pagina");
        }
    });
});

app.use(express.static("public"));
app.use("/uploads", express.static(uploadsDir));

const ADMIN_SECRET = String(process.env.ADMIN_SECRET || "poderesdoademir").trim();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_CHANNEL_ID = 1;
const DEFAULT_CHANNEL_NAME = "geral";
const PRESENCE_TTL_MS = 1000 * 45;
const TYPING_TTL_MS = 1000 * 6;
const MAX_VOICE_PARTICIPANTS = 3;

const onlineUsers = new Map();
const typingByChannel = new Map();
const voiceParticipantsByChannel = new Map();
const voiceStateBySocketId = new Map();

function hashToken(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(size = 24) {
    return crypto.randomBytes(size).toString("hex");
}

function cleanupRealtimeState() {
    const now = Date.now();

    for (const [username, lastSeen] of onlineUsers.entries()) {
        if (now - lastSeen > PRESENCE_TTL_MS) {
            onlineUsers.delete(username);
        }
    }

    for (const [channelId, usersMap] of typingByChannel.entries()) {
        for (const [username, startedAt] of usersMap.entries()) {
            if (now - startedAt > TYPING_TTL_MS) {
                usersMap.delete(username);
            }
        }

        if (usersMap.size === 0) {
            typingByChannel.delete(channelId);
        }
    }
}

function setUserOnline(username) {
    if (!username) {
        return;
    }

    onlineUsers.set(username, Date.now());
}

function setTyping(channelId, username, isTyping) {
    if (!channelId || !username) {
        return;
    }

    const key = String(channelId);
    const usersMap = typingByChannel.get(key) || new Map();

    if (isTyping) {
        usersMap.set(username, Date.now());
        typingByChannel.set(key, usersMap);
        return;
    }

    usersMap.delete(username);

    if (usersMap.size === 0) {
        typingByChannel.delete(key);
    } else {
        typingByChannel.set(key, usersMap);
    }
}

function clearUserTyping(username) {
    if (!username) {
        return;
    }

    for (const [channelId, usersMap] of typingByChannel.entries()) {
        usersMap.delete(username);

        if (usersMap.size === 0) {
            typingByChannel.delete(channelId);
        }
    }
}

function getVoiceRoomName(channelId) {
    return `voice:${channelId}`;
}

function removeSocketFromVoice(socketId) {
    const state = voiceStateBySocketId.get(socketId);

    if (!state) {
        return null;
    }

    const channelKey = String(state.channelId);
    const participants = voiceParticipantsByChannel.get(channelKey);

    if (participants) {
        participants.delete(socketId);

        if (participants.size === 0) {
            voiceParticipantsByChannel.delete(channelKey);
        }
    }

    voiceStateBySocketId.delete(socketId);
    return state;
}

setInterval(cleanupRealtimeState, 5000).unref();

function readBearerToken(req) {
    const header = String(req.headers.authorization || "");

    if (!header.toLowerCase().startsWith("bearer ")) {
        return "";
    }

    return header.slice(7).trim();
}

function requireAuth(req, res, next) {
    const token = readBearerToken(req);

    if (!token) {
        return res.status(401).json({ error: "Nao autorizado" });
    }

    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    authDb.get(
        `
        SELECT s.id AS session_id, s.username
        FROM auth_sessions s
        WHERE s.token_hash = ? AND s.expires_at > ?
        `,
        [tokenHash, now],
        (err, row) => {
            if (err) {
                return res.status(500).json({ error: "Erro ao validar sessao" });
            }

            if (!row) {
                return res.status(401).json({ error: "Sessao invalida ou expirada" });
            }

            return authDb.get(
                "SELECT expires_at FROM user_bans WHERE username = ? AND expires_at > ?",
                [row.username, now],
                (banErr, banRow) => {
                    if (banErr) {
                        return res.status(500).json({ error: "Erro ao validar bloqueio" });
                    }

                    if (banRow) {
                        return res.status(403).json({ error: "Usuario temporariamente banido" });
                    }

                    setUserOnline(row.username);
                    req.auth = { username: row.username, sessionId: row.session_id };
                    return next();
                }
            );
        }
    );
}

function requireAdmin(req, res, next) {
    if (!ADMIN_SECRET) {
        return res.status(500).json({ error: "ADMIN_SECRET nao configurado" });
    }

    const adminSecretHeader = String(req.headers["x-admin-secret"] || "").trim();

    if (adminSecretHeader !== ADMIN_SECRET) {
        return res.status(403).json({ error: "Acesso admin negado" });
    }

    return next();
}

function normalizeProfileRow(row = {}) {
    return {
        username: String(row.username || ""),
        avatarUrl: String(row.avatar_url || DEFAULT_PROFILE.avatarUrl),
        nameColor: String(row.name_color || DEFAULT_PROFILE.nameColor),
        statusText: String(row.status_text || DEFAULT_PROFILE.statusText)
    };
}

function readProfileByUsername(username, callback) {
    authDb.get(
        "SELECT username, avatar_url, name_color, status_text FROM user_profiles WHERE username = ?",
        [username],
        (err, row) => {
            if (err) {
                return callback(err);
            }

            if (!row) {
                return callback(null, {
                    username,
                    avatarUrl: DEFAULT_PROFILE.avatarUrl,
                    nameColor: DEFAULT_PROFILE.nameColor,
                    statusText: DEFAULT_PROFILE.statusText
                });
            }

            return callback(null, normalizeProfileRow(row));
        }
    );
}

function isValidColor(value) {
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value || ""));
}

function parseMinutes(value, fallback = 60, max = 43200) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.min(parsed, max);
}

function logAdminActivity({ action, actor = "admin", targetUsername = null, channelId = null, details = null }) {
    authDb.run(
        "INSERT INTO admin_activity (action, actor, target_username, channel_id, details) VALUES (?, ?, ?, ?, ?)",
        [action, actor, targetUsername, channelId, details]
    );
}

function setupVoiceSocketHandlers() {
    io.use((socket, next) => {
        const token = String(socket.handshake.auth?.token || "").trim();

        if (!token) {
            return next(new Error("nao autorizado"));
        }

        const tokenHash = hashToken(token);
        const now = new Date().toISOString();

        return authDb.get(
            `
            SELECT s.username
            FROM auth_sessions s
            WHERE s.token_hash = ? AND s.expires_at > ?
            `,
            [tokenHash, now],
            (err, row) => {
                if (err || !row) {
                    return next(new Error("nao autorizado"));
                }

                return authDb.get(
                    "SELECT expires_at FROM user_bans WHERE username = ? AND expires_at > ?",
                    [row.username, now],
                    (banErr, banRow) => {
                        if (banErr || banRow) {
                            return next(new Error("nao autorizado"));
                        }

                        socket.data.username = row.username;
                        setUserOnline(row.username);
                        return next();
                    }
                );
            }
        );
    });

    io.on("connection", (socket) => {
        socket.on("voice:join", ({ channelId }, callback) => {
            const ack = typeof callback === "function" ? callback : () => {};
            const parsedChannelId = parseChannelId(channelId, DEFAULT_CHANNEL_ID);

            resolveChannel(parsedChannelId, (channelErr) => {
                if (channelErr) {
                    ack({ ok: false, error: "Canal nao encontrado" });
                    socket.emit("voice:error", { error: "Canal nao encontrado" });
                    return;
                }

                const currentState = voiceStateBySocketId.get(socket.id);

                if (currentState?.channelId === parsedChannelId) {
                    ack({ ok: true, channelId: parsedChannelId, alreadyJoined: true });
                    return;
                }

                const targetChannelKey = String(parsedChannelId);
                const targetParticipants = voiceParticipantsByChannel.get(targetChannelKey) || new Map();

                if (targetParticipants.size >= MAX_VOICE_PARTICIPANTS) {
                    ack({ ok: false, error: "Canal de voz cheio (maximo de 3 pessoas)" });
                    socket.emit("voice:error", { error: "Canal de voz cheio (maximo de 3 pessoas)" });
                    return;
                }

                const previous = removeSocketFromVoice(socket.id);

                if (previous?.channelId) {
                    socket.leave(getVoiceRoomName(previous.channelId));
                    socket.to(getVoiceRoomName(previous.channelId)).emit("voice:user-left", { socketId: socket.id });
                }

                const channelKey = String(parsedChannelId);
                const participants = voiceParticipantsByChannel.get(channelKey) || new Map();
                const existingParticipants = Array.from(participants.entries()).map(([id, value]) => ({
                    socketId: id,
                    username: value.username,
                    muted: Boolean(value.muted),
                    speaking: Boolean(value.speaking),
                    deafened: Boolean(value.deafened)
                }));

                participants.set(socket.id, {
                    username: socket.data.username,
                    muted: false,
                    speaking: false,
                    deafened: false
                });

                voiceParticipantsByChannel.set(channelKey, participants);
                voiceStateBySocketId.set(socket.id, {
                    channelId: parsedChannelId,
                    username: socket.data.username,
                    muted: false,
                    speaking: false,
                    deafened: false
                });

                socket.join(getVoiceRoomName(parsedChannelId));
                ack({ ok: true, channelId: parsedChannelId });
                socket.emit("voice:participants", {
                    channelId: parsedChannelId,
                    participants: existingParticipants
                });

                socket.to(getVoiceRoomName(parsedChannelId)).emit("voice:user-joined", {
                    socketId: socket.id,
                    username: socket.data.username,
                    muted: false,
                    speaking: false,
                    deafened: false
                });
            });
        });

        socket.on("voice:leave", () => {
            const removed = removeSocketFromVoice(socket.id);

            if (!removed?.channelId) {
                return;
            }

            socket.leave(getVoiceRoomName(removed.channelId));
            socket.to(getVoiceRoomName(removed.channelId)).emit("voice:user-left", { socketId: socket.id });
        });

        socket.on("voice:mute", ({ muted }) => {
            const state = voiceStateBySocketId.get(socket.id);

            if (!state?.channelId) {
                return;
            }

            const isMuted = Boolean(muted);
            state.muted = isMuted;
            voiceStateBySocketId.set(socket.id, state);

            const participants = voiceParticipantsByChannel.get(String(state.channelId));

            if (participants?.has(socket.id)) {
                participants.set(socket.id, {
                    ...participants.get(socket.id),
                    muted: isMuted
                });
            }

            io.to(getVoiceRoomName(state.channelId)).emit("voice:user-muted", {
                socketId: socket.id,
                muted: isMuted
            });
        });

        socket.on("voice:deafen", ({ deafened }) => {
            const state = voiceStateBySocketId.get(socket.id);

            if (!state?.channelId) {
                return;
            }

            const isDeafened = Boolean(deafened);
            state.deafened = isDeafened;

            // Comportamento estilo Discord: ensurdecer tambem muta o microfone.
            if (isDeafened) {
                state.muted = true;
                state.speaking = false;
            }

            voiceStateBySocketId.set(socket.id, state);

            const participants = voiceParticipantsByChannel.get(String(state.channelId));

            if (participants?.has(socket.id)) {
                const previous = participants.get(socket.id) || {};
                participants.set(socket.id, {
                    ...previous,
                    deafened: isDeafened,
                    muted: isDeafened ? true : Boolean(previous.muted),
                    speaking: isDeafened ? false : Boolean(previous.speaking)
                });
            }

            io.to(getVoiceRoomName(state.channelId)).emit("voice:user-deafened", {
                socketId: socket.id,
                deafened: isDeafened
            });

            if (isDeafened) {
                io.to(getVoiceRoomName(state.channelId)).emit("voice:user-muted", {
                    socketId: socket.id,
                    muted: true
                });
            }
        });

        socket.on("voice:speaking", ({ speaking }) => {
            const state = voiceStateBySocketId.get(socket.id);

            if (!state?.channelId) {
                return;
            }

            const isSpeaking = Boolean(speaking) && !state.muted;

            if (state.speaking === isSpeaking) {
                return;
            }

            state.speaking = isSpeaking;
            voiceStateBySocketId.set(socket.id, state);

            const participants = voiceParticipantsByChannel.get(String(state.channelId));

            if (participants?.has(socket.id)) {
                participants.set(socket.id, {
                    ...participants.get(socket.id),
                    speaking: isSpeaking
                });
            }

            io.to(getVoiceRoomName(state.channelId)).emit("voice:user-speaking", {
                socketId: socket.id,
                speaking: isSpeaking
            });
        });

        socket.on("voice:signal", ({ to, data }) => {
            const state = voiceStateBySocketId.get(socket.id);

            if (!state?.channelId || !to || !data) {
                return;
            }

            const targetState = voiceStateBySocketId.get(String(to));

            if (!targetState || targetState.channelId !== state.channelId) {
                return;
            }

            io.to(String(to)).emit("voice:signal", {
                from: socket.id,
                data
            });
        });

        socket.on("voice:latency:ping", ({ sentAt }, callback) => {
            const ack = typeof callback === "function" ? callback : () => {};
            ack({
                sentAt: Number.isFinite(Number(sentAt)) ? Number(sentAt) : null,
                serverAt: Date.now()
            });
        });

        socket.on("disconnect", () => {
            const removed = removeSocketFromVoice(socket.id);

            if (removed?.channelId) {
                socket.to(getVoiceRoomName(removed.channelId)).emit("voice:user-left", { socketId: socket.id });
            }
        });
    });
}

// bancos
const messagesDb = new sqlite3.Database("messages.db");
const authDb = new sqlite3.Database("auth.db");
const channelsDb = new sqlite3.Database("channels.db");

function ensureChannelsSchema(callback) {
    channelsDb.serialize(() => {
        channelsDb.run(`
        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `, (createErr) => {
            if (createErr) {
                return callback(createErr);
            }

            channelsDb.run(
                `INSERT OR IGNORE INTO channels (id, name, created_by) VALUES (${DEFAULT_CHANNEL_ID}, ?, 'system')`,
                [DEFAULT_CHANNEL_NAME],
                callback
            );
        });
    });
}

function migrateLegacyChannelsFromMessagesDb(callback) {
    messagesDb.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channels'",
        (tableErr, tableRow) => {
            if (tableErr || !tableRow) {
                return callback(null);
            }

            return messagesDb.all(
                "SELECT id, name, created_by, created_at FROM channels ORDER BY id ASC",
                (readErr, rows) => {
                    if (readErr || !rows || rows.length === 0) {
                        return callback(null);
                    }

                    let pending = rows.length;
                    let failed = false;

                    rows.forEach((row) => {
                        channelsDb.run(
                            "INSERT OR IGNORE INTO channels (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
                            [row.id, row.name, row.created_by, row.created_at],
                            (insertErr) => {
                                if (failed) {
                                    return;
                                }

                                if (insertErr) {
                                    failed = true;
                                    return callback(insertErr);
                                }

                                pending -= 1;

                                if (pending === 0) {
                                    return callback(null);
                                }
                            }
                        );
                    });
                }
            );
        }
    );
}

function ensureAuthSchema(callback) {
    authDb.serialize(() => {
        authDb.run(`
        CREATE TABLE IF NOT EXISTS access_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key_hash TEXT NOT NULL UNIQUE,
            username TEXT NOT NULL UNIQUE,
            active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_used_at DATETIME
        )
        `);

        authDb.run(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT NOT NULL UNIQUE,
            username TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL
        )
        `);

        authDb.run(`
        CREATE TABLE IF NOT EXISTS user_profiles (
            username TEXT PRIMARY KEY,
            avatar_url TEXT,
            bio TEXT,
            name_color TEXT,
            status_text TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `);

        authDb.run(`
        CREATE TABLE IF NOT EXISTS user_bans (
            username TEXT PRIMARY KEY,
            reason TEXT,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `);

        authDb.run(`
        CREATE TABLE IF NOT EXISTS user_mutes (
            username TEXT PRIMARY KEY,
            reason TEXT,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `);

        authDb.run(`
        CREATE TABLE IF NOT EXISTS admin_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            actor TEXT,
            target_username TEXT,
            channel_id INTEGER,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `, callback);
    });
}

function ensureMessagesSchema(callback) {
    messagesDb.serialize(() => {
        messagesDb.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT DEFAULT 'Anonimo',
            text TEXT,
            file_url TEXT,
            file_name TEXT,
            file_mime TEXT,
            file_size INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `);

        messagesDb.run(`
        CREATE TABLE IF NOT EXISTS public_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `);

        messagesDb.all("PRAGMA table_info(messages)", (err, columns) => {
            if (err) {
                return callback(err);
            }

            const existingColumns = new Set(columns.map((column) => column.name));
            const requiredColumns = [
                { name: "name", sql: "ALTER TABLE messages ADD COLUMN name TEXT DEFAULT 'Anonimo'" },
                { name: "file_url", sql: "ALTER TABLE messages ADD COLUMN file_url TEXT" },
                { name: "file_name", sql: "ALTER TABLE messages ADD COLUMN file_name TEXT" },
                { name: "file_mime", sql: "ALTER TABLE messages ADD COLUMN file_mime TEXT" },
                { name: "file_size", sql: "ALTER TABLE messages ADD COLUMN file_size INTEGER" },
                { name: "channel_id", sql: `ALTER TABLE messages ADD COLUMN channel_id INTEGER DEFAULT ${DEFAULT_CHANNEL_ID}` },
                { name: "reply_to_id", sql: "ALTER TABLE messages ADD COLUMN reply_to_id INTEGER" },
                { name: "edited_at", sql: "ALTER TABLE messages ADD COLUMN edited_at DATETIME" }
            ];

            const pending = requiredColumns.filter((column) => !existingColumns.has(column.name));

            const finishMigration = () => {
                messagesDb.run(
                    `UPDATE messages SET channel_id = ${DEFAULT_CHANNEL_ID} WHERE channel_id IS NULL OR channel_id <= 0`,
                    (updateErr) => {
                        if (updateErr) {
                            return callback(updateErr);
                        }

                        return callback(null);
                    }
                );
            };

            if (pending.length === 0) {
                return finishMigration();
            }

            let pendingCount = pending.length;
            let failed = false;

            pending.forEach((column) => {
                messagesDb.run(column.sql, (alterErr) => {
                    if (failed) {
                        return;
                    }

                    if (alterErr) {
                        failed = true;
                        return callback(alterErr);
                    }

                    pendingCount -= 1;

                    if (pendingCount === 0) {
                        finishMigration();
                    }
                });
            });
        });
    });
}

function ensureSchema(callback) {
    ensureAuthSchema((authErr) => {
        if (authErr) {
            return callback(authErr);
        }

        return ensureChannelsSchema((channelsErr) => {
            if (channelsErr) {
                return callback(channelsErr);
            }

            return migrateLegacyChannelsFromMessagesDb((migrateErr) => {
                if (migrateErr) {
                    return callback(migrateErr);
                }

                return ensureMessagesSchema(callback);
            });
        });
    });
}

function parseChannelId(value, fallback = DEFAULT_CHANNEL_ID) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveChannel(channelId, callback) {
    channelsDb.get("SELECT id, name FROM channels WHERE id = ?", [channelId], (err, row) => {
        if (err) {
            return callback(err);
        }

        if (!row) {
            return callback(new Error("Canal nao encontrado"));
        }

        return callback(null, row);
    });
}

app.post("/auth/login", (req, res) => {
    const key = String(req.body?.key || "").trim();

    if (!key || key.length < 8 || key.length > 200) {
        return res.status(400).json({ error: "Chave invalida" });
    }

    const keyHash = hashToken(key);

    authDb.get(
        "SELECT id, username, active FROM access_keys WHERE key_hash = ?",
        [keyHash],
        (findErr, keyRow) => {
            if (findErr) {
                return res.status(500).json({ error: "Erro ao validar chave" });
            }

            if (!keyRow || Number(keyRow.active) !== 1) {
                return res.status(401).json({ error: "Chave invalida" });
            }

            const now = new Date().toISOString();

            return authDb.get(
                "SELECT expires_at FROM user_bans WHERE username = ? AND expires_at > ?",
                [keyRow.username, now],
                (banErr, banRow) => {
                    if (banErr) {
                        return res.status(500).json({ error: "Erro ao validar bloqueio" });
                    }

                    if (banRow) {
                        return res.status(403).json({ error: "Usuario temporariamente banido" });
                    }

                    const token = randomToken(32);
                    const tokenHash = hashToken(token);
                    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

                    authDb.run(
                        "INSERT INTO auth_sessions (token_hash, username, expires_at) VALUES (?, ?, ?)",
                        [tokenHash, keyRow.username, expiresAt],
                        (insertErr) => {
                            if (insertErr) {
                                return res.status(500).json({ error: "Erro ao criar sessao" });
                            }

                            authDb.run(
                                "UPDATE access_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?",
                                [keyRow.id]
                            );

                            return res.json({
                                token,
                                username: keyRow.username,
                                expiresAt
                            });
                        }
                    );
                }
            );
        }
    );
});

app.post("/auth/logout", requireAuth, (req, res) => {
    const token = readBearerToken(req);
    clearUserTyping(req.auth?.username);
    onlineUsers.delete(req.auth?.username);

    authDb.run("DELETE FROM auth_sessions WHERE token_hash = ?", [hashToken(token)], (err) => {
        if (err) {
            return res.status(500).json({ error: "Erro ao encerrar sessao" });
        }

        return res.status(204).end();
    });
});

app.get("/auth/me", requireAuth, (req, res) => {
    res.json({ username: req.auth.username });
});

app.get("/profile/me", requireAuth, (req, res) => {
    readProfileByUsername(req.auth.username, (err, profile) => {
        if (err) {
            return res.status(500).json({ error: "Erro ao carregar perfil" });
        }

        return res.json(profile);
    });
});

app.put("/profile/me", requireAuth, (req, res) => {
    const avatarUrl = String(req.body?.avatarUrl || "").trim().slice(0, 300);
    const nameColorInput = String(req.body?.nameColor || DEFAULT_PROFILE.nameColor).trim();
    const statusText = String(req.body?.statusText || "").trim().slice(0, 60);
    const nameColor = isValidColor(nameColorInput) ? nameColorInput : DEFAULT_PROFILE.nameColor;

    authDb.run(
        `
        INSERT INTO user_profiles (username, avatar_url, name_color, status_text, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username) DO UPDATE SET
            avatar_url = excluded.avatar_url,
            name_color = excluded.name_color,
            status_text = excluded.status_text,
            updated_at = CURRENT_TIMESTAMP
        `,
        [req.auth.username, avatarUrl, nameColor, statusText],
        (err) => {
            if (err) {
                return res.status(500).json({ error: "Erro ao salvar perfil" });
            }

            return readProfileByUsername(req.auth.username, (readErr, profile) => {
                if (readErr) {
                    return res.status(500).json({ error: "Erro ao carregar perfil" });
                }

                return res.json(profile);
            });
        }
    );
});

app.get("/profiles", requireAuth, (req, res) => {
    const usernames = String(req.query.usernames || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 100);

    if (usernames.length === 0) {
        return res.json([]);
    }

    const placeholders = usernames.map(() => "?").join(", ");

    return authDb.all(
        `
        SELECT username, avatar_url, name_color, status_text
        FROM user_profiles
        WHERE username IN (${placeholders})
        `,
        usernames,
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Erro ao listar perfis" });
            }

            const map = new Map((rows || []).map((row) => [row.username, normalizeProfileRow(row)]));
            const payload = usernames.map((username) => map.get(username) || {
                username,
                avatarUrl: DEFAULT_PROFILE.avatarUrl,
                nameColor: DEFAULT_PROFILE.nameColor,
                statusText: DEFAULT_PROFILE.statusText
            });

            return res.json(payload);
        }
    );
});

app.get("/channels", requireAuth, (_req, res) => {
    channelsDb.all(
        "SELECT id, name, created_by, created_at FROM channels ORDER BY id ASC",
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Erro ao listar canais" });
            }

            return res.json(rows);
        }
    );
});

app.post("/channels", requireAuth, (req, res) => {
    const channelName = String(req.body?.name || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 30);

    if (!channelName || channelName.length < 2) {
        return res.status(400).json({ error: "Nome de canal invalido" });
    }

    channelsDb.run(
        "INSERT INTO channels (name, created_by) VALUES (?, ?)",
        [channelName, req.auth.username],
        function insertChannel(err) {
            if (err) {
                if (String(err.message || "").includes("UNIQUE")) {
                    return res.status(409).json({ error: "Canal ja existe" });
                }

                return res.status(500).json({ error: "Erro ao criar canal" });
            }

            return res.status(201).json({
                id: this.lastID,
                name: channelName,
                createdBy: req.auth.username
            });
        }
    );
});

app.get("/presence", requireAuth, (_req, res) => {
    cleanupRealtimeState();
    const details = Array.from(onlineUsers.entries())
        .map(([username, lastSeenTs]) => ({
            username,
            lastSeenAt: new Date(lastSeenTs).toISOString(),
            lastSeenAgoMs: Math.max(0, Date.now() - lastSeenTs)
        }))
        .sort((a, b) => a.username.localeCompare(b.username));
    const users = details.map((row) => row.username);
    return res.json({ users, details, count: users.length });
});

app.get("/voice/channels", requireAuth, (_req, res) => {
    const channels = [];

    for (const [channelId, participantsMap] of voiceParticipantsByChannel.entries()) {
        const participants = Array.from(participantsMap.values()).map((participant) => ({
            username: participant.username,
            muted: Boolean(participant.muted),
            speaking: Boolean(participant.speaking),
            deafened: Boolean(participant.deafened)
        }));

        channels.push({
            channelId: Number(channelId),
            participants
        });
    }

    return res.json({ channels });
});

app.get("/typing", requireAuth, (req, res) => {
    const channelId = parseChannelId(req.query.channelId, DEFAULT_CHANNEL_ID);

    return resolveChannel(channelId, (channelErr) => {
        if (channelErr) {
            return res.status(404).json({ error: "Canal nao encontrado" });
        }

        cleanupRealtimeState();
        const usersMap = typingByChannel.get(String(channelId));
        const users = usersMap ? Array.from(usersMap.keys()) : [];
        return res.json({ users });
    });
});

app.post("/typing/start", requireAuth, (req, res) => {
    const channelId = parseChannelId(req.body?.channelId, DEFAULT_CHANNEL_ID);

    return resolveChannel(channelId, (channelErr) => {
        if (channelErr) {
            return res.status(404).json({ error: "Canal nao encontrado" });
        }

        setTyping(channelId, req.auth.username, true);
        return res.status(204).end();
    });
});

app.post("/typing/stop", requireAuth, (req, res) => {
    const channelId = parseChannelId(req.body?.channelId, DEFAULT_CHANNEL_ID);
    setTyping(channelId, req.auth.username, false);
    return res.status(204).end();
});

app.post("/admin/mod/ban", requireAdmin, (req, res) => {
    const username = String(req.body?.username || "").trim();
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    const minutes = parseMinutes(req.body?.minutes, 60, 43200);

    if (!username) {
        return res.status(400).json({ error: "Username invalido" });
    }

    const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

    return authDb.run(
        `
        INSERT INTO user_bans (username, reason, expires_at, created_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username) DO UPDATE SET
            reason = excluded.reason,
            expires_at = excluded.expires_at,
            created_at = CURRENT_TIMESTAMP
        `,
        [username, reason || null, expiresAt],
        (err) => {
            if (err) {
                return res.status(500).json({ error: "Erro ao banir usuario" });
            }

            authDb.run("DELETE FROM auth_sessions WHERE username = ?", [username]);
            logAdminActivity({
                action: "ban",
                targetUsername: username,
                details: JSON.stringify({ minutes, reason })
            });

            return res.json({ username, expiresAt, minutes, reason: reason || "" });
        }
    );
});

app.post("/admin/mod/mute", requireAdmin, (req, res) => {
    const username = String(req.body?.username || "").trim();
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    const minutes = parseMinutes(req.body?.minutes, 30, 43200);

    if (!username) {
        return res.status(400).json({ error: "Username invalido" });
    }

    const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

    return authDb.run(
        `
        INSERT INTO user_mutes (username, reason, expires_at, created_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username) DO UPDATE SET
            reason = excluded.reason,
            expires_at = excluded.expires_at,
            created_at = CURRENT_TIMESTAMP
        `,
        [username, reason || null, expiresAt],
        (err) => {
            if (err) {
                return res.status(500).json({ error: "Erro ao mutar usuario" });
            }

            logAdminActivity({
                action: "mute",
                targetUsername: username,
                details: JSON.stringify({ minutes, reason })
            });

            return res.json({ username, expiresAt, minutes, reason: reason || "" });
        }
    );
});

app.post("/admin/mod/unban", requireAdmin, (req, res) => {
    const username = String(req.body?.username || "").trim();

    if (!username) {
        return res.status(400).json({ error: "Username invalido" });
    }

    return authDb.run("DELETE FROM user_bans WHERE username = ?", [username], function done(err) {
        if (err) {
            return res.status(500).json({ error: "Erro ao remover ban" });
        }

        logAdminActivity({ action: "unban", targetUsername: username });
        return res.json({ username, removed: this.changes > 0 });
    });
});

app.post("/admin/mod/unmute", requireAdmin, (req, res) => {
    const username = String(req.body?.username || "").trim();

    if (!username) {
        return res.status(400).json({ error: "Username invalido" });
    }

    return authDb.run("DELETE FROM user_mutes WHERE username = ?", [username], function done(err) {
        if (err) {
            return res.status(500).json({ error: "Erro ao remover mute" });
        }

        logAdminActivity({ action: "unmute", targetUsername: username });
        return res.json({ username, removed: this.changes > 0 });
    });
});

app.post("/admin/mod/clear-channel", requireAdmin, (req, res) => {
    const channelId = parseChannelId(req.body?.channelId, DEFAULT_CHANNEL_ID);

    return resolveChannel(channelId, (channelErr, channelRow) => {
        if (channelErr) {
            return res.status(404).json({ error: "Canal nao encontrado" });
        }

        return messagesDb.all(
            "SELECT file_url FROM messages WHERE channel_id = ? AND file_url IS NOT NULL",
            [channelId],
            (readErr, rows) => {
                if (readErr) {
                    return res.status(500).json({ error: "Erro ao preparar limpeza" });
                }

                return messagesDb.run("DELETE FROM messages WHERE channel_id = ?", [channelId], function done(err) {
                    if (err) {
                        return res.status(500).json({ error: "Erro ao limpar canal" });
                    }

                    (rows || []).forEach((row) => {
                        const filePath = path.join(__dirname, "public", String(row.file_url || "").replace(/^\//, ""));
                        fs.unlink(filePath, () => {});
                    });

                    logAdminActivity({
                        action: "clear-channel",
                        channelId,
                        details: JSON.stringify({ channelName: channelRow?.name || "" })
                    });

                    return res.json({ channelId, deletedMessages: this.changes || 0 });
                });
            }
        );
    });
});

app.get("/admin/mod/activity", requireAdmin, (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);

    return authDb.all(
        `
        SELECT id, action, actor, target_username, channel_id, details, created_at
        FROM admin_activity
        ORDER BY id DESC
        LIMIT ?
        `,
        [limit],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Erro ao carregar atividade admin" });
            }

            return res.json(rows || []);
        }
    );
});

app.post("/admin/keys", requireAdmin, (req, res) => {
    const username = String(req.body?.username || "").trim();

    if (!username || username.length > 30) {
        return res.status(400).json({ error: "Username invalido" });
    }

    const plainKey = `ck_${randomToken(16)}`;
    const keyHash = hashToken(plainKey);

    authDb.get("SELECT id FROM access_keys WHERE username = ?", [username], (findErr, existing) => {
        if (findErr) {
            return res.status(500).json({ error: "Erro ao validar usuario" });
        }

        if (!existing) {
            return authDb.run(
                "INSERT INTO access_keys (key_hash, username, active) VALUES (?, ?, 1)",
                [keyHash, username],
                function insertKey(insertErr) {
                    if (insertErr) {
                        return res.status(500).json({ error: "Erro ao criar chave" });
                    }

                    return res.status(201).json({
                        id: this.lastID,
                        username,
                        key: plainKey
                    });
                }
            );
        }

        return authDb.run(
            "UPDATE access_keys SET key_hash = ?, active = 1, created_at = CURRENT_TIMESTAMP, last_used_at = NULL WHERE id = ?",
            [keyHash, existing.id],
            (updateErr) => {
                if (updateErr) {
                    return res.status(500).json({ error: "Erro ao atualizar chave" });
                }

                authDb.run("DELETE FROM auth_sessions WHERE username = ?", [username]);

                return res.status(200).json({
                    id: existing.id,
                    username,
                    key: plainKey
                });
            }
        );
    });
});

app.get("/admin/keys", requireAdmin, (_req, res) => {
    authDb.all(
        "SELECT id, username, active, created_at, last_used_at FROM access_keys ORDER BY id DESC",
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Erro ao listar chaves" });
            }

            return res.json(rows);
        }
    );
});

app.post("/admin/keys/:id/revoke", requireAdmin, (req, res) => {
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "ID invalido" });
    }

    authDb.run("UPDATE access_keys SET active = 0 WHERE id = ?", [id], function revokeErr(err) {
        if (err) {
            return res.status(500).json({ error: "Erro ao revogar chave" });
        }

        if (this.changes === 0) {
            return res.status(404).json({ error: "Chave nao encontrada" });
        }

        authDb.run("DELETE FROM auth_sessions WHERE username IN (SELECT username FROM access_keys WHERE id = ?)", [id]);
        return res.status(204).end();
    });
});

app.get("/public-chat/messages", (req, res) => {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 1), 200)
        : 80;

    const parsedAfterId = Number.parseInt(req.query.afterId, 10);
    const hasAfterId = Number.isFinite(parsedAfterId) && parsedAfterId > 0;

    if (hasAfterId) {
        return messagesDb.all(
            "SELECT id, name, text, created_at FROM public_messages WHERE id > ? ORDER BY id ASC LIMIT ?",
            [parsedAfterId, limit],
            (err, rows) => {
                if (err) {
                    return res.status(500).json({ error: "Erro ao buscar mensagens publicas" });
                }

                return res.json(rows);
            }
        );
    }

    return messagesDb.all(
        `
        SELECT id, name, text, created_at FROM (
            SELECT id, name, text, created_at
            FROM public_messages
            ORDER BY id DESC
            LIMIT ?
        ) ORDER BY id ASC
        `,
        [limit],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Erro ao buscar mensagens publicas" });
            }

            return res.json(rows);
        }
    );
});

app.post("/public-chat/messages", (req, res) => {
    const name = String(req.body?.name || "").trim();
    const text = String(req.body?.text || "").trim();

    if (!name || name.length < 2 || name.length > 30) {
        return res.status(400).json({ error: "Nome invalido" });
    }

    if (!text || text.length > 1000) {
        return res.status(400).json({ error: "Mensagem invalida" });
    }

    return messagesDb.run(
        "INSERT INTO public_messages (name, text) VALUES (?, ?)",
        [name, text],
        function insertPublicMessage(err) {
            if (err) {
                return res.status(500).json({ error: "Erro ao salvar mensagem publica" });
            }

            return res.status(201).json({ id: this.lastID });
        }
    );
});

// pegar mensagens
app.get("/messages", requireAuth, (req, res) => {
    const channelId = parseChannelId(req.query.channelId, DEFAULT_CHANNEL_ID);
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 1), 200)
        : 50;

    const parsedBeforeId = Number.parseInt(req.query.beforeId, 10);
    const parsedAfterId = Number.parseInt(req.query.afterId, 10);
    const hasBeforeId = Number.isFinite(parsedBeforeId) && parsedBeforeId > 0;
    const hasAfterId = Number.isFinite(parsedAfterId) && parsedAfterId >= 0;

    return resolveChannel(channelId, (channelErr) => {
        if (channelErr) {
            return res.status(404).json({ error: "Canal nao encontrado" });
        }

        if (hasAfterId) {
            return messagesDb.all(
                `
                SELECT m.*, r.name AS reply_name, r.text AS reply_text
                FROM messages m
                LEFT JOIN messages r ON r.id = m.reply_to_id
                WHERE m.channel_id = ? AND m.id > ?
                ORDER BY m.id ASC
                LIMIT ?
                `,
                [channelId, parsedAfterId, limit],
                (err, rows) => {
                    if (err) {
                        return res.status(500).json({ error: "Erro ao buscar mensagens" });
                    }

                    return res.json(rows);
                }
            );
        }

        if (hasBeforeId) {
            return messagesDb.all(
                `
                SELECT m.*, r.name AS reply_name, r.text AS reply_text
                FROM messages m
                LEFT JOIN messages r ON r.id = m.reply_to_id
                WHERE m.channel_id = ? AND m.id < ?
                ORDER BY m.id DESC
                LIMIT ?
                `,
                [channelId, parsedBeforeId, limit],
                (err, rows) => {
                    if (err) {
                        return res.status(500).json({ error: "Erro ao buscar mensagens" });
                    }

                    return res.json(rows.reverse());
                }
            );
        }

        return messagesDb.all(
            `
            SELECT * FROM (
                SELECT m.*, r.name AS reply_name, r.text AS reply_text
                FROM messages m
                LEFT JOIN messages r ON r.id = m.reply_to_id
                WHERE m.channel_id = ?
                ORDER BY m.id DESC
                LIMIT ?
            ) ORDER BY id ASC
            `,
            [channelId, limit],
            (err, rows) => {
                if (err) {
                    return res.status(500).json({ error: "Erro ao buscar mensagens" });
                }

                return res.json(rows);
            }
        );
    });
});

// enviar mensagem com texto e/ou anexo
app.post("/messages", requireAuth, (req, res) => {
    upload.single("file")(req, res, (uploadErr) => {
        if (uploadErr) {
            if (uploadErr instanceof multer.MulterError && uploadErr.code === "LIMIT_FILE_SIZE") {
                return res.status(400).send("Arquivo excede o limite permitido pelo servidor");
            }

            return res.status(400).send(uploadErr.message || "Falha no upload");
        }

        const text = String(req.body?.text || "").trim();
        const cleanName = String(req.auth?.username || "").trim();
        const channelId = parseChannelId(req.body?.channelId, DEFAULT_CHANNEL_ID);
        const replyToId = Number.parseInt(req.body?.replyToId, 10);
        const hasReply = Number.isFinite(replyToId) && replyToId > 0;
        const file = req.file;

        if (!cleanName || cleanName.length > 30) {
            if (file?.path) {
                fs.unlink(file.path, () => {});
            }

            return res.status(400).send("Nome inválido");
        }

        if (!text && !file) {
            return res.status(400).send("Envie texto, arquivo ou ambos");
        }

        if (text.length > 1000) {
            if (file?.path) {
                fs.unlink(file.path, () => {});
            }

            return res.status(400).send("Texto muito longo");
        }

        const fileUrl = file ? `/uploads/${file.filename}` : null;
        const fileName = file ? path.basename(file.originalname || "arquivo") : null;
        const fileMime = file ? file.mimetype : null;
        const fileSize = file ? file.size : null;
        const now = new Date().toISOString();

        return authDb.get(
            "SELECT expires_at FROM user_mutes WHERE username = ? AND expires_at > ?",
            [cleanName, now],
            (muteErr, muteRow) => {
                if (muteErr) {
                    if (file?.path) {
                        fs.unlink(file.path, () => {});
                    }

                    return res.status(500).send("Erro ao validar mute");
                }

                if (muteRow) {
                    if (file?.path) {
                        fs.unlink(file.path, () => {});
                    }

                    return res.status(403).send("Usuario mutado temporariamente");
                }

                return resolveChannel(channelId, (channelErr) => {
                    if (channelErr) {
                        if (file?.path) {
                            fs.unlink(file.path, () => {});
                        }

                        return res.status(404).send("Canal nao encontrado");
                    }

                    const persistMessage = (safeReplyToId) => {
                        messagesDb.run(
                            "INSERT INTO messages (name, text, file_url, file_name, file_mime, file_size, channel_id, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            [cleanName, text || null, fileUrl, fileName, fileMime, fileSize, channelId, safeReplyToId],
                            function insertCallback(err) {
                                if (err) {
                                    if (file?.path) {
                                        fs.unlink(file.path, () => {});
                                    }

                                    return res.status(500).send("Erro ao salvar mensagem");
                                }

                                return res.status(200).json({ id: this.lastID });
                            }
                        );
                    };

                    if (!hasReply) {
                        persistMessage(null);
                        return;
                    }

                    messagesDb.get(
                        "SELECT id FROM messages WHERE id = ? AND channel_id = ?",
                        [replyToId, channelId],
                        (replyErr, replyRow) => {
                            if (replyErr) {
                                if (file?.path) {
                                    fs.unlink(file.path, () => {});
                                }

                                return res.status(500).send("Erro ao validar resposta");
                            }

                            persistMessage(replyRow ? replyToId : null);
                        }
                    );
                });
            }
        );
    });
});

app.patch("/messages/:id", requireAuth, (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const text = String(req.body?.text || "").trim();

    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "ID invalido" });
    }

    if (!text || text.length > 1000) {
        return res.status(400).json({ error: "Texto invalido" });
    }

    return messagesDb.get("SELECT id, name FROM messages WHERE id = ?", [id], (findErr, row) => {
        if (findErr) {
            return res.status(500).json({ error: "Erro ao localizar mensagem" });
        }

        if (!row) {
            return res.status(404).json({ error: "Mensagem nao encontrada" });
        }

        if (String(row.name || "") !== req.auth.username) {
            return res.status(403).json({ error: "Sem permissao para editar" });
        }

        return messagesDb.run(
            "UPDATE messages SET text = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?",
            [text, id],
            function done(err) {
                if (err) {
                    return res.status(500).json({ error: "Erro ao editar mensagem" });
                }

                return messagesDb.get(
                    `
                    SELECT m.*, r.name AS reply_name, r.text AS reply_text
                    FROM messages m
                    LEFT JOIN messages r ON r.id = m.reply_to_id
                    WHERE m.id = ?
                    `,
                    [id],
                    (readErr, updatedRow) => {
                        if (readErr) {
                            return res.status(500).json({ error: "Mensagem atualizada, mas falha ao carregar retorno" });
                        }

                        return res.json(updatedRow);
                    }
                );
            }
        );
    });
});

app.delete("/messages/:id", requireAuth, (req, res) => {
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "ID invalido" });
    }

    return messagesDb.get(
        "SELECT id, name, file_url FROM messages WHERE id = ?",
        [id],
        (findErr, row) => {
            if (findErr) {
                return res.status(500).json({ error: "Erro ao localizar mensagem" });
            }

            if (!row) {
                return res.status(404).json({ error: "Mensagem nao encontrada" });
            }

            if (String(row.name || "") !== req.auth.username) {
                return res.status(403).json({ error: "Sem permissao para excluir" });
            }

            return messagesDb.run("DELETE FROM messages WHERE id = ?", [id], (err) => {
                if (err) {
                    return res.status(500).json({ error: "Erro ao excluir mensagem" });
                }

                messagesDb.run("UPDATE messages SET reply_to_id = NULL WHERE reply_to_id = ?", [id]);

                if (row.file_url) {
                    const filePath = path.join(__dirname, "public", String(row.file_url).replace(/^\//, ""));
                    fs.unlink(filePath, () => {});
                }

                return res.status(204).end();
            });
        }
    );
});

ensureSchema((schemaErr) => {
    if (schemaErr) {
        console.error("Erro ao preparar banco:", schemaErr.message);
        process.exit(1);
    }

    setupVoiceSocketHandlers();

    const parsedPort = Number.parseInt(process.env.PORT, 10);
    const port = Number.isFinite(parsedPort) && parsedPort > 0
        ? parsedPort
        : 8080;

    httpServer.on("error", (err) => {
        if (err?.code === "EADDRINUSE") {
            console.error(`Porta ${port} ja esta em uso. Finalize o processo atual antes de iniciar outro servidor.`);
            process.exit(1);
        }

        console.error("Erro ao iniciar servidor:", err?.message || err);
        process.exit(1);
    });

    httpServer.listen(port, () => {
        console.log(`Servidor rodando em http://localhost:${port}`);
    });
});