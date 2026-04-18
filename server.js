const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const OpenAI = require("openai");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// Use Environment Variables (from Render)
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const ADMIN_PASSWORD = "admin123";

const db = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  ssl: { rejectUnauthorized: false }
});

async function setupDB() {
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) UNIQUE, password VARCHAR(100))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS courses (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(200), video VARCHAR(500))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS notes (id INT AUTO_INCREMENT PRIMARY KEY, className VARCHAR(10), subject VARCHAR(100), chapter VARCHAR(200), content TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS study (id INT AUTO_INCREMENT PRIMARY KEY, user VARCHAR(100), chapter VARCHAR(200))`);
  console.log("✅ Railway Database and tables ready!");
}

setupDB();

const syllabus = {
  "10": {
    "Maths": ["Real Numbers","Polynomials","Pair of Linear Equations","Quadratic Equations","Arithmetic Progressions","Triangles","Coordinate Geometry","Trigonometry","Applications of Trigonometry","Circles","Surface Areas and Volumes","Statistics","Probability"],
    "Science": ["Chemical Reactions","Acids Bases and Salts","Metals and Non-metals","Carbon and Compounds","Life Processes","Control and Coordination","Reproduction","Heredity and Evolution","Light","Human Eye","Electricity","Magnetism","Environment","Resources"],
    "Social Science": ["Resources and Development","Forest and Wildlife","Water Resources","Agriculture","Minerals and Energy Resources","Manufacturing Industries","Lifelines of National Economy","Power Sharing","Federalism","Democracy and Diversity","Gender Religion Caste","Popular Struggles","Political Parties","Outcomes of Democracy","Challenges to Democracy","Development","Sectors of Economy","Money and Credit","Globalisation","Consumer Rights"],
    "English": ["A Letter to God","Nelson Mandela","Two Stories about Flying","From the Diary of Anne Frank","Glimpses of India","Mijbil the Otter","Madam Rides the Bus","The Sermon at Benares","The Proposal","A Triumph of Surgery","The Thief's Story","The Midnight Visitor","A Question of Trust","Footprints without Feet","The Making of a Scientist","The Necklace","The Hack Driver","Bholi","The Book That Saved the Earth"]
  },
  "12": {
    "Physics": ["Electric Charges and Fields","Electrostatic Potential","Current Electricity","Moving Charges and Magnetism","Magnetism and Matter","Electromagnetic Induction","Alternating Current","Electromagnetic Waves","Ray Optics","Wave Optics","Dual Nature of Radiation","Atoms","Nuclei","Semiconductor Electronics","Communication Systems"],
    "Chemistry": ["Solid State","Solutions","Electrochemistry","Chemical Kinetics","Surface Chemistry","General Principles of Isolation","p-Block Elements","d and f Block Elements","Coordination Compounds","Haloalkanes and Haloarenes","Alcohols Phenols and Ethers","Aldehydes Ketones and Carboxylic Acids","Amines","Biomolecules","Polymers","Chemistry in Everyday Life"],
    "Maths": ["Relations and Functions","Inverse Trigonometric Functions","Matrices","Determinants","Continuity and Differentiability","Application of Derivatives","Integrals","Application of Integrals","Differential Equations","Vector Algebra","Three Dimensional Geometry","Linear Programming","Probability"],
    "Biology": ["Reproduction in Organisms","Sexual Reproduction in Flowering Plants","Human Reproduction","Reproductive Health","Principles of Inheritance","Molecular Basis of Inheritance","Evolution","Human Health and Disease","Strategies for Enhancement in Food Production","Microbes in Human Welfare","Biotechnology Principles","Biotechnology and its Applications","Organisms and Populations","Ecosystem","Biodiversity and Conservation","Environmental Issues"],
    "English": ["The Last Lesson","Lost Spring","Deep Water","The Rattrap","Indigo","Poets and Pancakes","The Interview","Going Places","My Mother at Sixty Six","An Elementary School Classroom in a Slum","Keeping Quiet","A Thing of Beauty","A Roadside Stand","Aunt Jennifers Tigers","The Third Level","The Tiger King","Journey to the End of the Earth","The Enemy","On the Face of It","Memories of Childhood"]
  }
};

let memory = {};

app.post("/register", async (req, res) => {
  const { name, password } = req.body;
  const [rows] = await db.execute("SELECT * FROM users WHERE name = ?", [name]);
  if (rows.length > 0) return res.json({ message: "User already exists" });
  await db.execute("INSERT INTO users (name, password) VALUES (?, ?)", [name, password]);
  res.json({ message: "Registered successfully" });
});

app.post("/login", async (req, res) => {
  const { name, password } = req.body;
  const [rows] = await db.execute("SELECT * FROM users WHERE name = ? AND password = ?", [name, password]);
  if (rows.length === 0) return res.status(401).json({ message: "Invalid credentials" });
  res.json({ message: "Login success", user: { name } });
});

app.get("/courses", async (req, res) => {
  const [rows] = await db.execute("SELECT * FROM courses");
  res.json(rows);
});

app.post("/add-course", async (req, res) => {
  const { title, video, adminPass } = req.body;
  if (adminPass !== ADMIN_PASSWORD) return res.status(403).json({ message: "Unauthorized" });
  await db.execute("INSERT INTO courses (title, video) VALUES (?, ?)", [title, video]);
  res.json({ message: "Course added" });
});

app.get("/syllabus", (req, res) => res.json(syllabus));

app.post("/generate-notes", async (req, res) => {
  const { className, subject, chapter } = req.body;
  const [rows] = await db.execute("SELECT * FROM notes WHERE className = ? AND subject = ? AND chapter = ?", [className, subject, chapter]);
  if (rows.length > 0) return res.json({ notes: rows[0].content });

  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 1000,
    messages: [
      { role: "system", content: "You are a CBSE teacher. Write detailed structured notes with headings and bullet points." },
      { role: "user", content: `Class ${className} ${subject} — ${chapter}` }
    ]
  });

  const content = response.choices[0].message.content;
  await db.execute("INSERT INTO notes (className, subject, chapter, content) VALUES (?, ?, ?, ?)", [className, subject, chapter, content]);
  res.json({ notes: content });
});

app.post("/ask-ai", async (req, res) => {
  const { user, question, lang = "English" } = req.body;
  if (!memory[user]) memory[user] = [];
  memory[user].push({ role: "user", content: question });

  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 800,
    messages: [
      { role: "system", content: `You are a friendly CBSE teacher. Explain simply with examples. Reply in ${lang}.` },
      ...memory[user]
    ]
  });

  const answer = response.choices[0].message.content;
  memory[user].push({ role: "assistant", content: answer });
  res.json({ answer });
});

app.post("/quiz", async (req, res) => {
  const { className, subject, chapter } = req.body;
  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 800,
    messages: [
      { role: "system", content: "Create 5 CBSE-style MCQ questions with 4 options each and mark the correct answer." },
      { role: "user", content: `Class ${className} ${subject} — ${chapter}` }
    ]
  });
  res.json({ quiz: response.choices[0].message.content });
});

app.post("/exam", async (req, res) => {
  const { className } = req.body;
  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 1500,
    messages: [
      { role: "system", content: "Create a full CBSE-style board exam paper with sections A, B, C, D." },
      { role: "user", content: `Full sample paper for Class ${className}` }
    ]
  });
  res.json({ paper: response.choices[0].message.content });
});

app.post("/study", async (req, res) => {
  await db.execute("INSERT INTO study (user, chapter) VALUES (?, ?)", [req.body.user, req.body.chapter]);
  res.json({ message: "Tracked" });
});

app.get("/progress/:user", async (req, res) => {
  const [rows] = await db.execute("SELECT * FROM study WHERE user = ?", [req.params.user]);
  res.json({ total: rows.length, chapters: rows.map(r => r.chapter) });
});

app.post("/recommend", async (req, res) => {
  const { user, className, subject } = req.body;
  const [rows] = await db.execute("SELECT chapter FROM study WHERE user = ?", [user]);
  const done = rows.map(r => r.chapter);
  const all = (syllabus[className] || {})[subject] || [];
  const next = all.find(c => !done.includes(c));
  res.json({ next: next || "All chapters completed!" });
});

app.post("/complete-course", (req, res) => {
  const { user, course } = req.body;
  res.json({ certificate: `Certificate of Completion — ${user} has successfully completed ${course}` });
});

// ✅ NEW: Stats endpoint for Admin Panel
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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} — Ready for the world!`));
