const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const OpenAI = require("openai");
const jwt = require("jsonwebtoken");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "secret123";

const chatClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const imageClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const db = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: { rejectUnauthorized: false }
});

async function setupDB() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) UNIQUE,
        password VARCHAR(100),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS courses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200),
        video VARCHAR(500),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        className VARCHAR(10),
        subject VARCHAR(100),
        chapter VARCHAR(200),
        content TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_note (className, subject, chapter)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS study (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user VARCHAR(100),
        chapter VARCHAR(200),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_study (user, chapter)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS timer_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user VARCHAR(100) UNIQUE,
        minutes INT DEFAULT 25,
        seconds INT DEFAULT 0,
        label VARCHAR(100) DEFAULT 'Pomodoro',
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user VARCHAR(100),
        title VARCHAR(255),
        done BOOLEAN DEFAULT FALSE,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user VARCHAR(100),
        type VARCHAR(100),
        preview VARCHAR(255),
        content TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS generated_images (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user VARCHAR(100),
        prompt TEXT,
        style VARCHAR(100),
        size VARCHAR(30),
        imageUrl TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("DB Ready");
  } catch (err) {
    console.error("DB Setup Error:", err);
  }
}

setupDB();

function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ error: "No token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.name;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

async function askGroq(systemPrompt, userPrompt) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured");
  }

  const ai = await chatClient.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  return ai.choices?.[0]?.message?.content || "";
}

function buildImagePrompt({ prompt, style, size, subject, chapter }) {
  return [
    normalizeText(prompt),
    `${normalizeText(style || "Cinematic")} style`,
    subject ? `study theme around ${normalizeText(subject)}` : "",
    chapter ? `inspired by ${normalizeText(chapter)}` : "",
    "vibrant lighting",
    "clean composition",
    "high detail",
    size ? `aspect ${normalizeText(size)}` : ""
  ]
    .filter(Boolean)
    .join(", ");
}

app.post("/register", async (req, res) => {
  try {
    const name = normalizeText(req.body.name);
    const password = normalizeText(req.body.password);

    if (!name || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const [rows] = await db.execute("SELECT id FROM users WHERE name=?", [name]);

    if (rows.length) {
      return res.json({ message: "User exists" });
    }

    await db.execute("INSERT INTO users (name, password) VALUES (?, ?)", [name, password]);
    res.json({ message: "Registered" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const name = normalizeText(req.body.name);
    const password = normalizeText(req.body.password);

    const [rows] = await db.execute(
      "SELECT id FROM users WHERE name=? AND password=?",
      [name, password]
    );

    if (!rows.length) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ name }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/courses", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM courses ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error" });
  }
});

app.post("/add-course", async (req, res) => {
  try {
    const title = normalizeText(req.body.title);
    const video = normalizeText(req.body.video);

    if (!title || !video) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await db.execute("INSERT INTO courses (title, video) VALUES (?, ?)", [title, video]);
    res.json({ message: "Course added" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error" });
  }
});

app.post("/generate-notes", auth, async (req, res) => {
  try {
    const className = normalizeText(req.body.className);
    const subject = normalizeText(req.body.subject);
    const chapter = normalizeText(req.body.chapter);

    if (!className || !subject || !chapter) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const [rows] = await db.execute(
      "SELECT content FROM notes WHERE className=? AND subject=? AND chapter=?",
      [className, subject, chapter]
    );

    if (rows.length) {
      return res.json({ notes: rows[0].content, cached: true });
    }

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
    res.status(500).json({ error: "AI error" });
  }
});

app.post("/study", auth, async (req, res) => {
  try {
    const chapter = normalizeText(req.body.chapter);

    if (!chapter) {
      return res.status(400).json({ error: "Missing chapter" });
    }

    await db.execute("INSERT IGNORE INTO study (user, chapter) VALUES (?, ?)", [req.user, chapter]);
    res.json({ message: "Tracked" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error" });
  }
});

app.get("/progress", auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT chapter, createdAt FROM study WHERE user=? ORDER BY createdAt DESC",
      [req.user]
    );

    res.json({
      total: rows.length,
      chapters: rows.map((r) => r.chapter),
      history: rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error" });
  }
});

app.post("/ask-ai", auth, async (req, res) => {
  try {
    const question = normalizeText(req.body.question);

    if (!question) {
      return res.status(400).json({ error: "Missing question" });
    }

    const answer = await askGroq(
      "Explain simply like a helpful teacher. Use short sections and examples when useful.",
      question
    );

    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI error" });
  }
});

app.post("/quiz", auth, async (req, res) => {
  try {
    const className = normalizeText(req.body.className);
    const subject = normalizeText(req.body.subject);
    const chapter = normalizeText(req.body.chapter);

    if (!className || !subject || !chapter) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const quiz = await askGroq(
      "Create a short quiz with answers. Include 5 questions with clean formatting.",
      `${className} ${subject} ${chapter}`
    );

    res.json({ quiz });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Quiz error" });
  }
});

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
    const [u] = await db.execute("SELECT COUNT(*) AS c FROM users");
    const [s] = await db.execute("SELECT COUNT(*) AS c FROM study");
    const [n] = await db.execute("SELECT COUNT(*) AS c FROM notes");
    const [t] = await db.execute("SELECT COUNT(*) AS c FROM tasks");

    res.json({
      users: u[0].c,
      study: s[0].c,
      notes: n[0].c,
      tasks: t[0].c
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error" });
  }
});

app.get("/timer", auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT minutes, seconds, label FROM timer_settings WHERE user=?",
      [req.user]
    );

    if (!rows.length) {
      return res.json({ minutes: 25, seconds: 0, label: "Pomodoro" });
    }

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
    const label = normalizeText(req.body.label || "Custom");

    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || minutes < 0 || seconds < 0 || seconds > 59) {
      return res.status(400).json({ error: "Invalid timer values" });
    }

    await db.execute(
      `
        INSERT INTO timer_settings (user, minutes, seconds, label)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          minutes = VALUES(minutes),
          seconds = VALUES(seconds),
          label = VALUES(label)
      `,
      [req.user, minutes, seconds, label]
    );

    res.json({ message: "Timer saved", minutes, seconds, label });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Timer save error" });
  }
});

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

    if (!title) {
      return res.status(400).json({ error: "Missing title" });
    }

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
    const id = Number(req.params.id);
    const done = Boolean(req.body.done);

    await db.execute(
      "UPDATE tasks SET done=? WHERE id=? AND user=?",
      [done, id, req.user]
    );

    res.json({ message: "Task updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Task update error" });
  }
});

app.delete("/tasks/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.execute("DELETE FROM tasks WHERE id=? AND user=?", [id, req.user]);
    res.json({ message: "Task deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Task delete error" });
  }
});

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
    const type = normalizeText(req.body.type);
    const content = normalizeText(req.body.content);
    const preview = normalizeText(req.body.preview || content.slice(0, 120));

    if (!type || !content) {
      return res.status(400).json({ error: "Missing bookmark fields" });
    }

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
    const id = Number(req.params.id);
    await db.execute("DELETE FROM bookmarks WHERE id=? AND user=?", [id, req.user]);
    res.json({ message: "Bookmark deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Bookmark delete error" });
  }
});

app.post("/generate-image", auth, async (req, res) => {
  try {
    const prompt = normalizeText(req.body.prompt);
    const style = normalizeText(req.body.style || "Cinematic");
    const size = normalizeText(req.body.size || "1024x1024");
    const subject = normalizeText(req.body.subject || "");
    const chapter = normalizeText(req.body.chapter || "");

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const finalPrompt = buildImagePrompt({ prompt, style, size, subject, chapter });

    if (!imageClient) {
      return res.status(501).json({
        error: "OPENAI_API_KEY not configured for image generation",
        promptEnhanced: finalPrompt
      });
    }

    const image = await imageClient.images.generate({
      model: "gpt-image-1",
      prompt: finalPrompt,
      size
    });

    const imageUrl = image.data?.[0]?.url;
    const imageBase64 = image.data?.[0]?.b64_json;

    if (!imageUrl && !imageBase64) {
      return res.status(500).json({ error: "No image returned", promptEnhanced: finalPrompt });
    }

    await db.execute(
      "INSERT INTO generated_images (user, prompt, style, size, imageUrl) VALUES (?, ?, ?, ?, ?)",
      [req.user, finalPrompt, style, size, imageUrl || "[base64-image]"]
    );

    res.json({
      promptEnhanced: finalPrompt,
      imageUrl: imageUrl || null,
      b64_json: imageBase64 || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Image generation error" });
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

app.get("/", (req, res) => {
  res.send("BrainWave X Backend Running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
