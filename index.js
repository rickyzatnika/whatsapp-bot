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
  res.sendFile(path.join(__dirname, "client", "server.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "index.html"));
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
// Fungsi untuk menghapus folder session secara otomatis
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

  // Only delete the folder if there’s a reason to reset the session
  if (!fs.existsSync(sessionFolderPath)) {
    deleteSessionFolder(sessionFolderPath);
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolderPath);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: P({ level: "silent" }),
    version,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
  });
  store.bind(sock.ev);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      updateQR("qr");
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      switch (reason) {
        case DisconnectReason.badSession:
          console.log(`Bad Session File, Please Delete session and Scan Again`);
          await sock.logout();
          break;
        case DisconnectReason.connectionClosed:
          console.log("Connection closed, reconnecting....");
          connectToWhatsApp();
          break;
        case DisconnectReason.connectionLost:
          console.log("Connection Lost from Server, reconnecting...");
          connectToWhatsApp();
          break;
        case DisconnectReason.connectionReplaced:
          console.log(
            "Connection Replaced, Another New Session Opened, Please Close Current Session First"
          );
          await sock.logout();
          break;
        case DisconnectReason.loggedOut:
          console.log(
            `Device Logged Out, Please Delete session and Scan Again.`
          );
          await sock.logout();
          break;
        case DisconnectReason.restartRequired:
          console.log("Restart Required, Restarting...");
          connectToWhatsApp();
          break;
        case DisconnectReason.timedOut:
          console.log("Connection TimedOut, Reconnecting...");
          connectToWhatsApp();
          break;
        default:
          console.log(
            `Unknown DisconnectReason: ${reason}|${lastDisconnect?.error}`
          );
          await sock.end();
      }
    } else if (connection === "open") {
      console.log("WhatsApp connected");
      updateQR("connected");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Tentukan nomor pemilik WhatsApp
  const ownerNumber = "6289654361768@s.whatsapp.net"; // Ganti dengan nomor pemilik WhatsApp

  // Buat objek untuk menyimpan status pengguna
  const userStatus = {};

  // Durasi waktu setelah pengguna memilih "tidak" (dalam milidetik)
  const muteDuration = 60 * 60 * 1000; // 1 jam

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    const phone = msg.key.remoteJid;

    // Periksa apakah pengirim pesan adalah pemilik WhatsApp
    if (phone === ownerNumber) {
      // Jika pengirim adalah pemilik, tidak ada tindakan yang dilakukan
      console.log("Pesan dari pemilik, tidak direspons oleh AI.");
      return;
    }

    if (msg.message.conversation) {
      const pesan = msg.message.conversation;
      console.log(`Pesan masuk: ${pesan} - Dari: ${phone}`);

      try {
        // Periksa apakah pengguna sebelumnya sudah memilih untuk tidak berbicara dengan AI
        if (userStatus[phone] && userStatus[phone].muteUntil > Date.now()) {
          console.log(
            `Pengguna ${phone} telah memilih untuk tidak berbicara dengan AI.`
          );
          return;
        }

        // Jika ini adalah pesan pertama dari pengguna
        if (!userStatus[phone]) {
          // Tanyakan apakah pengguna ingin berbicara dengan AI
          userStatus[phone] = { firstMessageSent: true };
          const response =
            "Apakah Anda ingin chat dengan AI? Balas dengan 'ya' untuk berbicara dengan AI atau 'tidak' jika tidak ingin direspons oleh AI.";
          await sock.sendMessage(phone, { text: response });
        } else if (!userStatus[phone].aiEnabled) {
          // Periksa jawaban pengguna
          if (pesan.toLowerCase() === "ya") {
            userStatus[phone].aiEnabled = true;
            const welcomeMessage = "Hallo, Apa yang ingin anda tanyakan?😊";
            await sock.sendMessage(phone, { text: welcomeMessage });
          } else if (pesan.toLowerCase() === "tidak") {
            userStatus[phone].muteUntil = Date.now() + muteDuration;
            const goodbyeMessage = "Oke , see you next time.";
            await sock.sendMessage(phone, { text: goodbyeMessage });
          }
        } else {
          // Jika pengguna telah memilih untuk berbicara dengan AI
          const aiResponse = await run(pesan);
          await sock.sendMessage(phone, { text: aiResponse });
        }
      } catch (error) {
        console.error("Error processing message:", error);
        await sock.sendMessage(phone, {
          text: "Maaf, saya tidak dapat menjawab pertanyaan Anda saat ini.",
        });
      }
    }
  });

  // sock.ev.on("messages.upsert", async ({ messages }) => {
  //   const msg = messages[0];
  //   const phone = msg.key.remoteJid;

  //   if (msg.message.conversation) {
  //     const pesan = msg.message.conversation;
  //     console.log(`Pesan masuk: ${pesan} - Dari: ${phone}`);

  //     try {
  //       // Periksa status pengirim
  //       if (!userStatus[phone]) {
  //         // Pesan pertama
  //         userStatus[phone] = { firstMessageSent: true };
  //         const response =
  //           "Hallo saya AI Ampas, saat ini Ricky masih tidur. Jika ingin menunggu saya bersedia menemani, silahkan tanyakan pertanyaan apapun atau apakah anda ingin saya membantu dengan sesuatu yang lain? Misalnya, apakah anda ingin saya:\n- Mencari informasi tentang topik tertentu?\n- Membuat naskah, novel, artikel atau cerpen\n- Membuat berbagai resep makanan\n- Memberi solusi tentang masalah yang sedang anda alami\n\nSilahkan beri tahu saya apa yang ingin Anda lakukan. Saya siap membantu!😊";
  //         await sock.sendMessage(phone, { text: response });
  //       } else {
  //         // Pesan berikutnya
  //         const aiResponse = await run(pesan);
  //         await sock.sendMessage(phone, { text: aiResponse });
  //       }
  //     } catch (error) {
  //       console.error("Error processing message:", error);
  //       await sock.sendMessage(phone, {
  //         text: "Maaf, saya tidak dapat menjawab pertanyaan Anda saat ini.",
  //       });
  //     }
  //   }
  // });
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
      currentSocket?.emit("qrstatus", "./assets/check.svg");
      currentSocket?.emit("log", "WhatsApp terhubung!");
      break;
    case "qrscanned":
      currentSocket?.emit("qrstatus", "./assets/check.svg");
      currentSocket?.emit("log", "QR Code Telah discan!");
      break;
    case "loading":
      currentSocket?.emit("qrstatus", "./assets/loader.gif");
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
