const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// API route
app.get("/api", (req, res) => {
  res.json({
    message: "🌊 Ocean API is working!",
  });
});

// Fallback route (FIXED)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`🌊 Server running at http://localhost:${PORT}`);
});
