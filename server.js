const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const OpenAI = require("openai");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");

const app = express();

app.set("trust proxy", 1); // Fix for Render X-Forwarded-For / rate-limit issue

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// ── JWT Secret (required — never falls back to default) ───────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ FATAL: JWT_SECRET environment variable is not set. Server will not start.");
  process.exit(1);
}

// ── Firebase Admin Setup ──────────────────────────────────────────────────────
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("Firebase Admin initialized ✅");
  } catch (e) {
    console.warn("Firebase Admin init failed:", e.message);
  }
} else {
  console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT not set — Google login disabled");
}

// ── Groq AI Client ────────────────────────────────────────────────────────────
const chatClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

// ── MySQL Pool ────────────────────────────────────────────────────────────────
const db = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: { rejectUnauthorized: false }
});

// ── Rate Limiters ─────────────────────────────────────────────────────────────
// AI endpoints: max 20 requests per minute per IP
const aiLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." }
});

// Auth endpoints: max 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." }
});

app.use(["/ask-ai", "/ocr", "/generate-image", "/generate-notes", "/quiz"], aiLimiter);
app.use(["/login", "/register", "/firebase-login"], authLimiter);

// ── DB Setup ──────────────────────────────────────────────────────────────────
async function setupDB() {
  try {
    // Users table — includes fullName, class, email, phone
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(100) UNIQUE NOT NULL,
        password    VARCHAR(255)        NOT NULL,
        fullName    VARCHAR(150)        DEFAULT '',
        class       VARCHAR(10)         DEFAULT '',
        email       VARCHAR(200)        DEFAULT '',
        phone       VARCHAR(20)         DEFAULT '',
        createdAt   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add new columns to existing users table if they don't exist yet (safe migration)
    const alterColumns = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS fullName VARCHAR(150) DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS class    VARCHAR(10)  DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS email    VARCHAR(200) DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone    VARCHAR(20)  DEFAULT ''"
    ];
    for (const sql of alterColumns) {
      try { await db.execute(sql); } catch (_) { /* column already exists */ }
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS courses (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        title     VARCHAR(200),
        video     VARCHAR(500),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        className VARCHAR(10),
        subject   VARCHAR(100),
        chapter   VARCHAR(200),
        content   TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_note (className, subject, chapter)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS study (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        user      VARCHAR(100),
        chapter   VARCHAR(200),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_study (user, chapter)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS timer_settings (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        user      VARCHAR(100) UNIQUE,
        minutes   INT          DEFAULT 25,
        seconds   INT          DEFAULT 0,
        label     VARCHAR(100) DEFAULT 'Pomodoro',
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        user      VARCHAR(100),
        title     VARCHAR(255),
        done      BOOLEAN DEFAULT FALSE,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        user      VARCHAR(100),
        type      VARCHAR(100),
        preview   VARCHAR(255),
        content   TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS generated_images (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        user      VARCHAR(100),
        prompt    TEXT,
        style     VARCHAR(100),
        size      VARCHAR(30),
        imageUrl  TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS suggestions (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        user      VARCHAR(100),
        type      VARCHAR(100),
        text      TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("DB Ready ✅");
  } catch (err) {
    console.error("DB Setup Error:", err);
  }
}

setupDB();

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizeText(value) {
  return String(value || "").trim();
}

function parseBool(value) {
  if (value === true || value === 1 || value === "true" || value === "1") return true;
  return false;
}

function validateId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

// ── Auth Middleware ────────────────────────────────────────────────────────────
function auth(req, res, next) {
  let token = req.headers.authorization || "";
  if (token.startsWith("Bearer ")) token = token.slice(7);
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.name;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── AI Helper ─────────────────────────────────────────────────────────────────
async function askGroq(systemPrompt, userPrompt) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");
  const ai = await chatClient.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ]
  });
  return ai.choices?.[0]?.message?.content || "";
}

// ── Image Helpers ─────────────────────────────────────────────────────────────
function buildImagePrompt({ prompt, style, subject, chapter }) {
  return [
    normalizeText(prompt),
    `${normalizeText(style || "Cinematic")} style`,
    subject ? `study theme around ${normalizeText(subject)}` : "",
    chapter ? `inspired by ${normalizeText(chapter)}` : "",
    "vibrant lighting",
    "clean composition",
    "high detail"
  ].filter(Boolean).join(", ");
}

function getSizeDimensions(size) {
  const map = {
    "Square":    { width: 1024, height: 1024 },
    "Portrait":  { width: 768,  height: 1024 },
    "Landscape": { width: 1024, height: 576  },
    "1024x1024": { width: 1024, height: 1024 },
    "1024x1792": { width: 1024, height: 1792 },
    "1792x1024": { width: 1792, height: 1024 }
  };
  return map[size] || { width: 1024, height: 1024 };
}

function buildPollinationsUrl(prompt, width, height) {
  const seed = Math.floor(Math.random() * 999999);
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&nologo=true&seed=${seed}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── Root ──────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("BrainWave X Backend Running ✅");
});

// ── Register ──────────────────────────────────────────────────────────────────
app.post("/register", async (req, res) => {
  try {
    const name     = normalizeText(req.body.name);
    const password = normalizeText(req.body.password);
    const fullName = normalizeText(req.body.fullName || req.body.name);
    const cls      = normalizeText(req.body.class || "");
    const email    = normalizeText(req.body.email || "");
    const phone    = normalizeText(req.body.phone || "");

    if (!name || !password)      return res.status(400).json({ error: "Missing username or password" });
    if (name.includes(" "))      return res.status(400).json({ error: "Username cannot contain spaces" });
    if (password.length < 6)     return res.status(400).json({ error: "Password must be at least 6 characters" });

    const [rows] = await db.execute("SELECT id FROM users WHERE name=?", [name]);
    if (rows.length)             return res.status(409).json({ error: "Username already taken" });

    const hashed = await bcrypt.hash(password, 10);
    await db.execute(
      "INSERT INTO users (name, password, fullName, class, email, phone) VALUES (?, ?, ?, ?, ?, ?)",
      [name, hashed, fullName, cls, email, phone]
    );

    res.json({ message: "Registered successfully" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  try {
    const name     = normalizeText(req.body.name);
    const password = normalizeText(req.body.password);

    if (!name || !password) return res.status(400).json({ error: "Missing username or password" });

    const [rows] = await db.execute(
      "SELECT id, password, fullName, class, email FROM users WHERE name=?",
      [name]
    );
    if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, rows[0].password);
    if (!match)       return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ name }, JWT_SECRET, { expiresIn: "7d" });
    res.json({
      token,
      user: {
        name,
        fullName: rows[0].fullName || name,
        class:    rows[0].class    || "",
        email:    rows[0].email    || ""
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Firebase / Google Login ───────────────────────────────────────────────────
app.post("/firebase-login", async (req, res) => {
  try {
    if (!admin.apps.length) {
      return res.status(503).json({ error: "Firebase Admin not configured on server" });
    }
    const idToken = normalizeText(req.body.idToken);
    if (!idToken) return res.status(400).json({ error: "Missing idToken" });

    const decoded     = await admin.auth().verifyIdToken(idToken);
    const uid         = decoded.uid;
    const displayName = decoded.name || decoded.email?.split("@")[0] || "user_" + uid.slice(0, 8);
    const email       = decoded.email || "";
    const name        = displayName.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 50);

    const [rows] = await db.execute("SELECT id FROM users WHERE name=?", [name]);
    if (!rows.length) {
      // Firebase users get a bcrypt-hashed random password they never use
      const fakeHash = await bcrypt.hash("firebase_" + uid, 10);
      await db.execute(
        "INSERT INTO users (name, password, fullName, email) VALUES (?, ?, ?, ?)",
        [name, fakeHash, displayName, email]
      );
    }

    const token = jwt.sign({ name }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { name, displayName, email } });
  } catch (err) {
    console.error("Firebase login error:", err);
    res.status(401).json({ error: "Firebase token invalid or expired" });
  }
});

// ── Get User Profile ──────────────────────────────────────────────────────────
app.get("/profile", auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT name, fullName, class, email, phone, createdAt FROM users WHERE name=?",
      [req.user]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Profile error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Update User Profile ───────────────────────────────────────────────────────
app.patch("/profile", auth, async (req, res) => {
  try {
    const fullName = normalizeText(req.body.fullName || "");
    const cls      = normalizeText(req.body.class    || "");
    const email    = normalizeText(req.body.email    || "");
    const phone    = normalizeText(req.body.phone    || "");
    await db.execute(
      "UPDATE users SET fullName=?, class=?, email=?, phone=? WHERE name=?",
      [fullName, cls, email, phone, req.user]
    );
    res.json({ message: "Profile updated" });
  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Courses ───────────────────────────────────────────────────────────────────
app.get("/courses", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM courses ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching courses" });
  }
});

app.post("/add-course", async (req, res) => {
  try {
    const title = normalizeText(req.body.title);
    const video = normalizeText(req.body.video);
    if (!title || !video) return res.status(400).json({ error: "Missing fields" });
    await db.execute("INSERT INTO courses (title, video) VALUES (?, ?)", [title, video]);
    res.json({ message: "Course added" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error adding course" });
  }
});

// ── Generate Notes ────────────────────────────────────────────────────────────
app.post("/generate-notes", auth, async (req, res) => {
  try {
    const className = normalizeText(req.body.className);
    const subject   = normalizeText(req.body.subject);
    const chapter   = normalizeText(req.body.chapter);
    if (!className || !subject || !chapter) return res.status(400).json({ error: "Missing fields" });

    const [rows] = await db.execute(
      "SELECT content FROM notes WHERE className=? AND subject=? AND chapter=?",
      [className, subject, chapter]
    );
    if (rows.length) return res.json({ notes: rows[0].content, cached: true });

    const content = await askGroq(
      "Write structured, student-friendly CBSE notes with headings, bullet points, key takeaways, and a short revision recap.",
      `${className} ${subject} ${chapter}`
    );
    await db.execute(
      "INSERT INTO notes (className, subject, chapter, content) VALUES (?, ?, ?, ?)",
      [className, subject, chapter, content]
    );
    res.json({ notes: content, cached: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI error generating notes" });
  }
});

// ── Study Tracking ────────────────────────────────────────────────────────────
app.post("/study", auth, async (req, res) => {
  try {
    const chapter = normalizeText(req.body.chapter);
    if (!chapter) return res.status(400).json({ error: "Missing chapter" });
    await db.execute("INSERT IGNORE INTO study (user, chapter) VALUES (?, ?)", [req.user, chapter]);
    res.json({ message: "Tracked" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error tracking study" });
  }
});

app.get("/progress", auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT chapter, createdAt FROM study WHERE user=? ORDER BY createdAt DESC",
      [req.user]
    );
    res.json({ total: rows.length, chapters: rows.map(r => r.chapter), history: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching progress" });
  }
});

// ── Ask AI ────────────────────────────────────────────────────────────────────
app.post("/ask-ai", auth, async (req, res) => {
  try {
    const question = normalizeText(req.body.question);
    if (!question) return res.status(400).json({ error: "Missing question" });
    // Pass the full prompt as the user message — the frontend already includes
    // system context (BW_CONTEXT) in the question string
    const answer = await askGroq(
      "You are an expert CBSE tutor for Brainwaves AI Study Platform. Answer clearly and accurately.",
      question
    );
    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI error" });
  }
});

// ── Quiz ──────────────────────────────────────────────────────────────────────
app.post("/quiz", auth, async (req, res) => {
  try {
    const className = normalizeText(req.body.className);
    const subject   = normalizeText(req.body.subject);
    const chapter   = normalizeText(req.body.chapter);
    if (!className || !subject || !chapter) return res.status(400).json({ error: "Missing fields" });
    const quiz = await askGroq(
      "Create a short quiz with answers. Include 5 questions with clean formatting.",
      `${className} ${subject} ${chapter}`
    );
    res.json({ quiz });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Quiz generation error" });
  }
});

// ── Leaderboard & Stats ───────────────────────────────────────────────────────
app.get("/leaderboard", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT user AS name, COUNT(*) AS points
      FROM study
      GROUP BY user
      ORDER BY points DESC, name ASC
      LIMIT 10
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Leaderboard error" });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const [[u], [s], [n], [t]] = await Promise.all([
      db.execute("SELECT COUNT(*) AS c FROM users"),
      db.execute("SELECT COUNT(*) AS c FROM study"),
      db.execute("SELECT COUNT(*) AS c FROM notes"),
      db.execute("SELECT COUNT(*) AS c FROM tasks")
    ]);
    res.json({ users: u[0].c, study: s[0].c, notes: n[0].c, tasks: t[0].c });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stats error" });
  }
});

// ── Timer ─────────────────────────────────────────────────────────────────────
app.get("/timer", auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT minutes, seconds, label FROM timer_settings WHERE user=?",
      [req.user]
    );
    if (!rows.length) return res.json({ minutes: 25, seconds: 0, label: "Pomodoro" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Timer error" });
  }
});

app.post("/timer", auth, async (req, res) => {
  try {
    const minutes = Number(req.body.minutes);
    const seconds = Number(req.body.seconds);
    const label   = normalizeText(req.body.label || "Custom");
    if (
      !Number.isFinite(minutes) || !Number.isFinite(seconds) ||
      minutes < 0 || seconds < 0 || seconds > 59
    ) {
      return res.status(400).json({ error: "Invalid timer values" });
    }
    await db.execute(
      `INSERT INTO timer_settings (user, minutes, seconds, label)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE minutes=VALUES(minutes), seconds=VALUES(seconds), label=VALUES(label)`,
      [req.user, minutes, seconds, label]
    );
    res.json({ message: "Timer saved", minutes, seconds, label });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Timer save error" });
  }
});

// ── Tasks ─────────────────────────────────────────────────────────────────────
app.get("/tasks", auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT id, title, done, createdAt FROM tasks WHERE user=? ORDER BY id DESC",
      [req.user]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Tasks error" });
  }
});

app.post("/tasks", auth, async (req, res) => {
  try {
    const title = normalizeText(req.body.title);
    if (!title) return res.status(400).json({ error: "Missing title" });
    const [result] = await db.execute(
      "INSERT INTO tasks (user, title, done) VALUES (?, ?, FALSE)",
      [req.user, title]
    );
    res.json({ id: result.insertId, title, done: false, message: "Task added" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Task create error" });
  }
});

app.patch("/tasks/:id", auth, async (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid task ID" });
    const done = parseBool(req.body.done); // fixed: Boolean("false") bug
    await db.execute("UPDATE tasks SET done=? WHERE id=? AND user=?", [done, id, req.user]);
    res.json({ message: "Task updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Task update error" });
  }
});

app.delete("/tasks/:id", auth, async (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid task ID" });
    await db.execute("DELETE FROM tasks WHERE id=? AND user=?", [id, req.user]);
    res.json({ message: "Task deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Task delete error" });
  }
});

// ── Bookmarks ─────────────────────────────────────────────────────────────────
app.get("/bookmarks", auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT id, type, preview, content, createdAt FROM bookmarks WHERE user=? ORDER BY id DESC",
      [req.user]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Bookmarks error" });
  }
});

app.post("/bookmarks", auth, async (req, res) => {
  try {
    const type    = normalizeText(req.body.type);
    const content = normalizeText(req.body.content);
    const preview = normalizeText(req.body.preview || content.slice(0, 120));
    if (!type || !content) return res.status(400).json({ error: "Missing bookmark fields" });
    const [result] = await db.execute(
      "INSERT INTO bookmarks (user, type, preview, content) VALUES (?, ?, ?, ?)",
      [req.user, type, preview, content]
    );
    res.json({ id: result.insertId, message: "Bookmark saved" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Bookmark save error" });
  }
});

app.delete("/bookmarks/:id", auth, async (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid bookmark ID" });
    await db.execute("DELETE FROM bookmarks WHERE id=? AND user=?", [id, req.user]);
    res.json({ message: "Bookmark deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Bookmark delete error" });
  }
});

// ── Image Generation (Pollinations.AI) ────────────────────────────────────────
app.post("/generate-image", auth, async (req, res) => {
  try {
    const prompt  = normalizeText(req.body.prompt);
    const style   = normalizeText(req.body.style   || "Cinematic");
    const size    = normalizeText(req.body.size    || "Square");
    const subject = normalizeText(req.body.subject || "");
    const chapter = normalizeText(req.body.chapter || "");

    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const finalPrompt = buildImagePrompt({ prompt, style, subject, chapter });
    const { width, height } = getSizeDimensions(size);
    const imageUrl = buildPollinationsUrl(finalPrompt, width, height);

    await db.execute(
      "INSERT INTO generated_images (user, prompt, style, size, imageUrl) VALUES (?, ?, ?, ?, ?)",
      [req.user, finalPrompt, style, size, imageUrl]
    );

    res.json({ promptEnhanced: finalPrompt, imageUrl, b64_json: null });
  } catch (err) {
    console.error("Image generation error:", err);
    res.status(500).json({ error: "Image generation failed. Please try again." });
  }
});

app.get("/generated-images", auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT id, prompt, style, size, imageUrl, createdAt FROM generated_images WHERE user=? ORDER BY id DESC LIMIT 20",
      [req.user]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Image history error" });
  }
});

// ── OCR ───────────────────────────────────────────────────────────────────────
app.post("/ocr", auth, async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

    const mtype = normalizeText(mediaType || "image/jpeg");

    const response = await chatClient.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mtype};base64,${imageBase64}` }
            },
            {
              type: "text",
              text: "Extract ALL text from this image exactly as it appears. Preserve structure, headings, bullet points, equations, and formatting. If it's handwritten, do your best. Output only the extracted text, nothing else."
            }
          ]
        }
      ]
    });

    const extracted = response.choices?.[0]?.message?.content?.trim() || "";
    if (!extracted) return res.json({ text: "Could not extract text. Try a clearer image." });
    res.json({ text: extracted });
  } catch (err) {
    console.error("OCR error:", err);
    res.status(500).json({ error: "OCR failed: " + err.message });
  }
});

// ── Suggestions ───────────────────────────────────────────────────────────────
app.post("/suggest", auth, async (req, res) => {
  try {
    const type = normalizeText(req.body.type || "General Feedback");
    const text = normalizeText(req.body.text);
    if (!text) return res.status(400).json({ error: "Missing suggestion text" });
    await db.execute(
      "INSERT INTO suggestions (user, type, text) VALUES (?, ?, ?)",
      [req.user, type, text]
    );
    res.json({ message: "Suggestion saved. Thank you! 🙏" });
  } catch (err) {
    console.error("Suggest error:", err);
    res.status(500).json({ error: "Could not save suggestion" });
  }
});

// ── Announcement (public read-only) ───────────────────────────────────────────
app.get("/announcement", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT content, createdAt FROM notes WHERE className='__admin__' AND subject='__admin__' AND chapter='announcement'"
    );
    if (!rows.length) return res.json({ announcement: null });
    res.json({ announcement: rows[0].content, updatedAt: rows[0].createdAt });
  } catch {
    res.json({ announcement: null });
  }
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 BrainWave server running on port ${PORT}`);
});
