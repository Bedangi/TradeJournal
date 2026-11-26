"use strict";

require("dotenv").config();

const path = require("node:path");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const connectMongo = require("connect-mongo");
const cors = require("cors");
const express = require("express");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const helmet = require("helmet");

const app = express();
const isNetlify = Boolean(process.env.NETLIFY);
const isProduction = process.env.NODE_ENV === "production" || isNetlify;
const port = Number(process.env.PORT);
const mongoUri = process.env.MONGODB_URI || "";
const databaseName = process.env.MONGODB_DB_NAME || "edgevault";
const sessionSecret = process.env.SESSION_SECRET || "";
const cookieSameSite = (process.env.COOKIE_SAME_SITE || "lax").toLowerCase();
const allowedOrigins = new Set((process.env.FRONTEND_ORIGINS || "http://localhost:3000,http://127.0.0.1:8000")
  .split(",").map(origin => origin.trim()).filter(Boolean));
const SESSION_COOKIE = "edgevault.sid";
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const frontendFiles = new Set(["index.html", "styles.css", "app.js", "api-config.js"]);
let mongoClientPromise;
let databasePromise;
let sessionMiddleware;

function validateConfiguration() {
  if (!mongoUri || /USERNAME|PASSWORD|YOUR_CLUSTER|<|>/.test(mongoUri)) {
    throw new Error("Set MONGODB_URI in .env to your real MongoDB Atlas connection string.");
  }
  if (sessionSecret.length < 32 || /REPLACE_WITH|CHANGE_ME/i.test(sessionSecret)) {
    throw new Error("Set SESSION_SECRET in .env to a random secret of at least 32 characters.");
  }
  if (!["none", "lax", "strict"].includes(cookieSameSite)) {
    throw new Error("COOKIE_SAME_SITE must be none, lax, or strict.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validateEmailAndPassword(emailValue, passwordValue, requireStrongPassword) {
  const email = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : "";
  const password = typeof passwordValue === "string" ? passwordValue : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }
  const passwordBytes = Buffer.byteLength(password, "utf8");
  if (requireStrongPassword && (password.length < 12 || passwordBytes > 72)) {
    return { error: "Password must be at least 12 characters and no more than 72 UTF-8 bytes." };
  }
  if (!requireStrongPassword && (!password || passwordBytes > 72)) {
    return { error: "Enter a valid password." };
  }
  return { email, password };
}

function validateJournal(journal) {
  if (!journal || typeof journal !== "object" || Array.isArray(journal) ||
      !Array.isArray(journal.strategies) || !Array.isArray(journal.trades)) {
    return "Journal must contain strategies and trades arrays.";
  }
  if (journal.strategies.length > 500 || journal.trades.length > 25000) {
    return "Journal exceeds the supported number of entries.";
  }
  if (journal.trades.some(trade => !trade || typeof trade !== "object" || Array.isArray(trade))) {
    return "Every trade must be a JSON object.";
  }
  let serialized;
  try { serialized = JSON.stringify(journal); }
  catch { return "Journal must be valid JSON."; }
  if (Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_BYTES) {
    return "Journal is too large to save (maximum 4 MB).";
  }
  return null;
}

function publicUser(user) {
  return { id: user._id.toString(), email: user.email };
}

function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      req.session.userId = user._id.toString();
      req.session.save(saveError => saveError ? reject(saveError) : resolve());
    });
  });
}

function requireAuthentication(req, res, next) {
  if (!req.session.userId || !ObjectId.isValid(req.session.userId)) {
    return res.status(401).json({ error: "Sign in to access your journal." });
  }
  next();
}

function requestOriginIsAllowed(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  return allowedOrigins.has(origin) || origin === `${req.protocol}://${req.get("host")}`;
}

function getMongoClient() {
  if (!mongoClientPromise) {
    validateConfiguration();
    const client = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10,
      secureProtocol: "TLSv1_2_method"
    });
    mongoClientPromise = client.connect().then(() => client).catch(error => {
      mongoClientPromise = null;
      client.close().catch(() => {});
      throw error;
    });
  }
  return mongoClientPromise;
}

function getDatabase() {
  if (!databasePromise) {
    databasePromise = getMongoClient().then(async client => {
      const db = client.db(databaseName);
      await Promise.all([
        db.collection("users").createIndex({ email: 1 }, { unique: true, name: "unique_user_email" }),
        db.collection("journals").createIndex({ userId: 1 }, { unique: true, name: "one_journal_per_user" }),
        db.collection("sessions").createIndex({ expires: 1 }, { expireAfterSeconds: 0 })
      ]);
      return {
        client,
        db,
        users: db.collection("users"),
        journals: db.collection("journals")
      };
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function createSessionMiddleware(client) {
  if (!sessionMiddleware) {
    const store = connectMongo.create({
      clientPromise: Promise.resolve(client),
      dbName: databaseName,
      collectionName: "sessions",
      ttl: 7 * 24 * 60 * 60,
      autoRemove: "disabled"
    });
    sessionMiddleware = session({
      name: SESSION_COOKIE,
      secret: sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: isProduction || cookieSameSite === "none",
        sameSite: cookieSameSite,
        maxAge: 7 * 24 * 60 * 60 * 1000
      }
    });
  }
  return sessionMiddleware;
}

function initializeApiRequest(req, res, next) {
  getDatabase().then(({ client }) => {
    createSessionMiddleware(client)(req, res, next);
  }).catch(next);
}

app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use((req, res, next) => cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || requestOriginIsAllowed(req)) return callback(null, true);
    return callback(new Error("This browser origin is not allowed by the API."));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
})(req, res, next));
app.use(express.json({ limit: "5mb", strict: true }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !requestOriginIsAllowed(req)) {
    return res.status(403).json({ error: "This browser origin is not allowed to modify account data." });
  }
  next();
});
app.use("/api", initializeApiRequest);

function registerRoutes() {
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many account requests. Please wait a few minutes and try again." }
  });
  const auth = express.Router();

  auth.get("/me", asyncHandler(async (req, res) => {
    if (!req.session.userId || !ObjectId.isValid(req.session.userId)) {
      return res.json({ user: null });
    }
    const { users } = await getDatabase();
    const user = await users.findOne({ _id: new ObjectId(req.session.userId) });
    if (!user) {
      return res.status(401).json({ error: "Your session is no longer valid. Sign in again." });
    }
    res.json({ user: publicUser(user) });
  }));

  auth.post("/signup", asyncHandler(async (req, res) => {
    const credentials = validateEmailAndPassword(req.body?.email, req.body?.password, true);
    if (credentials.error) return res.status(400).json({ error: credentials.error });
    const passwordHash = await bcrypt.hash(credentials.password, 12);
    const { users } = await getDatabase();
    let result;
    try {
      result = await users.insertOne({
        email: credentials.email,
        passwordHash,
        createdAt: new Date()
      });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ error: "An account with that email already exists." });
      throw error;
    }
    const user = { _id: result.insertedId, email: credentials.email };
    await establishSession(req, user);
    res.status(201).json({ user: publicUser(user) });
  }));

  auth.post("/login", asyncHandler(async (req, res) => {
    const credentials = validateEmailAndPassword(req.body?.email, req.body?.password, false);
    if (credentials.error) return res.status(400).json({ error: credentials.error });
    const { users } = await getDatabase();
    const user = await users.findOne({ email: credentials.email });
    if (!user || !(await bcrypt.compare(credentials.password, user.passwordHash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    await establishSession(req, user);
    res.json({ user: publicUser(user) });
  }));

  auth.post("/logout", (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        secure: isProduction || cookieSameSite === "none",
        sameSite: cookieSameSite
      });
      res.json({ ok: true });
    });
  });
  app.use("/api/auth", authLimiter, auth);

  app.get("/api/health", asyncHandler(async (_req, res) => {
    const { db } = await getDatabase();
    await db.command({ ping: 1 });
    res.json({ ok: true });
  }));

  app.get("/api/journal", requireAuthentication, asyncHandler(async (req, res) => {
    const { journals } = await getDatabase();
    const document = await journals.findOne({ userId: new ObjectId(req.session.userId) });
    res.json({ journal: document?.journal || null, updatedAt: document?.updatedAt || null });
  }));

  app.put("/api/journal", requireAuthentication, asyncHandler(async (req, res) => {
    const journal = req.body?.journal;
    const validationError = validateJournal(journal);
    if (validationError) return res.status(400).json({ error: validationError });
    const { journals } = await getDatabase();
    const updatedAt = new Date();
    const userId = new ObjectId(req.session.userId);
    await journals.updateOne(
      { userId },
      { $set: { journal, updatedAt }, $setOnInsert: { userId, createdAt: updatedAt } },
      { upsert: true }
    );
    res.json({ ok: true, updatedAt });
  }));

  app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
  app.get("/:asset", (req, res, next) => {
    if (!frontendFiles.has(req.params.asset)) return next();
    res.sendFile(path.join(__dirname, req.params.asset));
  });

  app.use((_req, res) => res.status(404).json({ error: "Not found." }));
  app.use((error, _req, res, _next) => {
    console.error("EdgeVault API request failed:", error);
    if (res.headersSent) return;
    const status = error.type === "entity.too.large" ? 413
      : error.type === "entity.parse.failed" ? 400
        : error.message === "This browser origin is not allowed by the API." ? 403 : 500;
    res.status(status).json({
      error: status === 413 ? "Request body is too large."
        : status === 400 ? "Request body must contain valid JSON."
          : status === 403 ? "This browser origin is not allowed by the API."
            : "The request could not be completed."
    });
  });
}

registerRoutes();

module.exports = app;

if (!process.env.NETLIFY && require.main === module) {
  getDatabase().then(({ client }) => {
    const server = app.listen(port, () => {
      console.log(`EdgeVault server listening on port ${port}`);
    });
    const close = () => {
      server.close(() => client.close());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }).catch(error => {
    console.error(`EdgeVault could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
