const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const OpenAI = require("openai");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// OpenAI Client (Groq)
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const ADMIN_PASSWORD = "admin123";

// MySQL Connection Pool
const db = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  ssl: { rejectUnauthorized: false }
});

// Setup Database Tables
async function setupDB() {
  try {
    // Users table with points
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY, 
        name VARCHAR(100) UNIQUE, 
        password VARCHAR(100),
        points INT DEFAULT 0
      )
    `);

    await db.execute(`CREATE TABLE IF NOT EXISTS courses (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(200), video VARCHAR(500))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS notes (id INT AUTO_INCREMENT PRIMARY KEY, className VARCHAR(10), subject VARCHAR(100), chapter VARCHAR(200), content TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS study (id INT AUTO_INCREMENT PRIMARY KEY, user VARCHAR(100), chapter VARCHAR(200), date TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    console.log("✅ MySQL Database and tables ready with Points System!");
  } catch (err) {
    console.error("Database setup error:", err);
  }
}

setupDB();

// Hardcoded Syllabus
const syllabus = { /* ... your existing syllabus object ... */ };   // Keep your full syllabus here

let memory = {};

// ====================== AUTH ======================
app.post("/register", async (req, res) => {
  const { name, password } = req.body;
  try {
    const [rows] = await db.execute("SELECT * FROM users WHERE name = ?", [name]);
    if (rows.length > 0) return res.json({ message: "User already exists" });

    await db.execute("INSERT INTO users (name, password, points) VALUES (?, ?, 0)", [name, password]);
    res.json({ message: "Registered successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  const { name, password } = req.body;
  try {
    const [rows] = await db.execute("SELECT name, points FROM users WHERE name = ? AND password = ?", [name, password]);
    if (rows.length === 0) return res.status(401).json({ message: "Invalid credentials" });
    
    res.json({ 
      message: "Login success", 
      user: { name: rows[0].name, points: rows[0].points } 
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// ====================== LEADERBOARD ======================
app.get("/leaderboard", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT name, points 
      FROM users 
      ORDER BY points DESC 
      LIMIT 10
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

// ====================== POINTS SYSTEM ======================
app.post("/add-points", async (req, res) => {
  const { user, points: addedPoints } = req.body;
  if (!user || !addedPoints) return res.status(400).json({ message: "Missing data" });

  try {
    await db.execute("UPDATE users SET points = points + ? WHERE name = ?", [addedPoints, user]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to add points" });
  }
});

// ====================== STUDY & PROGRESS ======================
app.post("/study", async (req, res) => {
  const { user, chapter } = req.body;
  try {
    await db.execute("INSERT INTO study (user, chapter) VALUES (?, ?)", [user, chapter]);
    // Award 10 points for studying
    await db.execute("UPDATE users SET points = points + 10 WHERE name = ?", [user]);
    res.json({ message: "Study tracked +10 points" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/progress/:user", async (req, res) => {
  try {
    const [studyRows] = await db.execute("SELECT COUNT(*) as total FROM study WHERE user = ?", [req.params.user]);
    const [userRow] = await db.execute("SELECT points FROM users WHERE name = ?", [req.params.user]);
    
    res.json({ 
      total: studyRows[0].total, 
      points: userRow[0]?.points || 0 
    });
  } catch (err) {
    res.status(500).json({ total: 0, points: 0 });
  }
});

// ====================== OTHER ENDPOINTS (Keep existing) ======================
app.get("/courses", async (req, res) => {
  const [rows] = await db.execute("SELECT * FROM courses");
  res.json(rows);
});

app.get("/syllabus", (req, res) => res.json(syllabus));

app.post("/generate-notes", async (req, res) => { /* your existing code */ });
app.post("/ask-ai", async (req, res) => { /* your existing code */ });
app.post("/quiz", async (req, res) => { /* your existing code */ });
app.post("/exam", async (req, res) => { /* your existing code */ });
app.post("/recommend", async (req, res) => { /* your existing code */ });

app.post("/complete-course", async (req, res) => {
  const { user, course } = req.body;
  try {
    // Award 50 points for completing course
    await db.execute("UPDATE users SET points = points + 50 WHERE name = ?", [user]);
    res.json({ 
      certificate: `Certificate of Completion — ${user} has successfully completed ${course}` 
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/stats", async (req, res) => {
  const [users] = await db.execute("SELECT COUNT(*) as count FROM users");
  const [courses] = await db.execute("SELECT COUNT(*) as count FROM courses");
  const [study] = await db.execute("SELECT COUNT(*) as count FROM study");
  res.json({
    users: users[0].count,
    courses: courses[0].count,
    study: study[0].count
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} with Points & Leaderboard system!`));
