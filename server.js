const express = require("express");
const multer = require("multer");
const xml2js = require("xml2js");
const HTMLtoDOCX = require("html-to-docx");
const archiver = require("archiver");
const { PassThrough } = require("stream");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
let posts = [];

app.use(express.urlencoded({ extended: true }));

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeFilename(title, index) {
  const name = (title || "")
    .replace(/[^a-z0-9\s-]/gi, "")
    .trim()
    .replace(/\s+/g, "_")
    .substring(0, 80);
  return name || `post_${index}`;
}

const DOCX_OPTIONS = {
  table: { row: { cantSplit: true } },
  footer: false,
  pageNumber: false,
  font: "Arial",
  fontSize: 24,
  margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
};

// ── Upload ────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send(`
    <html>
    <head>
      <title>WP XML Viewer</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 1000px; margin: 40px auto; padding: 20px; }
        .upload-box { border: 2px dashed #ccc; padding: 30px; text-align: center; }
      </style>
    </head>
    <body>
      <h1>WordPress XML Viewer</h1>
      <form action="/upload" method="post" enctype="multipart/form-data">
        <div class="upload-box">
          <input type="file" name="xmlfile" accept=".xml" required />
          <br><br>
          <button type="submit">Upload XML</button>
        </div>
      </form>
    </body>
    </html>
  `);
});

app.post("/upload", upload.single("xmlfile"), async (req, res) => {
  try {
    const xml = req.file.buffer.toString("utf8");
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    const data = await parser.parseStringPromise(xml);
    const items = data.rss.channel.item || [];
    const arr = Array.isArray(items) ? items : [items];
    posts = arr.filter(item => (item["wp:post_type"] || item.post_type) === "post");
    res.redirect("/posts");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error parsing XML");
  }
});

// ── Post list ─────────────────────────────────────────────────────────────────

app.get("/posts", (req, res) => {
  let html = `
  <html>
  <head>
    <title>Posts</title>
    <style>
      body { font-family: Arial; max-width: 1000px; margin: 30px auto; padding: 20px; }
      li { margin: 8px 0; }
      a { text-decoration: none; color: #0066cc; }
      .download-all-btn {
        display: inline-block; background: #28a745; color: white;
        padding: 9px 20px; border-radius: 4px; font-size: 14px; text-decoration: none;
      }
      .download-all-btn:hover { background: #218838; }
    </style>
  </head>
  <body>
    <h1>Total Posts: ${posts.length}</h1>
    <p><a class="download-all-btn" href="/download-all">⬇ Download All as ZIP</a></p>
    <ul>
  `;
  posts.forEach((post, index) => {
    html += `<li><a href="/post/${index}">${escapeHtml(post.title || "Untitled")}</a></li>`;
  });
  html += `
    </ul>
    <p><a href="/">Upload Another XML</a></p>
  </body></html>`;
  res.send(html);
});

// ── Download ALL as ZIP  (defined before /post/:id to avoid any ambiguity) ───

app.get("/download-all", async (req, res) => {
  if (!posts.length) {
    return res.status(400).send("No posts loaded. Please upload an XML first.");
  }

  console.log(`Generating ZIP for ${posts.length} posts…`);

  // 1. Build every DOCX buffer first — if anything throws, we haven't touched res yet
  const files = [];
  const usedNames = {};

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const title = post.title || "Untitled";
    const date  = post["wp:post_date"] || "";
    const content = post["content:encoded"] || post.encoded || "";

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>${escapeHtml(title)}</title></head><body>
      <h1>${escapeHtml(title)}</h1>
      <p><em>Published: ${escapeHtml(date)}</em></p><hr>
      ${content}
      </body></html>`;

    try {
      const buf = await HTMLtoDOCX(html, null, DOCX_OPTIONS);
      let base = safeFilename(title, i);
      if (usedNames[base]) {
        usedNames[base]++;
        base = `${base}_${usedNames[base]}`;
      } else {
        usedNames[base] = 1;
      }
      files.push({ name: `${base}.docx`, buf });
      console.log(`  [${i + 1}/${posts.length}] OK — ${base}.docx`);
    } catch (err) {
      console.error(`  [${i + 1}/${posts.length}] FAILED — ${title}:`, err.message);
      // Skip broken post; keep going
    }
  }

  if (!files.length) {
    return res.status(500).send("Could not generate any DOCX files.");
  }

  // 2. All buffers ready — now stream the ZIP
  res.setHeader("Content-Disposition", 'attachment; filename="all-posts.zip"');
  res.setHeader("Content-Type", "application/zip");

  const archive = archiver("zip", { zlib: { level: 6 } });

  archive.on("error", err => {
    console.error("Archiver error:", err);
    // res headers already sent; just destroy
    res.destroy();
  });

  archive.pipe(res);

  for (const { name, buf } of files) {
    archive.append(buf, { name });
  }

  await archive.finalize();
  console.log("ZIP sent.");
});

// ── Single post view ──────────────────────────────────────────────────────────

app.get("/post/:id", (req, res) => {
  const post = posts[req.params.id];
  if (!post) return res.status(404).send("Post not found");

  const content = post["content:encoded"] || post.encoded || "";
  const date    = post["wp:post_date"] || "";

  res.send(`
    <html>
    <head>
      <title>${escapeHtml(post.title)}</title>
      <style>
        body { max-width: 900px; margin: 40px auto; font-family: Arial, sans-serif; line-height: 1.7; padding: 20px; }
        img { max-width: 100%; height: auto; }
        pre { overflow-x: auto; background: #f5f5f5; padding: 10px; }
        .actions { display: flex; align-items: center; gap: 16px; margin: 16px 0; }
        .download-btn {
          display: inline-block; background: #0066cc; color: white;
          padding: 8px 18px; border-radius: 4px; text-decoration: none; font-size: 14px;
        }
        .download-btn:hover { background: #0052a3; }
      </style>
    </head>
    <body>
      <div class="actions">
        <a href="/posts">← Back to Posts</a>
        <a class="download-btn" href="/post/${req.params.id}/download">⬇ Download as Word Doc</a>
      </div>
      <h1>${escapeHtml(post.title)}</h1>
      <p><small>${escapeHtml(date)}</small></p>
      <hr>
      ${content}
    </body>
    </html>
  `);
});

// ── Single post download ──────────────────────────────────────────────────────

app.get("/post/:id/download", async (req, res) => {
  const post = posts[req.params.id];
  if (!post) return res.status(404).send("Post not found");

  const content = post["content:encoded"] || post.encoded || "";
  const title   = post.title || "Untitled";
  const date    = post["wp:post_date"] || "";

  const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>${escapeHtml(title)}</title></head><body>
    <h1>${escapeHtml(title)}</h1>
    <p><em>Published: ${escapeHtml(date)}</em></p><hr>
    ${content}
    </body></html>`;

  try {
    const buf = await HTMLtoDOCX(htmlContent, null, DOCX_OPTIONS);
    const safe = safeFilename(title, req.params.id);
    res.setHeader("Content-Disposition", `attachment; filename="${safe}.docx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.send(buf);
  } catch (err) {
    console.error("DOCX generation error:", err);
    res.status(500).send("Error generating Word document");
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(3000, () => {
  console.log("Running on http://localhost:3000");
});
