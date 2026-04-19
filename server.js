const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const OpenAI = require("openai");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors({ origin: "*" }));
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "secret123";

/* ================= AI ================= */
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

/* ================= DB ================= */
const db = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  ssl: { rejectUnauthorized: false }
  waitForConnections: true
});

/* ================= DB SETUP ================= */
async function setupDB() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) UNIQUE,
        password VARCHAR(100)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS courses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200),
        video VARCHAR(500)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        className VARCHAR(10),
        subject VARCHAR(100),
        chapter VARCHAR(200),
        content TEXT
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS study (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user VARCHAR(100),
        chapter VARCHAR(200),
        UNIQUE(user, chapter)
      )
    `);

    console.log("✅ DB Ready");
  } catch (err) {
    console.error("❌ DB Setup Error:", err);
  }
}
setupDB();

/* ================= AUTH MIDDLEWARE ================= */
function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ error: "No token" });
  }
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.name;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
    res.status(401).json({ error: "Invalid token" });
  }
}

/* ================= AUTH ================= */
app.post("/register", async (req, res) => {
  try {
    const { name, password } = req.body;

    if (!name || !password)
      return res.status(400).json({ error: "Missing fields" });

    const [rows] = await db.execute(
      "SELECT * FROM users WHERE name=?",
      [name]
    );

    if (rows.length)
      return res.json({ message: "User exists" });

    await db.execute(
      "INSERT INTO users (name,password) VALUES (?,?)",
      [name, password]
    );

    res.json({ message: "Registered" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { name, password } = req.body;

    const [rows] = await db.execute(
      "SELECT * FROM users WHERE name=? AND password=?",
      [name, password]
    );

    if (!rows.length)
      return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ name }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, user: { name } });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= COURSES ================= */
app.get("/courses", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM courses");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Error" });
  }
});

app.post("/add-course", async (req, res) => {
  try {
    const { title, video } = req.body;

    if (!title || !video)
      return res.status(400).json({ error: "Missing fields" });

    await db.execute(
      "INSERT INTO courses (title, video) VALUES (?,?)",
      [title, video]
    );

    res.json({ message: "Course added" });

  } catch (err) {
    res.status(500).json({ error: "Error" });
  }
});

/* ================= NOTES ================= */
app.post("/generate-notes", auth, async (req, res) => {
  try {
    const { className, subject, chapter } = req.body;

    const [rows] = await db.execute(
      "SELECT * FROM notes WHERE className=? AND subject=? AND chapter=?",
      [className, subject, chapter]
    );

    if (rows.length)
      return res.json({ notes: rows[0].content });

    const ai = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "Write structured CBSE notes" },
        { role: "user", content: `${className} ${subject} ${chapter}` }
      ]
    });

    const content = ai.choices[0].message.content;

    await db.execute(
      "INSERT INTO notes (className,subject,chapter,content) VALUES (?,?,?,?)",
      [className, subject, chapter, content]
    );

    res.json({ notes: content });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI error" });
  }
});

/* ================= STUDY ================= */
app.post("/study", auth, async (req, res) => {
  try {
    const { chapter } = req.body;

    if (!chapter)
      return res.status(400).json({ error: "Missing chapter" });

    await db.execute(
      "INSERT IGNORE INTO study (user, chapter) VALUES (?,?)",
      [req.user, chapter]
    );

    res.json({ message: "Tracked" });

  } catch (err) {
    res.status(500).json({ error: "Error" });
  }
});

app.get("/progress", auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT chapter FROM study WHERE user=?",
      [req.user]
    );

    res.json({
      total: rows.length,
      chapters: rows.map(r => r.chapter)
    });

  } catch (err) {
    res.status(500).json({ error: "Error" });
  }
});

/* ================= AI ================= */
app.post("/ask-ai", auth, async (req, res) => {
  try {
    const { question } = req.body;

    if (!question)
      return res.status(400).json({ error: "Missing question" });

    const ai = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "Explain simply like a teacher" },
        { role: "user", content: question }
      ]
    });

    res.json({ answer: ai.choices[0].message.content });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI error" });
  }
});

/* ================= STATS ================= */
app.get("/stats", async (req, res) => {
  try {
    const [u] = await db.execute("SELECT COUNT(*) c FROM users");
    const [s] = await db.execute("SELECT COUNT(*) c FROM study");

    res.json({
      users: u[0].c,
      study: s[0].c
    });

    res.json({ users: u[0].c, study: s[0].c });
  } catch (err) {
    res.status(500).json({ error: "Error" });
  }
});

/* ================= HEALTH CHECK ================= */
/* ================= HEALTH ================= */
app.get("/", (req, res) => {
  res.send("🚀 BrainWave Backend Running");
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
