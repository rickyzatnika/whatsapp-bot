import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeInMemoryStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { makeWASocket } from "@whiskeysockets/baileys"; // Fixed import
import P from "pino";
import express from "express";
import fileUpload from "express-fileupload";
import cors from "cors";
import bodyParser from "body-parser";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs";
import http from "http";
import { Server as SocketIOServer } from "socket.io"; // Corrected import name
import qrcode from "qrcode";
import { fileURLToPath } from "url";

import { GoogleGenerativeAI } from "@google/generative-ai";

// Access your API key as an environment variable (see "Set up your API key" above)
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server); // Initialize Socket.IO server
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use("/assets", express.static(path.join(__dirname, "client", "assets")));

// Middleware Configuration
app.use(
  fileUpload({
    createParentPath: true,
  })
);
// Daftar domain yang diizinkan
const allowedOrigins = [
  "https://barland.vercel.app", // HTTPS
  "http://localhost:3000", // Localhost dengan HTTP
  "http://localhost:5000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
        // Jika origin ada dalam daftar yang diizinkan atau tidak ada origin (misalnya untuk permintaan dari server ke server)
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.get("/scan", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "server.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client", "index.html"));
});

// Utility Functions
const capitalize = (text) => {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

// Baileys Store
const store = makeInMemoryStore({
  logger: P().child({ level: "silent", stream: "store" }),
});

let sock;
let qrCode;
let currentSocket;

const userStatus = {};

const deleteSessionFolder = (folderPath) => {
  if (fs.existsSync(folderPath)) {
    fs.rmdirSync(folderPath, { recursive: true });
    console.log(`Folder ${folderPath} berhasil dihapus.`);
  } else {
    console.log(`Folder ${folderPath} tidak ditemukan.`);
  }
};

async function run(prompt) {
  try {
    console.log("Sending request to AI with prompt:", prompt);
    const result = await model.generateContent(prompt);
    console.log("Received response from AI:", result);

    // Pastikan untuk memeriksa struktur respons
    if (
      result &&
      result.response &&
      typeof result.response.text === "function"
    ) {
      // Panggil fungsi `text` untuk mendapatkan hasilnya
      const text = await result.response.text();
      console.log("Extracted text from AI response:", text);
      return text;
    } else {
      throw new Error("AI response text function not found or not callable");
    }
  } catch (error) {
    console.error("Error during AI interaction:", error);
    return "Maaf, saya tidak dapat menjawab pertanyaan Anda saat ini."; // Fallback message
  }
}

// WhatsApp Connection Function
const connectToWhatsApp = async () => {
  // Path folder session
  const sessionFolderPath = path.join(__dirname, "baileys_auth_info");

  // Hapus folder session sebelum memulai ulang koneksi
  deleteSessionFolder(sessionFolderPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolderPath);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: P({ level: "silent" }),
    version,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
  });

  // (kode lainnya tetap sama)
};

// Socket.io Connection
io.on("connection", (socket) => {
  currentSocket = socket;
  if (isConnected()) {
    updateQR("connected");
  } else if (qrCode) {
    updateQR("qr");
  }

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// Socket.io Connection
io.on("connection", (socket) => {
  currentSocket = socket;
  if (isConnected()) {
    updateQR("connected");
  } else if (qrCode) {
    updateQR("qr");
  }

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// Helper Functions
const isConnected = () => {
  return !!sock?.user;
};

const updateQR = (status) => {
  switch (status) {
    case "qr":
      qrcode.toDataURL(qrCode, (err, url) => {
        if (err) {
          console.error("Error generating QR Code: ", err);
        } else {
          currentSocket?.emit("qr", url);
          currentSocket?.emit("log", "QR Code received, please scan!");
        }
      });
      break;
    case "connected":
      currentSocket?.emit("qrstatus", "../assets/check.svg");
      currentSocket?.emit("log", "WhatsApp terhubung!");
      break;
    case "qrscanned":
      currentSocket?.emit("qrstatus", "../assets/check.svg");
      currentSocket?.emit("log", "QR Code Telah discan!");
      break;
    case "loading":
      currentSocket?.emit("qrstatus", "../assets/loader.gif");
      currentSocket?.emit("log", "Registering QR Code, please wait!");
      break;
    default:
      break;
  }
};

// Send Text Message to WhatsApp User
app.post("/send-message", async (req, res) => {
  let { numbers, message } = req.body;
  const file = req.files?.file_dikirim;

  // Parsing numbers jika masih berupa string
  if (typeof numbers === "string") {
    try {
      numbers = JSON.parse(numbers);
    } catch (error) {
      return res.status(400).json({
        status: false,
        response: "Format daftar nomor WA tidak valid!",
      });
    }
  }

  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({
      status: false,
      response: "Daftar nomor WA tidak disertakan!",
    });
  }

  try {
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "WhatsApp belum terhubung.",
      });
    }

    for (const number of numbers) {
      const numberWA = `${number}@s.whatsapp.net`;
      const [exists] = await sock.onWhatsApp(numberWA);

      if (!exists?.jid) {
        console.warn(`Nomor ${number} tidak terdaftar.`);
        continue;
      }

      let options = {};

      if (file) {
        // Handle File Upload
        const uploadPath = path.join(
          __dirname,
          "uploads",
          `${Date.now()}_${file.name}`
        );

        // Cek apakah direktori 'uploads' ada
        if (!fs.existsSync(path.join(__dirname, "uploads"))) {
          fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
        }

        await file.mv(uploadPath);

        const mimeType = file.mimetype;
        const extension = path.extname(uploadPath).toLowerCase();

        if ([".jpeg", ".jpg", ".png", ".gif"].includes(extension)) {
          options = {
            image: { url: uploadPath }, // Jika pengiriman menggunakan path file, sesuaikan di sini
            caption: message,
          };
        } else if ([".mp3", ".ogg"].includes(extension)) {
          options = {
            audio: { url: uploadPath }, // Pastikan path sesuai dengan sistem Railway
            mimetype: mimeType,
            ptt: true,
          };
        } else {
          options = {
            document: { url: uploadPath },
            mimetype: mimeType,
            fileName: file.name,
            caption: message,
          };
        }

        // Hapus file setelah dikirim
        fs.unlink(uploadPath, (err) => {
          if (err) console.error("Error deleting file: ", err);
        });
      } else {
        options = { text: message };
      }

      await sock.sendMessage(exists.jid, options);
    }

    res.status(200).json({
      status: true,
      response: "Pesan berhasil dikirim ke semua nomor.",
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: `Failed to send message: ${error.message}`,
    });
  }
});

const PORT = process.env.PORT || 8000;

// Start Express Server
server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
  connectToWhatsApp();
});
