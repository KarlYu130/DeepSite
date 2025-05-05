import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import {
  createRepo,
  uploadFiles,
  whoAmI,
  spaceInfo,
  fileExists,
} from "@huggingface/hub";
// import { InferenceClient } from "@huggingface/inference";
import bodyParser from "body-parser";
import OpenAI from "openai";

import checkUser from "./middlewares/checkUser.js";
import { PROVIDERS } from "./utils/providers.js";
import { COLORS } from "./utils/colors.js";

console.log('[DEBUG] process.cwd():', process.cwd());
// Load environment variables from .env file
dotenv.config();

// Runtime override: always use .env values for OPENAI_ variables
const envOverride = dotenv.config().parsed || {};
for (const k of Object.keys(envOverride)) {
  if (k.startsWith('OPENAI_')) {
    process.env[k] = envOverride[k];
  }
}

const app = express();

const ipAddresses = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.APP_PORT || 3000;
const REDIRECT_URI =
  process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/login`;
const DEFAULT_MODEL = process.env.OPENAI_MODEL; // Default OpenAI-compatible model
const MAX_REQUESTS_PER_IP = 2;

app.use(cookieParser());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "dist")));

const getPTag = (repoId) => {
  return `<p style="border-radius: 8px; text-align: center; font-size: 12px; color: #fff; margin-top: 16px;position: fixed; left: 8px; bottom: 8px; z-index: 10; background: rgba(0, 0, 0, 0.8); padding: 4px 8px;">Made with <img src="https://enzostvs-deepsite.hf.space/logo.svg" alt="DeepSite Logo" style="width: 16px; height: 16px; vertical-align: middle;display:inline-block;margin-right:3px;filter:brightness(0) invert(1);"><a href="https://enzostvs-deepsite.hf.space" style="color: #fff;text-decoration: underline;" target="_blank" >DeepSite</a> - 🧬 <a href="https://enzostvs-deepsite.hf.space?remix=${repoId}" style="color: #fff;text-decoration: underline;" target="_blank" >Remix</a></p>`;
};

app.get("/api/login", (_req, res) => {
  const redirectUrl = `https://huggingface.co/oauth/authorize?client_id=${process.env.OAUTH_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=openid%20profile%20write-repos%20manage-repos%20inference-api&prompt=consent&state=1234567890`;
  res.status(200).send({
    ok: true,
    redirectUrl,
  });
});
app.get("/auth/login", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect(302, "/");
  }
  const Authorization = `Basic ${Buffer.from(
    `${process.env.OAUTH_CLIENT_ID}:${process.env.OAUTH_CLIENT_SECRET}`
  ).toString("base64")}`;

  const request_auth = await fetch("https://huggingface.co/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const response = await request_auth.json();

  if (!response.access_token) {
    return res.redirect(302, "/");
  }

  res.cookie("hf_token", response.access_token, {
    httpOnly: false,
    secure: true,
    sameSite: "none",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  return res.redirect(302, "/");
});
app.get("/auth/logout", (req, res) => {
  res.clearCookie("hf_token", {
    httpOnly: false,
    secure: true,
    sameSite: "none",
  });
  return res.redirect(302, "/");
});

app.get("/api/@me", checkUser, async (req, res) => {
  let { hf_token } = req.cookies;

  if (process.env.HF_TOKEN && process.env.HF_TOKEN !== "") {
    return res.send({
      preferred_username: "local-use",
      isLocalUse: true,
    });
  }

  try {
    const request_user = await fetch("https://huggingface.co/oauth/userinfo", {
      headers: {
        Authorization: `Bearer ${hf_token}`,
      },
    });

    const user = await request_user.json();
    res.send(user);
  } catch (err) {
    res.clearCookie("hf_token", {
      httpOnly: false,
      secure: true,
      sameSite: "none",
    });
    res.status(401).send({
      ok: false,
      message: err.message,
    });
  }
});

app.post("/api/deploy", checkUser, async (req, res) => {
  const { html, title, path, prompts } = req.body;
  if (!html || (!path && !title)) {
    return res.status(400).send({
      ok: false,
      message: "Missing required fields",
    });
  }

  let { hf_token } = req.cookies;
  if (process.env.HF_TOKEN && process.env.HF_TOKEN !== "") {
    hf_token = process.env.HF_TOKEN;
  }

  try {
    const repo = {
      type: "space",
      name: path ?? "",
    };

    let readme;
    let newHtml = html;

    if (!path || path === "") {
      const { name: username } = await whoAmI({ accessToken: hf_token });
      const newTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .split("-")
        .filter(Boolean)
        .join("-")
        .slice(0, 96);

      const repoId = `${username}/${newTitle}`;
      repo.name = repoId;

      await createRepo({
        repo,
        accessToken: hf_token,
      });
      const colorFrom = COLORS[Math.floor(Math.random() * COLORS.length)];
      const colorTo = COLORS[Math.floor(Math.random() * COLORS.length)];
      readme = `---
title: ${newTitle}
emoji: 🐳
colorFrom: ${colorFrom}
colorTo: ${colorTo}
sdk: static
pinned: false
tags:
  - deepsite
---

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference`;
    }

    newHtml = html.replace(/<\/body>/, `${getPTag(repo.name)}</body>`);
    const file = new Blob([newHtml], { type: "text/html" });
    file.name = "index.html"; // Add name property to the Blob

    // create prompt.txt file with all the prompts used, split by new line
    const newPrompts = ``.concat(prompts.map((prompt) => prompt).join("\n"));
    const promptFile = new Blob([newPrompts], { type: "text/plain" });
    promptFile.name = "prompts.txt"; // Add name property to the Blob

    const files = [file, promptFile];
    if (readme) {
      const readmeFile = new Blob([readme], { type: "text/markdown" });
      readmeFile.name = "README.md"; // Add name property to the Blob
      files.push(readmeFile);
    }
    await uploadFiles({
      repo,
      files,
      accessToken: hf_token,
    });
    return res.status(200).send({ ok: true, path: repo.name });
  } catch (err) {
    return res.status(500).send({
      ok: false,
      message: err.message,
    });
  }
});

app.post("/api/ask-ai", async (req, res) => {
  // Print all OPENAI_ env variables for debugging
  Object.keys(process.env)
    .filter((k) => k.startsWith('OPENAI_'))
    .forEach((k) => console.log(`[DEBUG] process.env.${k}:`, process.env[k]));
  const { prompt, html, previousPrompt, provider } = req.body;
  if (!prompt) {
    return res.status(400).send({
      ok: false,
      message: "Missing required fields",
    });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_API_URL = process.env.OPENAI_API_URL;
  if (!OPENAI_API_KEY) {
    return res.status(500).send({
      ok: false,
      message: "OpenAI API key not configured.",
    });
  }

  // Model selection (provider is now model name, fallback to default or env)
  const model = provider && provider !== "auto" ? provider : (process.env.OPENAI_MODEL || DEFAULT_MODEL);

  // Compose messages array
  const messages = [
    {
      role: "system",
      content:
        "ONLY USE HTML, CSS AND JAVASCRIPT. If you want to use ICON make sure to import the library first. Try to create the best UI possible by using only HTML, CSS and JAVASCRIPT. Use as much as you can TailwindCSS for the CSS, if you can't do something with TailwindCSS, then use custom CSS (make sure to import <script src=\"https://cdn.tailwindcss.com\"></script> in the head). Also, try to ellaborate as much as you can, to create something unique. ALWAYS GIVE THE RESPONSE INTO A SINGLE HTML FILE",
    },
    ...(previousPrompt
      ? [
          {
            role: "user",
            content: previousPrompt,
          },
        ]
      : []),
    ...(html
      ? [
          {
            role: "assistant",
            content: `The current code is: ${html}.`,
          },
        ]
      : []),
    {
      role: "user",
      content: prompt,
    },
  ];

  // Set up response headers for streaming
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Debug print for Gemini detection
  // const isGemini = OPENAI_API_URL && OPENAI_API_URL.includes("generativelanguage.googleapis.com");
  // console.log("[DEBUG] OPENAI_API_URL:", OPENAI_API_URL);
  // console.log("[DEBUG] isGemini:", isGemini);

  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_API_URL });
    const stream = await openai.chat.completions.create({
      model,
      messages,
      stream: true,
    });

    let completeResponse = "";
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        res.write(delta);
        completeResponse += delta;
        if (completeResponse.includes("</html>")) {
          break;
        }
      }
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).send({
        ok: false,
        message: error.message || "An error occurred while processing your request.",
      });
    } else {
      res.end();
    }
  }
});

app.get("/api/remix/:username/:repo", async (req, res) => {
  const { username, repo } = req.params;
  const { hf_token } = req.cookies;

  let token = hf_token || process.env.DEFAULT_HF_TOKEN;

  if (process.env.HF_TOKEN && process.env.HF_TOKEN !== "") {
    token = process.env.HF_TOKEN;
  }

  const repoId = `${username}/${repo}`;

  const url = `https://huggingface.co/spaces/${repoId}/raw/main/index.html`;
  try {
    const space = await spaceInfo({
      name: repoId,
      accessToken: token,
      additionalFields: ["author"],
    });

    if (!space || space.sdk !== "static" || space.private) {
      return res.status(404).send({
        ok: false,
        message: "Space not found",
      });
    }

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(404).send({
        ok: false,
        message: "Space not found",
      });
    }
    let html = await response.text();
    // remove the last p tag including this url https://enzostvs-deepsite.hf.space
    html = html.replace(getPTag(repoId), "");

    let user = null;

    if (token) {
      const request_user = await fetch(
        "https://huggingface.co/oauth/userinfo",
        {
          headers: {
            Authorization: `Bearer ${hf_token}`,
          },
        }
      )
        .then((res) => res.json())
        .catch(() => null);

      user = request_user;
    }

    res.status(200).send({
      ok: true,
      html,
      isOwner: space.author === user?.preferred_username,
      path: repoId,
    });
  } catch (error) {
    return res.status(500).send({
      ok: false,
      message: error.message,
    });
  }
});
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
